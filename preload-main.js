'use strict';
/** 主窗口预加载：仅暴露受控 API 给渲染进程（contextIsolation 开启） */
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const schedule = require('./src/schedule');

contextBridge.exposeInMainWorld('api', {
  // 配置
  getConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),

  // 课表
  getCourses: () => ipcRenderer.invoke('courses:load'),
  saveCourses: (list) => ipcRenderer.invoke('courses:save', list),
  validateCourses: (list) => schedule.validateCourses(list),

  // 导入解析（本地规则，不经过任何 AI）
  parseHtml: (html) => ipcRenderer.invoke('import:html', html),
  openLastImportTables: () => ipcRenderer.invoke('debug:open-last-input'),

  // 网址导入
  fetchUrlHtml: (url) => ipcRenderer.invoke('import:fetch-url', url),
  openUrlBrowser: (url) => ipcRenderer.invoke('import:open-url', url),
  grabBrowserHtml: () => ipcRenderer.invoke('import:grab-browser'),
  getBrowserUrl: () => ipcRenderer.invoke('import:browser-url'),
  getFilePath: (file) =>
    webUtils && typeof webUtils.getPathForFile === 'function' ? webUtils.getPathForFile(file) : file && file.path,

  // 数据管理
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),

  // 课表信息
  getScheduleInfo: () => ipcRenderer.invoke('schedule:info'),

  // 学期档案
  listSemesters: () => ipcRenderer.invoke('semesters:list'),
  createSemester: (name) => ipcRenderer.invoke('semesters:create', name),
  switchSemester: (id) => ipcRenderer.invoke('semesters:switch', id),
  renameSemester: (id, name) => ipcRenderer.invoke('semesters:rename', { id, name }),
  deleteSemester: (id) => ipcRenderer.invoke('semesters:delete', id),

  // 小组件
  showWidget: () => ipcRenderer.invoke('widget:show'),
  hideWidget: () => ipcRenderer.invoke('widget:hide'),
  toggleWidget: () => ipcRenderer.invoke('widget:toggle'),
  setWidgetMode: (mode) => ipcRenderer.invoke('widget:set-mode', mode),
  setWidgetInteractive: (enabled) => ipcRenderer.invoke('widget:set-interactive', enabled),
  editWidget: () => ipcRenderer.invoke('widget:edit'),

  // 主题与背景
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeChange: (callback) => ipcRenderer.on('theme:update', (_event, theme) => callback(theme)),
  getBackground: () => ipcRenderer.invoke('background:get'),
  pickBackground: () => ipcRenderer.invoke('background:pick'),
  clearBackground: () => ipcRenderer.invoke('background:clear'),
  onBackgroundChange: (callback) =>
    ipcRenderer.on('app:background', (_event, payload) => callback(payload)),

  // 开机自启（登录项）
  getLoginItem: () => ipcRenderer.invoke('app:get-login-item'),
  setLoginItem: (enabled) => ipcRenderer.invoke('app:set-login-item', enabled)
});
