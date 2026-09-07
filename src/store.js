'use strict';
/**
 * 本地数据持久化（需求 2.2 / 3.1 / 3.3）
 * - 所有配置与课表只保存在本机 userdata/ 目录，不上传任何服务器
 * - JSON 文件损坏时自动备份并回退默认值，保证程序不闪退
 */
const fs = require('fs');
const path = require('path');

/**
 * 数据目录：
 * - 开发运行（npm start）：项目根目录下的 userdata/
 * - 打包后的 App：系统应用数据目录（~/Library/Application Support/mac-simple-course-widget）
 * 两种情况下数据都只存在本机。
 */
function resolveDataDir() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return app.getPath('userData');
  } catch (err) {
    /* 非 Electron 环境（如单元测试）时回退到项目目录 */
  }
  return path.join(__dirname, '..', 'userdata');
}

const DATA_DIR = resolveDataDir();
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const COURSES_FILE = path.join(DATA_DIR, 'courses.json');
const SEMESTERS_FILE = path.join(DATA_DIR, 'semesters.json'); // 学期档案：每学期的课表 + 开学日期

const DEFAULT_CONFIG = {
  semesterStart: '', // 开学第一周的周一，YYYY-MM-DD
  notifyEnabled: true, // 课前提醒总开关
  notifyLeadMinutes: 15, // 提前提醒分钟数，5 ~ 30
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  textModel: 'qwen2.5:7b',
  visionModel: 'llava:13b',
  themeMode: 'system', // system | light | dark（主窗口与小组件同步）
  widgetBackground: '', // 自定义背景图片路径（绝对路径，留空=系统风格半透明背景）
  mainUsesBackground: false, // 主窗口是否也使用同一张背景
  widgetMode: 'today', // today | week
  widgetVisible: true,
  widgetInteractive: false, // 默认贴桌面层（不遮挡其它程序）；如需点击切换日期/右键菜单，可在设置或托盘菜单开启「鼠标交互」
  widgetBounds: null, // { x, y, width, height }
  launchAtLogin: false, // 开机自启（登录项）
  wizardDone: false // 首次引导向导是否已完成
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return clone(fallback);
    const raw = fs.readFileSync(file, 'utf8');
    if (!String(raw).trim()) return clone(fallback);
    const data = JSON.parse(raw);
    return data === null || data === undefined ? clone(fallback) : data;
  } catch (err) {
    // 容错：文件损坏时备份原文件并回退默认值（需求 3.3）
    console.warn('[store] 读取失败，已回退默认值：', file, err.message);
    try {
      fs.renameSync(file, file + '.broken-' + Date.now());
    } catch (_) {
      /* 忽略备份失败 */
    }
    return clone(fallback);
  }
}

function writeJson(file, data) {
  ensureDataDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function clampLeadMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.notifyLeadMinutes;
  return Math.min(30, Math.max(5, Math.round(n)));
}

function loadConfig() {
  ensureDataDir();
  const raw = readJson(CONFIG_FILE, DEFAULT_CONFIG) || {};
  const cfg = Object.assign(clone(DEFAULT_CONFIG), raw);
  cfg.notifyEnabled = cfg.notifyEnabled !== false;
  cfg.notifyLeadMinutes = clampLeadMinutes(cfg.notifyLeadMinutes);
  cfg.themeMode = ['system', 'light', 'dark'].indexOf(cfg.themeMode) >= 0
    ? cfg.themeMode
    : cfg.followSystemTheme === false
      ? 'light'
      : 'system';
  cfg.widgetBackground = typeof cfg.widgetBackground === 'string' ? cfg.widgetBackground : '';
  cfg.mainUsesBackground = cfg.mainUsesBackground === true;
  cfg.widgetMode = cfg.widgetMode === 'week' ? 'week' : 'today';
  cfg.widgetVisible = cfg.widgetVisible !== false;
  cfg.widgetInteractive = cfg.widgetInteractive !== false;
  cfg.launchAtLogin = cfg.launchAtLogin === true;
  cfg.wizardDone = cfg.wizardDone === true;
  cfg.semesterStart = /^\d{4}-\d{2}-\d{2}$/.test(String(cfg.semesterStart || '')) ? cfg.semesterStart : '';
  cfg.ollamaBaseUrl = String(cfg.ollamaBaseUrl || DEFAULT_CONFIG.ollamaBaseUrl).replace(/\/+$/, '');
  return cfg;
}

function saveConfig(cfg) {
  const next = Object.assign({}, cfg);
  next.notifyLeadMinutes = clampLeadMinutes(next.notifyLeadMinutes);
  next.widgetMode = next.widgetMode === 'week' ? 'week' : 'today';
  writeJson(CONFIG_FILE, next);
  return next;
}

function loadCourses() {
  ensureDataDir();
  const list = readJson(COURSES_FILE, []);
  return Array.isArray(list) ? list : [];
}

function saveCourses(list) {
  writeJson(COURSES_FILE, Array.isArray(list) ? list : []);
}

/* ------------------------------------------------------------ 学期档案 */

/**
 * 学期档案：每个学期一份课表 + 开学日期，切换学期即可换回旧课表，
 * 避免每学期都要重新导入一遍（旧的课表不会被覆盖丢失）。
 * @typedef {{id: string, name: string, semesterStart: string, courses: Array, updatedAt: string}} Semester
 */
function loadSemesters() {
  const data = readJson(SEMESTERS_FILE, { activeId: '', list: [] }) || {};
  const list = Array.isArray(data.list) ? data.list : [];
  return {
    activeId: typeof data.activeId === 'string' ? data.activeId : '',
    list: list
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id: String(item.id || ''),
        name: String(item.name || '未命名学期'),
        semesterStart: typeof item.semesterStart === 'string' ? item.semesterStart : '',
        courses: Array.isArray(item.courses) ? item.courses : [],
        updatedAt: String(item.updatedAt || '')
      }))
      .filter((item) => item.id)
  };
}

function saveSemesters(data) {
  const payload = {
    activeId: (data && data.activeId) || '',
    list: Array.isArray(data && data.list) ? data.list : []
  };
  writeJson(SEMESTERS_FILE, payload);
  return payload;
}

module.exports = {
  DATA_DIR,
  CONFIG_FILE,
  COURSES_FILE,
  SEMESTERS_FILE,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  loadCourses,
  saveCourses,
  loadSemesters,
  saveSemesters
};
