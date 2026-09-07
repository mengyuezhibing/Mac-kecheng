'use strict';
/**
 * 课表导入与本地解析（不依赖任何 AI / 外部服务，全部在本机完成）
 *
 * 输入：教务课表网页源码、或直接从网页复制出来的表格文本
 * 解析策略（按准确率从高到低）：
 *   ① 课程清单型表格：校区 | 课程名称 | 编号 | 周次 | 教室 | 上课时间 | 教师 … → src/parser.js
 *   ② 单元格型周课表：时间 | 星期一 | … | 星期日，单元格内是 课程名：教师 / 校区：教室 / 周次
 * 两者都失败时返回空数组，由界面提示用户在课程管理页手动添加。
 */
const { normalizeCourse } = require('./schedule');
const {
  parseCourseListTables,
  periodTimesOf,
  mergeConsecutive,
  parseWeeks,
  splitMulti
} = require('./parser');

const HTML_LIMIT = 60000;

function stripHtmlNoise(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s{2,}/g, ' ');
}

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ');
}

/** 表格 → 纯文本（每行一门课的一个时段，“|” 分隔单元格） */
function tableToText(html) {
  return String(html || '')
    .replace(/<\s*\/?\s*(thead|tbody|tfoot)[^>]*>/gi, '')
    .replace(/<\s*tr[^>]*>/gi, '\n')
    .replace(/<\s*\/\s*tr[^>]*>/gi, '')
    .replace(/<\s*\/\s*(td|th)[^>]*>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, ' / ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 排除通知公告类表格（表头是 序号 / 标题 / 发布人 的那些） */
function isCourseTable(text) {
  const head = String(text || '').split('\n')[0] || '';
  if (/发布人|发布时间|公告|通知|标题|序号|点击数/.test(head)) return false;
  return /课程|课表|星期|周[一二三四五六日]|节次|教室|教师|上课时间/.test(head);
}

/**
 * 输入归一化：网页源码 → 若干张表的纯文本；纯文本表格直接按行使用
 * @returns {{tables: string[], kind: 'table'|'text'}}
 */
function preprocess(input) {
  const raw = String(input || '').trim();
  if (!raw) return { tables: [], kind: 'text' };

  if (/<\s*(table|tr|td|div)\b/i.test(raw)) {
    const cleaned = stripHtmlNoise(raw).slice(0, HTML_LIMIT);
    const rawTables = cleaned.match(/<table[\s\S]*?<\/table>/gi) || [];
    const tables = rawTables.map(tableToText).filter(Boolean);
    if (tables.length) {
      const picked = tables.filter(isCourseTable);
      return { tables: picked.length ? picked : tables, kind: 'table' };
    }
    // 没有表格（div 网格等）：整页去标签后作为纯文本备用
    return { tables: [stripTags(cleaned).replace(/\s{2,}/g, ' ')], kind: 'text' };
  }

  return { tables: [raw], kind: 'text' };
}

/** "12节" → [1,2]、"910节" → [9,10] */
function parsePeriods(cell) {
  const m = /(\d{1,3})\s*节/.exec(String(cell || ''));
  if (!m) return null;
  const s = m[1];
  if (s.length <= 1) {
    const n = Number(s);
    return n >= 1 && n <= 12 ? [n, n] : null;
  }
  if (s.length === 2) {
    const a = Number(s[0]);
    const b = Number(s[1]);
    if (a >= 1 && b <= 12 && b > a) return [a, b];
    const n = Number(s);
    return n >= 1 && n <= 12 ? [n, n] : null;
  }
  // 三位数：910 → 9、10
  const a = Number(s.slice(0, 1));
  const b = Number(s.slice(1));
  return a >= 1 && b <= 12 && b > a ? [a, b] : null;
}

/**
 * 单元格内的单门课文本 → 课程字段
 * 例：并行分布式计算：彭昌猛 / 雅安校区：10-B301室 / 13-16周 (连堂4学时) / (实验) /
 */
function parseCellCourse(text) {
  const fields = String(text || '')
    .split('/')
    .map((f) => f.trim())
    .filter(Boolean);
  if (!fields.length) return null;

  let courseName = '';
  let teacher = '';
  let location = '';
  let weeks = null;

  fields.forEach((field) => {
    if (/^-{3,}$/.test(field) || /^[（(]实验[)）]$/.test(field)) return;
    const kv = /^(.+?)\s*[:：]\s*(.+)$/.exec(field);
    if (kv) {
      const key = kv[1].trim();
      const value = kv[2].trim();
      if (/校区|教室|地点|室$/.test(key)) location = value.replace(/室$/, '') || value;
      else if (!courseName) {
        courseName = key;
        teacher = value;
      }
      return;
    }
    if (/\d+\s*[-~至]\s*\d+\s*周|^\d+\s*周/.test(field)) {
      weeks = parseWeeks(field);
      return;
    }
    if (!courseName && !/^(实验|理论|实践|上机)$/.test(field)) courseName = field;
  });

  if (!courseName) return null;
  return {
    courseName,
    teacher,
    location,
    startWeek: weeks ? weeks.startWeek : 1,
    endWeek: weeks ? weeks.endWeek : 16,
    weekType: weeks ? weeks.weekType : '全周'
  };
}

/** ② 单元格型周课表：时间 | 星期一 … 星期日 */
function parseGridTable(lines, periodTimes) {
  const headerIndex = lines.findIndex(
    (line) => /时间|节次/.test(line) && /星期[一二三四五六日]|周[一二三四五六日]/.test(line)
  );
  if (headerIndex < 0) return null;

  const list = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const cells = lines[i]
      .split('|')
      .map((c) => c.trim())
      .filter((cell, index, arr) => !(index === arr.length - 1 && !cell));
    if (cells.length < 4) continue;

    // 数据行形如：上午 | 12节 | 周一 | 周二 | … → 节次列右边第一列就是周一
    let periodIndex = -1;
    let periods = null;
    for (let c = 0; c < Math.min(3, cells.length); c++) {
      periods = parsePeriods(cells[c]);
      if (periods) {
        periodIndex = c;
        break;
      }
    }
    if (periodIndex < 0) continue;
    const weekStart = periodIndex + 1;
    if (cells.length - weekStart < 2) continue;

    for (let d = 0; d < 7; d++) {
      const cell = cells[weekStart + d];
      if (!cell || /^-+$/.test(cell)) continue;
      const weekday = d + 1; // 1 = 周一
      cell
        .split(/-{3,}/)
        .map((block) => block.trim())
        .filter(Boolean)
        .forEach((block) => {
          const parsed = parseCellCourse(block);
          if (!parsed) return;
          const start = periodTimes[periods[0]];
          const end = periodTimes[periods[1]];
          if (!start || !end) return;
          list.push(
            Object.assign({}, parsed, {
              weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday % 7],
              startTime: start[0],
              endTime: end[1],
              _sp: periods[0],
              _ep: periods[1]
            })
          );
        });
    }
  }
  return list.length ? list : null;
}

/**
 * 导入入口：网页源码 / 表格文本 → 课程数组
 * @returns {{courses: Array, source: 'list'|'grid'|'', tables: string[]}}
 */
function parseScheduleInput(input, customPeriodTimes) {
  const { tables } = preprocess(input);
  if (!tables.length) return { courses: [], source: '', tables };

  const periodTimes = periodTimesOf(customPeriodTimes);

  // ① 课程清单型表格（最准：教室与上课时间一一对应）
  const listResult = parseCourseListTables(tables, customPeriodTimes);
  if (listResult.matched && listResult.courses.length) {
    return { courses: listResult.courses, source: 'list', tables };
  }

  // ② 单元格型周课表
  let grid = [];
  tables.forEach((table) => {
    const lines = table.split('\n').map((l) => l.trim()).filter(Boolean);
    const parsed = parseGridTable(lines, periodTimes);
    if (parsed) grid = grid.concat(parsed);
  });
  if (grid.length) {
    const courses = mergeConsecutive(grid)
      .map((course) => normalizeCourse(course))
      .filter((course) => course.courseName && course.startTime && course.endTime && course.weekday);
    if (courses.length) return { courses, source: 'grid', tables };
  }

  return { courses: [], source: '', tables };
}

module.exports = {
  preprocess,
  parseScheduleInput,
  parsePeriods,
  parseGridTable,
  splitMulti
};
