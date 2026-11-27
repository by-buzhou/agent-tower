import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { startCoreDaemon } from "../../core/daemon.mjs";
import { openOrchestratorDb } from "../../core/db.mjs";
import {
  clearNativeConversationTitleCache,
  peekCachedHostConversationTitle,
  readNativeConversationTitle,
  resolveNativeConversationTitleAsync,
} from "../../core/engines/agy-native.mjs";
import { openProjectStore } from "../../core/project-store.mjs";
import { createIsolatedWorktree } from "../../core/worktree.mjs";
import { offlineCatalog, project } from "../helpers/fixtures.mjs";
import { runsRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

process.env.AGENT_TOWER_TEST_ROOT ??= runsRoot();

const normalPath = value => value.replaceAll("\\", "/");
const databasePath = root => path.join(root, ".agent-tower", "conversations", "tower.sqlite");

async function withDaemon(name, action) {
  return withProjectSandbox(name, async dir => {
    const home = project(dir, "home");
    const appDataDir = path.join(dir, "host");
    fs.mkdirSync(appDataDir);
    const daemon = await startCoreDaemon({
      dataDir: path.join(dir, "control"), defaultStudioRoot: home, catalogLoader: offlineCatalog,
    });
    const baseUrl = `http://127.0.0.1:${daemon.port}/`;
    const auth = { "X-Daemon-Token": daemon.token };
    daemon.orchestrator.updateHostContext({ appDataDir });
    const rpc = async (method, params = {}, headers = auth, route = "/rpc") => fetch(new URL(route, baseUrl), {
      method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(10_000),
    });
    const rpcResult = async (method, params) => {
      const response = await rpc(method, params);
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    try {
      await action({ dir, home, appDataDir, daemon, baseUrl, auth, rpc, rpcResult });
    } finally {
      await daemon.shutdown();
    }
  });
}

function seedThread(orchestrator, id, workspace, rootConversationId, extra = {}) {
  return orchestrator.db.upsertThread({
    id, title: id, cwd: workspace, workspace, provider: "codex", status: "completed",
    meta: { rootConversationId, projectRoot: workspace }, ...extra,
  });
}

const firstUserInput = "首句用户输入";

function writeTitleTranscript(appDataDir, conversationId, { large = false } = {}) {
  const logs = path.join(appDataDir, "brain", conversationId, ".system_generated", "logs");
  fs.mkdirSync(logs, { recursive: true });
  const line = JSON.stringify({ type: "USER_INPUT", content: firstUserInput }) + "\n";
  fs.writeFileSync(path.join(logs, "transcript.jsonl"), large ? line + " ".repeat(520 * 1024) + "\n" + line : line);
}

async function withHostTitleServer(respond, action) {
  const requests = [];
  const server = createServer(async (req, res) => {
    req.setEncoding("utf8");
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) };
    requests.push(request);
    respond(request, res);
  });
  clearNativeConversationTitleCache();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await action({ lsAddress: `127.0.0.1:${server.address().port}`, csrfToken: "fixture-csrf", requests });
  } finally {
    clearNativeConversationTitleCache();
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

test("studioStatus issues expiring single-use URLs without persisting or returning the session secret", t =>
  withDaemon("v023-launch", async ({ dir, home, baseUrl, daemon, rpc, rpcResult }) => {
    const workspace = project(dir, "project & # + 中文");
    const root = "Root & # + one";
    const child = seedThread(daemon.orchestrator, "member-launch", workspace, root);
    await rpcResult("setConversationPolicy", { conversationId: root, workspace, orchestrationMode: "complex" });
    const worktreePath = path.join(workspace, ".agent-tower", "worktrees", "w");
    fs.mkdirSync(worktreePath, { recursive: true });
    const treeRoot = "launch-worktree-root";
    seedThread(daemon.orchestrator, "member-launch-tree", worktreePath, treeRoot, { worktreePath });
    const treeLaunch = await rpcResult("studioStatus", { conversationId: treeRoot });
    assert.equal(normalPath(new URL(treeLaunch.launchUrl).searchParams.get("workspace")), normalPath(workspace));
    assert.equal((await rpc("studioStatus", {}, {})).status, 403);

    const launch = await rpcResult("studioStatus", { conversationId: child.id });
    assert.equal(launch.studioUrl, launch.launchUrl);
    assert.equal(launch.baseUrl, baseUrl);
    const url = new URL(launch.launchUrl);
    assert.ok(url.searchParams.get("launch"));
    assert.equal(url.searchParams.get("conversationId"), root);
    assert.equal(normalPath(url.searchParams.get("workspace")), normalPath(workspace));
    assert.equal(url.searchParams.has("auth"), false);
    const get = input => fetch(input, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    const explicit = await rpcResult("studioStatus", { conversationId: root, workspace });
    assert.equal(new URL(explicit.launchUrl).searchParams.get("workspace"), workspace);
    url.pathname = "/index.html";
    url.searchParams.set("conversationId", "stale-bookmark");
    url.searchParams.set("auth", "obsolete");
    const redeemed = await get(url);
    assert.equal(redeemed.status, 302);
    const cookie = redeemed.headers.get("set-cookie");
    assert.match(cookie, /^agent_tower_sid=[a-f0-9]+; HttpOnly; SameSite=Strict; Path=\/$/);
    const redirected = new URL(redeemed.headers.get("location"), baseUrl);
    assert.equal(redirected.pathname, "/");
    assert.deepEqual([...redirected.searchParams], [["conversationId", root], ["workspace", url.searchParams.get("workspace")]]);
    assert.equal((await get(url)).status, 401);
    assert.equal((await fetch(redirected, { headers: { Cookie: cookie.split(";")[0] } })).status, 200);
    const browserHeaders = { Cookie: cookie.split(";")[0] };
    const revisit = await fetch(url, { headers: browserHeaders, redirect: "manual" });
    assert.equal(revisit.status, 302);
    assert.ok(!/[?&](auth|launch)=/.test(revisit.headers.get("location")));
    const webChange = await rpc("setConversationPolicy", { conversationId: "browser-only", workspace, orchestrationMode: "relay" }, browserHeaders, "/api/rpc");
    assert.equal((await webChange.json()).ok, true);
    assert.equal((await rpcResult("getBootstrap")).suggestedConversationId, root, "网页调整模式不得抢占最近宿主会话");
    for (const route of ["/rpc", "/api/rpc"]) {
      assert.equal((await rpc("studioStatus", {}, { Cookie: cookie.split(";")[0] }, route)).status, 403);
    }
    const lease = fs.readFileSync(path.join(daemon.dataDir, "daemon-lease.json"), "utf8");
    assert.equal(lease.includes(cookie.split(/[=;]/)[1]), false);
    assert.equal(lease.includes("?auth="), false);
    assert.equal((await get(daemon.studioUrl)).status, 302, "legacy auth is still accepted in-process");

    const now = Date.now();
    const clock = t.mock.method(Date, "now", () => now);
    try {
      const expiring = await rpcResult("studioStatus", { workspace: home });
      clock.mock.mockImplementation(() => now + 300_000);
      assert.equal((await get(expiring.launchUrl)).status, 401);
    } finally { clock.mock.restore(); }

    const oldest = await rpcResult("studioStatus", {});
    let newest;
    for (let i = 0; i < 128; i++) newest = await rpcResult("studioStatus", {});
    assert.equal((await get(oldest.launchUrl)).status, 401);
    assert.equal((await get(newest.launchUrl)).status, 302);
  }));

test("project policy index reads case-insensitively, chooses the highest revision on a miss, and protects revision zero", () =>
  withProjectSandbox("v023-policies", dir => {
    const home = project(dir, "home");
    const other = project(dir, "other");
    const control = path.join(dir, "control");
    fs.mkdirSync(control);
    const store = openProjectStore(control, home);
    try {
      const created = store.setConversationPolicyRecord({ conversationId: "First", workspace: other, orchestrationMode: "complex", expectedPolicyRevision: 0 });
      assert.equal(created.policyRevision, 1);
      assert.equal(normalPath(store.getConversationPolicyRecord(" FIRST ").workspace), normalPath(other));
      assert.throws(() => store.setConversationPolicyRecord({ conversationId: "first", workspace: other, orchestrationMode: "relay", expectedPolicyRevision: 0 }), {
        code: "POLICY_REVISION_CONFLICT", details: { currentRevision: 1 },
      });
      const updated = store.setConversationPolicyRecord({ conversationId: "FIRST", workspace: other, orchestrationMode: "relay", expectedPolicyRevision: 1 });
      assert.deepEqual([updated.conversationId, updated.policyRevision], ["First", 2]);

      // Populate both fixtures after the store has indexed them, as a restart/reload race would.
      for (const [root, id, revisions] of [[home, "Case-Conflict", 1], [other, "case-conflict", 2]]) {
        const db = openOrchestratorDb(databasePath(root));
        try {
          for (let i = 0; i < revisions; i++) db.setConversationPolicyRecord({ conversationId: id, orchestrationMode: "complex", expectedPolicyRevision: i });
        } finally { db.close(); }
      }
      const found = store.getConversationPolicyRecord("CASE-CONFLICT");
      assert.equal(found.policyRevision, 2);
      assert.equal(normalPath(found.workspace), normalPath(other));
      assert.deepEqual(store.listConversationPolicies().filter(p => p.conversationId.toLowerCase() === "case-conflict"), [found]);

      const external = new DatabaseSync(databasePath(home));
      try {
        external.prepare("UPDATE conversation_policies SET policy_revision=3 WHERE conversation_id=?").run("Case-Conflict");
        external.prepare("INSERT INTO conversation_policies SELECT ?, orchestration_mode, dispatch_enabled, 1, source, updated_at FROM conversation_policies WHERE conversation_id=?").run("case-conflict", "Case-Conflict");
      } finally { external.close(); }
      assert.equal(store.getConversationPolicyRecord("case-conflict").policyRevision, 3);
      assert.throws(() => store.setConversationPolicyRecord({ conversationId: "case-conflict", expectedPolicyRevision: 2 }), { code: "POLICY_REVISION_CONFLICT", details: { currentRevision: 3 } });
      store.setConversationPolicyRecord({ conversationId: "Move-Target", orchestrationMode: "direct" });
      store.setConversationPolicyRecord({ conversationId: "MOVE-TARGET", workspace: other, orchestrationMode: "complex", expectedPolicyRevision: 1 });
      assert.equal(store.getConversationPolicyRecord("move-target").policyRevision, 2);
      assert.equal(normalPath(store.getConversationPolicyRecord("move-target").workspace), normalPath(other));
    } finally { store.close(); }

    const reopened = openProjectStore(control, home);
    try {
      assert.equal(reopened.getConversationPolicyRecord("case-conflict").policyRevision, 3);
      assert.equal(normalPath(reopened.getConversationPolicyRecord("move-target").workspace), normalPath(other));
    }
    finally { reopened.close(); }
  }));

test("bootstrap keeps unbound views empty and recommends only available recent or unique host conversations", t =>
  withDaemon("v023-bootstrap", async ({ dir, home, daemon, rpcResult }) => {
    const other = project(dir, "other");
    const specs = path.join(other, ".agent-tower", "spec", "02-coding");
    fs.mkdirSync(specs, { recursive: true });
    fs.writeFileSync(path.join(specs, "workspace.md"), "# Bound project rules\n\nProject-only example.\n");
    const o = daemon.orchestrator;
    const first = "thread-root-a";
    const second = "policy-root-b";
    const hostOnly = "pre-invocation-only-c";
    const member = seedThread(o, "member-bootstrap", home, first);
    o.db.upsertRuntimeRequest({ id: "request-bootstrap", threadId: member.id, title: "Bound only" });
    assert.equal((await o.getBootstrap()).suggestedConversationId, first);

    const requestedModes = ["complex", "relay"];
    const updates = await Promise.allSettled(requestedModes.map(orchestrationMode =>
      o.setConversationPolicy({ conversationId: second, workspace: other, orchestrationMode, expectedPolicyRevision: 0 })));
    assert.equal(updates.filter(update => update.status === "fulfilled").length, 1);
    assert.equal(updates.find(update => update.status === "rejected")?.reason.code, "POLICY_REVISION_CONFLICT");
    const winningMode = requestedModes[updates.findIndex(update => update.status === "fulfilled")];
    const unbound = await o.getBootstrap();
    assert.equal(unbound.bindingRequired, true);
    for (const field of ["threads", "boardMessages", "collaborationEdges", "pendingRequests", "worktrees", "activeRuns"]) {
      assert.deepEqual(unbound[field], [], field);
    }
    assert.equal(unbound.suggestedConversationId, second);
    const candidate = unbound.availableConversations.find(c => c.rootConversationId === second);
    assert.deepEqual([normalPath(candidate.projectRoot), candidate.projectName, candidate.memberCount, candidate.isRecentHost], [normalPath(other), "other", 0, true]);
    assert.ok(candidate.title);

    const bound = await o.getBootstrap({ conversationId: second.toUpperCase() });
    assert.equal(bound.bindingRequired, false);
    assert.equal(bound.activeMode.orchestrationMode, winningMode);
    assert.equal(normalPath(bound.workspace), normalPath(other));
    assert.deepEqual(bound.projectSpecs.map(spec => spec.key), ["coding/workspace"]);
    assert.deepEqual(bound.availableConversations.map(c => c.rootConversationId).sort(), [first, second].sort());
    const scoped = await o.getBootstrap({ workspace: home, conversationId: first });
    assert.equal(scoped.suggestedConversationId, first);
    assert.deepEqual(scoped.availableConversations.map(c => c.rootConversationId), [first]);
    assert.deepEqual(scoped.pendingRequests.map(r => r.id), ["request-bootstrap"]);
    assert.equal(normalPath((await o.getBootstrap({ conversationId: first })).workspace), normalPath(home));

    const subdir = path.join(other, "src");
    fs.mkdirSync(subdir);
    await rpcResult("getConversationPolicy", { conversationId: hostOnly, workspace: subdir, syncHostPlaybook: true });
    await rpcResult("getConversationPolicy", { conversationId: member.id, workspace: home, syncHostPlaybook: true });
    const recentHost = await o.getBootstrap();
    assert.equal(recentHost.suggestedConversationId, hostOnly);
    assert.ok(recentHost.availableConversations.some(c => c.rootConversationId === hostOnly && c.isRecentHost));
    assert.equal((await o.getBootstrap({ workspace: other })).suggestedConversationId, hostOnly);
    assert.equal(normalPath((await o.getBootstrap({ conversationId: hostOnly })).workspace), normalPath(other));
    const clock = t.mock.method(Date, "now", () => recentHost.availableConversations.find(c => c.isRecentHost).lastUpdatedAt + 30 * 60 * 1000);
    try {
      const pastTtl = await o.getBootstrap();
      assert.equal(pastTtl.suggestedConversationId, null);
      assert.ok(!pastTtl.availableConversations.some(c => c.isRecentHost));
    } finally { clock.mock.restore(); }

    const explicitHost = "host-request-root";
    await rpcResult("updateHostContext", { conversationId: explicitHost, workspace: other });
    assert.equal((await o.getBootstrap()).suggestedConversationId, explicitHost);
  }));

test("Studio uses host titles and project names in bootstrap, events, and conversation choices", () =>
  withDaemon("v023-host-title", async ({ home, appDataDir, daemon, rpcResult }) => {
    const annotated = "host-title-annotation";
    const summarized = "host-title-summary";
    const annotationTitle = "规划 Studio 顶栏";
    const summaryTitle = "🚀".repeat(80) + "…";
    for (const conversationId of [annotated, summarized]) {
      writeTitleTranscript(appDataDir, conversationId, { large: conversationId === summarized });
      seedThread(daemon.orchestrator, `thread-${conversationId}`, home, conversationId, { hostConversationId: conversationId });
    }
    assert.equal(readNativeConversationTitle(annotated, appDataDir), firstUserInput);
    await withHostTitleServer(({ body }, res) => {
      const payload = body.conversationId === annotated
        ? { conversation: { annotations: { title: "  规划\n Studio\t顶栏  " }, state: { summary: "备用摘要" } } }
        : { annotations: { title: "  " }, state: { summary: "🚀".repeat(81) } };
      res.end(JSON.stringify(payload));
    }, async ({ lsAddress, csrfToken, requests }) => {
      daemon.orchestrator.updateHostContext({ lsAddress, csrfToken });

      const events = await rpcResult("getEvents", { conversationId: summarized, workspace: home });
      assert.equal(events.conversationTitle, summaryTitle);
      assert.equal(events.projectName, "home");
      assert.equal(events.threadDigest.find(t => t.id === `thread-${summarized}`)?.title, summaryTitle);

      const boot = await rpcResult("getBootstrap", { conversationId: annotated });
      assert.equal(boot.conversationTitle, annotationTitle);
      assert.equal(boot.projectName, "home");
      assert.deepEqual(new Map(boot.availableConversations.map(c => [c.conversationId, [c.title, c.projectName]])),
        new Map([[annotated, [annotationTitle, "home"]], [summarized, [summaryTitle, "home"]]]));
      assert.equal(readNativeConversationTitle(annotated, appDataDir), annotationTitle);
      const polled = await rpcResult("getEvents", { conversationId: annotated, workspace: home });
      assert.equal(polled.conversationTitle, annotationTitle);
      assert.equal(polled.projectName, "home");
      assert.deepEqual(polled.events.filter(e => e.type === "title_updated").map(e => e.title), [annotationTitle]);

      assert.deepEqual(requests.map(r => r.body), [{ conversationId: summarized }, { conversationId: annotated }]);
      for (const request of requests) {
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/product.v1.ConversationService/GetConversation");
        assert.equal(request.headers["content-type"], "application/json");
        assert.equal(request.headers["connect-protocol-version"], "1");
        assert.equal(request.headers["x-antigravity-csrf-token"], csrfToken);
      }
      assert.equal((await rpcResult("getEvents", {})).projectName, null);

      for (let i = 0; i < 13; i++) seedThread(daemon.orchestrator, `candidate-${i}`, home, `extra-title-${i}`);
      clearNativeConversationTitleCache();
      requests.length = 0;
      const unbound = await rpcResult("getBootstrap");
      assert.equal(unbound.projectName, null);
      assert.equal(unbound.availableConversations.length, 15);
      const [hostChoices, diskChoices] = [unbound.availableConversations.slice(0, 12), unbound.availableConversations.slice(12)];
      assert.deepEqual(requests.map(r => r.body.conversationId).sort(), hostChoices.map(c => c.conversationId).sort());
      assert.ok(diskChoices.every(c => c.title !== summaryTitle && c.title !== annotationTitle));
    });
  }));

test("host title lookups share requests and retain the last title through a temporary failure", t =>
  withProjectSandbox("v023-title-cache", async appDataDir => {
    const conversationId = "host-cache-title";
    const title = "旧宿主标题";
    writeTitleTranscript(appDataDir, conversationId);
    let available = true;
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    await withHostTitleServer((_, res) => {
      res.statusCode = available ? 200 : 503;
      res.end(JSON.stringify({ annotations: { title } }));
    }, async ({ lsAddress, csrfToken, requests }) => {
      const options = { lsAddress, csrfToken, skipRootResolve: true };
      const resolveTitle = (id = conversationId) => resolveNativeConversationTitleAsync(id, appDataDir, options);
      assert.deepEqual(await Promise.all([resolveTitle(), resolveTitle(conversationId.toUpperCase())]), [title, title]);
      assert.equal(requests.length, 1);
      const otherProfile = path.join(appDataDir, "other-profile");
      writeTitleTranscript(otherProfile, conversationId);
      assert.equal(await resolveNativeConversationTitleAsync(conversationId, otherProfile), firstUserInput);
      assert.equal(readNativeConversationTitle(conversationId, otherProfile), firstUserInput);

      available = false;
      now += 14_999;
      assert.equal(await resolveTitle(), title);
      assert.equal(requests.length, 1);
      now += 1;
      assert.equal(await resolveTitle(), title);
      now += 4_999;
      assert.equal(await resolveTitle(), title);
      assert.equal(peekCachedHostConversationTitle(conversationId.toUpperCase()), title);
      assert.equal(requests.length, 2);
      now += 1;
      assert.equal(await resolveTitle(), title);
      assert.equal(requests.length, 3);

      now += 280_000;
      assert.equal(peekCachedHostConversationTitle(conversationId), "");
      assert.equal(await resolveTitle(), firstUserInput);
      assert.equal(requests.length, 4);
    });
  }));

test("host title lookups skip invalid addresses or credentials and cache timeout or empty results", t =>
  withProjectSandbox("v023-title-fallback", async appDataDir => {
    const conversationId = "host-timeout-title";
    writeTitleTranscript(appDataDir, conversationId);
    const mockedFetch = t.mock.method(globalThis, "fetch", () => Promise.reject(new Error("unexpected request")));
    try {
      for (const [lsAddress, csrfToken] of [
        ["192.0.2.1:12345", "token"], ["127.0.0.1:12345/path", "token"], ["127.0.0.1:12345", "  "],
      ]) {
        assert.equal(await resolveNativeConversationTitleAsync(conversationId, appDataDir, { lsAddress, csrfToken }), firstUserInput);
      }
      assert.equal(mockedFetch.mock.callCount(), 0);
    } finally {
      mockedFetch.mock.restore();
    }

    await withHostTitleServer(({ body }, res) => {
      if (body.conversationId !== conversationId) res.end("{}");
    }, async ({ lsAddress, csrfToken, requests }) => {
      const options = { lsAddress, csrfToken, timeoutMs: 250 };
      for (let i = 0; i < 2; i++) {
        assert.equal(await resolveNativeConversationTitleAsync(conversationId, appDataDir, options), firstUserInput);
        assert.equal(await resolveNativeConversationTitleAsync("missing-host-title", appDataDir, options), "");
      }
      assert.deepEqual(requests.map(r => r.body.conversationId), [conversationId, "missing-host-title"]);
    });
  }));

async function openStream(baseUrl, headers, params) {
  const abort = new AbortController();
  const url = new URL("/api/stream", baseUrl);
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, { headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const frames = [];
  let buffer = "";
  return {
    frames,
    close: () => abort.abort(),
    async until(predicate) {
      while (true) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          assert.match(frame, /^event: orch\ndata: /);
          const event = JSON.parse(frame.slice("event: orch\ndata: ".length));
          frames.push(event);
          if (predicate(event)) return event;
        } else {
          const { done, value } = await reader.read();
          assert.equal(done, false, "SSE ended before the expected frame");
          buffer += value;
        }
      }
    },
  };
}

test("SSE sends a scoped initial snapshot and isolates live and replayed swarm and worktree events", () =>
  withDaemon("v023-sse", async ({ home, appDataDir, baseUrl, auth, daemon, rpcResult }) => {
    const o = daemon.orchestrator;
    const first = "12345678-0000-4000-8000-123456789abc";
    const second = "23456789-0000-4000-8000-123456789abc";
    const worktree = await createIsolatedWorktree({ cwd: home, taskSlug: "sse-cleanup" });
    const cached = await createIsolatedWorktree({ cwd: home, taskSlug: "sse-runtime-cache" });
    seedThread(o, "cleanup-member", home, first, { worktreePath: worktree.worktreePath });
    seedThread(o, "cache-member", home, first, { worktreePath: cached.worktreePath });
    await rpcResult("setConversationPolicy", { conversationId: first, workspace: home, orchestrationMode: "complex" });
    await rpcResult("setConversationPolicy", { conversationId: second, workspace: home, orchestrationMode: "relay" });
    const sinceSeq = o.db.getLatestSeq();
    const subscribe = (conversationId, seq = sinceSeq) => openStream(baseUrl, auth, { conversationId, appDataDir, sinceSeq: seq });
    const streamA = await subscribe(first);
    try {
      const streamB = await subscribe(second);
      try {
        for (const [stream, id, mode] of [[streamA, first, "complex"], [streamB, second, "relay"]]) {
          const frame = await stream.until(e => Array.isArray(e.events));
          assert.deepEqual(stream.frames.map(e => e.type), ["connected", undefined]);
          assert.deepEqual(frame.events, []);
          assert.equal(frame.rootConversationId, id);
          assert.equal(frame.latestSeq, sinceSeq);
          assert.equal(frame.conversationPolicy.orchestrationMode, mode);
          assert.equal(frame.activeMode.orchestrationMode, mode);
          for (const field of ["boardMessages", "collaborationEdges", "healthIncidents"]) assert.ok(Array.isArray(frame[field]));
          assert.ok(frame.stats);
        }

        const swarmDir = path.join(appDataDir, "brain", first, ".system_generated", "swarm");
        fs.mkdirSync(swarmDir, { recursive: true });
        fs.writeFileSync(path.join(swarmDir, "members.json"), JSON.stringify({ title: "SSE roster", members: {
          coordinator: { role: "coordinator", conversation_id: first },
        } }));
        const logs = path.join(swarmDir, "..", "logs");
        fs.mkdirSync(logs);
        fs.writeFileSync(path.join(logs, "transcript.jsonl"), "");
        await o.getEvents({ conversationId: first, appDataDir });
        const swarm = await streamA.until(e => e.type === "swarm_snapshot");
        assert.equal(swarm.rootConversationId, first);
        assert.equal(o.matchesEventConversation({ swarm: { rootConversationId: first } }, first), true);
        assert.equal(o.matchesEventConversation({ swarm: { rootConversationId: first } }, second), false);

        await rpcResult("cleanupWorktree", { worktreePath: worktree.worktreePath });
        const cleanup = await streamA.until(e => e.type === "worktree_updated");
        assert.deepEqual([cleanup.rootConversationId, cleanup.threadId, cleanup.cleaned], [first, "cleanup-member", true]);
        assert.equal(o.db.getThread("cleanup-member").worktreePath, "");
        await rpcResult("cleanRuntimeCache", { workspace: home });
        const cache = await streamA.until(e => e.type === "worktree_updated" && e.runtimeCache);
        assert.deepEqual([cache.rootConversationId, cache.threadId, cache.worktreePaths.map(normalPath)], [first, "cache-member", [normalPath(cached.worktreePath)]]);

        // A later event on B proves its stream reached the same point without disclosing A's events.
        await rpcResult("setConversationPolicy", { conversationId: second, orchestrationMode: "direct" });
        await streamB.until(e => e.type === "conversation_policy_updated");
        assert.ok(!streamB.frames.some(e => e.rootConversationId === first || ["swarm_snapshot", "worktree_updated"].includes(e.type)));

        const getEvents = o.getEvents;
        let injectPendingPolicy = true;
        o.getEvents = async params => {
          const page = await getEvents(params);
          if (injectPendingPolicy) {
            injectPendingPolicy = false;
            await o.setConversationPolicy({ conversationId: first, orchestrationMode: "relay" });
          }
          return page;
        };
        const replay = await subscribe(first, sinceSeq);
        try {
          const snapshot = await replay.until(e => Array.isArray(e.events));
          assert.equal(snapshot.activeMode.orchestrationMode, "complex");
          const pending = await replay.until(e => e.type === "conversation_policy_updated");
          assert.equal(pending.activeMode.orchestrationMode, "relay");
          assert.ok(pending.seq > snapshot.latestSeq);
          const events = replay.frames.filter(e => ["swarm_snapshot", "worktree_updated"].includes(e.type));
          assert.ok(events.some(e => e.seq === swarm.seq));
          assert.ok(events.some(e => e.seq === cleanup.seq));
          assert.ok(events.some(e => e.seq === cache.seq));
          assert.ok(events.every(e => e.rootConversationId === first && e.seq <= snapshot.latestSeq));
        } finally { o.getEvents = getEvents; replay.close(); }
      } finally { streamB.close(); }
    } finally { streamA.close(); }
  }));
