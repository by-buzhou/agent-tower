import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { runsRoot } from './sandbox.mjs';

export async function until(read, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(40);
  }
  throw Error(`等待超时：${label}`);
}

function edgeExecutable() {
  const exe = [process.env.AGENT_TOWER_EDGE_PATH, ...['Program Files (x86)', 'Program Files'].map(base =>
    path.join(process.env.SystemDrive || 'C:', base, 'Microsoft/Edge/Application/msedge.exe'))].find(p => p && fs.existsSync(p));
  if (!exe) throw Error('需要 Microsoft Edge。可通过 AGENT_TOWER_EDGE_PATH 指定可执行文件。');
  return exe;
}

// 同一测试进程只冷启动 1 个共享无头 Edge；每次 withEdge 用独立 BrowserContext 隔离存储。
let shared;
let launching;
let hooksInstalled = false;

const alive = proc => proc.exitCode === null && proc.signalCode === null;

// 'exit' 回调只能同步执行：同步杀进程树后再删 profile。
function disposeShared() {
  const current = shared;
  shared = undefined;
  // A stopped instance must never be handed out again by a stale resolved launch promise.
  launching = undefined;
  if (!current) return;
  const { proc, profile } = current;
  if (proc.pid && alive(proc)) {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    } else {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
    }
  }
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}

function installExitHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.once('exit', disposeShared);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.once(signal, () => { disposeShared(); process.exit(signal === 'SIGINT' ? 130 : 143); });
    } catch { /* 平台不支持该信号 */ }
  }
}

async function launchShared() {
  const exe = edgeExecutable();
  fs.mkdirSync(runsRoot(), { recursive: true });
  const profile = fs.mkdtempSync(path.join(runsRoot(), 'edge-shared-'));
  const proc = spawn(exe, ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-extensions', '--disable-sync', '--disable-component-update', '--disable-breakpad', '--disable-crash-reporter',
    '--disable-gpu', '--window-size=900,700', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'],
    { cwd: profile, stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
  // 共享浏览器不得拖住测试进程退出；退出时由 'exit' 钩子同步清理。
  proc.unref();
  const entry = { proc, profile };
  shared = entry;
  installExitHooks();
  let spawnError;
  proc.once('error', error => { spawnError = error; });
  try {
    const browserUrl = await until(() => {
      if (spawnError) throw spawnError;
      if (!alive(proc)) throw Error('Edge 提前退出，退出码 ' + proc.exitCode);
      const file = path.join(profile, 'DevToolsActivePort');
      if (!fs.existsSync(file)) return false;
      const [port, wsPath] = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      return Number(port) && wsPath ? { port: Number(port), url: `ws://127.0.0.1:${Number(port)}${wsPath}` } : false;
    }, 'Edge 调试端口');
    entry.port = browserUrl.port;
    entry.browserWs = browserUrl.url;
    return entry;
  } catch (error) {
    if (shared === entry) disposeShared();
    throw error;
  }
}

export async function startSharedEdge() {
  const pending = launching;
  if (pending) {
    const entry = await pending.catch(() => null);
    if (entry && shared === entry && alive(entry.proc)) return entry;
    // 共享实例启动失败或意外退出：丢弃并自动重建。
    if (launching === pending) {
      if (entry && shared === entry) disposeShared();
      launching = undefined;
    }
  }
  launching ??= launchShared();
  return launching;
}

export const stopSharedEdge = disposeShared;
// Test-only introspection of the shared-instance bookkeeping (no handles leaked).
export const sharedEdgeState = () => ({ shared: Boolean(shared), launching: Boolean(launching) });

async function sharedBrowser() {
  if (process.env.AGENT_TOWER_SHARED_EDGE_WS && Number(process.env.AGENT_TOWER_SHARED_EDGE_PORT)) {
    return { port: Number(process.env.AGENT_TOWER_SHARED_EDGE_PORT), browserWs: process.env.AGENT_TOWER_SHARED_EDGE_WS, inherited: true };
  }
  return startSharedEdge();
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
  let id = 0;
  const requests = new Map();
  socket.addEventListener('message', e => {
    const response = JSON.parse(e.data);
    requests.get(response.id)?.(response);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) { reject(Error('CDP socket closed: ' + method)); return; }
    const key = ++id;
    const timeout = setTimeout(() => { requests.delete(key); reject(Error('CDP timeout: ' + method)); }, 10000);
    requests.set(key, reply => {
      clearTimeout(timeout);
      requests.delete(key);
      if (reply.error) reject(Error(reply.error.message)); else resolve(reply.result);
    });
    socket.send(JSON.stringify({ id: key, method, params }));
  });
  const close = () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  };
  return { send, close };
}

// Use the installed Edge and Node's built-in CDP WebSocket, with no browser download.
// `dir` 保留为调用方签名兼容；共享 profile 统一建在 runsRoot() 下。
export async function withEdge(_dir, url, exercise) {
  let { port, browserWs, inherited } = await sharedBrowser();
  let browser;
  try {
    browser = await connectCdp(browserWs);
  } catch (err) {
    if (!inherited) throw err;
    delete process.env.AGENT_TOWER_SHARED_EDGE_WS;
    ({ port, browserWs } = await startSharedEdge());
    browser = await connectCdp(browserWs);
  }
  let browserContextId;
  let targetId;
  let page;
  try {
    ({ browserContextId } = await browser.send('Target.createBrowserContext', { disposeOnDetach: true }));
    ({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId, width: 900, height: 700 }));
    page = await connectCdp(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    // The layout fixture uses local assets; a remote font must not hold iframe.onload open.
    await page.send('Network.enable');
    await page.send('Network.setBlockedURLs', { urls: ['*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*'] });
    await page.send('Page.navigate', { url });
    const evaluate = async expression => {
      const reply = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
      return reply.result.value;
    };
    await exercise(evaluate, page.send);
  } finally {
    page?.close();
    // 只关闭本次页面与上下文，绝不 Browser.close 共享浏览器。
    if (targetId) await browser.send('Target.closeTarget', { targetId }).catch(() => {});
    if (browserContextId) await browser.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    browser.close();
  }
}
