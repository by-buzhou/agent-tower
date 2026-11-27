import { closeSync, constants, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assertReadOnlySupport } from "../catalog.mjs";
export { buildAgyPinnedModelId } from "../catalog.mjs";
import { captureNoWindow, classifyErrorCategory, resolveHostAgentApiBinary, safeEngineError } from "./proc-utils.mjs";

const UUID_REGEX = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
const NAME_RUNE_RE = /[\p{L}\p{Nd}_-]/u;

function hasMentionToken(lowerText, lowerName) {
  if (!lowerName) return false;
  for (let i = lowerText.indexOf("@"); i >= 0; i = lowerText.indexOf("@", i + 1)) {
    if (i > 0) {
      const before = [...lowerText.slice(Math.max(0, i - 2), i)].pop();
      if (NAME_RUNE_RE.test(before)) continue;
    }
    if (!lowerText.startsWith(lowerName, i + 1)) continue;
    const j = i + 1 + lowerName.length;
    if (j >= lowerText.length) return true;
    const nextCp = lowerText.codePointAt(j);
    if (!NAME_RUNE_RE.test(String.fromCodePoint(nextCp))) return true;
  }
  return false;
}

function extractMentionsFromText(text = "", memberNames = []) {
  const lower = String(text || "").toLowerCase();
  const mentions = [];
  for (const name of memberNames) {
    const ln = String(name || "").toLowerCase();
    if (!ln) continue;
    if (hasMentionToken(lower, ln)) {
      mentions.push(name);
      continue;
    }
    const prefixMatch = /^(.+)-\d+$/.exec(ln);
    if (prefixMatch && hasMentionToken(lower, prefixMatch[1])) {
      mentions.push(name);
    }
  }
  return {
    mentions,
    all: hasMentionToken(lower, "all"),
  };
}

function parseBoardTimestampMs(timeStr) {
  if (!timeStr) return Date.now();
  const parsed = Date.parse(String(timeStr).trim().replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function buildShortModelDisplayName(rawModel = "") {
  const s = String(rawModel || "").trim();
  if (!s) return "";
  const map = {
    "gemini-4-carbon-high": "Carbon High",
    "gemini-4-carbon-medium": "Carbon Med",
    "gemini-4-carbon-low": "Carbon Low",
    "gemini-4-hydrogen-high": "Hydrogen High",
    "gemini-4-hydrogen-xhigh": "Hydrogen XHigh",
    "gemini-4-hydrogen-medium": "Hydrogen Med",
    "gemini-4-hydrogen-low": "Hydrogen Low",
    "gemini-4-argon-high": "Argon High",
    "gemini-4-argon-medium": "Argon Med",
    "gemini-pro-orchestrator": "Orchestrator",
  };
  if (map[s.toLowerCase()]) return map[s.toLowerCase()];
  return s;
}

function mapSwarmMemberState(rawMember = {}, transcriptSummary = null) {
  if (rawMember.killed) return "killed";
  if (typeof transcriptSummary?.idle === "boolean") {
    return transcriptSummary.idle ? "waiting" : "working";
  }
  const wake = String(rawMember.wake_mode || "").toLowerCase();
  if (wake === "mentions" || wake === "anything") return "waiting";
  return "working";
}

const idleTranscriptCache = new Map();
const subagentEntryScanCache = new Map();
const conversationTitleCache = new Map();
const hostConversationTitleCache = new Map();
const inFlightHostTitleLookups = new Map();
const NOFOLLOW_READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const swarmRosterCache = new Map();
const swarmBrainIndexCache = new Map();
const swarmWorkerLocationCache = new Map();

function rememberTranscriptResult(cache, key, entry, limit = 512) {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > limit) cache.delete(cache.keys().next().value);
  return entry.result;
}

function summarizeIdleTail(transcriptPath, size, maxBytes) {
  let text = readTailTextSync(transcriptPath, maxBytes);
  if (size > maxBytes) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
  }
  // Ignore a partially flushed JSONL record at the end.
  const lines = text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter((line) => line.trim());
  const results = [];
  let idle = lines.length ? false : null;
  let hasPlanner = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    let step;
    try {
      step = JSON.parse(lines[i]);
    } catch {
      break;
    }
    if (!step || typeof step !== 'object') break;
    if (step.type === 'GENERIC') {
      results.push(step);
      continue;
    }
    if (step.type !== 'PLANNER_RESPONSE') break;
    hasPlanner = true;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (!calls.length) {
      idle = results.length === 0;
    } else {
      const waitIdx = calls.findIndex((call) => call?.name === 'swarm_wait');
      idle = waitIdx >= 0 && results.length >= calls.length && results[results.length - 1 - waitIdx]?.status === 'DONE';
    }
    break;
  }
  return { idle, steps: lines.length, hasPlanner };
}

function summarizeTranscriptIdleSync(transcriptPath) {
  try {
    const st = statSync(transcriptPath);
    const fingerprint = `${st.mtimeMs}:${st.size}`;
    const cached = idleTranscriptCache.get(transcriptPath);
    if (cached?.fingerprint === fingerprint) return cached.result;
    let summary = summarizeIdleTail(transcriptPath, st.size, 65536);
    if (!summary.hasPlanner && st.size > 65536) {
      summary = summarizeIdleTail(transcriptPath, st.size, 262144);
    }
    const result = { mtime: st.mtimeMs, idle: summary.idle, steps: summary.steps };
    return rememberTranscriptResult(idleTranscriptCache, transcriptPath, { fingerprint, result });
  } catch {
    return null;
  }
}

function swarmFileFingerprint(filePath) {
  try {
    const stat = statSync(filePath);
    return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : "";
  } catch {
    return "";
  }
}

function readSwarmRosterCached(membersFile, fingerprint) {
  const cached = swarmRosterCache.get(membersFile);
  if (cached?.fingerprint === fingerprint) return cached.result;
  try {
    const parsed = JSON.parse(readFileSync(membersFile, "utf-8"));
    const members = parsed?.members && typeof parsed.members === "object" ? parsed.members : {};
    return rememberTranscriptResult(swarmRosterCache, membersFile, { fingerprint, result: members });
  } catch {
    return null;
  }
}

function readSwarmBrainIndex(brainDir) {
  let entries;
  try {
    entries = readdirSync(brainDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { byWorker: new Map() };
  }
  const files = entries.map((rootConversationId) => {
    const swarmDir = path.join(brainDir, rootConversationId, ".system_generated", "swarm");
    const membersFile = path.join(swarmDir, "members.json");
    return {
      rootConversationId,
      swarmDir,
      membersFile,
      fingerprint: swarmFileFingerprint(membersFile),
    };
  });
  const fingerprint = JSON.stringify(files.map((file) => [file.rootConversationId, file.fingerprint]));
  const cached = swarmBrainIndexCache.get(brainDir);
  if (cached?.fingerprint === fingerprint) return cached.result;

  const byWorker = new Map();
  for (const file of files) {
    if (!file.fingerprint) continue;
    const members = readSwarmRosterCached(file.membersFile, file.fingerprint);
    if (!members) continue;
    for (const member of Object.values(members)) {
      const workerId = String(member?.conversation_id || "").trim().toLowerCase();
      if (!workerId) continue;
      byWorker.set(workerId, {
        membersFile: file.membersFile,
        fingerprint: file.fingerprint,
        location: {
          appDataDir: path.dirname(brainDir),
          rootConversationId: file.rootConversationId,
          swarmDir: file.swarmDir,
        },
      });
    }
  }
  return rememberTranscriptResult(swarmBrainIndexCache, brainDir, { fingerprint, result: { byWorker } });
}

/**
 * Resolve native Antigravity `/swarm` root directory from either a coordinator conversationId
 * or any worker conversationId listed in `<appDataDir>/brain/<rootConvId>/.system_generated/swarm/members.json`.
 */
export function resolveNativeSwarmLocation(conversationId, appDataDir) {
  const convId = String(conversationId || "").trim();
  const rootDir = resolveDefaultAppDataDir(appDataDir);
  if (!convId || !existsSync(rootDir)) return null;

  const directSwarmDir = path.join(rootDir, "brain", convId, ".system_generated", "swarm");
  if (existsSync(path.join(directSwarmDir, "members.json"))) {
    return { appDataDir: rootDir, rootConversationId: convId, swarmDir: directSwarmDir };
  }

  const brainDir = path.join(rootDir, "brain");
  if (!existsSync(brainDir)) return null;
  const workerId = convId.toLowerCase();
  const cacheKey = `${brainDir}\0${workerId}`;
  const cached = swarmWorkerLocationCache.get(cacheKey);
  if (cached) {
    const fingerprint = swarmFileFingerprint(cached.membersFile);
    if (fingerprint && fingerprint === cached.fingerprint) return cached.result;
    swarmWorkerLocationCache.delete(cacheKey);
  }

  const hit = readSwarmBrainIndex(brainDir).byWorker.get(workerId);
  if (!hit || swarmFileFingerprint(hit.membersFile) !== hit.fingerprint) return null;
  return rememberTranscriptResult(swarmWorkerLocationCache, cacheKey, {
    membersFile: hit.membersFile,
    fingerprint: hit.fingerprint,
    result: hit.location,
  });
}

/**
 * Read native Antigravity `/swarm` members, board messages, and directed @mention collaboration edges
 * from `<appDataDir>/brain/<rootConvId>/.system_generated/swarm/{members.json, board.jsonl}`.
 */
export function readNativeSwarmSnapshot({
  conversationId,
  appDataDir,
} = {}) {
  const loc = resolveNativeSwarmLocation(conversationId, appDataDir);
  if (!loc) {
    return {
      found: false,
      rootConversationId: "",
      title: "",
      head: 0,
      members: [],
      messages: [],
      edges: [],
    };
  }

  let roster = { title: "", members: {} };
  try {
    const rawMembers = JSON.parse(readFileSync(path.join(loc.swarmDir, "members.json"), "utf-8"));
    if (rawMembers && typeof rawMembers === "object") {
      roster = {
        title: String(rawMembers.title || ""),
        members: rawMembers.members && typeof rawMembers.members === "object" ? rawMembers.members : {},
      };
    }
  } catch {
    return {
      found: false,
      rootConversationId: loc.rootConversationId,
      title: "",
      head: 0,
      members: [],
      messages: [],
      edges: [],
    };
  }

  const memberNames = Object.keys(roster.members).filter(
    (n) => roster.members[n] && typeof roster.members[n] === "object"
  );

  const rawMsgs = [];
  const boardFile = path.join(loc.swarmDir, "board.jsonl");
  if (existsSync(boardFile)) {
    try {
      const lines = readFileSync(boardFile, "utf-8").split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === "object") rawMsgs.push(obj);
        } catch {}
      }
    } catch {}
  }

  const edgeMap = new Map();
  const postsByMember = new Map();
  const messages = rawMsgs.map((m, idx) => {
    const seq = Number(m.seq) || idx + 1;
    const agent = String(m.agent || "");
    const text = String(m.text || "");
    const time = String(m.time || "");
    const ts = parseBoardTimestampMs(time);
    const kind = String(m.kind || "");
    const { mentions, all } = extractMentionsFromText(text, memberNames);
    const filteredMentions = mentions.filter((n) => n !== agent);

    const p = postsByMember.get(agent) || { posts: 0, lastPostSeq: 0, lastPostTime: "", lastPostTs: null };
    postsByMember.set(agent, {
      posts: p.posts + 1,
      lastPostSeq: seq,
      lastPostTime: time,
      lastPostTs: ts,
    });

    const targets = new Set(all ? memberNames : filteredMentions);
    targets.delete(agent);
    for (const to of targets) {
      const targetRole = String(roster.members[to]?.role || "").toLowerCase();
      if (targetRole === "monitor" || targetRole === "narrator") continue;
      const agentRole = String(roster.members[agent]?.role || "").toLowerCase();
      if (agentRole === "monitor" || agentRole === "narrator") continue;
      const edgeKey = `${agent}\0${to}`;
      const cur = edgeMap.get(edgeKey) || {
        from: agent,
        to,
        count: 0,
        direct: 0,
        viaAll: 0,
        kind: "mention",
      };
      cur.count++;
      if (filteredMentions.includes(to)) cur.direct++;
      else cur.viaAll++;
      edgeMap.set(edgeKey, cur);
    }

    const senderConvId = String(roster.members[agent]?.conversation_id || "").trim();
    const senderModel = String(roster.members[agent]?.applied_model || roster.members[agent]?.model || "").trim();

    return {
      seq,
      agent,
      mentions: filteredMentions,
      all: Boolean(all),
      text,
      time,
      ts,
      kind,
      conversationId: senderConvId,
      model: senderModel,
      modelDisplayName: buildShortModelDisplayName(senderModel),
      source: "native-swarm",
    };
  });

  const members = memberNames.map((name) => {
    const m = roster.members[name];
    const memberConvId = String(m.conversation_id || "").trim();
    const trSummary = memberConvId
      ? summarizeTranscriptIdleSync(resolveTranscriptPath(memberConvId, loc.appDataDir))
      : null;
    const rawModel = String(m.applied_model || m.desired_model || m.model || "").trim();
    const role = String(m.role || "worker");
    const isCoordinator = role === "coordinator" || memberConvId === loc.rootConversationId;
    const state = mapSwarmMemberState(m, trSummary);
    const postStats = postsByMember.get(name) || {
      posts: 0,
      lastPostSeq: 0,
      lastPostTime: "",
      lastPostTs: null,
    };

    return {
      name,
      memberName: name,
      role,
      model: rawModel,
      model_display_name: buildShortModelDisplayName(rawModel),
      state,
      killed: Boolean(m.killed),
      wake_mode: String(m.wake_mode || ""),
      phase: String(m.phase || ""),
      conversation_id: memberConvId,
      parentConversationId: isCoordinator ? null : loc.rootConversationId,
      rootConversationId: loc.rootConversationId,
      steps: trSummary?.steps || 0,
      transcriptMtime: trSummary?.mtime || 0,
      ...postStats,
    };
  });

  members.sort(
    (a, b) =>
      (a.role === "coordinator" ? 0 : 1) - (b.role === "coordinator" ? 0 : 1) ||
      a.name.localeCompare(b.name)
  );

  const head = messages.length ? messages[messages.length - 1].seq : 0;

  return {
    found: true,
    appDataDir: loc.appDataDir,
    rootConversationId: loc.rootConversationId,
    swarmDir: loc.swarmDir,
    title: roster.title,
    head,
    members,
    messages,
    edges: [...edgeMap.values()],
  };
}

function readTailTextSync(filePath, maxBytes = 12288) {
  try {
    const st = statSync(filePath);
    if (st.size <= 0) return "";
    const readSize = Math.min(st.size, maxBytes);
    const offset = Math.max(0, st.size - readSize);
    const buf = Buffer.allocUnsafe(readSize);
    const fd = openSync(filePath, NOFOLLOW_READ);
    try {
      const actual = readSync(fd, buf, 0, readSize, offset);
      return buf.subarray(0, actual).toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

function readHeadTextSync(filePath, maxBytes = 24576) {
  try {
    const st = statSync(filePath);
    if (st.size <= 0) return "";
    const readSize = Math.min(st.size, maxBytes);
    const buf = Buffer.allocUnsafe(readSize);
    const fd = openSync(filePath, NOFOLLOW_READ);
    try {
      const actual = readSync(fd, buf, 0, readSize, 0);
      return buf.subarray(0, actual).toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

const SUBAGENT_SCAN_CHUNK_BYTES = 64 * 1024;

const SUBAGENT_SCAN_HEAD_BYTES = 4 * 1024 * 1024;
const SUBAGENT_SCAN_TAIL_BYTES = 2 * 1024 * 1024;

function scanSubagentTranscript(item, needle) {
  const ranges = [];
  const truncated = item.size > SUBAGENT_SCAN_HEAD_BYTES + SUBAGENT_SCAN_TAIL_BYTES;
  if (truncated) ranges.push([0, SUBAGENT_SCAN_HEAD_BYTES], [item.size - SUBAGENT_SCAN_TAIL_BYTES, item.size]);
  else ranges.push([0, item.size]);
  const overlap = Math.max(Buffer.byteLength(needle), "invoke_subagent".length) - 1;
  const fd = openSync(item.trPath, NOFOLLOW_READ);
  try {
    for (const [rangeStart, rangeEnd] of ranges) {
      let pendingCalls = [];
      const inspectLine = line => {
        if (!line.trim()) return false;
        const lower = line.toLowerCase();
        const hasNeedle = lower.includes(needle);
        const hasInvoke = lower.includes("invoke_subagent");
        if (!hasNeedle && !hasInvoke) {
          if (lower.includes('"user_input"') || lower.includes('"planner_response"')) pendingCalls = [];
          else if (lower.includes('"generic"') && pendingCalls.length) pendingCalls.shift();
          return false;
        }
        let step;
        try {
          step = JSON.parse(line);
        } catch {
          return false;
        }
        if (!step || typeof step !== "object") return false;
        if (step.type === "PLANNER_RESPONSE") {
          const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
          pendingCalls = calls.map(call => String(call?.name || ""));
          return false;
        }
        if (step.type === "USER_INPUT") {
          pendingCalls = [];
          return false;
        }
        if (step.type === "GENERIC" && pendingCalls.length) {
          const toolName = pendingCalls.shift();
          return toolName === "invoke_subagent" && typeof step.content === "string" && step.content.toLowerCase().includes(needle);
        }
        return false;
      };

      let nextOffset = rangeStart;
      let carry = Buffer.alloc(0);
      while (nextOffset < rangeEnd) {
        const readStart = Math.max(rangeStart, nextOffset - overlap);
        const readEnd = Math.min(rangeEnd, nextOffset + SUBAGENT_SCAN_CHUNK_BYTES);
        const buffer = Buffer.allocUnsafe(readEnd - readStart);
        const actual = readSync(fd, buffer, 0, buffer.length, readStart);
        if (readStart + actual <= nextOffset) return { matched: false, truncated: true };
        const fresh = buffer.subarray(nextOffset - readStart, actual);
        nextOffset = readStart + actual;
        const data = Buffer.concat([carry, fresh]);
        const lastNewline = data.lastIndexOf(0x0a);
        if (lastNewline < 0) {
          carry = data;
          continue;
        }
        carry = data.subarray(lastNewline + 1);
        for (const line of data.subarray(0, lastNewline).toString("utf8").split(/\r?\n/)) {
          if (inspectLine(line)) return { matched: true, truncated };
        }
      }
      if (carry.length && inspectLine(carry.toString("utf8"))) return { matched: true, truncated };
    }
    return { matched: false, truncated };
  } finally {
    closeSync(fd);
  }
}

function isConversationInvokedAsSubagentSync(targetConvId, rootDir) {
  const brainDir = path.join(rootDir, "brain");
  if (!existsSync(brainDir) || !targetConvId) return "";
  const needle = targetConvId.toLowerCase();
  try {
    const entries = readdirSync(brainDir, { withFileTypes: true })
      .map((ent) => {
        if (!ent.isDirectory() || ent.name.toLowerCase() === needle) return null;
        const trPath = path.join(brainDir, ent.name, ".system_generated", "logs", "transcript.jsonl");
        if (!existsSync(trPath)) return null;
        try {
          const { mtimeMs, size } = statSync(trPath);
          return { convId: ent.name, trPath, mtimeMs, size };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 24);

    let incomplete = false;
    for (const item of entries) {
      const key = `${item.trPath}\0${needle}`;
      const fingerprint = `${item.mtimeMs}:${item.size}`;
      try {
        let entry = subagentEntryScanCache.get(key);
        if (entry?.fingerprint !== fingerprint) {
          entry = { fingerprint, ...scanSubagentTranscript(item, needle) };
          rememberTranscriptResult(subagentEntryScanCache, key, entry, 2048);
        }
        if (entry.matched) return item.convId;
        incomplete ||= entry.truncated;
      } catch {
        incomplete = true;
      }
    }
    return incomplete ? null : '';
  } catch {}
  return "";
}

/**
 * Resolve the root main conversationId for any Antigravity conversationId:
 * - If it owns a Swarm or is a standalone main conversation -> returns itself.
 * - If it is a Swarm worker listed in any `brain/<root>/.system_generated/swarm/members.json` -> returns `<root>`.
 * - If it was launched via `invoke_subagent` from a parent conversation -> walks up to the root conversationId.
 */
export function resolveConversationRoot(conversationId, appDataDir) {
  const convId = String(conversationId || "").trim();
  if (!convId) return "";
  const rootDir = resolveDefaultAppDataDir(appDataDir);

  const swarmLoc = resolveNativeSwarmLocation(convId, rootDir);
  if (swarmLoc?.rootConversationId) {
    return swarmLoc.rootConversationId;
  }

  // Walk up invoke_subagent chain (cycle-guarded, max 10 hops)
  let current = convId;
  const visited = new Set([current.toLowerCase()]);
  for (let hop = 0; hop < 10; hop++) {
    const parent = isConversationInvokedAsSubagentSync(current, rootDir);
    if (parent === null) return null; // Incomplete transcript evidence cannot establish a top-level conversation.
    if (!parent || visited.has(parent.toLowerCase())) break;
    visited.add(parent.toLowerCase());
    current = parent;
    const parentSwarm = resolveNativeSwarmLocation(current, rootDir);
    if (parentSwarm?.rootConversationId) {
      return parentSwarm.rootConversationId;
    }
  }

  return current;
}

/**
 * Best-effort fallback when an MCP tool (`delegate_task`, `launchThread`, etc.) is called
 * without an explicit `conversationId`: scans the 8 most recently modified transcripts under
 * `<appDataDir>/brain/` for tool-call or cwd evidence, and normalizes matches via
 * `resolveConversationRoot`. Blindly selecting the latest transcript requires an explicit opt-in.
 */
export function inferCallingHostConversation({
  appDataDir,
  cwd = "",
  maxAgeMs = 60000,
  allowBlindLatest = false,
} = {}) {
  const rootDir = resolveDefaultAppDataDir(appDataDir);
  const brainDir = path.join(rootDir, "brain");
  if (!existsSync(brainDir)) return "";

  const now = Date.now();
  const candidates = [];
  try {
    const entries = readdirSync(brainDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const trPath = path.join(brainDir, ent.name, ".system_generated", "logs", "transcript.jsonl");
      if (!existsSync(trPath)) continue;
      try {
        const st = statSync(trPath);
        if (st.size > 0 && now - st.mtimeMs <= maxAgeMs) {
          candidates.push({ convId: ent.name, trPath, mtimeMs: st.mtimeMs });
        }
      } catch {}
    }
  } catch {
    return "";
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = candidates.slice(0, 8);
  const normalizedCwd = String(cwd || "").trim().replace(/\\/g, "/").toLowerCase();

  for (const item of top) {
    const tail = readTailTextSync(item.trPath, 16384);
    if (!tail) continue;
    if (
      tail.includes("delegate_task") ||
      tail.includes("delegate_parallel_batch") ||
      tail.includes("thread_launch") ||
      tail.includes("review_code") ||
      tail.includes("agent-tower")
    ) {
      return resolveConversationRoot(item.convId, rootDir);
    }
  }

  if (normalizedCwd) {
    for (const item of top) {
      const tail = readTailTextSync(item.trPath, 16384).replace(/\\\\/g, "/").toLowerCase();
      if (tail.includes(normalizedCwd)) {
        return resolveConversationRoot(item.convId, rootDir);
      }
    }
  }

  return allowBlindLatest && top[0] ? resolveConversationRoot(top[0].convId, rootDir) : "";
}

export function peekCachedHostConversationTitle(conversationId, appDataDir) {
  const id = String(conversationId || "").trim().toLowerCase();
  let cached;
  if (appDataDir) cached = hostConversationTitleCache.get(`${appDataDir}\0${id}`);
  else {
    // 单参数兼容调用仅在会话 ID 唯一时可确定宿主资料目录。
    for (const entry of hostConversationTitleCache.values()) {
      if (entry.id !== id) continue;
      if (cached) return "";
      cached = entry;
    }
  }
  return cached && Date.now() < cached.softExpiresAt ? cached.title : "";
}

export function clearNativeConversationTitleCache() {
  hostConversationTitleCache.clear();
  inFlightHostTitleLookups.clear();
}

async function fetchNativeHostConversationTitle(rootConvId, lsAddress, csrfToken, timeoutMs) {
  try {
    const response = await fetch(`http://${lsAddress}/product.v1.ConversationService/GetConversation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-antigravity-csrf-token": csrfToken,
      },
      body: JSON.stringify({ conversationId: rootConvId }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return "";
    }
    const res = await response.json();
    const rawTitle = [res?.conversation?.annotations?.title, res?.annotations?.title,
      res?.conversation?.state?.summary, res?.state?.summary].find(value => typeof value === "string" && value.trim());
    if (!rawTitle) return "";
    const title = rawTitle.replace(/\s+/g, " ").trim();
    const characters = [...title];
    return characters.length > 80 ? `${characters.slice(0, 80).join("")}…` : title;
  } catch {
    return "";
  }
}

export async function resolveNativeConversationTitleAsync(conversationId, appDataDir, {
  skipRootResolve = false, lsAddress = "", csrfToken = "", timeoutMs = 800,
} = {}) {
  const convId = String(conversationId || "").trim();
  if (!convId) return "";
  const rootDir = resolveDefaultAppDataDir(appDataDir);
  const rootConvId = skipRootResolve ? convId : resolveConversationRoot(convId, rootDir) || convId;
  const id = rootConvId.toLowerCase();
  const key = `${rootDir}\0${id}`;
  const cached = hostConversationTitleCache.get(key);
  const now = Date.now();
  if (cached && now < cached.expiresAt) {
    return (now < cached.softExpiresAt && cached.title) ||
      readNativeConversationTitle(rootConvId, appDataDir, { skipRootResolve: true });
  }
  if (typeof csrfToken === "string" && csrfToken.trim() &&
    typeof lsAddress === "string" && /^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/i.test(lsAddress)) {
    let lookup = inFlightHostTitleLookups.get(key);
    if (!lookup) {
      lookup = fetchNativeHostConversationTitle(rootConvId, lsAddress, csrfToken, timeoutMs);
      inFlightHostTitleLookups.set(key, lookup);
    }
    const title = await lookup;
    if (inFlightHostTitleLookups.get(key) === lookup) {
      inFlightHostTitleLookups.delete(key);
      const updatedAt = Date.now();
      const previous = hostConversationTitleCache.get(key);
      const softTitle = previous && updatedAt < previous.softExpiresAt ? previous.title : "";
      hostConversationTitleCache.set(key, {
        id,
        title: title || softTitle,
        expiresAt: updatedAt + (title ? 15_000 : 5_000),
        softExpiresAt: title ? updatedAt + 300_000 : softTitle ? previous.softExpiresAt : 0,
      });
      if (hostConversationTitleCache.size > 256) {
        hostConversationTitleCache.delete(hostConversationTitleCache.keys().next().value);
      }
    }
    if (title) return title;
  }
  return peekCachedHostConversationTitle(rootConvId, rootDir) ||
    readNativeConversationTitle(rootConvId, rootDir, { skipRootResolve: true });
}

/**
 * Extract a clean display title for a native Antigravity conversation:
 * - Prefers the cached host title, then the native Swarm `title` from `members.json`.
 * - Falls back to the first `USER_INPUT` in `transcript.jsonl`, stripping XML wrapper tags and truncating cleanly to 28 chars.
 */
export function readNativeConversationTitle(conversationId, appDataDir, { skipRootResolve = false } = {}) {
  const convId = String(conversationId || '').trim();
  if (!convId) return '';
  const rootDir = resolveDefaultAppDataDir(appDataDir);
  const rootConvId = skipRootResolve ? convId : resolveConversationRoot(convId, rootDir) || convId;
  const hostTitle = peekCachedHostConversationTitle(rootConvId, rootDir);
  if (hostTitle) return hostTitle;

  const membersFile = path.join(rootDir, 'brain', rootConvId, '.system_generated', 'swarm', 'members.json');
  const fingerprint = swarmFileFingerprint(membersFile);
  if (fingerprint) {
    const key = `${membersFile}:${fingerprint}`;
    let cached = conversationTitleCache.get(key);
    if (!cached) {
      try {
        const parsed = JSON.parse(readFileSync(membersFile, { encoding: 'utf8', flag: NOFOLLOW_READ }));
        cached = { result: typeof parsed?.title === 'string' ? parsed.title.trim() : '' };
        rememberTranscriptResult(conversationTitleCache, key, cached);
      } catch {}
    }
    if (cached?.result) return cached.result;
  }

  const trPath = resolveTranscriptPath(rootConvId, rootDir);
  let size;
  try {
    size = statSync(trPath).size;
  } catch {
    conversationTitleCache.delete(trPath);
    return '';
  }
  const cached = conversationTitleCache.get(trPath);
  if (cached && size >= cached.firstSeenSize) return cached.result;
  conversationTitleCache.delete(trPath);
  const head = readHeadTextSync(trPath, 32768);
  if (!head) return '';

  const lines = head.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    if (step?.type !== "USER_INPUT" || !step.content) continue;
    const cleaned = extractCleanUserText(step.content)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned) {
      const result = cleaned.length > 28 ? `${cleaned.slice(0, 28)}…` : cleaned;
      return rememberTranscriptResult(conversationTitleCache, trPath, { firstSeenSize: size, result });
    }
  }
  return "";
}

/**
 * Resolve Antigravity's root AppData directory containing `brain/<conversationId>/...`.
 */
export function resolveDefaultAppDataDir(explicitDir, hostEnv = {}) {
  if (explicitDir && existsSync(explicitDir)) {
    return path.resolve(explicitDir);
  }
  const merged = { ...process.env, ...hostEnv };
  if (merged.ANTIGRAVITY_APP_DATA_DIR && existsSync(merged.ANTIGRAVITY_APP_DATA_DIR)) {
    return path.resolve(merged.ANTIGRAVITY_APP_DATA_DIR);
  }
  if (merged.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    // Walk up from executable/sidecar data dir to locate the root containing `brain`
    let cur = path.resolve(merged.ANTIGRAVITY_EXECUTABLE_DATA_DIR);
    for (let i = 0; i < 5; i++) {
      if (existsSync(path.join(cur, "brain"))) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return path.join(os.homedir(), ".gemini", "antigravity");
}

/**
 * Build absolute path to a native Antigravity conversation's `transcript.jsonl`.
 */
export function resolveTranscriptPath(conversationId, appDataDir) {
  const root = resolveDefaultAppDataDir(appDataDir);
  return path.join(root, "brain", String(conversationId || "").trim(), ".system_generated", "logs", "transcript.jsonl");
}

function extractCleanUserText(rawContent = "") {
  const str = String(rawContent || "");
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(str);
  if (m && m[1]) return m[1].trim();
  return str
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    .trim();
}

function extractSwarmBriefText(rawContent = "") {
  const str = String(rawContent || "");
  if (!str.includes("Your assignment")) return "";
  const m = /Your assignment[^\n]*:\s*([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/i.exec(str);
  return m && m[1] ? m[1].trim() : "";
}

function unwrapJsonQuotedArgValue(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}

function normalizeTranscriptToolArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== "object") return rawArgs;
  const out = {};
  for (const [k, v] of Object.entries(rawArgs)) {
    out[k] = unwrapJsonQuotedArgValue(v);
  }
  return out;
}

function inferNativeToolKind(name = "") {
  const lower = String(name).toLowerCase();
  if (lower.includes("read") || lower.includes("grep") || lower.includes("find") || lower.includes("list")) {
    return "read";
  }
  if (lower.includes("write") || lower.includes("edit") || lower.includes("replace")) {
    return "edit";
  }
  if (lower.includes("command") || lower.includes("terminal") || lower.includes("exec")) {
    return "execute";
  }
  if (lower.includes("search") || lower.includes("web") || lower.includes("browser")) {
    return "fetch";
  }
  return "other";
}

function stripDuplicateTimestampHeader(rawOutput = "") {
  return String(rawOutput || "")
    .replace(/^(?:Created At:[^\n]*\nCompleted At:[^\n]*\n)+/i, "")
    .trim();
}

/**
 * Incrementally read and parse `transcript.jsonl` from `fromByteOffset` with zero external processes.
 * Safely stops at the last complete newline so partial in-flight writes are retried on the next tick.
 */
export async function readNativeTranscriptSnapshot({
  appDataDir,
  conversationId,
  fromByteOffset = 0,
  initialUsage,
  initialTurnStartedAt = 0,
  initialTurnSettled = false,
  // Cross-tick carry-over from the previous incremental read: tool calls still awaiting their GENERIC result and a
  // trailing reasoning block whose real end time is only known once the next step arrives.
  initialPendingTools = [],
  initialOpenReasoning = null,
} = {}) {
  const convId = String(conversationId || "").trim();
  const rootDir = resolveDefaultAppDataDir(appDataDir);
  const transcriptPath = resolveTranscriptPath(convId, rootDir);

  if (!convId || !existsSync(transcriptPath)) {
    return {
      found: false,
      exists: false,
      conversationId: convId,
      transcriptPath,
      nextByteOffset: fromByteOffset,
      title: "",
      isSettled: false,
      stepsParsed: 0,
      usage: initialUsage || {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
      events: [],
      turnItems: [],
      items: [],
      discoveredSubagents: [],
      lastAssistantText: "",
      lastReasoningText: "",
      turnStartedAt: Number(initialTurnStartedAt || 0),
      turnCompletedAt: null,
      turnDurationMs: 0,
      pendingTools: Array.isArray(initialPendingTools) ? [...initialPendingTools] : [],
      openReasoning: initialOpenReasoning || null,
    };
  }

  const stat = await fsp.stat(transcriptPath);
  let effectiveOffset = Math.max(0, Number(fromByteOffset) || 0);
  if (effectiveOffset > 0 && stat.size < effectiveOffset) {
    effectiveOffset = 0;
    initialUsage = undefined;
    initialTurnStartedAt = 0;
    initialTurnSettled = false;
    initialPendingTools = [];
    initialOpenReasoning = null;
  }
  if (stat.size === effectiveOffset) {
    return {
      unchanged: true,
      found: true,
      exists: true,
      conversationId: convId,
      transcriptPath,
      nextByteOffset: effectiveOffset,
      title: "",
      isSettled: false,
      stepsParsed: 0,
      usage: initialUsage || {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
      events: [],
      turnItems: [],
      items: [],
      discoveredSubagents: [],
      lastAssistantText: "",
      lastReasoningText: "",
      turnStartedAt: Number(initialTurnStartedAt || 0),
      turnCompletedAt: null,
      turnDurationMs: 0,
      pendingTools: Array.isArray(initialPendingTools) ? [...initialPendingTools] : [],
      openReasoning: initialOpenReasoning || null,
    };
  }

  const bytesToRead = stat.size - effectiveOffset;
  const buf = Buffer.allocUnsafe(bytesToRead);
  const fh = await fsp.open(transcriptPath, "r");
  let bytesRead = 0;
  try {
    const readRes = await fh.read(buf, 0, bytesToRead, effectiveOffset);
    bytesRead = readRes.bytesRead;
  } finally {
    await fh.close();
  }

  const slice = buf.subarray(0, bytesRead);
  const lastNl = slice.lastIndexOf(0x0a); // '\n'
  // Hold trailing incomplete bytes until newline arrives so half-flushed JSONL lines are never skipped
  if (lastNl < 0) {
    return {
      unchanged: true,
      found: true,
      exists: true,
      conversationId: convId,
      transcriptPath,
      nextByteOffset: effectiveOffset,
      title: "",
      isSettled: false,
      stepsParsed: 0,
      usage: initialUsage || {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
      events: [],
      turnItems: [],
      items: [],
      discoveredSubagents: [],
      lastAssistantText: "",
      lastReasoningText: "",
      turnStartedAt: Number(initialTurnStartedAt || 0),
      turnCompletedAt: null,
      turnDurationMs: 0,
      pendingTools: Array.isArray(initialPendingTools) ? [...initialPendingTools] : [],
      openReasoning: initialOpenReasoning || null,
    };
  }
  const completeBuf = slice.subarray(0, lastNl + 1);
  const consumedBytes = lastNl + 1;
  const nextByteOffset = effectiveOffset + consumedBytes;

  const rawText = completeBuf.toString("utf-8");
  const lines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const events = [];
  const turnItems = [];
  const discoveredSubagents = [];
  const seenSubagentIds = new Set();

  let title = "";
  let lastAssistantText = "";
  let lastReasoningText = "";
  let lastStepWasFinalResponse = Boolean(initialTurnSettled);

  const usage = {
    inputTokens: Number(initialUsage?.inputTokens || 0),
    cachedInputTokens: Number(initialUsage?.cachedInputTokens || 0),
    outputTokens: Number(initialUsage?.outputTokens || 0),
    reasoningOutputTokens: Number(initialUsage?.reasoningOutputTokens || 0),
    totalTokens: Number(initialUsage?.totalTokens || 0),
  };

  // Queue of pending tool calls from the most recent PLANNER_RESPONSE awaiting GENERIC step outputs
  let pendingToolsQueue = Array.isArray(initialPendingTools) ? [...initialPendingTools] : [];
  let openReasoning = initialOpenReasoning && Number.isFinite(Number(initialOpenReasoning.createdMs))
    ? { ...initialOpenReasoning } : null;
  const parsedSteps = [];
  for (const line of lines) {
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    const stepIdx = step.step_index ?? parsedSteps.length + 1;
    const createdMs = step.created_at ? Date.parse(step.created_at) || Date.now() : Date.now();
    parsedSteps.push({ step, stepIdx, createdMs });
  }
  const stepsParsed = parsedSteps.length;
  let turnStartedAt = Number(initialTurnStartedAt || 0);
  let lastStepMs = 0;

  for (let parsedIdx = 0; parsedIdx < parsedSteps.length; parsedIdx++) {
    const { step, stepIdx, createdMs } = parsedSteps[parsedIdx];
    const nextStepMs = parsedSteps[parsedIdx + 1]?.createdMs;
    lastStepMs = createdMs;

    // The previous tick ended on a reasoning block: its real end is the first step of this tick.
    if (parsedIdx === 0 && openReasoning && step.type !== "USER_INPUT") {
      const durationMs = Math.max(0, createdMs - openReasoning.createdMs);
      const item = {
        id: `agy_think_${convId}_${openReasoning.stepIdx}`,
        type: "reasoning",
        status: "completed",
        text: openReasoning.text,
        createdAt: openReasoning.createdMs,
        completedAt: createdMs,
        durationMs,
      };
      events.push({ type: "reasoning_delta", delta: "", text: openReasoning.text, stepIndex: openReasoning.stepIdx,
        timestamp: createdMs, backfill: true, item });
      openReasoning = null;
    }

    if (step.type === "USER_INPUT") {
      turnStartedAt = createdMs;
      lastStepWasFinalResponse = false;
      pendingToolsQueue = [];
      openReasoning = null;
      const userText = extractCleanUserText(step.content);
      if (userText) {
        if (!title) {
          title = userText.split(/\r?\n/)[0].slice(0, 72);
          events.push({ type: "title_updated", title, timestamp: createdMs });
        }
        const item = {
          id: `agy_user_${convId}_${stepIdx}`,
          type: "user_message",
          status: "completed",
          text: userText,
          createdAt: createdMs,
          completedAt: createdMs,
        };
        turnItems.push(item);
        events.push({ type: "user_message", text: userText, item, timestamp: createdMs });
      }
      continue;
    }

    if (step.type === "SYSTEM_MESSAGE") {
      if (!turnStartedAt || (lastStepWasFinalResponse && pendingToolsQueue.length === 0)) {
        turnStartedAt = createdMs;
        lastStepWasFinalResponse = false;
      }
      if (!title) {
        const briefText = extractSwarmBriefText(step.content);
        if (briefText) {
          title = briefText.split(/\r?\n/)[0].slice(0, 72);
          events.push({ type: "title_updated", title, timestamp: createdMs });
        }
      }
      continue;
    }

    if (step.type === "PLANNER_RESPONSE") {
      // A planner step after a settled turn (e.g. a plain `swarm_wait` return) opens a new turn.
      if (!turnStartedAt || lastStepWasFinalResponse) {
        turnStartedAt = createdMs;
        lastStepWasFinalResponse = false;
      }
      const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      const inTok = Number(step.input_tokens || 0);
      const cacheTok = Number(step.cache_read_tokens || 0);
      const outTok = Number(step.output_tokens || 0);
      if (inTok || cacheTok || outTok) {
        usage.inputTokens += inTok;
        usage.cachedInputTokens += cacheTok;
        usage.outputTokens += outTok;
        usage.totalTokens = usage.inputTokens + usage.cachedInputTokens + usage.outputTokens;
        events.push({
          type: "usage_updated",
          usage: { ...usage, contextUsed: inTok + cacheTok + outTok, contextLimit: 1048576 },
          timestamp: createdMs,
        });
      }

      if (typeof step.thinking === "string" && step.thinking.trim()) {
        const thinkStr = step.thinking.trim();
        const completedAt = nextStepMs ?? (step.status === "DONE" && toolCalls.length === 0 ? createdMs : null);
        // Last step of this tick and still open: back-filled once the next step lands in a later tick.
        if (nextStepMs == null && completedAt == null) openReasoning = { stepIdx, createdMs, text: thinkStr };
        const thinkItem = {
          id: `agy_think_${convId}_${stepIdx}`,
          type: "reasoning",
          status: "completed",
          text: thinkStr,
          createdAt: createdMs,
          completedAt,
          durationMs: completedAt == null ? 0 : Math.max(0, completedAt - createdMs),
        };
        lastReasoningText = thinkStr;
        turnItems.push(thinkItem);
        events.push({
          type: "reasoning_delta",
          delta: `${thinkStr}\n`,
          text: `${thinkStr}\n`,
          stepIndex: stepIdx,
          timestamp: createdMs,
          item: thinkItem,
        });
      }

      pendingToolsQueue = [];

      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        if (!tc || !tc.name) continue;
        const parsedArgs = normalizeTranscriptToolArgs(tc.args);
        const toolCallId = `agy_tc_${convId}_${stepIdx}_${i}`;
        const kind = inferNativeToolKind(tc.name);
        const fileLoc = parsedArgs?.Path || parsedArgs?.path || parsedArgs?.TargetFile || "";
        const cmdStr = parsedArgs?.CommandLine || parsedArgs?.command || "";

        const toolEntry = {
          toolCallId,
          id: toolCallId,
          toolName: tc.name,
          name: tc.name,
          kind,
          title: parsedArgs?.toolSummary || (fileLoc ? `${tc.name}: ${path.basename(String(fileLoc))}` : tc.name),
          status: "in_progress",
          input: parsedArgs,
          rawInput: parsedArgs,
          command: typeof cmdStr === "string" ? cmdStr : "",
          filePath: typeof fileLoc === "string" ? fileLoc : "",
          locations: typeof fileLoc === "string" && fileLoc ? [{ path: fileLoc }] : undefined,
          output: "",
          createdAt: createdMs,
        };

        pendingToolsQueue.push(toolEntry);
        events.push({ type: "tool_call", ...toolEntry, timestamp: createdMs });
        if (tc.name === "post_message" && typeof parsedArgs?.text === "string" && parsedArgs.text.trim()) {
          const text = parsedArgs.text.trim();
          lastAssistantText = text;
          const item = { id: `agy_msg_${convId}_${stepIdx}_${i}`, type: "assistant_message", role: "assistant",
            status: "completed", text, createdAt: createdMs, completedAt: createdMs };
          turnItems.push(item);
          events.push({ type: "message_delta", delta: `${text}\n`, text: `${text}\n`, phase: "commentary",
            stepIndex: `${stepIdx}_${i}`, item, timestamp: createdMs });
        }
      }

      if (typeof step.content === "string" && step.content.trim()) {
        const msgStr = step.content.trim();
        lastAssistantText = msgStr;
        turnItems.push({
          id: `agy_msg_${convId}_${stepIdx}`,
          type: "assistant_message",
          status: "completed",
          text: msgStr,
          createdAt: createdMs,
          completedAt: createdMs,
        });
        events.push({
          type: "message_delta",
          delta: `${msgStr}\n`,
          text: `${msgStr}\n`,
          phase: toolCalls.length === 0 ? "final_answer" : "commentary",
          stepIndex: stepIdx,
          timestamp: createdMs,
        });
      }

      lastStepWasFinalResponse = step.status === "DONE" &&
        (toolCalls.length === 0 || toolCalls.some(call => call?.name === "swarm_wait"));
      continue;
    }

    if (step.type === "GENERIC" && pendingToolsQueue.length > 0) {
      const matchedTool = pendingToolsQueue.shift();
      const cleanedOut = stripDuplicateTimestampHeader(step.content || "");
      const isErr = step.status === "ERROR";

      const completedTool = {
        ...matchedTool,
        status: isErr ? "failed" : "completed",
        output: cleanedOut.slice(0, 8000),
        rawOutput: cleanedOut.slice(0, 8000),
        completedAt: createdMs,
        durationMs: Math.max(0, createdMs - (matchedTool.createdAt || createdMs)),
      };

      turnItems.push({
        id: completedTool.toolCallId,
        type: completedTool.kind === "execute" ? "command_execution" : completedTool.kind === "edit" ? "file_change" : "dynamic_tool",
        status: completedTool.status,
        title: completedTool.title,
        command: completedTool.command,
        filePath: completedTool.filePath,
        output: completedTool.output,
        rawInput: completedTool.input,
        createdAt: completedTool.createdAt,
        completedAt: createdMs,
        durationMs: completedTool.durationMs,
      });

      events.push({ type: "tool_call", ...completedTool, timestamp: createdMs });

      // The host returns `swarm_wait` only when the member is woken, carrying the wake message in the same body:
      // the new turn starts at the wake time, so hours of standby never count toward the previous turn.
      if (matchedTool.toolName === "swarm_wait" && /<SYSTEM_MESSAGE>|\[swarm\] new board message/i.test(step.content || "")) {
        const stamp = /timestamp=(\d{4}-\d{2}-\d{2}T[^\s"'<>]+)/.exec(step.content || "")?.[1];
        const parsedWake = stamp ? Date.parse(stamp) : NaN;
        turnStartedAt = Number.isFinite(parsedWake) ? parsedWake : createdMs;
        lastStepWasFinalResponse = false;
      }

      // Detect native `invoke_subagent` child conversation IDs from tool call args or output!
      if (matchedTool.toolName === "invoke_subagent") {
        const candidates = [];
        let m;
        UUID_REGEX.lastIndex = 0;
        while ((m = UUID_REGEX.exec(cleanedOut)) !== null) {
          candidates.push(m[1].toLowerCase());
        }
        for (const childId of candidates) {
          if (childId === convId.toLowerCase() || seenSubagentIds.has(childId)) continue;
          const childTranscript = resolveTranscriptPath(childId, rootDir);
          if (existsSync(childTranscript) || existsSync(path.join(rootDir, "brain", childId))) {
            seenSubagentIds.add(childId);
            const rawRoleOrName =
              matchedTool.input?.SubagentName ||
              matchedTool.input?.Role ||
              matchedTool.input?.role ||
              matchedTool.input?.name ||
              matchedTool.input?.agent ||
              "native-subagent";
            const shortMemberName = String(rawRoleOrName).trim().slice(0, 48) || "native-subagent";
            const subInfo = {
              parentConversationId: convId,
              childConversationId: childId,
              subagentName: shortMemberName,
              memberName: shortMemberName,
              role: String(matchedTool.input?.Role || matchedTool.input?.role || shortMemberName),
              prompt:
                matchedTool.input?.Prompt ||
                matchedTool.input?.prompt ||
                matchedTool.input?.Task ||
                "",
              timestamp: createdMs,
            };
            discoveredSubagents.push(subInfo);
            events.push({ type: "subagent_discovered", ...subInfo });
          }
        }
      }
    }
  }

  const isSettled = lastStepWasFinalResponse && pendingToolsQueue.every((t) => t.toolName === "swarm_wait");
  const turnCompletedAt = isSettled && lastStepMs >= turnStartedAt ? lastStepMs : null;
  return {
    found: true,
    exists: true,
    conversationId: convId,
    transcriptPath,
    nextByteOffset,
    title,
    isSettled,
    turnStartedAt: turnStartedAt || 0,
    turnCompletedAt,
    turnDurationMs: turnCompletedAt == null ? 0 : Math.max(0, turnCompletedAt - turnStartedAt),
    stepsParsed,
    usage,
    events,
    turnItems,
    items: turnItems,
    discoveredSubagents,
    lastAssistantText,
    lastReasoningText,
    pendingTools: pendingToolsQueue,
    openReasoning,
  };
}

/**
 * Live Brain Transcript Watcher:
 * Zero-subprocess native bridge that incrementally tails `<appDataDir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`
 * and recursively discovers & tracks native `invoke_subagent` child conversations!
 */
export function ingestNativeConversation({
  appDataDir,
  conversationId,
  fromByteOffset = 0,
  initialUsage,
  initialTurnStartedAt = 0,
  initialTurnSettled = false,
  initialTurnCompletedAt = null,
  initialTurnDurationMs = 0,
  followSubagents = true,
  watch = true,
  pollIntervalMs = 650,
  pollSwarmRoster = true,
  resolveChildResumeState,
  onEvent,
  onSubagentDiscovered,
  _visited = new Set(),
} = {}) {
  const convId = String(conversationId || "").trim();
  const rootDir = resolveDefaultAppDataDir(appDataDir);
  let byteOffset = Number(fromByteOffset) || 0;
  let runningUsage = {
    inputTokens: Number(initialUsage?.inputTokens || 0),
    cachedInputTokens: Number(initialUsage?.cachedInputTokens || 0),
    outputTokens: Number(initialUsage?.outputTokens || 0),
    reasoningOutputTokens: Number(initialUsage?.reasoningOutputTokens || 0),
    totalTokens: Number(initialUsage?.totalTokens || 0),
  };
  let stopped = false;
  let currentSyncPromise = null;
  let timer = null;
  let boundEmitted = false;
  let latestSnapshot = null;
  let lastSettledEmitted = null;
  let lastTimingSig = "";
  let lastSwarmSig = "";
  let carriedPendingTools = [];
  let carriedOpenReasoning = null;
  let idleSyncCount = 0;
  let currentPollMs = 0;
  const childWatchers = new Map();

  function setWatchDelay(delay) {
    const next = Math.max(250, Number(delay) || 650);
    if (!watch || stopped || !convId || (timer && currentPollMs === next)) return;
    if (timer) clearInterval(timer);
    currentPollMs = next;
    timer = setInterval(() => { void syncNow({ resetIdle: false }).catch(() => {}); }, next);
    timer.unref?.();
  }

  function childResumeState(childConversationId) {
    try {
      return resolveChildResumeState?.(childConversationId) || null;
    } catch {
      return null;
    }
  }

  _visited.add(convId.toLowerCase());

  const emit = (evt) => {
    try {
      onEvent?.({
        provider: "antigravity",
        isNativeHost: true,
        conversationId: convId,
        hostConversationId: convId,
        nativeSessionId: convId,
        nextByteOffset: byteOffset,
        ...evt,
      });
    } catch {}
  };

  async function runSync() {
    const snap = await readNativeTranscriptSnapshot({
      appDataDir: rootDir,
      conversationId: convId,
      fromByteOffset: byteOffset,
      initialUsage: runningUsage,
      initialTurnStartedAt: latestSnapshot?.turnStartedAt || Number(initialTurnStartedAt || 0),
      initialTurnSettled: typeof latestSnapshot?.isSettled === "boolean" ? latestSnapshot.isSettled : Boolean(initialTurnSettled),
      initialPendingTools: carriedPendingTools,
      initialOpenReasoning: carriedOpenReasoning,
    });

    // 未变化且尚无历史快照（如守护进程刚重启、偏移量已在文件末尾）时状态未知，返回 null，
    // 避免把已完结的会话误判为「工作中」。
    if (snap.unchanged) {
      snap.isSettled = typeof latestSnapshot?.isSettled === "boolean"
        ? latestSnapshot.isSettled
        : initialTurnSettled
          ? true
          : null;
      snap.turnStartedAt = latestSnapshot?.turnStartedAt || Number(initialTurnStartedAt || 0);
      // Before any snapshot exists (resumed at the persisted offset), keep the settled turn's persisted timing;
      // new bytes later re-derive it from the real steps.
      snap.turnCompletedAt = latestSnapshot
        ? latestSnapshot.turnCompletedAt ?? null
        : initialTurnSettled ? initialTurnCompletedAt ?? null : null;
      snap.turnDurationMs = latestSnapshot
        ? latestSnapshot.turnDurationMs || 0
        : initialTurnSettled ? Number(initialTurnDurationMs || 0) : 0;
    }
    latestSnapshot = snap;
    if (!snap.found) {
      idleSyncCount++;
      setWatchDelay(idleSyncCount >= 8 ? 10000 : idleSyncCount >= 2 ? 3000 : pollIntervalMs);
      return snap;
    }

    if (!boundEmitted) {
      boundEmitted = true;
      emit({
        type: "session_bound",
        nativeSessionId: convId,
        sessionId: convId,
        hostConversationId: convId,
        isNativeHost: true,
        turnStartedAt: snap.turnStartedAt || 0,
        turnCompletedAt: snap.turnCompletedAt ?? null,
        turnDurationMs: snap.turnDurationMs || 0,
        timestamp: Date.now(),
      });
    }

    const advanced = snap.nextByteOffset !== byteOffset;
    if (advanced) {
      byteOffset = snap.nextByteOffset;
      runningUsage = snap.usage;
      // The parser already clears both on USER_INPUT; keep whatever is still open for the next tick.
      carriedPendingTools = Array.isArray(snap.pendingTools) ? snap.pendingTools : [];
      carriedOpenReasoning = snap.openReasoning || null;

      for (const ev of snap.events) {
        emit(ev);
      }

      if (followSubagents && snap.discoveredSubagents.length > 0) {
        for (const sub of snap.discoveredSubagents) {
          const childKey = sub.childConversationId.toLowerCase();
          if (_visited.has(childKey) || childWatchers.has(childKey)) continue;
          try {
            onSubagentDiscovered?.(sub);
          } catch {}

          const resume = childResumeState(sub.childConversationId);
          const childWatcher = ingestNativeConversation({
            appDataDir: rootDir,
            conversationId: sub.childConversationId,
            fromByteOffset: Number(resume?.fromByteOffset || 0),
            initialUsage: resume?.initialUsage,
            initialTurnStartedAt: Number(resume?.initialTurnStartedAt || 0),
            initialTurnSettled: Boolean(resume?.initialTurnSettled),
            initialTurnCompletedAt: resume?.initialTurnCompletedAt ?? null,
            initialTurnDurationMs: Number(resume?.initialTurnDurationMs || 0),
            followSubagents: true,
            watch,
            pollIntervalMs,
            pollSwarmRoster: false,
            resolveChildResumeState,
            onEvent: (childEvt) => {
              try {
                onEvent?.({
                  ...childEvt,
                  parentConversationId: convId,
                  memberName: childEvt.memberName || sub.memberName || sub.subagentName,
                });
              } catch {}
            },
            onSubagentDiscovered,
            _visited,
          });
          childWatchers.set(childKey, childWatcher);
        }
      }
    }

    // 本轮事件回放完后，再推送一次「是否已收尾」与本轮真实起止耗时的权威状态（含单拍内唤醒并完结的快轮次）
    const timingSig = `${snap.isSettled}|${snap.turnStartedAt || 0}|${snap.turnCompletedAt ?? ""}`;
    if (typeof snap.isSettled === "boolean" && (snap.isSettled !== lastSettledEmitted || (advanced && timingSig !== lastTimingSig))) {
      lastSettledEmitted = snap.isSettled;
      lastTimingSig = timingSig;
      const turnTiming = {
        turnStartedAt: snap.turnStartedAt || 0,
        turnCompletedAt: snap.turnCompletedAt ?? null,
        turnDurationMs: snap.turnDurationMs || 0,
      };
      emit({ type: "settle_state", settled: snap.isSettled, ...turnTiming, timestamp: Date.now() });
      if (snap.isSettled) {
        emit({ type: "turn_completed", settled: true, ...turnTiming, timestamp: snap.turnCompletedAt || Date.now() });
      }
    }

    // Also discover and watch all native `/swarm` members (even if transcript offset hasn't moved!)
    const swarmSnap = followSubagents && pollSwarmRoster
      ? readNativeSwarmSnapshot({ conversationId: convId, appDataDir: rootDir })
      : null;

    if (swarmSnap?.found) {
      const swarmSig = `${swarmSnap.head}|${swarmSnap.members.map((m) => `${m.name}:${m.state}:${m.model}`).join(",")}`;
      if (swarmSig !== lastSwarmSig) {
        lastSwarmSig = swarmSig;
        emit({
          type: "swarm_snapshot",
          swarm: swarmSnap,
          timestamp: Date.now(),
        });
      }

      for (const mem of swarmSnap.members) {
        const memConvId = String(mem.conversation_id || "").trim();
        if (!memConvId) continue;
        const memKey = memConvId.toLowerCase();
        if (mem.killed) {
          childWatchers.get(memKey)?.stop();
          childWatchers.delete(memKey);
          continue;
        }
        if (memKey === convId.toLowerCase() || _visited.has(memKey) || childWatchers.has(memKey)) continue;

        try {
          onSubagentDiscovered?.({
            parentConversationId: mem.parentConversationId || swarmSnap.rootConversationId,
            childConversationId: memConvId,
            subagentName: mem.name,
            memberName: mem.name,
            role: mem.role,
            model: mem.model,
            modelDisplayName: mem.model_display_name,
            state: mem.state,
            killed: mem.killed,
            isSwarmMember: true,
            rootConversationId: swarmSnap.rootConversationId,
            timestamp: mem.transcriptMtime || Date.now(),
          });
        } catch {}

        const resume = childResumeState(memConvId);
        const memberWatcher = ingestNativeConversation({
          appDataDir: rootDir,
          conversationId: memConvId,
          fromByteOffset: Number(resume?.fromByteOffset || 0),
          initialUsage: resume?.initialUsage,
          initialTurnStartedAt: Number(resume?.initialTurnStartedAt || 0),
          initialTurnSettled: Boolean(resume?.initialTurnSettled),
          initialTurnCompletedAt: resume?.initialTurnCompletedAt ?? null,
          initialTurnDurationMs: Number(resume?.initialTurnDurationMs || 0),
          followSubagents: true,
          watch,
          pollIntervalMs,
          pollSwarmRoster: false,
          resolveChildResumeState,
          onEvent: (childEvt) => {
            try {
              onEvent?.({
                ...childEvt,
                parentConversationId: mem.parentConversationId || swarmSnap.rootConversationId,
                memberName: childEvt.memberName || mem.name,
              });
            } catch {}
          },
          onSubagentDiscovered,
          _visited,
        });
        childWatchers.set(memKey, memberWatcher);
      }
    }

    if (childWatchers.size > 0) {
      await Promise.all([...childWatchers.values()].map((cw) => cw.syncNow({ resetIdle: false }).catch(() => null)));
    }

    const active = snap.isSettled === false || swarmSnap?.members?.some(member =>
      !member.killed && ["working", "running"].includes(member.state));
    idleSyncCount = active || advanced ? 0 : idleSyncCount + 1;
    setWatchDelay(idleSyncCount >= 8 ? 10000 : idleSyncCount >= 2 ? 3000 : pollIntervalMs);
    return snap;
  }

  function syncNow({ resetIdle = true } = {}) {
    if (stopped || !convId) return Promise.resolve(latestSnapshot);
    if (resetIdle) {
      idleSyncCount = 0;
      setWatchDelay(pollIntervalMs);
    }
    if (currentSyncPromise) return currentSyncPromise;
    currentSyncPromise = runSync().finally(() => {
      currentSyncPromise = null;
    });
    return currentSyncPromise;
  }

  // Trigger initial sync asynchronously
  const initialSyncPromise = syncNow({ resetIdle: false }).catch(() => null);

  setWatchDelay(pollIntervalMs);

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    for (const [, cw] of childWatchers) {
      cw.stop();
    }
    childWatchers.clear();
  }

  function getChildOffsets() {
    const offsets = {};
    for (const [childKey, childWatcher] of childWatchers) {
      offsets[childWatcher.conversationId || childKey] = childWatcher.getOffset();
      Object.assign(offsets, childWatcher.getChildOffsets?.() || {});
    }
    return offsets;
  }

  return {
    conversationId: convId,
    isNativeHost: true,
    initialSyncPromise,
    syncNow,
    getOffset: () => byteOffset,
    getChildOffsets,
    getPollDelayMs: () => currentPollMs,
    getSnapshot: () => latestSnapshot,
    stop,
    close: stop,
  };
}

/**
 * Execute Antigravity Host's native `agentapi` CLI asynchronously with timeout protection
 * (never blocking the event loop like `execFileSync`).
 */
function hostTopLevelForbidden() {
  return Object.assign(new Error('已禁止调用 agentapi new-conversation 在宿主主界面新建顶层窗口；Antigravity 角色子成员请在当前宿主会话直接调用原生 swarm({ action: "add", name, model }) 派遣。'), {
    code: "HOST_TOPLEVEL_FORBIDDEN",
  });
}

export async function execHostAgentApi(args = [], { hostEnv = {}, timeoutMs = 10000 } = {}) {
  if (args[0] === "new-conversation") throw hostTopLevelForbidden();
  const hostBin = resolveHostAgentApiBinary(hostEnv);
  if (!hostBin.available || !hostBin.command) {
    return Promise.reject(
      new Error("Antigravity Host agentapi environment (ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN) is not active.")
    );
  }

  let stdout;
  try {
    ({ stdout } = await captureNoWindow(hostBin.command, [...hostBin.prefixArgs, ...args], {
      env: hostBin.env, timeoutMs, maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (err) {
    const detail = safeEngineError(String(err.stderr || err.stdout || err.message || "").trim());
    throw new Error(`agentapi ${args[0] || ""} failed: ${detail}`);
  }
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed); }
  catch {
    const m = UUID_REGEX.exec(trimmed);
    UUID_REGEX.lastIndex = 0;
    return m ? { conversationId: m[1] } : {};
  }
}

export async function sendWakeAlertToHostConversation({
  conversationId, message, agentApiExe, projectId, lsAddress, csrfToken, timeoutMs = 4000,
} = {}) {
  if (!conversationId || String(conversationId).startsWith('-') || !message) {
    return { ok: false, error: "Missing or invalid host wake target" };
  }
  const hostEnv = {
    ...(lsAddress ? { ANTIGRAVITY_LS_ADDRESS: lsAddress } : {}),
    ...(csrfToken ? { ANTIGRAVITY_CSRF_TOKEN: csrfToken } : {}),
    ...(agentApiExe ? { ANTIGRAVITY_AGENTAPI_EXE: agentApiExe } : {}),
    ...(projectId ? { ANTIGRAVITY_PROJECT_ID: projectId } : {}),
  };
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 2 ** 31 - 1) : 4000;
  let timer;
  try {
    return await Promise.race([
      execHostAgentApi(["send-message", String(conversationId), String(message)], {
        hostEnv, timeoutMs: timeout,
      }).then(() => ({ ok: true })),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ ok: false, error: 'Host wake timed out' }), timeout);
      }),
    ]);
  } catch (error) {
    return { ok: false, error: safeEngineError(error?.message) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Primary `'antigravity'` Engine Turn Driver:
 * - Inside Antigravity Host (`ANTIGRAVITY_LS_ADDRESS` & `ANTIGRAVITY_CSRF_TOKEN` available):
 *   Drives an existing native Antigravity conversation via async `agentapi send-message`
 *   and live-streams its `<appDataDir>/brain/<id>/.system_generated/logs/transcript.jsonl` (ZERO `agy.exe` nesting!).
 */
export function unsupportedHostCancel() {
  return { ok: false, cancelled: false, unsupported: true, error: '插件仅监听宿主 transcript，无法代为中断；请在 Antigravity 主窗口停止回合。' };
}

export function runAgyNativeTurn(opts = {}) {
  const {
    runId,
    threadId,
    nativeSessionId,
    prompt = "",
    title,
    hostEnv = {},
    appDataDir,
    onEvent,
  } = opts;

  const convId = String(nativeSessionId || "").trim();
  if (!convId) throw hostTopLevelForbidden();
  assertReadOnlySupport("antigravity", opts.permissionMode);
  let detached = false;
  let watcher = null;
  let resolveDetach = null;

  const emit = (evt) => {
    if (detached) return;
    try {
      onEvent?.({
        runId,
        threadId,
        provider: "antigravity",
        isNativeHost: true,
        timestamp: Date.now(),
        ...evt,
      });
    } catch {}
  };

  const result = (async () => {
    let assistantText = "";
    let reasoningText = "";
    let usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    };

    const rootDir = resolveDefaultAppDataDir(appDataDir, hostEnv);
    let baselineOffset = 0;

    try {
      const existingTranscript = resolveTranscriptPath(convId, rootDir);
      if (existsSync(existingTranscript)) {
        const st = await fsp.stat(existingTranscript).catch(() => null);
        baselineOffset = st?.size || 0;
      }
      const sendArgs = ["send-message"];
      if (title) sendArgs.push("--title", String(title));
      sendArgs.push(convId, String(prompt));
      await execHostAgentApi(sendArgs, { hostEnv, timeoutMs: 12000 });

      if (detached) return { detached: true };
      emit({
        type: "session_bound",
        nativeSessionId: convId,
        sessionId: convId,
        hostConversationId: convId,
        isNativeHost: true,
      });

      // Stream live transcript deltas until the native turn settles or is detached
      let settledTicks = 0;
      let sawNewActivity = false;

      await new Promise((resolve) => {
        resolveDetach = resolve;

        watcher = ingestNativeConversation({
          appDataDir: rootDir,
          conversationId: convId,
          fromByteOffset: baselineOffset,
          followSubagents: true,
          watch: false,
          onEvent(ev) {
            if (ev.type === "session_bound") return;
            sawNewActivity = true;
            if (ev.type === "reasoning_delta" && ev.delta) {
              reasoningText += ev.delta;
            } else if (ev.type === "message_delta" && ev.delta) {
              assistantText += ev.delta;
            } else if (ev.type === "usage_updated" && ev.usage) {
              usage = { ...usage, ...ev.usage };
            }
            emit(ev);
          },
        });

        const pollLoop = setInterval(async () => {
          if (detached) {
            clearInterval(pollLoop);
            resolve();
            return;
          }
          const snap = await watcher.syncNow().catch(() => null);
          if (snap && sawNewActivity && snap.isSettled) {
            settledTicks++;
            // Confirm 2 consecutive quiet checks (~1s) after final PLANNER_RESPONSE with no tool calls
            if (settledTicks >= 2) {
              clearInterval(pollLoop);
              resolve();
            }
          } else {
            settledTicks = 0;
          }
        }, 500);
        pollLoop.unref?.();
      });

      watcher?.stop();

      if (detached) return { detached: true };

      return {
        status: "completed",
        stopReason: "end_turn",
        nativeSessionId: convId,
        hostConversationId: convId,
        isNativeHost: true,
        assistantText: assistantText.trim(),
        reasoningText: reasoningText.trim(),
        usage,
      };
    } catch (err) {
      watcher?.stop();
      if (detached) return { detached: true };
      const errMsg = err?.message || String(err);
      emit({
        type: "error",
        message: errMsg,
        error: errMsg,
        category: classifyErrorCategory(errMsg),
      });
      return {
        status: "failed",
        stopReason: "error",
        nativeSessionId: convId || undefined,
        assistantText: assistantText.trim(),
        reasoningText: reasoningText.trim(),
        usage,
        error: errMsg,
      };
    }
  })();

  return {
    passiveHost: true,
    async cancel() { return unsupportedHostCancel(); },
    async forceKill() { return unsupportedHostCancel(); },
    detach() { detached = true; watcher?.stop(); resolveDetach?.(); },
    async steer(text) {
      if (!detached && convId) {
        try {
          await execHostAgentApi(["send-message", convId, String(text ?? "")], {
            hostEnv,
            timeoutMs: 8000,
          });
          return { supported: true };
        } catch {}
      }
      return { supported: false };
    },
    async respondPermission() {},
    async respondQuestion() {},
    result,
  };
}
