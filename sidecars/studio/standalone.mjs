#!/usr/bin/env node
/**
 * @fileoverview AgentTower — 独立 Web 监控台 CLI 入口 (`standalone.mjs`)。
 *
 * 适用场景：
 * 1. Antigravity IDE（未开启原生 UI Sidecar 右侧栏时，直接在浏览器打开完整多 Agent 工作台）；
 * 2. 无头服务器 / Antigravity CLI (`agy`) 配合 `ssh -L 8790:127.0.0.1:8790` 远程盯盘与操控；
 * 3. 快速命令行状态探针：`node sidecars/studio/standalone.mjs --status`。
 *
 * 安全策略：默认仅绑定回环地址 `127.0.0.1`；若显式指定非回环 `--host`（如 `0.0.0.0`），
 * 强制要求配置 `--token <secret>`（或环境变量 `AGENT_TOWER_STANDALONE_TOKEN`）。
 */

import { randomBytes, createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { globalSettings } from '../../core/global-settings.mjs';
import { studioDir } from '../../core/storage-paths.mjs';
import { resolveStudioAsset, studioRequestPath } from '../../core/frontend-assets.mjs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  daemonGet,
  daemonRpc,
  ensureDaemon,
  openDaemonStream,
  resolveSharedDataDir,
} from '../../core/daemon-client.mjs';

const AUTH_COOKIE = 'agent_tower_standalone_auth';
const MAX_BODY_BYTES = 1024 * 1024;
const NO_STORE = Object.freeze({
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
});

export function isLoopbackHost(host) {
  const clean = String(host || '127.0.0.1')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!clean || clean === 'localhost' || clean === '::1' || clean === '0:0:0:0:0:0:0:1') {
    return true;
  }
  return /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(
    clean
  );
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

function deriveCookieDigest(secret) {
  return createHmac('sha256', 'agent-tower-standalone-v1').update(secret, 'utf8').digest('hex');
}

function parseCookies(header) {
  const map = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) map[k] = v;
  }
  return map;
}

export function parseStandaloneArgs(argv = process.argv.slice(2), env = process.env) {
  const opts = {
    help: false,
    statusOnly: false,
    host: String(env.AGENT_TOWER_STANDALONE_HOST || '127.0.0.1').trim() || '127.0.0.1',
    port: env.AGENT_TOWER_STANDALONE_PORT ? Number(env.AGENT_TOWER_STANDALONE_PORT) : null,
    token: String(env.AGENT_TOWER_STANDALONE_TOKEN || '').trim(),
    dataDir: String(env.AGENT_TOWER_DATA_DIR || '').trim(),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || '');
    if (!arg) continue;
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--status') {
      opts.statusOnly = true;
      continue;
    }
    const eqIdx = arg.indexOf('=');
    const flag = eqIdx > 0 ? arg.slice(0, eqIdx) : arg;
    const nextVal = () => (eqIdx > 0 ? arg.slice(eqIdx + 1) : String(argv[++i] || ''));

    if (flag === '--port' || flag === '-p') {
      const p = Number(nextVal().trim());
      if (!Number.isInteger(p) || p < 0 || p > 65535) {
        throw new Error('Invalid --port (expected integer 0..65535)');
      }
      opts.port = p;
    } else if (flag === '--host' || flag === '-H') {
      opts.host = nextVal().trim() || '127.0.0.1';
    } else if (flag === '--token') {
      opts.token = nextVal().trim();
    } else if (flag === '--data-dir') {
      opts.dataDir = nextVal().trim();
    }
  }
  return opts;
}

export function formatHelpText() {
  return [
    'AgentTower — Standalone Web Server',
    '',
    'Usage:',
    '  node sidecars/studio/standalone.mjs [options]',
    '',
    'Options:',
    '  -p, --port <port>       Bind fixed HTTP port (omit to use Core Daemon studioUrl directly)',
    '  -H, --host <host>       Bind address (default: 127.0.0.1)',
    '      --token <secret>    Access token (mandatory when --host is non-loopback)',
    '      --data-dir <dir>    Explicit plugin data directory override',
    '      --status            Ensure Core Daemon is up, print JSON status, and exit',
    '  -h, --help              Show this help message',
  ].join('\n');
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        const err = new Error('Payload too large');
        err.statusCode = 413;
        rejectBody(err);
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

export async function createStandaloneProxyServer({ host = '127.0.0.1', port = 8790, token = '', dataDir } = {}) {
  const loopback = isLoopbackHost(host);
  if (!loopback && !token) {
    throw new Error(
      `Refusing to bind non-loopback host "${host}" without --token <secret> (or AGENT_TOWER_STANDALONE_TOKEN).`
    );
  }

  const resolvedDataDir = dataDir ? resolve(dataDir) : undefined;
  const daemonOpts = resolvedDataDir ? { dataDir: resolvedDataDir } : {};
  await ensureDaemon(daemonOpts);

  const generated = !token;
  let launchSecret = token || randomBytes(32).toString('hex');
  const cookieDigest = deriveCookieDigest(randomBytes(32).toString('hex'));
  function isAuthorized(req, urlObj, pathname) {
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return { ok: false };
    if (loopback && !isLoopbackHost(new URL(`http://${req.headers.host}`).hostname)) return { ok: false };
    if (req.method === 'GET' && ['/', '/index.html'].includes(pathname) && safeEqual(urlObj.searchParams.get('auth'), launchSecret)) {
      if (generated) launchSecret = '';
      return { ok: true, setCookie: true };
    }
    return { ok: safeEqual(parseCookies(req.headers.cookie)[AUTH_COOKIE], cookieDigest) };
  }

  function send(res, status, contentType, body, extraHeaders = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': buf.length,
      ...NO_STORE,
      ...extraHeaders,
    });
    res.end(buf);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const method = String(req.method || 'GET').toUpperCase();
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = urlObj.pathname || '/';
      const rawAssetPath = studioRequestPath(req.url);

      const auth = isAuthorized(req, urlObj, rawAssetPath);
      if (!auth.ok) {
        send(res, 401, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      if (auth.setCookie && (rawAssetPath === '/' || rawAssetPath === '/index.html')) {
        urlObj.searchParams.delete('auth');
        const qs = urlObj.searchParams.toString();
        res.writeHead(302, {
          'Referrer-Policy': 'no-referrer',
          Location: qs ? `/?${qs}` : '/',
          'Set-Cookie': `${AUTH_COOKIE}=${cookieDigest}; HttpOnly; SameSite=Strict; Path=/`,
          ...NO_STORE,
        });
        res.end();
        return;
      }

      if (method === 'GET') {
        // `/`、`/index.html`、`/styles.css`、`/app.js` 与全部 `/ui/*.js`：Cookie 校验之后统一走白名单解析器
        const studioAsset = rawAssetPath ? resolveStudioAsset(rawAssetPath) : null;
        if (studioAsset) {
          send(res, 200, studioAsset.contentType, studioAsset.content);
          return;
        }
        if (pathname === '/preload.js') {
          send(res, 200, 'application/javascript; charset=utf-8', '/* standalone web mode shim */\n');
          return;
        }
        if (pathname === '/favicon.ico') {
          res.writeHead(204, NO_STORE);
          res.end();
          return;
        }
        if (pathname === '/api/bootstrap' || pathname === '/api/events') {
          urlObj.searchParams.delete('auth');
          const qs = urlObj.searchParams.toString();
          const data = await daemonGet(qs ? `${pathname}?${qs}` : pathname, daemonOpts);
          send(res, 200, 'application/json; charset=utf-8', JSON.stringify(data));
          return;
        }
        if (pathname === '/api/stream') {
          const sinceSeq = Number(urlObj.searchParams.get('sinceSeq') || 0) || 0;
          const workspace = urlObj.searchParams.get('workspace') || '';
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.flushHeaders?.();
          res.write(`: connected sinceSeq=${sinceSeq}\n\n`);

          const ac = new AbortController();
          let closed = false;
          let handle = null;
          const hb = setInterval(() => {
            if (!closed && !res.writableEnded) res.write(`: heartbeat ${Date.now()}\n\n`);
          }, 15_000);
          hb.unref?.();

          const closeStream = () => {
            if (closed) return;
            closed = true;
            clearInterval(hb);
            ac.abort();
            if (typeof handle === 'function') handle();
            else if (handle?.close) handle.close();
            if (!res.writableEnded) res.end();
          };
          req.on('close', closeStream);
          res.on('close', closeStream);

          handle = await openDaemonStream({
            sinceSeq,
            conversationId: urlObj.searchParams.get('conversationId') || '',
            dataDir: resolvedDataDir,
            workspace,
            signal: ac.signal,
            onData: (evt) => {
              if (!closed && !res.writableEnded) {
                res.write(`event: orch\ndata: ${typeof evt === 'string' ? evt : JSON.stringify(evt)}\n\n`);
              }
            },
            onError: () => closeStream(),
          });
          return;
        }
      }

      if (method === 'POST' && pathname.startsWith('/_sidecar/')) {
        send(res, 200, 'application/json; charset=utf-8', '{}');
        return;
      }

      if (method === 'POST' && pathname === '/api/rpc') {
        const raw = await readBody(req);
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        const rpcMethod = String(parsed?.method || '').trim();
        if (rpcMethod === '__shutdown' || rpcMethod === 'studioStatus') { send(res, 403, 'application/json', '{}'); return; }
        if (!rpcMethod) {
          send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: 'Missing method' }));
          return;
        }
        try {
          const out = await daemonRpc(rpcMethod, { ...parsed?.params, _standalone: true }, daemonOpts);
          const envelope =
            out && typeof out === 'object' && 'ok' in out && ('result' in out || 'error' in out)
              ? out
              : { ok: true, result: out };
          send(res, 200, 'application/json; charset=utf-8', JSON.stringify(envelope));
        } catch (err) {
          send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: err?.message || String(err) }));
        }
        return;
      }

      send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: 'Not found' }));
    } catch (err) {
      send(
        res,
        Number(err?.statusCode) || 500,
        'application/json; charset=utf-8',
        JSON.stringify({ ok: false, error: err?.message || 'Internal server error' })
      );
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return {
    get launchUrl() { return launchSecret ? `http://${displayHost}:${actualPort}/?auth=${encodeURIComponent(launchSecret)}` : null; },
    server,
    host,
    port: actualPort,
    url: `http://${displayHost}:${actualPort}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export async function runStandaloneCli(argv = process.argv.slice(2)) {
  const opts = parseStandaloneArgs(argv, process.env);
  if (opts.help) {
    console.log(formatHelpText());
    return;
  }

  const dataDir = opts.dataDir ? resolve(opts.dataDir) : resolveSharedDataDir();
  const daemon = await ensureDaemon({ dataDir });

  if (opts.statusOnly) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          host: daemon.host,
          port: daemon.port,
          pid: daemon.pid,
          studioOrigin: `http://${daemon.host}:${daemon.port}`,
          dataDir,
        },
        null,
        2
      )
    );
    return;
  }

  if (opts.port !== null && isLoopbackHost(opts.host) && opts.port === daemon.port) {
    throw new Error(
      `Standalone proxy port (${opts.port}) conflicts with backing Core Daemon port; choose another --port (e.g. 8790) or omit --port.`
    );
  }

  const proxy = await createStandaloneProxyServer({
    host: opts.host,
    port: opts.port ?? 0,
    token: opts.token,
    dataDir,
  });
  console.log(`[agent-tower] Standalone Studio Proxy listening at ${proxy.url}`);
  console.log(`[agent-tower] Backing Core Daemon PID ${daemon.pid} (http://${daemon.host}:${daemon.port})`);

  // A generated URL is a credential: hand it off in the private data directory, never stdout.
  const launchFile = !opts.token ? join(studioDir(globalSettings(dataDir).root, "tmp"), `standalone-launch-${process.pid}.url`) : null;
  if (launchFile) {
    try { await writeFile(launchFile, proxy.launchUrl, { mode: 0o600, flag: 'wx' }); }
    catch (err) { await proxy.close(); throw err; }
    console.log(`[agent-tower] One-time launch URL file: ${launchFile}`);
  }
  const shutdown = async () => {
    if (launchFile) await unlink(launchFile).catch(() => {});
    await proxy.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  runStandaloneCli().catch((err) => {
    console.error(`[agent-tower] Fatal: ${err?.message || err}`);
    process.exit(1);
  });
}
