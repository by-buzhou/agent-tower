import { rotateLog } from "./storage-paths.mjs";
import * as crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { frontendAssetHash, resolveStudioAsset, studioRequestPath } from "./frontend-assets.mjs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { STUDIO_PROTOCOL_REVISION, isPidAlive, negotiateDaemonVersion, readDaemonLease, resolveSharedDataDir, verifyDaemonLeaseOwner } from "./daemon-client.mjs";
import { createOrchestrator } from "./orchestrator.mjs";
import { projectPathKey } from "./orchestrator/helpers.mjs";
import { readUpdateRecord, writeUpdateRecord, UPDATE_INTERNAL } from "./updater.mjs";


const LEASE_FILENAME = "daemon-lease.json";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const LAUNCH_TICKET_TTL_MS = 300_000;
const MAX_LAUNCH_TICKETS = 128;

function parseCliArgs(argv) {
  const opts = {
    dataDir: "",
    port: 0,
    token: "",
    preserveRunningState: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || "");
    if (arg.startsWith("--data-dir=")) {
      opts.dataDir = arg.slice("--data-dir=".length).trim();
    } else if (arg === "--data-dir" && argv[i + 1]) {
      opts.dataDir = String(argv[++i]).trim();
    } else if (arg === "--preserve-running-state") {
      opts.preserveRunningState = true;
    } else if (arg === "--self-test") {
      opts.selfTest = true;
    } else if (arg.startsWith("--prefer-port=")) {
      opts.preferPort = Number(arg.slice("--prefer-port=".length));
    } else if (arg.startsWith("--update-operation=")) {
      opts.updateOperation = arg.slice("--update-operation=".length);
    } else if (arg.startsWith("--port=")) {
      opts.port = Number.parseInt(arg.slice("--port=".length), 10) || 0;
    } else if (arg === "--port" && argv[i + 1]) {
      opts.port = Number.parseInt(String(argv[++i]), 10) || 0;
    } else if (arg.startsWith("--token=")) {
      opts.token = arg.slice("--token=".length).trim();
    } else if (arg === "--token" && argv[i + 1]) {
      opts.token = String(argv[++i]).trim();
    }
  }
  return opts;
}

function safeTokenCompare(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function isTrustedLoopbackBrowserRequest(req, boundPort) {
  const hostHeader = String(req.headers.host || "").trim().toLowerCase();
  const validHosts = new Set([
    `127.0.0.1:${boundPort}`,
    `localhost:${boundPort}`,
  ]);
  if (!validHosts.has(hostHeader)) return false;

  const origin = String(req.headers.origin || "").trim().toLowerCase();
  if (origin) {
    if (origin !== `http://${hostHeader}`) return false;
  }

  const secFetchSite = String(req.headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return false;
  }

  return true;
}

function hasBrowserSession(req, secret) {
  return String(req.headers.cookie || "").split(";").some((pair) => {
    const cookie = pair.trim();
    const sep = cookie.indexOf("=");
    return sep > 0 && cookie.slice(0, sep) === "agent_tower_sid" && safeTokenCompare(cookie.slice(sep + 1), secret);
  });
}

function extractHostContextFromRequest(req) {
  const out = {};
  const b64 = req.headers["x-host-context"];
  if (typeof b64 === "string" && b64.trim()) {
    try {
      const parsed = JSON.parse(Buffer.from(b64.trim(), "base64").toString("utf8"));
      if (parsed && typeof parsed === "object") {
        Object.assign(out, parsed);
      }
      // v0.2.6 C07①：客户端进程启动时间戳只接受正整数，其余一律丢弃（回退为未携带时间戳的直写语义）。
      if (!(Number.isSafeInteger(out.clientStartedAt) && out.clientStartedAt > 0)) delete out.clientStartedAt;
    } catch {}
  }
  if (typeof req.headers["x-host-agentapi-exe"] === "string" && req.headers["x-host-agentapi-exe"].trim()) {
    out.agentApiExe = req.headers["x-host-agentapi-exe"].trim();
  }
  if (typeof req.headers["x-host-app-data-dir"] === "string" && req.headers["x-host-app-data-dir"].trim()) {
    out.appDataDir = req.headers["x-host-app-data-dir"].trim();
  }
  if (typeof req.headers["x-host-project-id"] === "string" && req.headers["x-host-project-id"].trim()) {
    out.projectId = req.headers["x-host-project-id"].trim();
  }
  if (typeof req.headers["x-host-conversation-id"] === "string" && req.headers["x-host-conversation-id"].trim()) {
    out.conversationId = req.headers["x-host-conversation-id"].trim();
  }
  return out;
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request payload too large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function writeLeaseAtomically(leasePath, leaseData) {
  const tmpPath = `${leasePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(leaseData, null, 2), "utf8");
  renameSync(tmpPath, leasePath);
}

function removeOwnLeaseIfCurrent(leasePath, lease) {
  try {
    if (!existsSync(leasePath)) return;
    const cur = JSON.parse(readFileSync(leasePath, "utf8"));
    if (cur?.pid === lease.pid && cur.port === lease.port &&
        cur.startedAt === lease.startedAt && cur.token === lease.token) {
      unlinkSync(leasePath);
    }
  } catch {}
}

/**
 * Start the AgentTower Core Daemon HTTP + SSE server on 127.0.0.1.
 */
export async function startCoreDaemon(options = {}) {
  const dataDir = path.resolve(options.dataDir || resolveSharedDataDir());
  function checkTrialStartup() {
    if (!options.updateOperation) return;
    const lock = readUpdateRecord(dataDir, "apply.lock");
    if (lock?.id !== options.updateOperation || !isPidAlive(lock.pid) ||
        readUpdateRecord(dataDir, "probation.json")?.id !== lock.id) {
      throw Error("Update startup is no longer active");
    }
  }
  checkTrialStartup();
  mkdirSync(dataDir, { recursive: true });

  const log = msg => rotateLog(orchestrator.db.defaultStudioRoot, 'daemon.log', `[pid=${process.pid}] ${msg}`);

  const token = options.token || crypto.randomBytes(24).toString("hex");
  let browserSessionSecret = crypto.randomBytes(32).toString("hex");
  const launchTickets = new Map();
  const preferPort = Number.isInteger(options.preferPort) && options.preferPort > 0 && options.preferPort <= 65535
    ? options.preferPort : 0;
  const requestedPort = Number(options.port) || preferPort;
  const startedAt = Date.now();
  const leasePath = path.join(dataDir, LEASE_FILENAME);

  const orchestrator = createOrchestrator({
    dataDir,
    defaultStudioRoot: options.defaultStudioRoot,
    catalogLoader: options.catalogLoader,
    feedUrl: options.feedUrl,
    fetchImpl: options.fetchImpl,
    recoverStaleState: !options.preserveRunningState,
    log,
  });

  const sseClients = new Set();
  let boundPort = requestedPort;
  let shuttingDown = false;
  let shutdownPromise;
  let inFlightRequests = 0;
  let notifyDrained;

  const unsubscribeOrch = orchestrator.subscribe((evt) => {
    if (sseClients.size === 0) return;
    for (const client of sseClients) {
      if (evt.type === "project_config_updated") {
        const evtKey = projectPathKey(evt.workspace);
        if (!evtKey) continue;
        if (client.projectKey) {
          if (evtKey !== client.projectKey && !client.projectKey.startsWith(`${evtKey}/`)) continue;
        } else if (client.rootConvFilter) {
          if (!orchestrator.matchesEventConversation(evt, client.rootConvFilter)) continue;
        } else {
          continue;
        }
      } else if (client.rootConvFilter) {
        if (!orchestrator.matchesEventConversation(evt, client.rootConvFilter)) {
          continue;
        }
        if (client.workspaceFilter && evt.type === "spec_curation_updated") {
          const evtWs = String(evt.workspace || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
          if (evtWs && evtWs !== client.workspaceFilter) continue;
        }
      } else if (client.workspaceFilter) {
        const evtWs = String(evt.workspace || evt.cwd || "").replace(/\\/g, "/").toLowerCase();
        if (evtWs && evtWs !== client.workspaceFilter && !evtWs.startsWith(`${client.workspaceFilter}/`)) {
          continue;
        }
      }
      try {
        if (client.pending) {client.pending.push(evt); continue;}
        client.res.write(`event: orch\ndata: ${JSON.stringify(evt)}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  });

  const heartbeatTimer = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.res.write(`event: orch\ndata: ${JSON.stringify({ type: "heartbeat", frontendAssetHash: frontendAssetHash() })}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  }, 15000);
  heartbeatTimer.unref?.();

  function pruneLaunchTickets(now) {
    for (const [ticket, { expiresAt }] of launchTickets) {
      if (expiresAt <= now) launchTickets.delete(ticket);
    }
  }

  async function issueStudioLaunchUrl(params, appDataDir) {
    const requestedId = String(params.conversationId || "").trim();
    const conversationId = requestedId ? orchestrator.resolveConversationRoot(requestedId, appDataDir) || requestedId : "";
    let workspace = String(params.workspace || "").trim();
    if (!workspace && conversationId) {
      const bootstrap = await orchestrator.getBootstrap({ conversationId, appDataDir });
      workspace = bootstrap.workspace || "";
    }
    const now = Date.now();
    pruneLaunchTickets(now);
    if (launchTickets.size >= MAX_LAUNCH_TICKETS) launchTickets.delete(launchTickets.keys().next().value);
    const ticket = crypto.randomBytes(32).toString("hex");
    launchTickets.set(ticket, { expiresAt: now + LAUNCH_TICKET_TTL_MS, conversationId, workspace });
    const baseUrl = `http://127.0.0.1:${boundPort}/`;
    const launch = new URL(baseUrl);
    launch.searchParams.set("launch", ticket);
    if (conversationId) launch.searchParams.set("conversationId", conversationId);
    if (workspace) launch.searchParams.set("workspace", workspace);
    const launchUrl = launch.href;
    return { studioUrl: launchUrl, launchUrl, baseUrl };
  }

  function serveStaticAsset(res, asset, headers = {}) {
    res.writeHead(200, {
      "Content-Type": asset.contentType,
      "Content-Length": asset.content.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    });
    res.end(asset.content);
  }

  const server = http.createServer(async (req, res) => {
    let counted = false;
    try {
      const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${boundPort || 80}`);
      const pathname = reqUrl.pathname || "/";
      const rawAssetPath = studioRequestPath(req.url);
      const method = (req.method || "GET").toUpperCase();
      const headerToken = String(req.headers["x-daemon-token"] || "");
      const hasValidToken = safeTokenCompare(headerToken, token);

      // 1. Health check reports actual build while keeping already-open protocol-revision-1 stdio MCP clients compatible on protocol rev 1
      if (method === "GET" && pathname === "/healthz") {
        const clientExpected = String(req.headers["x-expected-daemon-version"] || "").trim();
        // v0.2.6 C09②：语义化版本兼容握手——协议修订一致且客户端期望版本 <= 实际版本即回显期望版本（升小版本不断连）。
        // 兼容仍在内存中运行旧 3 段 semver 正则的 0.2.7 客户端访问 4 段补丁号（0.2.7.1）Daemon。
        const negotiatedVersion = negotiateDaemonVersion(clientExpected, orchestrator.version, STUDIO_PROTOCOL_REVISION);
        const compatRelease = /^\d+\.\d+\.\d+\.\d+$/.test(orchestrator.version) &&
          /^0\.2\.\d+$/.test(clientExpected) &&
          negotiatedVersion === clientExpected
          ? orchestrator.version.split(".").slice(0, 3).join(".")
          : orchestrator.version;
        sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          port: boundPort,
          version: negotiatedVersion,
          releaseVersion: compatRelease,
          studioProtocolRevision: STUDIO_PROTOCOL_REVISION,
          shuttingDown: Boolean(shuttingDown),
          startedAt,
        });
        return;
      }

      // 2. Static Studio Web Assets (enables opening studioUrl directly in any browser)
      if (method === "GET" && (rawAssetPath === "/" || rawAssetPath === "/index.html")) {
        if (!isTrustedLoopbackBrowserRequest(req, boundPort)) {
          sendJson(res, 403, { ok: false, error: "Forbidden: untrusted origin" });
          return;
        }
        const queryAuth = String(reqUrl.searchParams.get("auth") || "");
        const hasAuthLaunch = safeTokenCompare(queryAuth, browserSessionSecret);
        const launchTicket = reqUrl.searchParams.get("launch");
        pruneLaunchTickets(Date.now());
        const issued = launchTickets.get(launchTicket);
        if (issued) launchTickets.delete(launchTicket);
        if (!hasValidToken && !hasAuthLaunch && !issued && !hasBrowserSession(req, browserSessionSecret)) {
          sendJson(res, 401, { ok: false, error: "Unauthorized: open studioUrl from Studio or MCP studio_status" });
          return;
        }
        if (launchTicket !== null || reqUrl.searchParams.has("auth")) {
          if (issued) {
            for (const key of ["conversationId", "workspace"]) {
              if (issued[key]) reqUrl.searchParams.set(key, issued[key]);
              else reqUrl.searchParams.delete(key);
            }
          }
          reqUrl.searchParams.delete("launch");
          reqUrl.searchParams.delete("auth");
          res.writeHead(302, { Location: "/" + reqUrl.search, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
            "Set-Cookie": `agent_tower_sid=${browserSessionSecret}; HttpOnly; SameSite=Strict; Path=/` });
          res.end(); return;
        }
        const index = resolveStudioAsset(rawAssetPath);
        if (!index) {
          sendJson(res, 404, { ok: false, error: "Asset not found: index.html" });
          return;
        }
        serveStaticAsset(res, index, {
          "Set-Cookie": `agent_tower_sid=${browserSessionSecret}; HttpOnly; SameSite=Strict; Path=/`,
          "Cache-Control": "no-store",
        });
        return;
      }
      // styles.css / app.js / ui/*.js：统一走 frontend-assets 白名单解析器；未知路径返回 null 继续向下（不误吞 /api/*）
      const studioAsset = method === "GET" && rawAssetPath && rawAssetPath !== "/" && rawAssetPath !== "/index.html" ? resolveStudioAsset(rawAssetPath) : null;
      if (studioAsset) {
        serveStaticAsset(res, studioAsset);
        return;
      }
      if (method === "GET" && pathname === "/preload.js") {
        const shim = Buffer.from(
          "/* Standalone Browser Shim */\nwindow.sidecar = window.sidecar || undefined;\n",
          "utf8"
        );
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Content-Length": shim.length,
          "Cache-Control": "no-cache",
        });
        res.end(shim);
        return;
      }
      if (method === "GET" && pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Security gate for API / RPC routes: require valid X-Daemon-Token OR authenticated same-origin loopback browser
      if (!hasValidToken && (headerToken || !isTrustedLoopbackBrowserRequest(req, boundPort) || !hasBrowserSession(req, browserSessionSecret))) {
        sendJson(res, 403, { ok: false, error: "Forbidden: invalid daemon token or untrusted browser session" });
        return;
      }

      if (shuttingDown) { sendJson(res, 503, { ok: false, error: "Daemon is shutting down" }); return; }
      counted = true;
      inFlightRequests++;
      let reqHostCtx = {};
      if (hasValidToken) {
        reqHostCtx = extractHostContextFromRequest(req);
        if (Object.keys(reqHostCtx).length > 0) orchestrator.updateHostContext?.(reqHostCtx);
      }

      // 2b. v0.2.6：独立网页端前端热刷新探活（与 Sidecar /api/health 同形的轻量存活与资产指纹，不触碰数据库）
      if (method === "GET" && pathname === "/api/health") {
        sendJson(res, 200, { ok: true, version: orchestrator.version, startedAt, frontendAssetHash: frontendAssetHash(), daemon: { reachable: true } });
        return;
      }

      // 3. Bootstrap snapshot
      // Strictly use the request's explicit `?conversationId=` (never fall back to shared Sidecar/Daemon env conversationId!)
      if (method === "GET" && pathname === "/api/bootstrap") {
        const workspace = reqUrl.searchParams.get("workspace") || "";
        const conversationId = reqUrl.searchParams.get("conversationId") || "";
        const appDataDir = reqUrl.searchParams.get("appDataDir") || reqHostCtx.appDataDir || "";
        const agentApiExe = reqUrl.searchParams.get("agentApiExe") || reqHostCtx.agentApiExe || "";
        const projectId = reqUrl.searchParams.get("projectId") || reqHostCtx.projectId || "";
        if (appDataDir || agentApiExe || projectId) {
          orchestrator.updateHostContext?.({ appDataDir, agentApiExe, projectId });
        }
        const snapshot = await orchestrator.getBootstrap({
          workspace,
          conversationId,
          appDataDir,
        });
        sendJson(res, 200, snapshot);
        return;
      }

      // 4. Incremental event polling
      if (method === "GET" && pathname === "/api/events") {
        const sinceSeq = Number(reqUrl.searchParams.get("sinceSeq") || reqUrl.searchParams.get("since") || 0);
        const limit = Number(reqUrl.searchParams.get("limit") || 300);
        const workspace = reqUrl.searchParams.get("workspace") || "";
        const threadId = reqUrl.searchParams.get("threadId") || "";
        const conversationId = reqUrl.searchParams.get("conversationId") || "";
        const boardSig = reqUrl.searchParams.get("boardSig") || "";
        const appDataDir = reqUrl.searchParams.get("appDataDir") || reqHostCtx.appDataDir || "";
        if (appDataDir) {
          orchestrator.updateHostContext?.({ appDataDir });
        }
        const eventsPayload = await orchestrator.getEvents({
          sinceSeq,
          limit,
          workspace,
          threadId,
          conversationId,
          appDataDir,
          boardSig,
        });
        sendJson(res, 200, eventsPayload);
        return;
      }

      // 5. Real-time Server-Sent Events (SSE) stream
      if (method === "GET" && pathname === "/api/stream") {
        const sinceSeq = Number(reqUrl.searchParams.get("sinceSeq") || reqUrl.searchParams.get("since") || 0);
        const workspace = reqUrl.searchParams.get("workspace") || "";
        const conversationId = reqUrl.searchParams.get("conversationId") || "";
        const appDataDir = reqUrl.searchParams.get("appDataDir") || reqHostCtx.appDataDir || "";
        const rootConvFilter = conversationId
          ? String(orchestrator.resolveConversationRoot(conversationId, appDataDir) || conversationId)
              .trim()
              .toLowerCase()
          : "";
        const workspaceFilter = workspace
          ? path.resolve(workspace).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
          : "";

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.socket?.setNoDelay?.(true);
        res.write(`event: orch\ndata: ${JSON.stringify({ type: "connected", frontendAssetHash: frontendAssetHash() })}\n\n`);

        // Subscribe before replay, and deduplicate events that arrived while reading pages.
        const clientEntry = { res, workspaceFilter, projectKey: projectPathKey(workspace), rootConvFilter, pending: [] };
        sseClients.add(clientEntry);
        res.on("close", () => sseClients.delete(clientEntry));
        let cursor = sinceSeq;
        let page;
        try {
          while (!res.destroyed && !shuttingDown) {
            page = await orchestrator.getEvents({
              sinceSeq: cursor, limit: 500, workspace, conversationId, appDataDir,
            });
            for (const evt of page.events) res.write(`event: orch\ndata: ${JSON.stringify(evt)}\n\n`);
            cursor = page.nextSeq;
            if (cursor >= page.latestSeq) break;
          }
          if (rootConvFilter && page && !res.destroyed && !shuttingDown) {
            const { conversationPolicy, activeMode, boardMessages, collaborationEdges, healthIncidents, stats, latestSeq, rootConversationId, systemUpdate } = page;
            const snapshot = { events: [], conversationPolicy, activeMode, boardMessages, collaborationEdges, healthIncidents, stats, latestSeq, rootConversationId, systemUpdate };
            res.write(`event: orch\ndata: ${JSON.stringify(snapshot)}\n\n`);
          }
          // The snapshot cursor covers replay only. Newer pending events advance it on the client in order.
          for (const evt of clientEntry.pending) if (evt.seq > cursor) res.write(`event: orch\ndata: ${JSON.stringify(evt)}\n\n`);
          clientEntry.pending = null;
        } catch { sseClients.delete(clientEntry); res.end(); }
        return;
      }

      // 6. RPC Endpoint (`/rpc` requires X-Daemon-Token; `/api/rpc` allows token or same-origin loopback browser)
      if (method === "POST" && (pathname === "/rpc" || pathname === "/api/rpc")) {
        const body = await readJsonBody(req);
        const rpcMethod = String(body?.method || "").trim();
        const rpcParams = body?.params && typeof body.params === "object" ? body.params : {};

        if (rpcMethod === "studioStatus" && !hasValidToken) {
          sendJson(res, 403, { ok: false, error: "Trusted RPC required" });
          return;
        }
        if (!hasValidToken && pathname === "/rpc") {
          sendJson(res, 401, { ok: false, error: "Unauthorized: daemon token required" });
          return;
        }
        if (!rpcMethod) {
          sendJson(res, 400, { ok: false, error: "Missing RPC method" });
          return;
        }
        if (rpcMethod === "specCuration" &&
            (req.headers["x-agent-tower-surface"] === "mcp" || rpcParams._agentTowerSurface === "mcp") &&
            !["begin", "submit", "status"].includes(rpcParams.action)) {
          sendJson(res, 403, { ok: false, code: "SPEC_CURATION_SURFACE_FORBIDDEN",
            error: "MCP 仅可发起规范梳理和提交提案，管理操作请在 Studio 执行" });
          return;
        }

        if (["__shutdown", "__prepareCutover", "__commitUpdate", "__finishUpdate"].includes(rpcMethod)) {
          if (!hasValidToken || rpcParams._standalone === true) {
            sendJson(res, 401, { ok: false, error: "Trusted daemon RPC required" });
            return;
          }
        }

        try {
          if (rpcMethod === "__shutdown") {
            if (rpcParams.updateId) {
              const lock = readUpdateRecord(dataDir, "apply.lock");
              if (lock?.id !== rpcParams.updateId || !["applying", "rolling_back"].includes(lock.phase)) {
                throw Object.assign(new Error("Update commitment is missing"), { code: "UPDATE_IN_PROGRESS" });
              }
            }
            if (rpcParams.requireCutover === true && !(await orchestrator.systemUpdate({ action: "prepareCutover" })).quiescing) {
              throw Object.assign(new Error("Daemon has not drained"), { code: "DAEMON_BUSY" });
            }
            if (rpcParams.updateId) {
              writeUpdateRecord(dataDir, "transaction/browser-session.json", { id: rpcParams.updateId, port: boundPort, secret: browserSessionSecret });
            }
            sendJson(res, 200, { ok: true, result: { shuttingDown: true } });
            void shutdownDaemon("rpc_shutdown");
            return;
          }
          const workerAction = rpcMethod === "__commitUpdate" ? "commitWorker" : rpcMethod === "__finishUpdate" ? "finishWorker" : "";
          const result = workerAction
            ? await orchestrator.systemUpdate({ action: workerAction, [UPDATE_INTERNAL]: rpcParams.updateId })
            : rpcMethod === "studioStatus"
            ? await issueStudioLaunchUrl(rpcParams, rpcParams.appDataDir || reqHostCtx.appDataDir)
            : rpcMethod === "__prepareCutover"
            ? await orchestrator.systemUpdate({ action: "prepareCutover" })
            : await orchestrator.handleRpc(rpcMethod, hasValidToken ? rpcParams : { ...rpcParams, _standalone: true });
          sendJson(res, 200, { ok: true, result });
        } catch (rpcErr) {
          const errMessage = rpcErr?.message || String(rpcErr);
          const status = rpcErr?.code === "METHOD_NOT_FOUND" ? 404 : 200;
          sendJson(res, status, {
            ok: false,
            error: errMessage,
            code: rpcErr?.code || "RPC_ERROR",
            ...(rpcErr?.details !== undefined ? { details: rpcErr.details } : {}),
          });
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: `Not found: ${method} ${pathname}` });
    } catch (err) {
      log("Unhandled HTTP request error");
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: err?.message || "Internal daemon error" });
      } else {
        try { res.end(); } catch {}
      }
    } finally {
      if (counted && --inFlightRequests === 0) notifyDrained?.();
    }
  });

  function listen(port) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  }
  try {
    try { await listen(requestedPort); }
    catch (error) {
      if (options.port || !preferPort || error.code !== "EADDRINUSE") throw error;
      await listen(0);
    }
    checkTrialStartup();
  } catch (error) {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    clearInterval(heartbeatTimer);
    unsubscribeOrch();
    await orchestrator.shutdown();
    throw error;
  }

  const addr = server.address();
  boundPort = typeof addr === "object" && addr ? addr.port : requestedPort;
  if (options.updateOperation) {
    const session = readUpdateRecord(dataDir, "transaction", "browser-session.json");
    if (session?.id === options.updateOperation && session.port === boundPort && /^[a-f0-9]{64}$/.test(session.secret)) {
      browserSessionSecret = session.secret;
    }
  }
  const studioUrl = `http://127.0.0.1:${boundPort}/?auth=${browserSessionSecret}`;
  orchestrator.setStudioUrl(`http://127.0.0.1:${boundPort}/`);

  const leaseData = {
    host: "127.0.0.1",
    port: boundPort,
    token,
    pid: process.pid,
    startedAt,
  };
  writeLeaseAtomically(leasePath, leaseData);
  log(`Core Daemon listening on loopback port ${boundPort}`);

  let checkingLease = false;
  const supersededTimer = setInterval(async () => {
    if (shuttingDown || checkingLease || inFlightRequests || orchestrator.hasActiveRuns()) return;
    const successor = readDaemonLease(dataDir);
    if (!successor || successor.port === boundPort || successor.startedAt < startedAt) return;
    checkingLease = true;
    try {
      if (!await verifyDaemonLeaseOwner(successor, 1500)) return;
      const current = readDaemonLease(dataDir);
      if (current?.pid === successor.pid && current.port === successor.port &&
          current.startedAt === successor.startedAt && current.token === successor.token &&
          !inFlightRequests && !orchestrator.hasActiveRuns()) await shutdownDaemon("superseded");
    } catch {
      // Keep serving if the replacement is not confirmed or lease I/O fails.
    } finally {
      checkingLease = false;
    }
  }, 2000);
  supersededTimer.unref?.();

  function shutdownDaemon(reason = "signal") {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = Promise.resolve().then(async () => {
      log(`Core Daemon shutting down (${reason})...`);
      clearInterval(heartbeatTimer);
      unsubscribeOrch();
      clearInterval(supersededTimer);
      for (const client of sseClients) {
        try { client.res.end(); } catch {}
      }
      sseClients.clear();

      // Keep health and the lease observable until every admitted request and engine has drained.
      if (inFlightRequests) await new Promise(resolve => { notifyDrained = resolve; });
      await orchestrator.shutdown();
      removeOwnLeaseIfCurrent(leasePath, leaseData);
      await new Promise(resolve => server.close(resolve));

      if (reason === "superseded" && options.exitOnSupersede) {
        setTimeout(() => process.exit(0), 150).unref?.();
      }
    });
    return shutdownPromise;
  }

  return {
    host: "127.0.0.1",
    port: boundPort,
    token,
    pid: process.pid,
    studioUrl,
    dataDir,
    orchestrator,
    shutdown: shutdownDaemon,
  };
}

// Execute when launched directly as a standalone daemon process
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

async function selfTest() {
  // All Orchestrator imports are resolved above. Project stores may only open outside the control plane.
  if (typeof createOrchestrator !== "function") throw Error("Orchestrator failed to load");
  for (const route of ["/", "/styles.css", "/app.js"]) {
    if (!resolveStudioAsset(route)?.content?.length) throw Error("Missing Studio asset");
  }
}

if (isMainModule) {
  const cliOpts = parseCliArgs(process.argv.slice(2));
  (cliOpts.selfTest ? selfTest() : startCoreDaemon({ ...cliOpts, exitOnSupersede: true }))
    .then((daemon) => {
      if (!daemon) return;
      const gracefulExit = async (sig) => {
        await daemon.shutdown(sig);
        process.exit(0);
      };
      process.once("SIGINT", () => void gracefulExit("SIGINT"));
      process.once("SIGTERM", () => void gracefulExit("SIGTERM"));
      process.on("uncaughtException", (err) => {
        try {
          rotateLog(daemon.orchestrator.db.defaultStudioRoot, "daemon.log", "Uncaught exception");
        } catch {}
      });
      process.on("unhandledRejection", (reason) => {
        try {
          rotateLog(daemon.orchestrator.db.defaultStudioRoot, "daemon.log", "Unhandled rejection");
        } catch {}
      });
    })
    .catch((err) => {
      process.stderr.write(`[agent-tower daemon] Fatal startup error\n`);
      process.exit(1);
    });
}
