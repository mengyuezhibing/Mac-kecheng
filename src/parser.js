'use strict';
/**
 * 本地结构化课表解析（不经过 AI）
 *
 * 适用教务系统输出的「课程清单型」表格，典型表头：
 *   校区 | 课程名称 | 编号 | 周次 | 教室 | 上课时间 | 学分 | 学时 | 周学时 | 实验周学时 | 考核方法 | 教师 | 选课方式 | 混合式教学
 * 典型数据行：
 *   雅安 | 并行分布式计算 | 300539423 | 1-16 | 10-A402 / | 1-5,1-6 / | 3 | 48 | 2 | 4 | 卷面考核 | 彭昌猛 | 初修 |
 *
 * 这种数据格式固定，用规则解析比大模型更准确：时间由节次表换算、教室与时间段一一对应，
 * 不会出现"只识别出一门课""时间地点错位"的问题。解析不成功时会自动回退到单元格型周课表解析。
 */
const { normalizeCourse } = require('./schedule');

/**
 * 默认节次作息表（四川农业大学作息：每节 45 分钟、小节间休息 10 分钟、大课间 20 分钟）
 * 1-2 节 08:10-09:50，3-4 节 10:10-11:50，5-6 节 14:20-16:00，7-8 节 16:20-18:00，9-10 节 19:30-21:10
 * 可通过 config.periodTimes 覆盖（对象，键为节次数字，值为 [开始, 结束]）
 */
const DEFAULT_PERIOD_TIMES = {
  1: ['08:10', '08:55'],
  2: ['09:05', '09:50'],
  3: ['10:10', '10:55'],
  4: ['11:05', '11:50'],
  5: ['14:20', '15:05'],
  6: ['15:15', '16:00'],
  7: ['16:20', '17:05'],
  8: ['17:15', '18:00'],
  9: ['19:30', '20:15'],
  10: ['20:25', '21:10'],
  11: ['21:20', '22:05'],
  12: ['22:15', '23:00']
};

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 表头列名别名（同字段多个别名，取最先命中的列） */
const COLUMN_ALIASES = {
  courseName: ['课程名称', '课程名', '课程'],
  teacher: ['任课教师', '授课教师', '教师'],
  location: ['上课地点', '教室', '地点'],
  weeks: ['上课周次', '起止周', '周次'],
  time: ['上课时间', '节次', '时间'],
  campus: ['校区']
};

function periodTimesOf(custom) {
  if (!custom || typeof custom !== 'object') return DEFAULT_PERIOD_TIMES;
  const merged = Object.assign({}, DEFAULT_PERIOD_TIMES);
  Object.keys(custom).forEach((key) => {
    const period = Number(key);
    const value = custom[key];
    if (Number.isFinite(period) && Array.isArray(value) && value.length >= 2) {
      merged[period] = [String(value[0]), String(value[1])];
    }
  });
  return merged;
}

/** 按 | 切分表格行，去掉首尾空单元格 */
function splitRow(line) {
  return String(line || '')
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell, index, arr) => !(index === 0 && !cell) && !(index === arr.length - 1 && !cell));
}

/** 单元格里的多值：10-A301 / 10-A707 / → ['10-A301', '10-A707'] */
function splitMulti(value) {
  return String(value || '')
    .split('/')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => v.replace(/^[^:：]{0,10}校区[:：]/, '').trim());
}

/** 表头 → 列下标映射 */
function mapColumns(header) {
  const cols = { courseName: -1, teacher: -1, location: -1, weeks: -1, time: -1, campus: -1 };
  Object.keys(COLUMN_ALIASES).forEach((field) => {
    COLUMN_ALIASES[field].forEach((alias) => {
      if (cols[field] >= 0) return;
      const exact = header.indexOf(alias);
      if (exact >= 0) {
        cols[field] = exact;
        return;
      }
      const fuzzy = header.findIndex((cell) => cell.indexOf(alias) >= 0);
      if (fuzzy >= 0) cols[field] = fuzzy;
    });
  });
  return cols;
}

/** 周次：1-16 → { startWeek: 1, endWeek: 16 }；附带识别 (单)/(双) */
function parseWeeks(text) {
  const raw = String(text || '').trim();
  const range = /(\d{1,2})\s*[-~至]\s*(\d{1,2})/.exec(raw);
  const single = range ? null : /(\d{1,2})/.exec(raw);
  const startWeek = range ? Number(range[1]) : single ? Number(single[1]) : 1;
  const endWeek = range ? Number(range[2]) : single ? Number(single[1]) : 16;
  const weekType = /单/.test(raw) ? '单周' : /双/.test(raw) ? '双周' : '全周';
  return {
    startWeek: Math.min(52, Math.max(1, startWeek || 1)),
    endWeek: Math.min(52, Math.max(1, endWeek || 16)),
    weekType
  };
}

/**
 * 上课时间单元格 → 时间段
 * "1-5,1-6"        → 周一 第5-6节
 * "2-9,2-10(单)"   → 周二 第9-10节 单周
 * "任课教师自行安排" → null（跳过）
 */
function parseSlot(text) {
  const raw = String(text || '').trim();
  if (!raw || /自行安排|待定|未排|无|暂无/.test(raw)) return null;

  const weekType = /单/.test(raw) ? '单周' : /双/.test(raw) ? '双周' : '全周';
  const parts = raw
    .replace(/[（(]/g, ' ')
    .replace(/[)）]/g, ' ')
    .split(/[,，、]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const first = /(\d+)\s*[-~]\s*(\d+)/.exec(parts[0]);
  const last = /(\d+)\s*[-~]\s*(\d+)/.exec(parts[parts.length - 1]);
  if (!first || !last) return null;

  const weekday = Number(first[1]);
  let startPeriod = Number(first[2]);
  let endPeriod = Number(last[2]);
  if (!(weekday >= 1 && weekday <= 7)) return null;
  if (startPeriod > endPeriod) {
    const tmp = startPeriod;
    startPeriod = endPeriod;
    endPeriod = tmp;
  }
  if (!(startPeriod >= 1 && endPeriod <= 12)) return null;

  return { weekday, startPeriod, endPeriod, weekType };
}

function parseRow(cells, cols, periodTimes) {
  const courseName = (cells[cols.courseName] || '').trim();
  if (!courseName) return [];

  const teacher = cols.teacher >= 0 ? (cells[cols.teacher] || '').trim() : '';
  const rooms = cols.location >= 0 ? splitMulti(cells[cols.location]) : [];
  const slots = splitMulti(cells[cols.time]);
  const weeks = parseWeeks(cols.weeks >= 0 ? cells[cols.weeks] : '');

  const list = [];
  slots.forEach((slotText, index) => {
    const slot = parseSlot(slotText);
    if (!slot) return;
    const start = periodTimes[slot.startPeriod];
    const end = periodTimes[slot.endPeriod];
    if (!start || !end) return;
    list.push({
      courseName,
      teacher,
      location: rooms[index] || rooms[rooms.length - 1] || '',
      weekday: WEEKDAY_CN[slot.weekday % 7],
      startTime: start[0],
      endTime: end[1],
      startWeek: weeks.startWeek,
      endWeek: weeks.endWeek,
      weekType: slot.weekType !== '全周' ? slot.weekType : weeks.weekType,
      _sp: slot.startPeriod,
      _ep: slot.endPeriod
    });
  });
  return list;
}

/** 连堂（1-2 节 + 3-4 节）合并为一条课程 */
function mergeConsecutive(list) {
  const sorted = list
    .slice()
    .sort((a, b) => WEEKDAY_CN.indexOf(a.weekday) - WEEKDAY_CN.indexOf(b.weekday) || a._sp - b._sp);
  const out = [];
  sorted.forEach((course) => {
    const prev = out[out.length - 1];
    const canMerge =
      prev &&
      prev.courseName === course.courseName &&
      prev.weekday === course.weekday &&
      prev.location === course.location &&
      prev.startWeek === course.startWeek &&
      prev.endWeek === course.endWeek &&
      prev.weekType === course.weekType &&
      course._sp === prev._ep + 1;
    if (canMerge) {
      prev._ep = course._ep;
      prev.endTime = course.endTime;
      return;
    }
    out.push(Object.assign({}, course));
  });
  return out;
}

function parseTable(lines, periodTimes) {
  const headerIndex = lines.findIndex(
    (line) => /课程名称|课程名/.test(line) && /上课时间|节次|时间/.test(line)
  );
  if (headerIndex < 0) return null;

  const cols = mapColumns(splitRow(lines[headerIndex]));
  if (cols.courseName < 0 || cols.time < 0) return null;

  const list = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    if (cells.length < 3) continue;
    if (/^\d+$/.test(cells[0]) && !cells[cols.courseName]) continue; // 纯序号行
    list.push(...parseRow(cells, cols, periodTimes));
  }
  return list.length ? list : null;
}

/**
 * 从预处理后的表格里做本地规则解析
 * @param {string[]} tables 每个元素是一张表的纯文本（首行为表头）
 * @param {object} customPeriodTimes 自定义节次时间
 * @returns {{courses: Array, matched: boolean}} matched=false 表示没匹配到清单型表格，应回退 AI
 */
function parseCourseListTables(tables, customPeriodTimes) {
  const periodTimes = periodTimesOf(customPeriodTimes);
  let matched = false;
  let list = [];

  (tables || []).forEach((table) => {
    const lines = String(table || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const parsed = parseTable(lines, periodTimes);
    if (parsed) {
      matched = true;
      list = list.concat(parsed);
    }
  });

  if (!matched) return { courses: [], matched: false };

  const courses = mergeConsecutive(list)
    .map((course) => normalizeCourse(course))
    .filter((course) => course.courseName && course.startTime && course.endTime && course.weekday);

  return { courses, matched: true };
}

module.exports = {
  DEFAULT_PERIOD_TIMES,
  parseCourseListTables,
  parseSlot,
  parseWeeks,
  splitMulti,
  periodTimesOf,
  mergeConsecutive
};
