'use strict';
/** 小组件窗口预加载：接收主进程推送的课表数据与主题变化 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetApi', {
  onData: (callback) => ipcRenderer.on('widget:data', (_event, payload) => callback(payload)),
  onThemeChange: (callback) => ipcRenderer.on('theme:update', (_event, theme) => callback(theme)),
  onEditModeChange: (callback) => ipcRenderer.on('widget:edit-mode', (_event, editable) => callback(editable)),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  showContextMenu: () => ipcRenderer.send('widget:context-menu'),
  exitEditMode: () => ipcRenderer.send('widget:exit-edit'),
  resizeBy: (dx, dy) => ipcRenderer.send('widget:resize-by', dx, dy),
  setDayOffset: (offset) => ipcRenderer.invoke('widget:set-day', offset),
  refresh: () => ipcRenderer.send('widget:refresh')
});
