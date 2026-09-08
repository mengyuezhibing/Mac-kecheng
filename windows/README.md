# Windows 简易版（windows/ 目录）

本目录是 Windows 简易版，与 macOS 版（项目根目录的 `main.js`）**共用同一份业务代码**：

- 复用（**未做任何修改**）：上级目录的 `src/`（课表解析与计算）、`renderer/`（界面）、`preload-main.js`、`preload-widget.js`
- 本目录新增：`main-win.js`（Windows 主进程）、`assets/icon.ico` 与 `assets/icon.png`（由 macOS 的 `assets/icon.icns` 提取，图案与 Mac 完全一致）、`assets/widget-bottom.ps1`（小组件置底脚本）、`electron-builder-win.json`（Windows 打包配置）

Mac 版的所有文件都留在项目根目录不动，Windows 版单独放在 `windows/` 下分类管理，
因此 macOS 上的 `npm start` 行为**完全不受影响**。

## 一、在 Windows 上运行

前置：安装 Node.js 18 及以上（https://nodejs.org）

在**项目根目录**执行：

```bat
npm install
npm run start:win
```

> `start:win` 实际执行 `electron windows/main-win.js`；macOS 版入口仍是根目录的 `main.js`（`npm start`）。

## 二、打包成安装包 / 免安装版

建议在 **Windows 电脑**上打包（在 macOS 上打 Windows 包需要额外安装 Wine）：

```bat
npm run dist:win
```

产物：

```
dist/
├── 简易课程表-1.0.0-setup.exe      # NSIS 安装版（可选安装位置、建桌面快捷方式）
└── 简易课程表-1.0.0-portable.exe   # 免安装版（双击即用）
```

打包入口由 `windows/electron-builder-win.json` 的 `extraMetadata.main` 指定为 `windows/main-win.js`，
不会影响 macOS 打包（`npm run dist` 依然用 `main.js` 打 dmg）。

## 三、与 macOS 版的功能差异（平台限制导致）

| 能力 | macOS | Windows 简易版 |
| --- | --- | --- |
| 主窗口 | 无边框隐形标题栏 `hiddenInset` | 标准标题栏（菜单栏自动隐藏，按 `Alt` 可唤出） |
| 桌面小组件 | 真正沉到桌面图标之下（`type:'desktop'`） | 无边框窗口 + 调用 Windows API 压到 **Z 序最底层**，不遮挡其它窗口（Windows 没有桌面层级概念） |
| 小组件鼠标交互 | 切换桌面层 / 普通层 | 切换是否接收鼠标事件（`focusable`） |
| 托盘 / 应用图标 | `assets/icon.icns` | `windows/assets/icon.png`、`icon.ico`（从 `icon.icns` 提取，与 Mac 同款图案） |
| 单击托盘图标 | 显示 / 隐藏小组件 | 打开主窗口（符合 Windows 习惯） |
| 开机自启 | `openAtLogin` + `openAsHidden` | 仅 `openAtLogin`（写入注册表 Run 项，Windows 不支持隐藏启动） |
| 关闭主窗口 | 常驻托盘不退出 | 同样常驻托盘（Windows 默认会退出，这里已保持一致） |
| 课前通知 | 系统通知 | 系统通知（Win10+，需开启通知） |

**功能本身与 macOS 版完全一致**：课表导入解析、今日 / 周历视图、学期档案、农历、深浅色主题、自定义背景、课前提醒、数据导出导入——因为共用同一套 `src/` 与 `renderer/`。

界面里残留的 macOS 文案（如「Mac简易课程表」、`~/Library/...` 路径）会在页面加载后**自动替换**为 Windows 说法（仅改文本节点的文字，不破坏任何交互）。

## 四、数据存放位置

- 开发运行（`npm run start:win`）：项目目录下的 `userdata/`
- 安装后的程序：`%APPDATA%\简易课程表\`（即 `C:\Users\<用户名>\AppData\Roaming\...`）

两种情况数据都只存在本机，不联网、不上传。

## 五、已知限制

1. 小组件置底依赖 Windows API（`SetWindowPos(HWND_BOTTOM)`），由 `windows/assets/widget-bottom.ps1` 调用；若系统禁用 PowerShell 脚本会静默降级为普通窗口（仍不置顶，其它窗口激活后依然会盖住它）。调整位置 / 大小时会临时置顶以方便操作，「完成调整」后自动回到置底状态。
2. 打包需要 Windows 环境（或配置 Wine）。
3. 图标 `windows/assets/icon.ico`（16/32/48/64/128/256 全尺寸）与 `icon.png` 均从 macOS 的 `assets/icon.icns` 提取而来，与 Mac 版图案一致；要换成自己的图标，替换这两个文件即可（加载顺序：`icon.png` → `icon.ico` → 上级 `assets/icon.icns`）。
