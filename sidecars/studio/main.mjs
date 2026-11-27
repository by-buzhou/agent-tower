/**
 * @fileoverview AgentTower v0.2.0 — Antigravity Sidecar Web UI 宿主入口 (`main.mjs`)。
 *
 * 运行环境：由 Antigravity Language Server 通过内置 `agy-node.cmd` 启动，自动挂载
 * `--import=.../sidecar_sdk/register_loader.js`。本文件是插件中唯一导入 `sidecar_sdk` 的薄壳层：
 * 1. 免缓存服务 `/`, `/index.html`, `/styles.css`, `/app.js` 经典脚本与全部 `/ui/*.js` 源模块（统一白名单解析器）；
 * 2. 将宿主的 `appDataDir`、`agentApiExe`、`projectId`、`conversationId` 自动桥接透传给常驻 Core Daemon，
 *    驱动 `agy-native` 零子进程实时纳管当前宿主对话及 `invoke_subagent` 原生子代理；
 * 3. 在 `await app.run()` 之后使用带 **1500ms 硬超时保护的异步 `execFile`** 覆盖 `SidecarApp` 默认的
 *    同步 `execFileSync` (`/_sidecar/get-conversation-metadata` / `send-message`)，
 *    彻底根除主会话繁忙时 `preload.js` 同步阻塞导致面板无限转圈的问题；
 *    `/_sidecar/new-conversation` 一律 403 拒绝（严禁在宿主左侧乱开顶层新会话）；
 * 4. 在底层 `http.Server` 上保留 `/api/stream` SSE 通道供纯外部浏览器模式使用；
 * 5. v0.2.6：`/api/health` 独立秒回 Sidecar 自身存活态（不阻塞等待 Daemon），响应完成钩子做脱敏限频诊断与
 *    带 5 分钟冷却锁的「连续带 token 401」优雅自退（交由 `sidecar.json` `restart_policy: "always"` 重拉刷新凭据）。
 */

import { captureNoWindow, safeEngineError } from '../../core/engines/proc-utils.mjs';
import { frontendAssetHash, listStudioAssetPaths, resolveStudioAsset, studioRequestPath } from '../../core/frontend-assets.mjs';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  CLIENT_STARTED_AT,
  createSidecarRequestMonitor,
  daemonGet,
  daemonRpc,
  ensureDaemon,
  openDaemonStream,
  peekDaemonHealth,
  PLUGIN_VERSION,
} from '../../core/daemon-client.mjs';

/** 本 Sidecar 进程启动时间戳（与 X-Host-Context.clientStartedAt 同源）。 */
const SIDECAR_STARTED_AT = CLIENT_STARTED_AT;
const PLUGIN_MANIFEST_PATH = fileURLToPath(new URL('../../plugin.json', import.meta.url));

/** 磁盘上当前 plugin.json 版本（热切换后可能领先于本长寿进程内存中的 PLUGIN_VERSION）；读取失败返回空串。 */
function readDiskPluginVersion() {
  try {
    const parsed = JSON.parse(readFileSync(PLUGIN_MANIFEST_PATH, 'utf8'));
    return typeof parsed?.version === 'string' ? parsed.version.trim() : '';
  } catch {
    return '';
  }
}

function isPluginVersionDrifted() {
  const diskVersion = readDiskPluginVersion();
  return Boolean(diskVersion && diskVersion !== PLUGIN_VERSION);
}


const NO_STORE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
});

const app = new SidecarApp();

/**
 * 解析当前 Sidecar 宿主所属的 AppData 根目录（如 `~/.gemini/antigravity`），
 * 供 Core Daemon 的 `agy-native` 模块定位 `brain/<conversationId>/.system_generated/logs/transcript.jsonl`。
 */
function resolveHostAppDataDir() {
  const explicit = String(process.env.ANTIGRAVITY_APP_DATA_DIR || '').trim();
  if (explicit) return resolve(explicit);

  const execDataDir = String(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || '').trim();
  if (execDataDir) {
    let cur = resolve(execDataDir);
    for (let depth = 0; depth < 8; depth++) {
      if (basename(cur).toLowerCase() === 'sidecar_data') {
        return dirname(cur);
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return '';
}

const HOST_APP_DATA_DIR = resolveHostAppDataDir();
const HOST_AGENTAPI_EXE = String(process.env.ANTIGRAVITY_AGENTAPI_EXE || '').trim();

// 后台异步预热常驻 Core Daemon（不阻塞 HTTP 端口监听）
ensureDaemon().catch((err) => {
  console.error(`[agent-tower/studio] daemon prewarm warning: ${err?.message || err}`);
});

// ---------------------------------------------------------------------------
// 异步非阻塞 AgentAPI 执行器（替代 sidecar_sdk 中无超时的同步 execFileSync）
// ---------------------------------------------------------------------------

const metadataCache = new Map(); // conversationId -> { expiresAt: number, data: object }
const METADATA_CACHE_TTL_MS = 30_000;

async function execAgentApiAsync(args, { projectId, timeoutMs = 1500, fallbackEmptyOnError = false } = {}) {
  const env = { ...process.env };
  if (projectId) {
    env.ANTIGRAVITY_PROJECT_ID = String(projectId);
  }

  const exe = HOST_AGENTAPI_EXE;
  const file = exe || 'agentapi';
  const execArgs = exe ? ['agentapi', ...args] : args;

  try {
    const { stdout } = await captureNoWindow(file, execArgs, { env, timeoutMs, maxBuffer: 2 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (err) {
    if (fallbackEmptyOnError) return {};
    throw new Error(safeEngineError(err));
  }
}

function buildQueryString(paramsObj) {
  if (!paramsObj || typeof paramsObj !== 'object') return '';
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(paramsObj)) {
    if (v === undefined || v === null || v === '' || k.toLowerCase() === 'token') continue;
    search.set(k, String(v));
  }
  return search.toString();
}

function enrichWithHostEnv(inputObj = {}, { allowProcessConversationFallback = true } = {}) {
  const out = inputObj && typeof inputObj === 'object' && !Array.isArray(inputObj) ? { ...inputObj } : {};
  // 严禁在全局共享 Sidecar 下将首个启动窗口固化的 process.env.ANTIGRAVITY_CONVERSATION_ID
  // 强行填充给未传 conversationId 的请求（防跨窗口/跨项目串号！）
  if (allowProcessConversationFallback && !out.conversationId && !out.parentConversationId && app.config.conversationId) {
    out.conversationId = app.config.conversationId;
  }
  if (!out.appDataDir && HOST_APP_DATA_DIR) {
    out.appDataDir = HOST_APP_DATA_DIR;
  }
  if (!out.agentApiExe && HOST_AGENTAPI_EXE) {
    out.agentApiExe = HOST_AGENTAPI_EXE;
  }
  if (!out.projectId && app.config.projectId) {
    out.projectId = app.config.projectId;
  }
  return out;
}

function unwrapDaemonReadPayload(raw) {
  if (raw && typeof raw === 'object' && 'ok' in raw) {
    if (raw.ok === false && raw.error) {
      throw new Error(String(raw.error));
    }
    if (raw.ok === true && raw.result !== undefined && !('providers' in raw) && !('events' in raw)) {
      return raw.result;
    }
  }
  return raw;
}

// Register the exact whitelist known at startup; the HTTP listener handles new modules.
function serveResolvedStudioAsset(route) {
  const asset = resolveStudioAsset(route);
  if (!asset) return new Response('Not Found', { status: 404, headers: NO_STORE_HEADERS });
  return new Response(asset.content, { status: 200, contentType: asset.contentType, headers: NO_STORE_HEADERS });
}
const REGISTERED_ASSET_ROUTES = new Set(listStudioAssetPaths());
for (const route of REGISTERED_ASSET_ROUTES) {
  app.page(route, () => serveResolvedStudioAsset(route));
}
app.page('/favicon.ico', () => new Response('', { status: 204, headers: NO_STORE_HEADERS }));

// ---------------------------------------------------------------------------
// 2. 只读聚合查询与非重叠增量轮询路由（GET）
//    注意：SidecarApp.api 的 handler 仅接收 (data) 单参数！
// ---------------------------------------------------------------------------

app.api(
  '/api/bootstrap',
  async (data) => {
    const query = enrichWithHostEnv(data, { allowProcessConversationFallback: false });
    const qs = buildQueryString(query);
    const payload = await daemonGet(qs ? `/api/bootstrap?${qs}` : '/api/bootstrap');
    return new Response(JSON.stringify({ ...unwrapDaemonReadPayload(payload), frontendAssetHash: frontendAssetHash() }), {
      status: 200,
      contentType: 'application/json; charset=utf-8',
      headers: NO_STORE_HEADERS,
    });
  },
  'GET'
);

app.api(
  '/api/events',
  async (data) => {
    const query = enrichWithHostEnv(data, { allowProcessConversationFallback: false });
    const qs = buildQueryString(query);
    const payload = await daemonGet(qs ? `/api/events?${qs}` : '/api/events');
    return new Response(JSON.stringify({ ...unwrapDaemonReadPayload(payload), frontendAssetHash: frontendAssetHash() }), {
      status: 200,
      contentType: 'application/json; charset=utf-8',
      headers: NO_STORE_HEADERS,
    });
  },
  'GET'
);

// v0.2.6 C06①：健康态只反映 Sidecar 自身存活，Daemon 仅做 ≤300ms 非阻塞快照（未起 / 繁忙时 reachable: false 仍秒回 200）。
app.api(
  '/api/health',
  async () => {
    const diskVersion = readDiskPluginVersion();
    const daemon = await peekDaemonHealth({ timeoutMs: 300 });
    return new Response(
      JSON.stringify({
        ok: true,
        version: PLUGIN_VERSION,
        diskVersion,
        versionDrifted: Boolean(diskVersion && diskVersion !== PLUGIN_VERSION),
        startedAt: SIDECAR_STARTED_AT,
        frontendAssetHash: frontendAssetHash(),
        sidecar: 'agent-tower/studio',
        conversationId: app.config.conversationId || '',
        projectId: app.config.projectId || '',
        appDataDir: HOST_APP_DATA_DIR,
        hasAgentApiExe: Boolean(HOST_AGENTAPI_EXE),
        daemon,
      }),
      {
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: NO_STORE_HEADERS,
      }
    );
  },
  'GET'
);

// ---------------------------------------------------------------------------
// 3. 受保护的控制平面 RPC 路由（POST，由 SidecarApp 强制校验 X-Sidecar-Token）
// ---------------------------------------------------------------------------

app.api(
  '/api/rpc',
  async (data) => {
    const method = typeof data?.method === 'string' ? data.method.trim() : '';
    if (!method) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing required RPC "method" string' }),
        {
          status: 400,
          contentType: 'application/json; charset=utf-8',
          headers: NO_STORE_HEADERS,
        }
      );
    }

    const enrichedParams = enrichWithHostEnv(data?.params, { allowProcessConversationFallback: false });

    try {
      const rawOut = await daemonRpc(method, enrichedParams);
      if (
        rawOut &&
        typeof rawOut === 'object' &&
        'ok' in rawOut &&
        ('result' in rawOut || 'error' in rawOut)
      ) {
        const envelope = rawOut.ok
          ? { ok: true, result: rawOut.result }
          : { ok: false, error: String(rawOut.error || 'Daemon RPC failed'), ...(rawOut.code ? { code: rawOut.code } : {}), ...(rawOut.details !== undefined ? { details: rawOut.details } : {}) };
        return new Response(JSON.stringify(envelope), {
          status: 200,
          contentType: 'application/json; charset=utf-8',
          headers: NO_STORE_HEADERS,
        });
      }

      return new Response(JSON.stringify({ ok: true, result: rawOut }), {
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: NO_STORE_HEADERS,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: err?.message || String(err), ...(err?.code ? { code: err.code } : {}), ...(err?.details !== undefined ? { details: err.details } : {}) }),
        {
          status: 200,
          contentType: 'application/json; charset=utf-8',
          headers: NO_STORE_HEADERS,
        }
      );
    }
  },
  'POST'
);

// ---------------------------------------------------------------------------
// 4. 启动 SidecarApp，覆盖同步阻塞内置路由，并挂载外部浏览器 SSE 通道
// ---------------------------------------------------------------------------

function registerNonBlockingBuiltinOverrides() {
  // 覆盖 SidecarApp.run() 注册的同步 execFileSync 路由，彻底杜绝事件循环阻塞！
  app.api(
    '/_sidecar/get-conversation-metadata',
    async (data) => {
      const convId = String(data?.conversationId || app.config.conversationId || '').trim();
      if (!convId) return {};

      const cached = metadataCache.get(convId);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.data;
      }

      const result = await execAgentApiAsync(['get-conversation-metadata', convId], {
        timeoutMs: 1500,
        fallbackEmptyOnError: true,
      });
      if (result && typeof result === 'object' && Object.keys(result).length > 0) {
        if (metadataCache.size > 128) metadataCache.clear();
        metadataCache.set(convId, {
          expiresAt: Date.now() + METADATA_CACHE_TTL_MS,
          data: result,
        });
      }
      return result || {};
    },
    'POST'
  );

  app.api(
    '/_sidecar/send-message',
    async (data) => {
      const convId = String(data?.conversationId || app.config.conversationId || '').trim();
      const message = String(data?.message || '');
      if (!convId || !message) {
        return { error: 'conversationId and message are required' };
      }
      const args = ['send-message'];
      if (data?.title) args.push('--title', String(data.title));
      args.push(convId, message);
      try {
        return await execAgentApiAsync(args, {
          projectId: data?.projectId || app.config.projectId,
          timeoutMs: 8000,
          fallbackEmptyOnError: false,
        });
      } catch (err) {
        return { error: err?.message || String(err) };
      }
    },
    'POST'
  );

  // v0.2.6 C07②：严禁经 Sidecar 调用 agentapi 另开宿主顶层会话，直接结构化拒绝。
  app.api(
    '/_sidecar/new-conversation',
    async () => new Response(
      JSON.stringify({ ok: false, code: 'HOST_TOPLEVEL_FORBIDDEN', error: '禁止通过 Sidecar 新建宿主顶层会话' }),
      { status: 403, contentType: 'application/json; charset=utf-8', headers: NO_STORE_HEADERS }
    ),
    'POST'
  );
}

// v0.2.6 C07②：响应完成钩子的脱敏限频诊断 + 冷却自退护栏（AGENT_TOWER_DISABLE_SIDECAR_SELF_EXIT=1 可关闭自退）。
const requestMonitor = createSidecarRequestMonitor({
  startedAt: SIDECAR_STARTED_AT,
  log: (line) => console.warn(line),
  exit: (code) => process.exit(code),
  disabled: process.env.AGENT_TOWER_DISABLE_SIDECAR_SELF_EXIT === '1',
  isVersionDrifted: isPluginVersionDrifted,
});

function attachResponseDiagnostics(req, res) {
  const begunAt = Date.now();
  const url = req.url;
  const hadSidecarToken = Boolean(req.headers?.['x-sidecar-token']);
  res.once('finish', () => {
    try {
      requestMonitor.observe({ url, status: res.statusCode, hadSidecarToken, durationMs: Date.now() - begunAt });
    } catch { /* Diagnostics must never affect request handling. */ }
  });
}

function attachSseStreamRoute(server) {
  const existingListeners = server.listeners('request');
  server.removeAllListeners('request');

  server.on('request', (req, res) => {
    attachResponseDiagnostics(req, res);
    if (serveUnregisteredUiModule(req, res)) return;

    if (req.method === 'GET' && req.url?.split('?', 1)[0] === '/api/stream') {
      const parsedUrl = new URL(req.url, 'http://127.0.0.1');
      const rawSeq = Number(parsedUrl.searchParams.get('sinceSeq') || 0);
      const sinceSeq = Number.isFinite(rawSeq) && rawSeq >= 0 ? Math.floor(rawSeq) : 0;
      const workspace = parsedUrl.searchParams.get('workspace') || '';
      const conversationId = parsedUrl.searchParams.get('conversationId') || '';

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      res.write(`: connected sinceSeq=${sinceSeq}\n\n`);

      const abortController = new AbortController();
      let closed = false;
      let streamHandle = null;

      const heartbeatTimer = setInterval(() => {
        if (closed || res.writableEnded || res.destroyed) return;
        try {
          res.write(`: heartbeat ${Date.now()}\n\n`);
        } catch {
          cleanup();
        }
      }, 15_000);
      heartbeatTimer.unref?.();

      function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeatTimer);
        abortController.abort();
        if (typeof streamHandle === 'function') {
          try {
            streamHandle();
          } catch {}
        } else if (streamHandle && typeof streamHandle.close === 'function') {
          try {
            streamHandle.close();
          } catch {}
        }
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.end();
          } catch {}
        }
      }

      req.on('close', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);

      Promise.resolve(
        openDaemonStream({
          sinceSeq,
          workspace,
          conversationId,
          signal: abortController.signal,
          onData: (evt) => {
            if (closed || res.writableEnded || res.destroyed) return;
            const serialized = typeof evt === 'string' ? evt : JSON.stringify(evt);
            try {
              res.write(`event: orch\ndata: ${serialized}\n\n`);
            } catch {
              cleanup();
            }
          },
          onError: (err) => {
            if (closed || abortController.signal.aborted) return;
            if (!res.writableEnded && !res.destroyed) {
              try {
                res.write(
                  `event: error\ndata: ${JSON.stringify({
                    error: err?.message || 'Daemon stream disconnected',
                  })}\n\n`
                );
              } catch {}
            }
            cleanup();
          },
        })
      )
        .then((handle) => {
          streamHandle = handle;
          if (closed && handle) {
            if (typeof handle === 'function') handle();
            else if (typeof handle.close === 'function') handle.close();
          }
        })
        .catch((err) => {
          if (closed || abortController.signal.aborted) return;
          if (!res.writableEnded && !res.destroyed) {
            try {
              res.write(
                `event: error\ndata: ${JSON.stringify({
                  error: err?.message || 'Failed to attach daemon stream',
                })}\n\n`
              );
            } catch {}
          }
          cleanup();
        });

      return;
    }

    for (const listener of existingListeners) {
      listener.call(server, req, res);
    }
  });
}

/** 底层 HTTP 兜底：仅服务白名单命中且启动时未注册 app.page 的 /ui/*.js（返回 true 表示已处理）。 */
function serveUnregisteredUiModule(req, res) {
  if (req.method !== 'GET' || !req.url?.startsWith('/ui/')) return false;
  const pathname = studioRequestPath(req.url);
  if (!pathname || REGISTERED_ASSET_ROUTES.has(pathname)) return false;
  const asset = resolveStudioAsset(pathname);
  if (!asset) return false;
  res.writeHead(200, { 'Content-Type': asset.contentType, 'Content-Length': asset.content.length, ...NO_STORE_HEADERS });
  res.end(asset.content);
  return true;
}

const httpServer = await app.run();
registerNonBlockingBuiltinOverrides();
attachSseStreamRoute(httpServer);
