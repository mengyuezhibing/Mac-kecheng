'use strict';
/**
 * 轻量更新器（Mac / Windows 通用，不依赖代码签名）
 *
 * 工作方式：
 *   - 检测：调用 GitHub API 读取最新 Release（public repo 匿名即可，仅低频调用）
 *   - 下载：发现新版本后自动在后台下载对应平台的安装包
 *     （macOS → MacKecheng-*-arm64.dmg；Windows → *-setup.exe）
 *   - 安装引导：下载完成后打开安装包
 *       · macOS 未签名无法静默替换 .app，故打开 dmg 让用户拖拽（一次操作）
 *       · Windows 的 setup.exe 会自动替换已安装程序
 *
 * 注意：因应用未签名，无法做 macOS 原生「增量 + 静默安装」（那需要 electron-updater + Apple 签名公证），
 * 这里下载的是完整更新包，但下载过程走 GitHub CDN 真实 IP 并跟随重定向，未签名环境也能稳定拉取。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { app, shell, Notification } = require('electron');

const REPO_OWNER = 'mengyuezhibing';
const REPO_NAME = 'Mac-kecheng';
const API_HOST = '20.205.243.168'; // api.github.com 真实 IP（本机 hosts 已指向，避免解析异常）
// GitHub CDN 固定 IP 段，用于直连 objects.githubusercontent.com（绕过本机 hosts 对其 127.0.0.1 的劫持）
const OBJ_IPS = ['185.199.108.133', '185.199.109.133', '185.199.110.133', '185.199.111.133'];

let checking = false;

function apiGet(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: API_HOST,
        port: 443,
        path: apiPath,
        method: 'GET',
        headers: { Host: 'api.github.com', 'User-Agent': 'MacKecheng-Updater' }
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          } else {
            reject(new Error('GitHub API ' + res.statusCode));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** 按当前平台挑出要下载的附件 */
function pickAsset(release) {
  const assets = release.assets || [];
  if (process.platform === 'darwin') {
    return (
      assets.find((a) => /^MacKecheng-.*-arm64\.dmg$/i.test(a.name)) ||
      assets.find((a) => /^MacKecheng-.*-arm64-mac\.zip$/i.test(a.name))
    );
  }
  if (process.platform === 'win32') {
    return (
      assets.find((a) => /setup\.exe$/i.test(a.name)) ||
      assets.find((a) => /portable\.exe$/i.test(a.name))
    );
  }
  return null;
}

function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 跟随重定向下载；对 objects/github CDN 强制走真实 IP，绕过本机 hosts 劫持 */
function downloadWithRedirect(urlObj, dest, depth, onProgress, onDone, onErr) {
  if (depth > 6) return onErr(new Error('重定向次数过多'));
  const host = urlObj.hostname;
  let hostIp = null;
  if (host === 'api.github.com') hostIp = API_HOST;
  else if (host === 'objects.githubusercontent.com') hostIp = OBJ_IPS[Math.floor(Math.random() * OBJ_IPS.length)];
  // 其它域名（如 github.com）走系统 DNS，不强制 IP
  const req = https.request(
    {
      host: hostIp || host,
      port: 443,
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'GET',
      headers: { Host: host, 'User-Agent': 'MacKecheng-Updater' }
    },
    (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          return downloadWithRedirect(new URL(res.headers.location), dest, depth + 1, onProgress, onDone, onErr);
        } catch (e) {
          return onErr(e);
        }
      }
      if (res.statusCode !== 200) return onErr(new Error('下载失败 HTTP ' + res.statusCode));
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        received += c.length;
        if (onProgress && total) onProgress(received, total);
      });
      res.on('end', () => onDone(dest));
      res.pipe(out);
    }
  );
  req.on('error', onErr);
  req.end();
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch (e) {
    /* 通知不可用则忽略 */
  }
}

/**
 * 检查更新；发现新版本会自动在后台下载并打开安装引导。
 * @param {object} opts { manual?: boolean, onStatus?: (msg:string)=>void }
 */
async function checkForUpdates(opts = {}) {
  if (checking) return;
  checking = true;
  const onStatus = opts.onStatus || (() => {});
  try {
    onStatus('正在检查更新…');
    const release = await apiGet(`/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`);
    const latest = String(release.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();
    if (!latest) {
      onStatus('未获取到版本信息');
      return;
    }
    if (cmpVer(latest, current) <= 0) {
      onStatus(opts.manual ? `已是最新版本 (v${current})` : '已是最新版本');
      if (opts.manual) notify('课程表', `当前已是最新版本 v${current}`);
      return;
    }
    const asset = pickAsset(release);
    if (!asset) {
      onStatus(`v${latest} 暂无可用的更新包`);
      return;
    }
    onStatus(`发现新版本 v${latest}，开始下载更新包…`);
    const ext = path.extname(asset.name);
    const tmp = path.join(app.getPath('temp'), `MacKecheng-update-${latest}${ext}`);
    await new Promise((resolve, reject) => {
      downloadWithRedirect(
        new URL(asset.browser_download_url),
        tmp,
        0,
        (recv, total) => {
          if (total) onStatus(`下载更新包 ${Math.round((recv / total) * 100)}%`);
        },
        () => resolve(),
        reject
      );
    });
    onStatus(`v${latest} 已下载完成，正在打开安装…`);
    notify('课程表更新', `v${latest} 已下载完成，点击打开安装`);
    shell.openPath(tmp);
  } catch (e) {
    onStatus('检查更新失败：' + (e && e.message ? e.message : e));
  } finally {
    checking = false;
  }
}

module.exports = { checkForUpdates };
