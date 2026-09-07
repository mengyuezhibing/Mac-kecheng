'use strict';
/**
 * 课表业务计算逻辑（需求 2.2，纯逻辑无 UI）
 * - 根据「开学第一周的周一」计算当前教学周
 * - 按 startWeek / endWeek / weekType（全周 / 单周 / 双周）过滤有效课程
 * - 提供今日课程列表、当月日历网格数据
 * 注意：农历仅用于展示，不参与本模块任何计算。
 */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEK_TYPES = ['全周', '单周', '双周'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CN_WEEKDAY_MAP = { 天: 0, 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseDateKey(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(value).trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isSameDate(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 当前教学周；未配置开学日期返回 null，未开学返回 0 */
function getCurrentWeek(semesterStart, date = new Date()) {
  const start = parseDateKey(semesterStart);
  if (!start) return null;
  const diff = Math.round((startOfDay(date) - startOfDay(start)) / 86400000);
  if (diff < 0) return 0;
  return Math.floor(diff / 7) + 1;
}

function normalizeWeekday(value) {
  if (typeof value === 'number') {
    if (value === 0) return 0;
    if (value >= 1 && value <= 7) return value % 7;
    return -1;
  }
  const s = String(value === null || value === undefined ? '' : value).trim();
  if (!s) return -1;
  const direct = WEEKDAYS.indexOf(s);
  if (direct >= 0) return direct;
  const m = /(?:星期|周)?([一二三四五六日天])/.exec(s);
  if (m) return CN_WEEKDAY_MAP[m[1]];
  const num = Number(s);
  if (Number.isFinite(num)) return normalizeWeekday(num);
  return -1;
}

function normalizeTime(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  const m = /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(s);
  if (!m) return '';
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const mi = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${pad2(h)}:${pad2(mi)}`;
}

function toInt(value, fallback) {
  const n = Number(String(value === null || value === undefined ? '' : value).trim());
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function clampWeek(n, fallback) {
  const v = toInt(n, fallback);
  return Math.min(52, Math.max(1, v));
}

/** AI 输出字段容错归一化：缺失字段给出默认值，交由人工在编辑页修正 */
function normalizeCourse(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const startWeek = clampWeek(c.startWeek, 1);
  const endWeek = clampWeek(c.endWeek, startWeek || 20);
  const weekdayIdx = normalizeWeekday(c.weekday);
  let weekType = String(c.weekType || '').trim();
  if (weekType.indexOf('单') >= 0) weekType = '单周';
  else if (weekType.indexOf('双') >= 0) weekType = '双周';
  else weekType = '全周';

  return {
    courseName: String(c.courseName || c.name || '').trim(),
    teacher: String(c.teacher || c.授课教师 || '').trim(),
    location: String(c.location || c.place || '').trim(),
    weekday: weekdayIdx >= 0 ? WEEKDAYS[weekdayIdx] : '',
    startTime: normalizeTime(c.startTime),
    endTime: normalizeTime(c.endTime),
    startWeek: startWeek || 1,
    endWeek: endWeek < startWeek ? startWeek : endWeek,
    weekType: WEEK_TYPES.indexOf(weekType) >= 0 ? weekType : '全周'
  };
}

/** 单条课程在指定教学周是否生效 */
function isActiveInWeek(course, week) {
  if (!course || !week || week <= 0) return false;
  const sw = Number(course.startWeek);
  const ew = Number(course.endWeek);
  if (Number.isFinite(sw) && week < sw) return false;
  if (Number.isFinite(ew) && week > ew) return false;
  if (course.weekType === '单周') return week % 2 === 1;
  if (course.weekType === '双周') return week % 2 === 0;
  return true;
}

function timeToMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!m) return Number.POSITIVE_INFINITY;
  return Number(m[1]) * 60 + Number(m[2]);
}

function sortByTime(list) {
  return list.slice().sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
}

/** 指定日期的有效课程，按上课时间升序 */
function getCoursesForDate(courses, date, semesterStart) {
  const week = getCurrentWeek(semesterStart, date);
  if (!week || week <= 0) return [];
  const weekdayIdx = date.getDay();
  return sortByTime(
    (Array.isArray(courses) ? courses : []).filter((c) => {
      if (normalizeWeekday(c && c.weekday) !== weekdayIdx) return false;
      return isActiveInWeek(c, week);
    })
  );
}

/**
 * 本周课表（周一 ~ 周日），每天按上课时间升序。
 * 教学周未配置或未开学时返回 7 天，但课程为空。
 */
function getWeekSchedule(courses, semesterStart, now = new Date()) {
  const week = getCurrentWeek(semesterStart, now);
  const monday = startOfDay(now);
  const offsetToMonday = (now.getDay() + 6) % 7; // 将周日=0 调整为周一=0
  monday.setDate(now.getDate() - offsetToMonday);
  const labels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push({
      label: labels[i],
      dateText: `${d.getMonth() + 1}/${d.getDate()}`,
      isToday: isSameDate(d, now),
      weekday: WEEKDAYS[d.getDay()],
      courses: week && week > 0 ? getCoursesForDate(courses, d, semesterStart) : []
    });
  }
  return { week, days };
}

/** 字段校验，返回错误数组（空数组表示合法） */
function validateCourse(course) {
  const errors = [];
  const c = course || {};
  if (!String(c.courseName || '').trim()) errors.push('课程名称不能为空');
  if (WEEKDAYS.indexOf(c.weekday) < 0) errors.push('星期需为 周一 ~ 周日');
  if (!TIME_RE.test(String(c.startTime || ''))) errors.push('开始时间需为 HH:mm');
  if (!TIME_RE.test(String(c.endTime || ''))) errors.push('结束时间需为 HH:mm');
  if (errors.length === 0 && timeToMinutes(c.startTime) >= timeToMinutes(c.endTime)) {
    errors.push('结束时间必须晚于开始时间');
  }
  const sw = Number(c.startWeek);
  const ew = Number(c.endWeek);
  if (!Number.isInteger(sw) || sw < 1 || sw > 52) errors.push('起始周需为 1 ~ 52 的整数');
  if (!Number.isInteger(ew) || ew < 1 || ew > 52) errors.push('结束周需为 1 ~ 52 的整数');
  if (Number.isInteger(sw) && Number.isInteger(ew) && sw > ew) errors.push('起始周不能大于结束周');
  if (WEEK_TYPES.indexOf(c.weekType) < 0) errors.push('周类型需为 全周 / 单周 / 双周');
  return errors;
}

/** 批量校验，返回 [{ index, errors }] */
function validateCourses(list) {
  const result = [];
  (Array.isArray(list) ? list : []).forEach((c, index) => {
    const errors = validateCourse(c);
    if (errors.length) result.push({ index, errors, courseName: c && c.courseName });
  });
  return result;
}

module.exports = {
  WEEKDAYS,
  WEEK_TYPES,
  pad2,
  toDateKey,
  parseDateKey,
  startOfDay,
  isSameDate,
  getCurrentWeek,
  normalizeWeekday,
  normalizeTime,
  normalizeCourse,
  isActiveInWeek,
  timeToMinutes,
  sortByTime,
  getCoursesForDate,
  getWeekSchedule,
  validateCourse,
  validateCourses
};
