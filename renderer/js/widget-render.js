/* 小组件渲染进程：今日课程视图 / 周历视图，数据由主进程推送（不做后台轮询） */
'use strict';

const $ = (selector) => document.querySelector(selector);
let lastPayload = null;

/**
 * 自适应：以 320x400 为基准计算缩放系数，并按尺寸分档（s / m / l）。
 * 所有字号间距都用 --w-scale 计算，因此拖动缩放手柄时内容会实时等比变化、不会溢出。
 */
function applyScale() {
  const width = window.innerWidth || 320;
  const height = window.innerHeight || 400;
  // 用宽高比的几何平均决定缩放：横向拉宽或竖向拉高都能让字明显变大，不再被另一维度死压
  const base = Math.sqrt((width / 300) * (height / 360));
  const scale = Math.max(0.5, Math.min(base, 4));
  document.documentElement.style.setProperty('--w-scale', scale.toFixed(3));
  document.documentElement.dataset.size =
    width < 250 || height < 300 ? 's' : width >= 420 && height >= 460 ? 'l' : 'm';
}

window.addEventListener('resize', applyScale);

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

/** 当前查看的日期（0 = 今天，1 = 明天，2 = 后天） */
let daysCache = [];
let dayOffset = 0;

function maxOffset() {
  return daysCache.length ? daysCache[daysCache.length - 1].offset : 2;
}

function currentDay() {
  return daysCache.find((day) => day.offset === dayOffset) || daysCache[0] || null;
}

/** 切换查看的日期，并同步给主进程（托盘菜单、重启后都保持一致） */
function changeDay(delta) {
  const next = Math.min(maxOffset(), Math.max(0, dayOffset + delta));
  if (next === dayOffset) return;
  dayOffset = next;
  renderToday();
  if (window.widgetApi && window.widgetApi.setDayOffset) window.widgetApi.setDayOffset(next);
}

function renderToday() {
  const day = currentDay();
  if (!day) return;

  $('#todayDate').textContent = day.dateText || '';
  $('#todayLunar').textContent = day.lunarText || '';
  $('#dayLabel').textContent = day.label || '今天';
  $('#dayPrev').disabled = dayOffset <= 0;
  $('#dayNext').disabled = dayOffset >= maxOffset();

  const weekNumber = day.weekNumber === undefined ? null : day.weekNumber;
  $('#todayWeek').textContent =
    weekNumber === null ? '未设置开学日期' : weekNumber === 0 ? '尚未开学' : `第 ${weekNumber} 教学周`;

  const list = day.courses || [];
  if (!list.length) {
    $('#todayCourses').innerHTML = `<div class="empty-tip">${day.label || '今日'}暂无课程</div>`;
    return;
  }

  $('#todayCourses').innerHTML = list
    .map(
      (course) => `
      <div class="course-item">
        <div class="time">
          <span class="start">${escapeHtml(course.startTime)}</span>
          <span>${escapeHtml(course.endTime)}</span>
        </div>
        <div class="info">
          <div class="name">${escapeHtml(course.courseName)}</div>
          <div class="meta">${escapeHtml(course.location || '地点未填写')}</div>
          ${course.teacher ? `<div class="teacher">${escapeHtml(course.teacher)}</div>` : ''}
        </div>
      </div>`
    )
    .join('');
}

function renderWeek(data) {
  const week = data && data.week;
  const days = (data && data.days) || [];
  $('#weekTitle').textContent =
    week === null ? '未设置开学日期' : week === 0 ? '尚未开学' : `第 ${week} 教学周`;
  if (!days.length) {
    $('#weekCols').innerHTML = '<div class="empty-tip">本周暂无课程</div>';
    return;
  }
  $('#weekCols').innerHTML = days
    .map((day) => {
      const list = day.courses || [];
      const courses = list.length
        ? list
            .map(
              (c) => `
            <div class="wc-course">
              <span class="wc-time">${escapeHtml(c.startTime)}-${escapeHtml(c.endTime)}</span>
              <span class="wc-name">${escapeHtml(c.courseName)}</span>
              ${c.location ? `<span class="wc-loc">${escapeHtml(c.location)}</span>` : ''}
            </div>`
            )
            .join('')
        : '<span class="wc-empty">—</span>';
      return `
      <div class="week-col${day.isToday ? ' today' : ''}">
        <div class="wc-head">${escapeHtml(day.label)}<span class="wc-date">${escapeHtml(day.dateText)}</span></div>
        <div class="wc-list">${courses}</div>
      </div>`;
    })
    .join('');
}

function applyBackground(url) {
  const widget = $('#widget');
  if (url) {
    widget.style.setProperty('--w-bg-image', `url("${url}")`);
    widget.classList.add('has-bg');
  } else {
    widget.style.removeProperty('--w-bg-image');
    widget.classList.remove('has-bg');
  }
}

function render(payload) {
  if (!payload) return;
  lastPayload = payload;

  applyBackground(payload.backgroundUrl || '');

  const isWeek = payload.mode === 'week';
  $('#viewToday').classList.toggle('active', !isWeek);
  $('#viewWeek').classList.toggle('active', isWeek);

  // 今天 / 明天 / 后天：主进程一次推送，切换在本地完成
  daysCache = payload.days && payload.days.length
    ? payload.days
    : [
        {
          offset: 0,
          label: '今天',
          dateText: (payload.today || {}).dateText,
          lunarText: (payload.today || {}).lunarText,
          weekNumber: payload.weekNumber,
          courses: (payload.today || {}).courses || []
        }
      ];
  if (typeof payload.dayOffset === 'number') dayOffset = payload.dayOffset;

  if (isWeek) renderWeek(payload.week || {});
  else renderToday();
}

function applyTheme(theme) {
  document.body.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

/* 编辑模式：主进程切换窗口层级时同步提示；编辑中右键不弹菜单，Esc 也可完成调整 */
let editMode = false;
window.widgetApi.onEditModeChange((on) => {
  editMode = !!on;
  document.body.classList.toggle('edit-mode', editMode);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && editMode) window.widgetApi.exitEditMode();
});

/* 右键菜单：切换显示模式 / 刷新课表数据 / 关闭小组件 */
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (!editMode) window.widgetApi.showContextMenu();
});

/* 右下角手柄拖拽缩放小组件整体尺寸 */
(function bindResize() {
  const grip = $('#resizeGrip');
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  grip.addEventListener('mousedown', (event) => {
    dragging = true;
    lastX = event.screenX;
    lastY = event.screenY;
    event.preventDefault();
  });

  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const dx = event.screenX - lastX;
    const dy = event.screenY - lastY;
    if (!dx && !dy) return;
    lastX = event.screenX;
    lastY = event.screenY;
    window.widgetApi.resizeBy(dx, dy);
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
  });
})();

$('#dayPrev').addEventListener('click', () => changeDay(-1));
$('#dayNext').addEventListener('click', () => changeDay(1));

window.widgetApi.onData(render);
window.widgetApi.onThemeChange(applyTheme);

window.widgetApi.getTheme().then(applyTheme);

applyScale(); // 首次进入即按当前窗口尺寸定档

// 首次渲染前先兜底显示今日视图
if (!lastPayload) $('#viewToday').classList.add('active');
