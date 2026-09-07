'use strict';
/**
 * 农历展示（需求 2.3.2）
 * 依赖 Chromium/Node 内置的 ICU 中国农历日历（Intl），无需外部数据表。
 * 重要：农历仅用于界面展示，不参与任何课程时间计算。
 */
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const CN_MONTH = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
const CN_MONTH_EXTRA = { 十一: 11, 十二: 12 }; // ICU 会输出「十一月」「十二月」
const CN_DAY_PREFIX = ['初', '十', '廿', '三'];

function cnDay(day) {
  if (day === 10) return '初十';
  if (day === 20) return '二十';
  if (day === 30) return '三十';
  const prefix = CN_DAY_PREFIX[Math.floor(day / 10)];
  const rest = day % 10;
  return rest === 0 ? `${prefix}十` : `${prefix}${CN_NUM[rest]}`;
}

function cnMonth(month, leap) {
  const name = CN_MONTH[month - 1] || String(month);
  return `${leap ? '闰' : ''}${name}月`;
}

/** 解析中文农历月份，如「七月」「闰七月」「冬月」「7月」 */
function parseCnMonth(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return null;
  const leap = text.indexOf('闰') >= 0 || text.indexOf('閏') >= 0;
  const name = text.replace(/[闰閏月]/g, '');
  if (CN_MONTH_EXTRA[name]) return { month: CN_MONTH_EXTRA[name], leap };
  const index = CN_MONTH.indexOf(name);
  if (index >= 0) return { month: index + 1, leap };
  const digits = /(\d+)/.exec(name);
  if (digits) return { month: Number(digits[1]), leap };
  return null;
}

/** 返回 { month, day, leap }，不支持时返回 null */
function lunarParts(date) {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      month: 'long',
      day: 'numeric'
    }).formatToParts(date);
    let monthInfo = null;
    let day = 0;
    for (const part of parts) {
      if (part.type === 'month' && !monthInfo) monthInfo = parseCnMonth(part.value);
      if (part.type === 'day') {
        const m = /(\d+)/.exec(part.value);
        day = m ? Number(m[1]) : Number(part.value);
      }
    }
    if (!monthInfo || !day || !Number.isFinite(monthInfo.month) || !Number.isFinite(day)) return null;
    return { month: monthInfo.month, day, leap: monthInfo.leap };
  } catch (err) {
    return null; // 运行环境不支持农历时不影响主功能
  }
}

/** 例：七月廿六 / 闰四月初五；不支持时返回空串 */
function lunarText(date) {
  const parts = lunarParts(date);
  if (!parts) return '';
  return `${cnMonth(parts.month, parts.leap)}${cnDay(parts.day)}`;
}

module.exports = { lunarText, lunarParts, cnDay, cnMonth };
