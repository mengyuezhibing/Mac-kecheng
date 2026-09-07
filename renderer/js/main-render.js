/* 主窗口渲染进程：设置、课表导入、课程预览与编辑 */
'use strict';

const $ = (selector) => document.querySelector(selector);

let config = null;
let courses = [];
let pending = false; // 解析结果尚未保存
let editingIndex = -1;

/* ------------------------------------------------------------ 通用工具 */

let toastTimer = null;
function toast(message, type = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${type}`;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function showLoading(text) {
  $('#loadingText').textContent = text || '解析中，请稍候…';
  $('#loading').classList.remove('hidden');
}

function hideLoading() {
  $('#loading').classList.add('hidden');
}

function applyTheme(theme) {
  document.body.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

function switchPage(page) {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
  document.querySelectorAll('.page').forEach((section) => {
    section.classList.toggle('active', section.id === `page-${page}`);
  });
}

/* -------------------------------------------------------------- 设置页 */

function fillSettingsForm() {
  if (!config) return;
  $('#semesterStart').value = config.semesterStart || '';
  $('#notifyEnabled').checked = config.notifyEnabled !== false;
  $('#notifyLeadMinutes').value = config.notifyLeadMinutes || 15;
  $('#themeMode').value = ['system', 'light', 'dark'].indexOf(config.themeMode) >= 0
    ? config.themeMode
    : config.followSystemTheme === false
      ? 'light'
      : 'system';
  $('#widgetMode').value = config.widgetMode === 'week' ? 'week' : 'today';
  $('#mainUsesBg').checked = config.mainUsesBackground === true;
  $('#launchAtLogin').checked = config.launchAtLogin === true;
  $('#widgetInteractive').checked = config.widgetInteractive === true;
}

function readSettingsForm() {
  const lead = Number($('#notifyLeadMinutes').value);
  return {
    semesterStart: $('#semesterStart').value,
    notifyEnabled: $('#notifyEnabled').checked,
    notifyLeadMinutes: Number.isFinite(lead) ? lead : 15,
    themeMode: $('#themeMode').value,
    mainUsesBackground: $('#mainUsesBg').checked,
    widgetMode: $('#widgetMode').value,
    launchAtLogin: $('#launchAtLogin').checked
  };
}

/** 应用自定义背景（主窗口） */
function applyBackground({ url, mainUses } = {}) {
  const body = document.body;
  if (url && mainUses) {
    body.style.backgroundImage = `url("${url}")`;
    body.style.backgroundSize = 'cover';
    body.style.backgroundPosition = 'center';
    body.style.backgroundAttachment = 'fixed';
  } else {
    body.style.backgroundImage = '';
  }
}

async function refreshBackgroundUi() {
  const info = await window.api.getBackground();
  applyBackground(info);
  const wrap = $('#bgPreviewWrap');
  if (info.url && info.path) {
    $('#bgPreview').src = info.url;
    $('#bgPathText').textContent = info.path;
    wrap.classList.remove('hidden');
  } else {
    wrap.classList.add('hidden');
  }
}

async function saveSettings(silent = false) {
  const patch = readSettingsForm();
  const lead = patch.notifyLeadMinutes;
  if (!Number.isFinite(lead) || lead < 5 || lead > 30) {
    toast('提前提醒时间需为 5 ~ 30 分钟', 'error');
    return false;
  }
  config = await window.api.saveConfig(patch);
  await refreshInfo();
  if (!silent) toast('设置已保存', 'success');
  return true;
}

async function refreshInfo() {
  const info = await window.api.getScheduleInfo();
  currentWeek = info.week === undefined ? null : info.week;
  const weekText = info.week === null ? '未设置开学日期' : info.week === 0 ? '尚未开学' : `第 ${info.week} 教学周`;
  $('#weekBadge').textContent = `${weekText} · 今日 ${info.todayCount} 门课`;
  updateWeekHint();
}

/* -------------------------------------------------------- 首次引导向导 */

let wizardStep = 0;
let wizardState = {};
let wizardImport = 'later';

function openWizard() {
  wizardState = {
    semesterStart: config.semesterStart || '',
    themeMode: config.themeMode || 'system',
    widgetMode: config.widgetMode === 'week' ? 'week' : 'today',
    widgetBackground: config.widgetBackground || '',
    mainUsesBackground: config.mainUsesBackground === true,
    launchAtLogin: config.launchAtLogin === true
  };
  $('#wsSemesterStart').value = wizardState.semesterStart;
  $('#wsThemeMode').value = wizardState.themeMode;
  $('#wsWidgetMode').value = wizardState.widgetMode;
  $('#wsMainUsesBg').checked = wizardState.mainUsesBackground;
  $('#wsLaunchAtLogin').checked = wizardState.launchAtLogin;
  wizardImport = 'later';
  document.querySelectorAll('.wizard-option').forEach((el) => {
    el.classList.toggle('selected', el.dataset.import === 'later');
  });
  hideWizardBgPreview();
  $('#wizardMask').classList.remove('hidden');
  goWizardStep(0);
}

function closeWizard() {
  $('#wizardMask').classList.add('hidden');
}

async function finishWizard() {
  const patch = {
    semesterStart: $('#wsSemesterStart').value,
    themeMode: $('#wsThemeMode').value,
    widgetMode: $('#wsWidgetMode').value,
    mainUsesBackground: $('#wsMainUsesBg').checked,
    launchAtLogin: $('#wsLaunchAtLogin').checked,
    wizardDone: true
  };
  config = await window.api.saveConfig(patch);
  fillSettingsForm();
  closeWizard();
  toast('引导完成，基础设置已保存', 'success');
  if (wizardImport === 'url') {
    switchPage('import');
    switchImportTab('url');
  } else if (wizardImport === 'html') {
    switchPage('import');
    switchImportTab('html');
  }
}

function goWizardStep(step) {
  wizardStep = step;
  document.querySelectorAll('.wizard-step').forEach((el) => {
    el.classList.toggle('hidden', Number(el.dataset.step) !== step);
  });
  const prev = $('#wizardPrev');
  const next = $('#wizardNext');
  prev.disabled = step === 0;
  next.textContent = step === 6 ? '完成' : '下一步';

  const total = 7;
  $('#wizardSteps').innerHTML = Array.from({ length: total })
    .map((_, i) => `<span class="ws-dot ${i <= step ? 'active' : ''}"></span>`)
    .join('');
}

function hideWizardBgPreview() {
  $('#wsBgPreviewWrap').classList.add('hidden');
}

async function wizardPickBg() {
  const result = await window.api.pickBackground();
  if (result && result.ok) {
    $('#wsBgPreview').src = result.url;
    $('#wsBgPreviewWrap').classList.remove('hidden');
    wizardState.widgetBackground = result.path;
  }
}

async function wizardClearBg() {
  await window.api.clearBackground();
  wizardState.widgetBackground = '';
  hideWizardBgPreview();
}

/* -------------------------------------------------------------- 导入页 */

function switchImportTab(tab) {
  document.querySelectorAll('.tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
  $('#pane-url').classList.toggle('active', tab === 'url');
  $('#pane-html').classList.toggle('active', tab === 'html');
  if (tab !== 'url') stopBrowserWatch();
}

function setUrlStatus(text) {
  $('#urlStatus').textContent = text;
}

/* 实时显示“即将抓取的页面地址”，避免抓错窗口 */
let browserWatchTimer = null;

async function updateBrowserStatus() {
  try {
    const info = await window.api.getBrowserUrl();
    if (!info.open) {
      setUrlStatus('内置浏览器窗口已关闭：请重新点「用内置浏览器打开并登录」。');
      stopBrowserWatch();
      return;
    }
    setUrlStatus(
      info.url
        ? `即将抓取的页面：${info.url}（确认是课表页后点「抓取当前页面并解析」）`
        : '内置浏览器页面加载中…'
    );
  } catch (err) {
    stopBrowserWatch();
  }
}

function startBrowserWatch() {
  stopBrowserWatch();
  updateBrowserStatus();
  browserWatchTimer = setInterval(updateBrowserStatus, 1500);
}

function stopBrowserWatch() {
  if (browserWatchTimer) {
    clearInterval(browserWatchTimer);
    browserWatchTimer = null;
  }
}

/** 抓到的页面像登录页（有登录/验证码字样但没有课表内容）时提前提示 */
function looksLikeLoginPage(html) {
  const text = String(html || '').slice(0, 20000);
  const hasCourse = /课程|课表|星期|周[一二三四五六日]|节次|教室|教师/.test(text);
  const hasLogin = /登录|登陆|验证码|用户名|密码|统一身份认证/.test(text);
  return hasLogin && !hasCourse;
}

/** 打开内置浏览器，由用户自己登录教务系统 */
async function openUrlBrowser() {
  const url = ($('#scheduleUrl').value || '').trim();
  if (!url) {
    toast('请先填写课表网页地址', 'error');
    return;
  }
  try {
    await window.api.openUrlBrowser(url);
    toast('已打开内置浏览器，登录后回到本窗口抓取');
    startBrowserWatch(); // 状态栏会实时显示即将抓取的页面地址
    setUrlStatus('已打开内置浏览器：请在其中登录并进入课表页面，然后回到本窗口点「抓取当前页面并解析」。');
  } catch (err) {
    toast(err && err.message ? err.message : '打开网址失败', 'error');
  }
}

/**
 * 网址导入
 * @param {'browser'|'direct'} mode browser = 抓取内置浏览器当前页面；direct = 后台直接抓取网址
 */
async function runParseUrl(mode) {
  const button = mode === 'direct' ? $('#btnFetchUrl') : $('#btnGrabBrowser');
  const url = ($('#scheduleUrl').value || '').trim();
  if (mode === 'direct' && !url) {
    toast('请先填写课表网页地址', 'error');
    return;
  }

  button.disabled = true;
  try {
    let result;
    if (mode === 'direct') {
      showLoading('正在打开网址并获取网页源码…');
      result = await window.api.fetchUrlHtml(url);
    } else {
      showLoading('正在读取内置浏览器当前页面…');
      result = await window.api.grabBrowserHtml();
    }
    stopBrowserWatch();
    setUrlStatus(`已抓取：${result.url}（源码 ${result.html.length} 字符）`);
    await parseHtmlAndShow(result.html);
  } catch (err) {
    setUrlStatus(err && err.message ? err.message : '获取网页失败');
    toast(err && err.message ? err.message : '获取网页失败，请改用「表格 / 源码导入」', 'error');
  } finally {
    hideLoading();
    button.disabled = false;
  }
}

/** 网页源码 / 表格文本 → 本地规则解析 → 课程预览页 */
async function parseHtmlAndShow(html) {
  if (looksLikeLoginPage(html)) {
    toast('抓到的是登录页面（没有课表内容）：请点「用内置浏览器打开并登录」，进入课表页面后再抓取。', 'error');
    return;
  }
  if (!/课程|课表|星期|周[一二三四五六日]|节次|教室/.test(String(html).slice(0, 200000))) {
    toast('该页面源码里没有看到课表内容（可能是脚本动态渲染）：请改用「用内置浏览器打开并登录」方式抓取。', 'error');
    return;
  }
  showLoading('正在解析课表…');
  const result = await window.api.parseHtml(html);
  courses = result.courses || [];
  if (!courses.length) {
    toast('没能从该页面解析出课程：请确认页面上显示的是「课程清单 / 周课表」表格，或改用「表格 / 源码导入」粘贴课表内容。', 'error');
    return;
  }
  pending = true;
  renderCourses();
  switchPage('courses');
  const from = result.source === 'grid' ? '周课表' : '课程清单';
  toast(`已按${from}解析出 ${courses.length} 条课程（本机规则解析），请核对后保存`, 'success');
}

/** 判断是否只粘贴了网址（而非页面源代码） */
function looksLikeUrlOnly(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const isUrl = /^https?:\/\/\S+$/i.test(t);
  const hasHtml = /<[a-z!]/i.test(t);
  return isUrl && !hasHtml;
}

/** 粘贴的表格文本 / 网页源码 → 本地规则解析 */
async function runParseText() {
  const button = $('#btnParseHtml');
  const text = $('#htmlSource').value || '';

  // 粘贴的是网址而非课表内容时，直接帮他切到「网址导入」
  if (looksLikeUrlOnly(text)) {
    $('#scheduleUrl').value = text.trim();
    $('#htmlSource').value = '';
    switchImportTab('url');
    toast('检测到你粘贴的是网址，已切换到「网址导入」：点「用内置浏览器打开并登录」后抓取，或点「直接抓取并解析」。');
    return;
  }
  if (!text.trim()) {
    toast('请先粘贴课表表格内容或网页源码', 'error');
    return;
  }

  button.disabled = true;
  showLoading('正在解析课表…');
  try {
    const result = await window.api.parseHtml(text);
    courses = result.courses || [];
    if (!courses.length) {
      toast(
        '没能解析出课程：请粘贴「课程名称 / 周次 / 教室 / 上课时间 / 教师」这样的课程清单，或整张周课表；也可以到「课程管理」手动添加。',
        'error'
      );
      return;
    }
    pending = true;
    renderCourses();
    switchPage('courses');
    const from = result.source === 'grid' ? '周课表' : '课程清单';
    toast(`已按${from}解析出 ${courses.length} 条课程（本机规则解析），请核对后保存`, 'success');
  } catch (err) {
    toast(err && err.message ? err.message : '解析失败，请核对粘贴的内容', 'error');
  } finally {
    hideLoading();
    button.disabled = false;
  }
}

/* ------------------------------------------------------------ 学期档案 */

let semesters = { activeId: '', list: [] };

function fillSemesterSelect() {
  const select = $('#semesterSelect');
  if (!select) return;
  select.innerHTML = semesters.list
    .map(
      (item) =>
        `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}（${item.count} 节${
          item.semesterStart ? ' · ' + escapeHtml(item.semesterStart) : ''
        }）</option>`
    )
    .join('');
  if (semesters.activeId) select.value = semesters.activeId;
}

function applySemesterResult(result) {
  semesters = { activeId: result.activeId, list: result.list };
  fillSemesterSelect();
}

async function loadSemesters() {
  semesters = await window.api.listSemesters();
  fillSemesterSelect();
}

async function switchSemester(id) {
  if (!id || id === semesters.activeId) return;
  if (pending && !confirm('当前有未保存的修改，切换学期会丢失这些修改，确定继续？')) {
    fillSemesterSelect();
    return;
  }
  try {
    const result = await window.api.switchSemester(id);
    courses = result.courses || [];
    config.semesterStart = result.semesterStart || '';
    applySemesterResult(result);
    fillSettingsForm();
    pending = false;
    renderCourses();
    await refreshInfo();
    fillWeekPicker();
    toast('已切换到该学期的课表');
  } catch (err) {
    toast(err && err.message ? err.message : '切换学期失败', 'error');
  }
}

async function createSemester() {
  const name = prompt('新学期名称（例如 2026-2027-1）：', `学期 ${semesters.list.length + 1}`);
  if (name === null) return;
  try {
    const result = await window.api.createSemester(name);
    courses = result.courses || [];
    config.semesterStart = '';
    applySemesterResult(result);
    fillSettingsForm();
    pending = false;
    renderCourses();
    await refreshInfo();
    fillWeekPicker();
    toast('已创建新学期，请导入该学期的课表');
    switchPage('import');
  } catch (err) {
    toast(err && err.message ? err.message : '创建学期失败', 'error');
  }
}

async function renameSemester() {
  const id = $('#semesterSelect').value;
  const current = semesters.list.find((item) => item.id === id);
  if (!id) return;
  const name = prompt('学期名称：', current ? current.name : '');
  if (!name) return;
  const result = await window.api.renameSemester(id, name);
  applySemesterResult(result);
}

async function deleteSemester() {
  const id = $('#semesterSelect').value;
  if (!id) return;
  const current = semesters.list.find((item) => item.id === id);
  if (!confirm(`确定删除「${current ? current.name : '该学期'}」及其课表？`)) return;
  const result = await window.api.deleteSemester(id);
  courses = result.courses || [];
  config.semesterStart = '';
  applySemesterResult(result);
  fillSettingsForm();
  renderCourses();
  await refreshInfo();
  fillWeekPicker();
  toast('已删除该学期');
}

/* ------------------------------------------------------------ 课程列表 */

const WEEK_ORDER = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
let currentWeek = null; // 当前教学周（未设置开学日期时为 null）
let weekFilter = 0; // 周课表筛选的周次，0 = 不限周次

/** 课程在指定教学周是否生效（与 src/schedule.js isActiveInWeek 逻辑一致） */
function isActiveInWeek(course, week) {
  if (!week || week <= 0) return true;
  const sw = Number(course.startWeek) || 1;
  const ew = Number(course.endWeek) || sw;
  if (week < sw || week > ew) return false;
  if (course.weekType === '单周') return week % 2 === 1;
  if (course.weekType === '双周') return week % 2 === 0;
  return true;
}

/** 列表编辑 / 周课表 两种视图切换 */
function switchCourseView(view) {
  document.querySelectorAll('.view-switch .seg').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.courseView === view);
  });
  $('#courseWeekView').classList.toggle('hidden', view !== 'week');
  $('#courseListView').classList.toggle('hidden', view !== 'list');
  if (view === 'week') {
    fillWeekPicker();
    renderWeekGrid();
  }
}

/** 周次下拉：默认选中本周，可切换到任意周或“全部周次” */
function fillWeekPicker() {
  const picker = $('#weekPicker');
  if (!picker) return;
  const maxWeek = courses.reduce((max, c) => Math.max(max, Number(c.endWeek) || 0, Number(c.startWeek) || 0), 20);
  const options = ['<option value="0">全部周次</option>'];
  for (let w = 1; w <= maxWeek; w++) {
    options.push(`<option value="${w}">第 ${w} 周${w === currentWeek ? '（本周）' : ''}</option>`);
  }
  picker.innerHTML = options.join('');
  picker.value = String(weekFilter || 0);
  updateWeekHint();
}

function updateWeekHint() {
  const hint = $('#weekPickerHint');
  if (!hint) return;
  if (!weekFilter) {
    hint.textContent = '当前显示全部周次的课程（含只在某几周上的课）。';
    return;
  }
  const count = courses.filter((c) => isActiveInWeek(c, weekFilter)).length;
  hint.textContent = `第 ${weekFilter} 周共 ${count} 节课${weekFilter === currentWeek ? '（本周）' : ''}。`;
}

/** 周课表：行 = 上课时段，列 = 周一 ~ 周日，按起始时间排序 */
function renderWeekGrid() {
  const grid = $('#weekGrid');
  if (!courses.length) {
    grid.innerHTML = '<div class="empty">暂无课程，请先在「课表导入」中解析或点击「新增课程」手动添加。</div>';
    return;
  }

  const slots = [];
  courses.forEach((course, index) => {
    // 只显示所选周次真正会上课的条目（周次区间 + 单双周）
    if (weekFilter && !isActiveInWeek(course, weekFilter)) return;
    const key = `${course.startTime || ''}-${course.endTime || ''}`;
    let slot = slots.find((s) => s.key === key);
    if (!slot) {
      slot = { key, startTime: course.startTime || '—', endTime: course.endTime || '—', cells: {} };
      slots.push(slot);
    }
    (slot.cells[course.weekday] = slot.cells[course.weekday] || []).push({ course, index });
  });

  if (!slots.length) {
    grid.innerHTML = `<div class="empty">第 ${weekFilter} 周没有课程。</div>`;
    return;
  }
  slots.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));

  let html = '<div class="week-cell head"></div>';
  html += WEEK_ORDER.map((day) => `<div class="week-cell head">${day}</div>`).join('');

  slots.forEach((slot) => {
    html += `<div class="week-cell time"><span class="t">${escapeHtml(slot.startTime)}</span><span>${escapeHtml(
      slot.endTime
    )}</span></div>`;
    WEEK_ORDER.forEach((day) => {
      const list = slot.cells[day] || [];
      if (!list.length) {
        html += '<div class="week-cell empty"></div>';
        return;
      }
      html += `<div class="week-cell">${list
        .map(
          ({ course, index }) => `
        <div class="wc-item" data-index="${index}" title="点击编辑">
          <div class="wc-name">${escapeHtml(course.courseName) || '未命名'}</div>
          <div class="wc-meta">${escapeHtml(course.location || '地点未填写')}</div>
          <div class="wc-weeks">${escapeHtml(String(course.startWeek || 1))}-${escapeHtml(
            String(course.endWeek || 1)
          )}周 ${escapeHtml(course.weekType || '')}</div>
        </div>`
        )
        .join('')}</div>`;
    });
  });

  grid.innerHTML = html;
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

function renderCourses() {
  const list = $('#courseList');
  $('#courseCount').textContent = `共 ${courses.length} 门课程`;
  $('#pendingTip').classList.toggle('hidden', !pending);

  renderWeekGrid(); // 周课表与列表保持同步

  if (!courses.length) {
    list.innerHTML = '<div class="empty">暂无课程，请先在「课表导入」中解析或点击「新增课程」手动添加。</div>';
    return;
  }

  list.innerHTML = courses
    .map(
      (course, index) => `
      <div class="course-row" data-index="${index}">
        <span class="name">${escapeHtml(course.courseName) || '<span class="muted">未命名</span>'}</span>
        <span class="${course.teacher ? '' : 'muted'}">${escapeHtml(course.teacher) || '—'}</span>
        <span class="${course.location ? '' : 'muted'}">${escapeHtml(course.location) || '—'}</span>
        <span>${escapeHtml(course.weekday) || '<span class="muted">—</span>'}</span>
        <span>${escapeHtml(course.startTime) || '—'}${course.endTime ? ' - ' + escapeHtml(course.endTime) : ''}</span>
        <span>${escapeHtml(course.startWeek) || '—'}-${escapeHtml(course.endWeek) || '—'} 周</span>
        <span>${escapeHtml(course.weekType) || '—'}</span>
        <span class="row-actions">
          <button class="btn btn-link" data-action="edit" data-index="${index}">编辑</button>
          <button class="btn btn-danger" data-action="delete" data-index="${index}">删除</button>
        </span>
      </div>`
    )
    .join('');
}

/* -------------------------------------------------------------- 编辑弹窗 */

function openCourseModal(index) {
  editingIndex = index;
  const course = index >= 0 ? courses[index] : null;
  $('#modalTitle').textContent = course ? '编辑课程' : '新增课程';
  $('#fCourseName').value = course ? course.courseName || '' : '';
  $('#fTeacher').value = course ? course.teacher || '' : '';
  $('#fLocation').value = course ? course.location || '' : '';
  $('#fWeekday').value = course && course.weekday ? course.weekday : '周一';
  $('#fStartTime').value = course ? course.startTime || '' : '';
  $('#fEndTime').value = course ? course.endTime || '' : '';
  $('#fStartWeek').value = course ? course.startWeek || 1 : 1;
  $('#fEndWeek').value = course ? course.endWeek || 16 : 16;
  $('#fWeekType').value = course && course.weekType ? course.weekType : '全周';
  $('#modalError').classList.add('hidden');
  $('#courseModal').classList.remove('hidden');
}

function closeCourseModal() {
  $('#courseModal').classList.add('hidden');
  editingIndex = -1;
}

function readModalCourse() {
  return {
    courseName: $('#fCourseName').value.trim(),
    teacher: $('#fTeacher').value.trim(),
    location: $('#fLocation').value.trim(),
    weekday: $('#fWeekday').value,
    startTime: $('#fStartTime').value,
    endTime: $('#fEndTime').value,
    startWeek: Number($('#fStartWeek').value),
    endWeek: Number($('#fEndWeek').value),
    weekType: $('#fWeekType').value
  };
}

function saveModalCourse() {
  const course = readModalCourse();
  const invalid = window.api.validateCourses([course]);
  if (invalid.length) {
    const errorBox = $('#modalError');
    errorBox.textContent = invalid[0].errors.join('；');
    errorBox.classList.remove('hidden');
    return;
  }
  if (editingIndex >= 0) courses[editingIndex] = course;
  else courses.push(course);
  pending = true;
  renderCourses();
  closeCourseModal();
  toast(editingIndex >= 0 ? '课程已更新，请记得保存课表' : '课程已添加，请记得保存课表');
}

async function saveAllCourses() {
  if (!courses.length && !pending) {
    toast('当前没有课程可保存');
    return;
  }
  try {
    await window.api.saveCourses(courses);
    pending = false;
    renderCourses();
    await refreshInfo();
    toast('课表已保存，小组件已同步更新', 'success');
  } catch (err) {
    toast(err && err.message ? err.message : '保存失败，请检查课程字段', 'error');
  }
}

/* ---------------------------------------------------------------- 绑定 */

function bindEvents() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action) return; // 动作型按钮（调整 / 显示小组件）由下方单独处理，不切换页面
      switchPage(btn.dataset.page);
    });
  });

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchImportTab(btn.dataset.tab));
  });

  $('#btnSaveSettings').addEventListener('click', () => saveSettings(false));
  $('#btnDisableNotify').addEventListener('click', async () => {
    $('#notifyEnabled').checked = false;
    await saveSettings(true);
    toast('已关闭全部课前提醒', 'success');
  });

  $('#btnParseHtml').addEventListener('click', runParseText);

  document.querySelectorAll('.view-switch .seg').forEach((btn) => {
    btn.addEventListener('click', () => switchCourseView(btn.dataset.courseView));
  });
  $('#weekGrid').addEventListener('click', (event) => {
    const item = event.target.closest('.wc-item');
    if (item) openCourseModal(Number(item.dataset.index));
  });
  $('#weekPicker').addEventListener('change', () => {
    weekFilter = Number($('#weekPicker').value) || 0;
    renderWeekGrid();
    updateWeekHint();
  });

  $('#semesterSelect').addEventListener('change', () => switchSemester($('#semesterSelect').value));
  $('#btnSemesterNew').addEventListener('click', createSemester);
  $('#btnSemesterRename').addEventListener('click', renameSemester);
  $('#btnSemesterDelete').addEventListener('click', deleteSemester);
  $('#widgetInteractive').addEventListener('change', async () => {
    const enabled = $('#widgetInteractive').checked;
    await window.api.setWidgetInteractive(enabled);
    toast(enabled ? '已开启鼠标交互：现在可以点击小组件切换日期、右键菜单' : '已关闭鼠标交互：小组件回到桌面层');
  });

  $('#btnOpenUrl').addEventListener('click', openUrlBrowser);
  $('#btnGrabBrowser').addEventListener('click', () => runParseUrl('browser'));
  $('#btnFetchUrl').addEventListener('click', () => runParseUrl('direct'));
  $('#btnDebugInput').addEventListener('click', async () => {
    const result = await window.api.openLastImportTables();
    if (result.empty) toast('还没有导入记录，请先导入一次');
    else if (result.ok) toast('已打开导入时识别到的表格：' + result.filePath);
    else toast('打开失败：' + (result.error || '未知错误'), 'error');
  });

  $('#scheduleUrl').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openUrlBrowser();
  });

  $('#btnAddCourse').addEventListener('click', () => openCourseModal(-1));
  $('#btnSaveCourses').addEventListener('click', saveAllCourses);
  $('#btnModalCancel').addEventListener('click', closeCourseModal);
  $('#btnModalSave').addEventListener('click', saveModalCourse);
  $('#courseModal').addEventListener('click', (event) => {
    if (event.target === $('#courseModal')) closeCourseModal();
  });

  $('#courseList').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const index = Number(button.dataset.index);
    if (button.dataset.action === 'edit') openCourseModal(index);
    else if (button.dataset.action === 'delete') {
      courses.splice(index, 1);
      pending = true;
      renderCourses();
      toast('已删除该课程，请记得保存课表');
    }
  });

  $('#btnExport').addEventListener('click', async () => {
    const result = await window.api.exportData();
    if (result && result.ok) toast('备份已导出：' + result.filePath, 'success');
  });

  $('#btnImport').addEventListener('click', async () => {
    try {
      const result = await window.api.importData();
      if (!result || !result.ok) return;
      courses = result.courses || [];
      config = await window.api.getConfig();
      fillSettingsForm();
      pending = false;
      renderCourses();
      await refreshInfo();
      toast('已从备份恢复课表', 'success');
    } catch (err) {
      toast(err && err.message ? err.message : '恢复失败', 'error');
    }
  });

  $('#themeMode').addEventListener('change', async () => {
    // 切换主题后立即生效（不必等点击“保存设置”）
    const themeMode = $('#themeMode').value;
    config = await window.api.saveConfig({ themeMode });
  });

  $('#mainUsesBg').addEventListener('change', async () => {
    // 切换“主窗口也使用该背景”后立即生效
    config = await window.api.saveConfig({ mainUsesBackground: $('#mainUsesBg').checked });
  });

  $('#btnPickBg').addEventListener('click', async () => {
    const result = await window.api.pickBackground();
    if (result && result.ok) {
      await refreshBackgroundUi();
      toast('背景已应用（主窗口是否使用取决于下方开关）', 'success');
    }
  });
  $('#btnClearBg').addEventListener('click', async () => {
    await window.api.clearBackground();
    await refreshBackgroundUi();
    toast('已清除自定义背景');
  });

  /* 首次引导向导 */
  $('#btnReopenWizard').addEventListener('click', openWizard);
  $('#wizardClose').addEventListener('click', finishWizard);
  $('#wizardPrev').addEventListener('click', () => {
    if (wizardStep > 0) goWizardStep(wizardStep - 1);
  });
  $('#wizardNext').addEventListener('click', () => {
    if (wizardStep >= 6) finishWizard();
    else goWizardStep(wizardStep + 1);
  });
  $('#wsPickBg').addEventListener('click', wizardPickBg);
  $('#wsClearBg').addEventListener('click', wizardClearBg);
  document.querySelectorAll('.wizard-option').forEach((el) => {
    el.addEventListener('click', () => {
      wizardImport = el.dataset.import;
      document.querySelectorAll('.wizard-option').forEach((o) => o.classList.toggle('selected', o === el));
    });
  });

  $('#navWidgetToggle').addEventListener('click', () => window.api.toggleWidget());
  $('#navWidgetEdit').addEventListener('click', () => {
    window.api.editWidget();
    toast('已进入调整模式：拖动小组件移动，右下角缩放，点击窗口外部或按 Esc 退出');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#courseModal').classList.contains('hidden')) closeCourseModal();
  });
}

/* ---------------------------------------------------------------- 启动 */

async function init() {
  applyTheme(await window.api.getTheme());
  window.api.onThemeChange(applyTheme);
  window.api.onBackgroundChange(applyBackground);

  config = await window.api.getConfig();
  courses = await window.api.getCourses();

  fillSettingsForm();
  await refreshBackgroundUi();
  renderCourses();
  bindEvents();
  await refreshInfo();
  if (currentWeek && currentWeek > 0) weekFilter = currentWeek; // 周课表默认显示本周
  await loadSemesters(); // 填充学期下拉，并遵守已在学期档案中的课表

  // 首次使用：自动弹出引导向导（之后可在「基础设置」中重新运行）
  if (!config.wizardDone) openWizard();
}

init();
