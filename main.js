'use strict';
/**
 * Electron 主进程（需求 4）
 * 负责：窗口管理、系统托盘、本地文件读写、课表解析与业务计算、系统通知调度。
 *
 * 已知限制（需求 7）：
 * - 小组件是 Electron 无边框悬浮窗口模拟实现，不是 macOS WidgetKit 原生小组件，重启电脑后需启动本应用。
 * - 没有网页爬虫：不会自动登录教务网站。网址导入只提供一个普通浏览器窗口，由用户自己登录并进入课表页面，
 *   抓取时机完全由用户点击决定。
 * - 课表解析全部在本机用规则完成（课程清单表 / 单元格型周课表），不依赖任何 AI 与外部服务。
 */
const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  Notification,
  nativeTheme,
  dialog,
  screen,
  shell
} = require('electron');

const store = require('./src/store');
const schedule = require('./src/schedule');
const importer = require('./src/importer');
const { lunarText } = require('./src/lunar');

const CHECK_INTERVAL = 30000; // 通知检测间隔（仅比对时间，不做小组件渲染轮询）

let mainWindow = null;
let widgetWindow = null;
let importerWindow = null; // 网址导入用的内置浏览器窗口（需求 2.1.2）
let tray = null;
let config = store.loadConfig();
let courses = store.loadCourses();

const notifiedKeys = new Set();
let notifiedDayKey = '';
let lastDayKey = schedule.toDateKey(new Date());
let isQuitting = false;
let boundsTimer = null;
let widgetEditMode = false;
let lastImportTables = []; // 最近一次导入识别到的表格（排查用）

/* ------------------------------------------------------------ 开机自启 */

/** 根据配置同步“登录项”，使应用随系统启动；系统偏好设置中改动后此处以配置为准 */
function applyLoginItem() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!config.launchAtLogin,
      openAsHidden: !!config.launchAtLogin
    });
  } catch (err) {
    console.warn('[login] 设置登录项失败：', err && err.message);
  }
}

function currentLoginItemState() {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch (err) {
    return !!config.launchAtLogin;
  }
}

/* ------------------------------------------------------------------ 主题 */

function currentTheme() {
  const mode = config.themeMode || 'system';
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return nativeTheme.shouldUseDarkMode ? 'dark' : 'light';
}

function pushTheme() {
  const theme = currentTheme();
  [mainWindow, widgetWindow].forEach((win) => {
    if (win && !win.isDestroyed()) win.webContents.send('theme:update', theme);
  });
}

/** 自定义背景图片：返回可在渲染进程使用的 file:// 地址 */
function backgroundUrl() {
  const file = config.widgetBackground;
  if (!file || !fs.existsSync(file)) return '';
  return require('url').pathToFileURL(file).href;
}

/** 推送背景到主窗口与小组件 */
function pushBackground() {
  const url = backgroundUrl();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:background', { url, mainUses: !!config.mainUsesBackground });
  }
  refreshWidget();
}

/* -------------------------------------------------------------- 主窗口 */

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1020,
    height: 720,
    minWidth: 900,
    minHeight: 620,
    title: 'Mac简易课程表',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkMode ? '#1e1e1e' : '#f2f2f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload-main.js'),
      contextIsolation: true,
      sandbox: false,
      spellcheck: false // 关闭拼写检查，省一个词典进程
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.once('did-finish-load', pushTheme);
  return mainWindow;
}

/* --------------------------------------------------- 网址导入（需求 2.1.2） */

/** 在内置浏览器中打开的页面里抓取 HTML：主文档 + 同源 iframe（很多教务系统把课表放在 iframe 里） */
const GRAB_PAGE_SCRIPT = `(() => {
  try {
    const parts = [document.documentElement.outerHTML];
    document.querySelectorAll('iframe').forEach((f) => {
      try {
        const d = f.contentDocument;
        if (d && d.documentElement) parts.push(d.documentElement.outerHTML);
      } catch (e) { /* 跨域 iframe 无法访问，忽略 */ }
    });
    return parts.join('\\n');
  } catch (e) {
    return document.documentElement ? document.documentElement.outerHTML : '';
  }
})()`;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * 打开（或复用）内置浏览器窗口加载教务网址。
 * 仅提供一个普通浏览器窗口由用户自己登录，程序不做任何自动登录、验证码或爬虫行为。
 */
/**
 * 教务系统常用 window.open 弹出课表窗口，导致“抓的是旧窗口”：
 * - 带 URL 的弹窗 → 直接在当前窗口打开，保持只有一个窗口、抓取目标不变；
 * - 无 URL（about:blank 再由脚本跳转）→ 允许创建，并把抓取目标切到新窗口。
 */
function attachImporterHandlers(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:/i.test(url)) {
      if (importerWindow && !importerWindow.isDestroyed()) {
        importerWindow.loadURL(url).catch(() => {});
      }
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  win.webContents.on('did-create-window', (newWin) => {
    importerWindow = newWin; // 抓取目标跟随最新打开的窗口
    newWin.setTitle('课表网页（登录后回到主窗口抓取）');
    attachImporterHandlers(newWin);
    newWin.on('closed', () => {
      if (importerWindow === newWin) importerWindow = null;
    });
  });
}

function openImporterWindow(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('请填写以 http:// 或 https:// 开头的完整网址');

  if (importerWindow && !importerWindow.isDestroyed()) {
    importerWindow.loadURL(target).catch(() => {});
    importerWindow.show();
    importerWindow.focus();
    return { ok: true, url: target };
  }

  importerWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    title: '课表网页（登录后回到主窗口抓取）',
    backgroundColor: nativeTheme.shouldUseDarkMode ? '#1e1e1e' : '#f2f2f7',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  attachImporterHandlers(importerWindow);
  importerWindow.loadURL(target).catch((err) => {
    console.warn('[import:url] 打开网址失败：', err && err.message);
  });
  importerWindow.on('closed', () => {
    importerWindow = null;
  });
  return { ok: true, url: target };
}

/** 抓取内置浏览器当前页面的 HTML */
async function grabImporterHtml() {
  if (!importerWindow || importerWindow.isDestroyed()) {
    throw new Error('内置浏览器窗口未打开，请先点击「用内置浏览器打开并登录」');
  }
  const wc = importerWindow.webContents;
  if (wc.isLoading()) throw new Error('页面还在加载中，请等页面完整显示后再抓取');
  const html = await wc.executeJavaScript(GRAB_PAGE_SCRIPT, false);
  if (!String(html || '').trim()) throw new Error('未能读取到页面内容，请确认页面已正常显示');
  return { ok: true, html, url: wc.getURL() };
}

/** 从响应头或 meta 标签判断编码，兼容 GBK 教务站点 */
function detectCharset(buffer, contentType) {
  const header = /charset=([\w-]+)/i.exec(String(contentType || ''));
  if (header) return header[1].toLowerCase();
  const head = buffer.subarray(0, 2048).toString('latin1');
  const meta = /charset\s*=\s*["']?([\w-]+)/i.exec(head);
  return meta ? meta[1].toLowerCase() : 'utf-8';
}

/** 后台直接抓取网页源码（适用于无需登录即可访问的课表页面） */
async function fetchUrlHtml(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('请填写以 http:// 或 https:// 开头的完整网址');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml' }
    });
    if (!res.ok) throw new Error(`网页返回 HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    let html;
    try {
      html = new TextDecoder(detectCharset(buffer, res.headers.get('content-type'))).decode(buffer);
    } catch (err) {
      html = buffer.toString('utf8');
    }
    if (!html.trim()) throw new Error('网页返回内容为空，请确认网址可直接访问课表');
    return { ok: true, html, url: res.url || target };
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('打开网址超时（20 秒），请检查网络或改用内置浏览器');
    const reason = (err && err.cause && err.cause.code) || (err && err.code) || (err && err.message);
    throw new Error(`无法打开该网址（${reason || '未知错误'}）；若教务网站需要登录，请改用「内置浏览器」方式`);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------ 小组件窗口 */

function persistWidgetBounds() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    const b = widgetWindow.getBounds();
    config.widgetBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    store.saveConfig(config);
  }, 400);
}

/**
 * 创建小组件窗口
 * @param {boolean} editable false = 桌面壁纸层级（type: 'desktop'，不打扰但收不到鼠标事件）
 *                           或开启了 config.widgetInteractive 时 = 普通窗口层级（可点击日期箭头、右键菜单）
 *                           true  = 编辑模式（普通层级，可拖动 / 缩放 / 右键）
 */
function createWidgetWindow(editable = false) {
  const b = config.widgetBounds || {};
  widgetEditMode = editable;

  // 默认停靠在屏幕右下角（仅当没有已保存的位置时生效）
  let defX = undefined;
  let defY = undefined;
  try {
    const area = screen.getPrimaryDisplay().workAreaSize;
    defX = Math.max(0, area.width - (b.width || 320) - 24);
    defY = Math.max(0, area.height - (b.height || 400) - 24);
  } catch (err) {
    /* 计算失败时回退到系统默认位置 */
  }

  widgetWindow = new BrowserWindow({
    width: b.width || 320,
    height: b.height || 400,
    x: typeof b.x === 'number' ? b.x : defX,
    y: typeof b.y === 'number' ? b.y : defY,
    frame: false, // 无边框、无标题栏
    transparent: true,
    hasShadow: true,
    resizable: editable,
    movable: true,
    skipTaskbar: true,
    fullscreenable: false,
    show: false,
    title: 'Mac简易课程表',
    // 开启“鼠标交互”后改为普通窗口层级，这样点击日期箭头、右键菜单才能真正收到鼠标事件
    type: editable || config.widgetInteractive ? undefined : 'desktop',
    // 编辑模式下需要可聚焦，才能响应 Esc 与“点击外部自动退出”；
    // 普通 / 交互模式下保持不抢焦点（点击小组件不夺走其它应用的输入焦点）
    focusable: editable,
    // 编辑模式下窗口已可聚焦，关闭 acceptsFirstMouse，避免“第一次点击被用于激活窗口”而被吞掉，
    // 否则小组件上的「完成」按钮点了没反应；普通 / 交互模式仍需它，让点击在未激活时也能立即生效
    acceptsFirstMouse: !editable,
    webPreferences: {
      preload: path.join(__dirname, 'preload-widget.js'),
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: true // 小组件是静态展示，后台节流可明显降低占用
    }
  });

  widgetWindow.loadFile(path.join(__dirname, 'renderer', 'widget.html'));

  // 桌面层级窗口本身跨所有空间；普通层级时也保持跨空间显示
  // 注意：不要调用 setAlwaysOnTop(false)，它会把窗口层级重置为普通层，导致小组件浮在其他窗口之上
  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

  widgetWindow.on('moved', persistWidgetBounds);
  widgetWindow.on('resized', persistWidgetBounds);
  widgetWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    widgetWindow.hide();
    config.widgetVisible = false;
    store.saveConfig(config);
    updateTrayMenu();
  });

  if (editable) {
    // 编辑模式下点击其他窗口 → 自动沉回桌面层（同原生图标：点别处就“放下”）
    widgetWindow.on('blur', () => {
      setTimeout(() => {
        if (widgetEditMode && widgetWindow && !widgetWindow.isDestroyed() && !widgetWindow.isFocused()) {
          exitWidgetEditMode();
        }
      }, 150);
    });
  }

  widgetWindow.once('ready-to-show', () => {
    refreshWidget();
    sendWidgetEditMode();
    if (!config.widgetVisible) return;
    if (editable) {
      widgetWindow.show();
      widgetWindow.focus();
    } else {
      widgetWindow.showInactive();
    }
  });
  widgetWindow.webContents.once('did-finish-load', pushTheme);
}

/** 进入编辑模式：小组件浮起，可像桌面图标一样拖动 / 缩放 */
function enterWidgetEditMode() {
  const b = widgetWindow && !widgetWindow.isDestroyed() ? widgetWindow.getBounds() : config.widgetBounds;
  if (b) {
    config.widgetBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    store.saveConfig(config);
  }
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.destroy();
  config.widgetVisible = true;
  createWidgetWindow(true);
}

/** 退出编辑模式：小组件沉回桌面层（点击窗口外任何地方也会自动触发） */
function exitWidgetEditMode() {
  if (!widgetEditMode) return;
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    const b = widgetWindow.getBounds();
    config.widgetBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    store.saveConfig(config);
    widgetWindow.destroy();
  }
  createWidgetWindow(false);
}

function sendWidgetEditMode() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send('widget:edit-mode', widgetEditMode);
  }
}

function buildWidgetPayload() {
  const now = new Date();
  const week = schedule.getCurrentWeek(config.semesterStart, now);
  const todayCourses = schedule.getCoursesForDate(courses, now, config.semesterStart);
  const lunar = lunarText(now);
  return {
    mode: config.widgetMode === 'week' ? 'week' : 'today',
    backgroundUrl: backgroundUrl(),
    weekNumber: week,
    dayOffset: config.widgetDayOffset || 0,
    today: {
      dateText: `${now.getMonth() + 1}月${now.getDate()}日 周${'日一二三四五六'[now.getDay()]}`,
      lunarText: lunar,
      courses: todayCourses
    },
    days: [0, 1, 2].map((offset) => {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      return {
        offset,
        label: offset === 0 ? '今天' : offset === 1 ? '明天' : '后天',
        dateText: `${date.getMonth() + 1}月${date.getDate()}日 周${'日一二三四五六'[date.getDay()]}`,
        lunarText: lunarText(date),
        weekNumber: week === null ? null : schedule.getCurrentWeek(config.semesterStart, date),
        courses: schedule.getCoursesForDate(courses, date, config.semesterStart)
      };
    }),
    week: schedule.getWeekSchedule(courses, config.semesterStart, now)
  };
}

function setWidgetMode(mode) {
  config.widgetMode = mode === 'week' ? 'week' : 'today';
  store.saveConfig(config);
  refreshWidget();
  updateTrayMenu();
}

/** 切换小组件查看的日期：0 = 今天，1 = 明天，2 = 后天（仅今日视图使用） */
function setWidgetDayOffset(offset) {
  config.widgetDayOffset = Math.max(0, Math.min(2, Number(offset) || 0));
  store.saveConfig(config);
  if (config.widgetVisible) {
    if (!widgetWindow || widgetWindow.isDestroyed()) createWidgetWindow(false);
    else refreshWidget();
  }
  updateTrayMenu();
}

/** 刷新小组件数据（仅在保存课表、手动刷新、跨天或显示时触发，不做后台轮询） */
function refreshWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const payload = buildWidgetPayload();
  if (widgetWindow.webContents.isLoading()) {
    widgetWindow.webContents.once('did-finish-load', () => {
      if (!widgetWindow.isDestroyed()) widgetWindow.webContents.send('widget:data', payload);
    });
  } else {
    widgetWindow.webContents.send('widget:data', payload);
  }
}

/**
 * 小组件鼠标交互开关
 * - 关闭：桌面壁纸层级（点击穿透，纯展示，不打扰其它窗口）
 * - 开启：普通窗口层级（可点击切换今天/明天、右键菜单；代价是会被其它应用窗口遮住）
 */
function setWidgetInteractive(enabled) {
  config.widgetInteractive = !!enabled;
  store.saveConfig(config);
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    const b = widgetWindow.getBounds();
    config.widgetBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    store.saveConfig(config);
    widgetWindow.destroy(); // 层级必须在创建时决定，只能重建
    widgetWindow = null;
  }
  if (config.widgetVisible) createWidgetWindow(false);
  updateTrayMenu();
}

function showWidget(show = true) {
  config.widgetVisible = !!show;
  store.saveConfig(config);

  if (show) {
    // 隐藏时窗口已被销毁以释放内存，这里重新创建（位置与尺寸会按保存的 bounds 恢复）
    if (!widgetWindow || widgetWindow.isDestroyed()) createWidgetWindow(false);
    else {
      widgetWindow.showInactive();
      refreshWidget();
    }
  } else if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.destroy(); // 直接销毁渲染进程，而不是仅隐藏，减少常驻内存
    widgetWindow = null;
  }
  updateTrayMenu();
}

function toggleWidget() {
  const visible = !!(widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible());
  showWidget(!visible);
}

/* ---------------------------------------------------------------- 托盘 */

function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '打开主配置窗口', click: () => createMainWindow() },
    {
      label: config.widgetVisible ? '隐藏桌面小组件' : '显示桌面小组件',
      click: () => toggleWidget()
    },
    {
      label: widgetEditMode ? '完成调整（小组件沉回桌面）' : '调整小组件位置 / 大小',
      click: () => (widgetEditMode ? exitWidgetEditMode() : enterWidgetEditMode())
    },
    {
      label: config.widgetMode === 'week' ? '切换为今日课程视图' : '切换为周历视图',
      click: () => setWidgetMode(config.widgetMode === 'week' ? 'today' : 'week')
    },
    { label: '查看明天课程', click: () => setWidgetDayOffset(1) },
    { label: '回到今天', click: () => setWidgetDayOffset(0) },
    {
      label: config.widgetInteractive ? '关闭小组件鼠标交互（回到桌面层）' : '开启小组件鼠标交互（可点击切换日期）',
      click: () => setWidgetInteractive(!config.widgetInteractive)
    },
    { type: 'separator' },
    { label: '退出应用程序', click: () => quitApp() }
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.icns');
  const image = nativeImage.createFromPath(iconPath);
  // 托盘使用与 App 一致的软件图标
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('Mac简易课程表');
  updateTrayMenu();
  tray.on('click', () => toggleWidget());
}

function showWidgetContextMenu() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    {
      label: config.widgetMode === 'week' ? '切换为今日课程视图' : '切换为周历视图',
      click: () => setWidgetMode(config.widgetMode === 'week' ? 'today' : 'week')
    },
    {
      label: (config.widgetDayOffset || 0) > 0 ? '回到今天' : '查看明天课程',
      click: () => setWidgetDayOffset((config.widgetDayOffset || 0) > 0 ? 0 : 1)
    },
    { label: '刷新课表数据', click: () => refreshWidget() },
    { type: 'separator' },
    { label: '关闭小组件', click: () => showWidget(false) }
  ]);
  menu.popup({ window: widgetWindow });
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

/* -------------------------------------------------------------- 课前通知 */

function minutesUntil(hhmm, now) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return Number.POSITIVE_INFINITY;
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]));
  return (target - now) / 60000;
}

function showClassNotification(course, minutes) {
  const when = minutes <= 1 ? '马上就要上课' : `${Math.max(1, Math.round(minutes))} 分钟后上课`;
  const notification = new Notification({
    title: `${when}：${course.courseName}`,
    body: `${course.startTime}-${course.endTime} · ${course.location || '地点未填写'}${
      course.teacher ? ` · ${course.teacher}` : ''
    }`
  });
  notification.show();
}

/** 时间轮询仅用于通知触发；同一节课当天只提醒一次 */
function checkNotifications() {
  const now = new Date();
  const dayKey = schedule.toDateKey(now);

  if (dayKey !== lastDayKey) {
    lastDayKey = dayKey;
    refreshWidget(); // 跨天时顺带刷新日期显示，不属于定时渲染轮询
  }
  if (dayKey !== notifiedDayKey) {
    notifiedDayKey = dayKey;
    notifiedKeys.clear();
  }
  if (!config.notifyEnabled) return;

  const list = schedule.getCoursesForDate(courses, now, config.semesterStart);
  const lead = config.notifyLeadMinutes;
  list.forEach((course) => {
    const key = `${course.courseName}|${course.startTime}|${course.location}`;
    if (notifiedKeys.has(key)) return;
    const minutes = minutesUntil(course.startTime, now);
    if (minutes <= lead && minutes >= 0) {
      notifiedKeys.add(key);
      showClassNotification(course, minutes);
    }
  });
}

/* ------------------------------------------------------------ 学期档案 */

/** 首次使用时把当前课表纳入一个默认学期档案 */
function ensureSemesterArchive() {
  const archive = store.loadSemesters();
  if (archive.list.length) return archive;
  const id = `s-${Date.now()}`;
  return store.saveSemesters({
    activeId: id,
    list: [
      {
        id,
        name: '默认学期',
        semesterStart: config.semesterStart || '',
        courses,
        updatedAt: new Date().toISOString()
      }
    ]
  });
}

/** 把当前课表与开学日期写回激活的学期档案 */
function persistActiveSemester() {
  const archive = store.loadSemesters();
  if (!archive.activeId) return;
  const target = archive.list.find((item) => item.id === archive.activeId);
  if (!target) return;
  target.courses = courses;
  target.semesterStart = config.semesterStart || '';
  target.updatedAt = new Date().toISOString();
  store.saveSemesters(archive);
}

function semesterSummaries() {
  const archive = ensureSemesterArchive();
  return {
    activeId: archive.activeId,
    list: archive.list.map((item) => ({
      id: item.id,
      name: item.name,
      semesterStart: item.semesterStart,
      count: (item.courses || []).length,
      updatedAt: item.updatedAt
    }))
  };
}

/* ------------------------------------------------------------------ IPC */

function registerIpc() {
  ipcMain.handle('config:load', () => config);
  ipcMain.handle('config:save', (_event, patch) => {
    const prevStart = config.semesterStart;
    config = store.saveConfig(Object.assign({}, config, patch || {}));
    // 开学日期属于当前学期，变化时同步进学期档案
    if (config.semesterStart !== prevStart) persistActiveSemester();
    applyLoginItem();
    pushTheme();
    pushBackground();
    updateTrayMenu();
    if (widgetWindow && !widgetWindow.isDestroyed()) refreshWidget();
    return config;
  });

  ipcMain.handle('app:get-login-item', () => currentLoginItemState());
  ipcMain.handle('app:set-login-item', (_event, enabled) => {
    config.launchAtLogin = !!enabled;
    config = store.saveConfig(config);
    applyLoginItem();
    return currentLoginItemState();
  });

  ipcMain.handle('background:get', () => ({
    path: config.widgetBackground || '',
    url: backgroundUrl(),
    mainUses: !!config.mainUsesBackground
  }));

  ipcMain.handle('background:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: '选择背景图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) return { canceled: true };

    const source = result.filePaths[0];
    const dir = path.join(store.DATA_DIR, 'backgrounds');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `bg-${Date.now()}${path.extname(source)}`);
    fs.copyFileSync(source, dest); // 复制到应用数据目录，避免原图被移动后失效

    config.widgetBackground = dest;
    config = store.saveConfig(config);
    pushBackground();
    return { ok: true, path: dest, url: backgroundUrl() };
  });

  ipcMain.handle('background:clear', () => {
    config.widgetBackground = '';
    config = store.saveConfig(config);
    pushBackground();
    return { ok: true };
  });

  ipcMain.handle('courses:load', () => courses);

  ipcMain.handle('semesters:list', () => semesterSummaries());

  ipcMain.handle('semesters:create', (_event, name) => {
    persistActiveSemester();
    const archive = store.loadSemesters();
    const id = `s-${Date.now()}`;
    archive.list.push({
      id,
      name: String(name || '').trim() || `学期 ${archive.list.length + 1}`,
      semesterStart: '',
      courses: [],
      updatedAt: new Date().toISOString()
    });
    archive.activeId = id;
    store.saveSemesters(archive);

    courses = [];
    store.saveCourses(courses);
    config.semesterStart = '';
    config = store.saveConfig(config);
    notifiedKeys.clear();
    refreshWidget();
    return Object.assign({ ok: true, activeId: id, courses }, semesterSummaries());
  });

  ipcMain.handle('semesters:switch', (_event, id) => {
    persistActiveSemester();
    const archive = store.loadSemesters();
    const target = archive.list.find((item) => item.id === id);
    if (!target) throw new Error('未找到该学期档案');
    archive.activeId = id;
    store.saveSemesters(archive);

    courses = target.courses || [];
    store.saveCourses(courses);
    config.semesterStart = target.semesterStart || '';
    config = store.saveConfig(config);
    notifiedKeys.clear();
    refreshWidget();
    return Object.assign({ ok: true, courses, semesterStart: config.semesterStart }, semesterSummaries());
  });

  ipcMain.handle('semesters:rename', (_event, payload) => {
    const archive = store.loadSemesters();
    const target = archive.list.find((item) => item.id === (payload && payload.id));
    if (!target) throw new Error('未找到该学期档案');
    target.name = String((payload && payload.name) || '').trim() || target.name;
    target.updatedAt = new Date().toISOString();
    store.saveSemesters(archive);
    return semesterSummaries();
  });

  ipcMain.handle('semesters:delete', (_event, id) => {
    const archive = store.loadSemesters();
    const index = archive.list.findIndex((item) => item.id === id);
    if (index < 0) throw new Error('未找到该学期档案');
    archive.list.splice(index, 1);
    if (archive.activeId === id) {
      const next = archive.list[0];
      archive.activeId = next ? next.id : '';
      courses = next ? next.courses || [] : [];
      store.saveCourses(courses);
      config.semesterStart = next ? next.semesterStart || '' : '';
      config = store.saveConfig(config);
      notifiedKeys.clear();
      refreshWidget();
    }
    store.saveSemesters(archive);
    return Object.assign({ ok: true, courses }, semesterSummaries());
  });

  ipcMain.handle('courses:save', (_event, list) => {
    if (!Array.isArray(list)) throw new Error('课表数据格式不正确');
    const invalid = schedule.validateCourses(list);
    if (invalid.length) {
      const first = invalid[0];
      throw new Error(`第 ${first.index + 1} 条课程${first.courseName ? `（${first.courseName}）` : ''}：${first.errors[0]}`);
    }
    courses = list;
    store.saveCourses(courses);
    persistActiveSemester(); // 同步进当前学期档案，切换学期不会丢
    notifiedKeys.clear(); // 课表变更后重置提醒记录
    refreshWidget(); // 保存课表后自动推送更新小组件（需求 2.3.3）
    return { ok: true };
  });

  ipcMain.handle('schedule:info', () => {
    const now = new Date();
    return {
      week: schedule.getCurrentWeek(config.semesterStart, now),
      todayCount: schedule.getCoursesForDate(courses, now, config.semesterStart).length,
      total: courses.length
    };
  });



  ipcMain.handle('import:open-url', (_event, url) => openImporterWindow(url));

  ipcMain.handle('import:grab-browser', async () => grabImporterHtml());

  /** 供界面实时显示“即将抓取的是哪个页面”，避免抓错窗口 */
  ipcMain.handle('import:browser-url', () => {
    if (!importerWindow || importerWindow.isDestroyed()) return { open: false, url: '', title: '' };
    return {
      open: true,
      url: importerWindow.webContents.getURL(),
      title: importerWindow.getTitle()
    };
  });

  ipcMain.handle('import:fetch-url', async (_event, url) => fetchUrlHtml(url));

  /** 本地规则解析（不经过任何 AI）：网页源码 / 表格文本 → 课程数组 */
  ipcMain.handle('import:html', async (_event, html) => {
    const result = importer.parseScheduleInput(html, config.periodTimes);
    lastImportTables = result.tables || [];
    return { ok: true, courses: result.courses, source: result.source || '' };
  });

  /** 排查用：导出最近一次解析时识别到的表格文本 */
  ipcMain.handle('debug:open-last-input', async () => {
    const dir = path.join(store.DATA_DIR, 'debug');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'last-import-tables.txt');
    const text = lastImportTables.join('\n=====\n');
    fs.writeFileSync(file, text || '（本次启动后还没有导入过课表）', 'utf8');
    const err = await shell.openPath(file);
    return { ok: !err, filePath: file, empty: !text, error: err || '' };
  });

  ipcMain.handle('data:export', async () => {
    const result = await dialog.showSaveDialog(mainWindow || undefined, {
      title: '导出课表备份',
      defaultPath: `course-backup-${schedule.toDateKey(new Date())}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(
      result.filePath,
      JSON.stringify({ exportedAt: new Date().toISOString(), config, courses }, null, 2),
      'utf8'
    );
    return { ok: true, filePath: result.filePath };
  });

  ipcMain.handle('data:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: '从备份恢复课表',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) return { ok: false, canceled: true };

    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    } catch (err) {
      throw new Error('备份文件解析失败，请确认选择的是本应用导出的 JSON 备份');
    }

    const list = Array.isArray(payload) ? payload : payload && payload.courses;
    if (!Array.isArray(list)) throw new Error('备份文件中未找到课程数据');

    courses = list.map(schedule.normalizeCourse);
    store.saveCourses(courses);
    if (payload && payload.config) {
      config = store.saveConfig(Object.assign({}, config, payload.config));
      pushTheme();
    }
    notifiedKeys.clear();
    refreshWidget();
    return { ok: true, courses };
  });

  ipcMain.handle('theme:get', () => currentTheme());

  ipcMain.handle('widget:show', () => {
    showWidget(true);
    return { ok: true };
  });
  ipcMain.handle('widget:hide', () => {
    showWidget(false);
    return { ok: true };
  });
  ipcMain.handle('widget:toggle', () => {
    toggleWidget();
    return { ok: true };
  });
  ipcMain.handle('widget:set-mode', (_event, mode) => {
    setWidgetMode(mode);
    return { ok: true };
  });
  ipcMain.handle('widget:set-day', (_event, offset) => {
    setWidgetDayOffset(offset);
    return { ok: true };
  });
  ipcMain.handle('widget:set-interactive', (_event, enabled) => {
    setWidgetInteractive(enabled);
    return { ok: true };
  });
  ipcMain.handle('widget:edit', () => {
    enterWidgetEditMode();
    return { ok: true };
  });

  ipcMain.on('widget:exit-edit', () => exitWidgetEditMode());
  ipcMain.on('widget:context-menu', () => showWidgetContextMenu());
  ipcMain.on('widget:refresh', () => refreshWidget());
  ipcMain.on('widget:resize-by', (_event, dx, dy) => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    const [w, h] = widgetWindow.getSize();
    widgetWindow.setSize(Math.max(240, Math.round(w + (dx || 0))), Math.max(220, Math.round(h + (dy || 0))));
  });
}

/* ---------------------------------------------------------------- 启动 */

app.whenReady().then(() => {
  registerIpc();
  applyLoginItem(); // 与系统登录项保持一致
  createTray();
  createMainWindow();
  // 小组件默认隐藏时不创建窗口（隐藏状态不占渲染进程内存），需要显示时再创建
  if (config.widgetVisible) createWidgetWindow();

  nativeTheme.on('updated', () => {
    pushTheme();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkMode ? '#1e1e1e' : '#f2f2f7');
    }
  });

  setInterval(checkNotifications, CHECK_INTERVAL);
  checkNotifications();
});

app.on('window-all-closed', (event) => {
  // 托盘常驻：关闭窗口不退出应用
  if (process.platform === 'darwin') event.preventDefault();
});

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
});
