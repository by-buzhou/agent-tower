import path, { isAbsolute } from "node:path";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { swarmMemberName } from "../catalog.mjs";
import { inside } from "../storage-paths.mjs";
import { inspectSpecPath } from "../spec-context.mjs";
import { stat } from "node:fs/promises";
import {
  ingestNativeConversation,
  peekCachedHostConversationTitle,
  readNativeConversationTitle,
  readNativeSwarmSnapshot,
  readNativeTranscriptSnapshot,
  resolveDefaultAppDataDir,
  resolveTranscriptPath,
} from "../engines/agy-native.mjs";
import {
  normalizeProjectPath,
  summarizeOutput,
  enrichThreadForClient,
  mapSwarmStateToThreadStatus,
} from "./helpers.mjs";

const LARGE_TRANSCRIPT_BYTES = 512 * 1024;
const ROOT_CATCHUP_BYTES = 256 * 1024;

function rootCatchupStart(transcriptPath, startOffset = 0) {
  let fd;
  try {
    fd = openSync(transcriptPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size - startOffset <= LARGE_TRANSCRIPT_BYTES) return null;
    const start = Math.max(startOffset, st.size - ROOT_CATCHUP_BYTES);
    // Include the preceding byte to retain a line beginning exactly at the window boundary.
    const tail = Buffer.allocUnsafe(st.size - start + 1);
    const read = readSync(fd, tail, 0, tail.length, start - 1);
    const firstNewline = tail.subarray(0, read).indexOf(0x0a);
    // If the window contains no line boundary, keep the prior offset for the oversized record.
    return { offset: firstNewline < 0 ? startOffset : start + firstNewline };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function createHostSyncModule(ctx) {
  function nativeTranscriptAvailable(conversationId) {
    if (!/^[a-z0-9_-]{8,128}$/i.test(conversationId)) return false;
    const appDataDir = resolveDefaultAppDataDir(ctx.hostContext.appDataDir, buildHostEnvForDriver());
    const transcript = resolveTranscriptPath(conversationId, appDataDir);
    return Boolean(transcript && existsSync(transcript));
  }

  const passiveDirectOffsets = new Map();
  function buildHostEnvForDriver() {
    const out = {};
    if (ctx.hostContext.appDataDir) out.ANTIGRAVITY_APP_DATA_DIR = ctx.hostContext.appDataDir;
    if (ctx.hostContext.agentApiExe) out.ANTIGRAVITY_AGENTAPI_EXE = ctx.hostContext.agentApiExe;
    if (ctx.hostContext.projectId) out.ANTIGRAVITY_PROJECT_ID = ctx.hostContext.projectId;
    return out;
  }

  function findThreadByHostConversationId(convId) {
    if (!convId) return null;
    const direct = ctx.db.getThread(`thr_native_${convId}`, { includeQueue: false });
    if (direct) return direct;
    const byTask = ctx.db.getThread(convId, { includeQueue: false }) || ctx.db.getConversationThread(convId);
    if (byTask) return byTask;
    const lower = String(convId).toLowerCase();
    const all = ctx.db.listThreads({ includeSubagents: true, includeArchived: true, includeQueue: false, limit: 400 });
    return (
      all.find(
        (t) =>
          String(t.hostConversationId || "").toLowerCase() === lower ||
          String(t.nativeSessionId || "").toLowerCase() === lower
      ) || null
    );
  }

  function validWorkspace(raw) {
    if (!raw || !isAbsolute(raw)) return "";
    try {
      return inspectSpecPath(raw)?.isDirectory() ? normalizeProjectPath(raw) : "";
    } catch { return ""; }
  }

  function nativeWorkspace(rootConvId, rawWorkspace, ...threadWorkspaces) {
    const given = validWorkspace(rawWorkspace);
    const fits = bound => bound && (!given || bound === given || inside(given, bound));
    const policy = validWorkspace(ctx.scopePolicy.getBoundPolicyWorkspace(rootConvId));
    if (policy) return policy;
    const nearby = threadWorkspaces.map(validWorkspace).find(fits);
    if (nearby && nearby !== given) return nearby;
    const fromRoot = ctx.db.listThreads({ rootConversationId: rootConvId, includeSubagents: true, includeQueue: false, limit: 500 })
      .filter(thread => !thread.worktreePath && String(thread.rootConversationId || thread.meta?.rootConversationId || "").toLowerCase() === String(rootConvId || "").toLowerCase())
      .map(thread => validWorkspace(thread.meta.projectRoot || thread.meta.workspace || thread.workspace))
      .find(bound => fits(bound) && bound !== given);
    return fromRoot || given || nearby || policy || "";
  }

  function matchSwarmPreset(name, presets) {
    const exact = String(name || "").trim().toLowerCase();
    if (!exact) return;
    if (Object.hasOwn(presets, exact)) return presets[exact].provider === "antigravity" ? presets[exact] : undefined;
    const canonical = value => value.replace(/-/g, "_");
    const normalized = canonical(exact);
    const keys = Object.keys(presets).filter(key => presets[key].provider === "antigravity");
    const exactAliases = keys.filter(key => canonical(key) === normalized || canonical(swarmMemberName(key)) === normalized);
    if (exactAliases.length === 1) return presets[exactAliases[0]];
    if (exactAliases.length === 0 && exact.length === 24) {
      const truncated = keys.filter(key => canonical(key.slice(0, 24)) === normalized);
      if (truncated.length === 1) return presets[truncated[0]];
    }
  }

  function archiveSupersededNativePlaceholders(nativeThread, rootConversationId, presetKey) {
    const nativeRoot = String(nativeThread.rootConversationId || nativeThread.meta?.rootConversationId || "").toLowerCase();
    const expectedRoot = String(rootConversationId || "").toLowerCase();
    if (!presetKey || !expectedRoot || nativeRoot !== expectedRoot) return;
    const placeholders = ctx.db.listThreads({ rootConversationId, includeSubagents: true, includeQueue: false, limit: 1000 }).filter(thread =>
      thread.id !== nativeThread.id && !thread.isNativeHost && !thread.meta?.isNativeHost && thread.status === "failed" &&
      thread.presetKey === presetKey && String(thread.rootConversationId || thread.meta?.rootConversationId || "").toLowerCase() === expectedRoot &&
      /new-conversation|HOST_TOPLEVEL_FORBIDDEN|AGY_SWARM_DISPATCH_REQUIRED/i.test(`${thread.lastError || ""} ${thread.meta?.error || ""}`));
    for (const thread of placeholders) {
      const archived = ctx.db.upsertThread({ id: thread.id, archived: true,
        meta: { supersededByNativeId: nativeThread.id, supersededAt: Date.now() } });
      ctx.context.emitEvent({ type: "thread_archived", threadId: thread.id, rootConversationId,
        workspace: archived.workspace || archived.cwd, thread: enrichThreadForClient(archived) });
    }
  }

  function ensureNativeHostThread(
    convId,
    {
      parentConvId = "",
      subagentName = "",
      memberName = "",
      role = "",
      curationPrompt,
      model = "",
      status = "",
      swarmState = "",
      isSwarmMember = false,
      killed = false,
      title = "",
      workspace = "",
    } = {}
  ) {
    const cleanConvId = String(convId || "").trim();
    const existing = findThreadByHostConversationId(cleanConvId);
    if (existing?.archived && (!killed || existing.status === "interrupted")) return existing;
    let parentThreadId = existing?.parentThreadId || null;
    let parentThread = parentThreadId ? ctx.db.getThread(parentThreadId, { includeQueue: false }) : null;
    if (parentConvId && parentConvId !== cleanConvId && parentConvId !== parentThread?.hostConversationId) {
      const candidateParent = findThreadByHostConversationId(parentConvId) || ensureNativeHostThread(parentConvId, { workspace });
      if (candidateParent && candidateParent.id !== (existing?.id || `thr_native_${cleanConvId}`)) {
        parentThread = candidateParent;
        parentThreadId = candidateParent.id;
      }
    }

    const threadId = existing?.id || `thr_native_${cleanConvId}`;
    const isSubagent = Boolean(parentConvId || parentThreadId);
    const rootConvId = parentThread?.rootConversationId || parentThread?.meta?.rootConversationId || parentConvId || existing?.rootConversationId || existing?.meta?.rootConversationId || cleanConvId;
    const normWs = nativeWorkspace(rootConvId, workspace,
      existing?.meta?.projectRoot, parentThread?.meta?.projectRoot,
      existing?.meta?.workspace || existing?.workspace, parentThread?.meta?.workspace || parentThread?.workspace);
    const shortName =
      memberName ||
      subagentName ||
      existing?.meta?.memberName ||
      (isSubagent ? `agent-${cleanConvId.slice(0, 6)}` : "coordinator");
    const effectiveTitle =
      title ||
      (memberName
        ? memberName
        : existing?.title &&
            !existing.title.startsWith("Antigravity ") &&
            !existing.title.startsWith("原生子代理")
          ? existing.title
          : subagentName || (isSubagent ? `agent-${cleanConvId.slice(0, 6)}` : "coordinator"));

    const isCoordinator = cleanConvId === rootConvId && !isSubagent ||
      [role, shortName].some(value => String(value || "").toLowerCase() === "coordinator");
    const presets = ctx.db.getProjectRoster(normWs).presets;
    const matched = (isSubagent || isSwarmMember || existing?.meta?.isSwarmMember) && !isCoordinator
      ? matchSwarmPreset(shortName, presets) : undefined;
    const claimed = !isCoordinator && (isSubagent || isSwarmMember || existing?.meta?.isSwarmMember)
      ? ctx.dispatch?.claimNativeHandoff({ rootConversationId: rootConvId, presetKey: matched?.key || "",
        swarmName: isSwarmMember ? shortName : "", label: !isSwarmMember ? shortName : "",
        nativeKind: isSwarmMember || existing?.meta?.isSwarmMember ? "swarm" : "subagent",
        conversationId: cleanConvId, swarmState, curationPrompt }) : null;
    const activePreset = matched || (claimed?.presetKey && Object.hasOwn(presets, claimed.presetKey) ? presets[claimed.presetKey] : undefined);
    const knownRole = ["commander", "advisor", "executor", "review", "reviewer", "research", "general"].includes(String(role || "").toLowerCase()) ? role : "";

    const thread = ctx.db.upsertThread({
      id: threadId,
      taskId: existing?.taskId || cleanConvId,
      parentThreadId,
      hostConversationId: cleanConvId,
      nativeSessionId: cleanConvId,
      title: activePreset ? activePreset.label || activePreset.title || shortName : effectiveTitle,
      role: activePreset ? activePreset.group || activePreset.role || "executor" : claimed?.role || knownRole || existing?.role || (isSubagent ? "executor" : "commander"),
      presetKey: activePreset?.key || "",
      provider: "antigravity",
      model: model || claimed?.requestedModel || activePreset?.model || existing?.model || (isSubagent ? "gemini-4-hydrogen" : "gemini-4-carbon"),
      effort: activePreset ? activePreset.effort || "high" : existing?.effort || "medium",
      permissionMode: claimed?.role === "curator" ? "plan" : existing?.permissionMode || "auto-accept-edits",
      interactionMode: claimed?.role === "curator" ? "plan" : existing?.interactionMode || "default",
      isolation: claimed?.role === "curator" ? "shared" : "local",
      status: killed ? "interrupted" : status || existing?.status || "completed",
      ...(killed ? { archived: true } : {}),
      workspace: normWs,
      cwd: existing?.worktreePath ? existing.cwd : normWs || existing?.cwd,
      meta: {
        ...(existing?.meta || {}),
        isNativeHost: true,
        hostConversationId: cleanConvId,
        rootConversationId: rootConvId,
        memberName: shortName,
        isSwarmMember: Boolean(isSwarmMember || existing?.meta?.isSwarmMember),
        ...(swarmState ? { swarmState } : {}),
        ...(claimed ? { handoffId: claimed.handoffId, nativeKind: claimed.nativeKind,
          planPath: claimed.planPath, specIds: claimed.specIds, targetPaths: claimed.targetPaths } : {}),
        ...(normWs ? { projectRoot: normWs } : {}),
      },
    });
    if (claimed?.role === "curator") ctx.specs.observeNativeCuration(claimed, thread, {});
    if (activePreset || claimed) archiveSupersededNativePlaceholders(thread, rootConvId, activePreset?.key || claimed?.presetKey || "");

    if (killed) {
      ctx.context.emitEvent({ type: "thread_archived", threadId, rootConversationId: rootConvId, workspace: normWs,
        thread: enrichThreadForClient(thread) });
    } else if (!existing) {
      const enriched = enrichThreadForClient(thread, {
        repoRootCache: ctx.repoRootCache,
        fallbackWorkspace: normWs,
      });
      ctx.context.emitEvent({
        type: "thread_created",
        threadId: enriched.id,
        workspace: normWs,
        rootConversationId: rootConvId,
        isNativeHost: true,
        hostConversationId: cleanConvId,
        thread: enriched,
      });
    } else if (["status", "title", "role", "presetKey", "model", "effort", "workspace"].some(key => existing[key] !== thread[key]) || existing.meta?.projectRoot !== thread.meta?.projectRoot) {
      // Publish identity, workspace and status changes so attached panels stay in sync.
      ctx.context.emitEvent({
        type: "thread_updated",
        threadId: thread.id,
        workspace: normWs,
        thread: enrichThreadForClient(thread, { repoRootCache: ctx.repoRootCache, fallbackWorkspace: normWs }),
      });
    }

    return thread;
  }

  function reconcileMissingSwarmMembers(swarmSnap) {
    const root = swarmSnap.rootConversationId;
    if (!root) return;
    const present = new Set(swarmSnap.members.map(member => String(member.conversation_id || "").toLowerCase()).filter(Boolean));
    const missing = ctx.db.listThreads({ rootConversationId: root, includeSubagents: true, includeQueue: false, limit: 1000 }).filter(thread =>
      (thread.meta?.isSwarmMember || thread.isSwarmMember) &&
      thread.role !== "commander" &&
      String(thread.hostConversationId || "").toLowerCase() !== String(root).toLowerCase() &&
      String(ctx.scopePolicy.threadPolicyRoot(thread) || "").toLowerCase() === String(root).toLowerCase() &&
      !present.has(String(thread.nativeSessionId || thread.hostConversationId || "").toLowerCase()));
    for (const thread of missing) {
      const ticket = ctx.dispatch.findNativeHandoff({ rootConversationId: root, nativeKind: "swarm",
        conversationId: thread.hostConversationId, includeClaimed: true, role: "curator" });
      if (ticket) ctx.specs.observeNativeCuration(ticket, thread, { settled: true, cancelled: true });
      const archived = ctx.db.upsertThread({ id: thread.id, archived: true, activeRunId: null,
        meta: { leftSwarm: true, leftSwarmAt: Date.now() } });
      ctx.context.emitEvent({ type: "thread_archived", threadId: thread.id, rootConversationId: root,
        workspace: archived.workspace || archived.cwd, thread: enrichThreadForClient(archived) });
    }
  }

  function materializeSwarmSnapshotThreads(swarmSnap, workspace, appDataDir) {
    if (!swarmSnap?.found || !Array.isArray(swarmSnap.members)) return;
    ctx.latestSwarmSnapshots.set(swarmSnap.rootConversationId, swarmSnap);
    const normWs = nativeWorkspace(swarmSnap.rootConversationId, workspace);

    // Ensure coordinator root thread exists first so worker parentThreadId always resolves cleanly
    const coord = swarmSnap.members.find(
      (m) => m.role === "coordinator" || m.conversation_id === swarmSnap.rootConversationId
    );
    if (coord?.conversation_id) {
      ensureNativeHostThread(coord.conversation_id, {
        parentConvId: "",
        memberName: coord.name || "coordinator",
        role: "commander",
        model: coord.model || "gemini-4-carbon",
        killed: coord.killed === true,
        status: mapSwarmStateToThreadStatus(coord.state),
        swarmState: coord.state,
        isSwarmMember: true,
        title: peekCachedHostConversationTitle(coord.conversation_id, appDataDir) ||
          (swarmSnap.title ? `${coord.name} · ${swarmSnap.title}` : coord.name),
        workspace: normWs,
      });
    }

    for (const mem of swarmSnap.members) {
      const cid = String(mem.conversation_id || "").trim();
      if (!cid || cid === coord?.conversation_id) continue;
      ensureNativeHostThread(cid, {
        parentConvId: mem.parentConversationId || swarmSnap.rootConversationId,
        memberName: mem.name,
        subagentName: mem.name,
        role: mem.role === "monitor" ? "monitor" : "executor",
        model: mem.model,
        killed: mem.killed === true,
        status: mapSwarmStateToThreadStatus(mem.state),
        swarmState: mem.state,
        isSwarmMember: true,
        title: mem.name,
        workspace: normWs,
      });
    }
    reconcileMissingSwarmMembers(swarmSnap);
    return normWs;
  }

  function observeSwarmCuration(swarm) {
    for (const member of swarm.members || []) {
      const conversationId = member.conversation_id;
      if (!conversationId) continue;
      let ticket = ctx.dispatch.findNativeHandoff({ rootConversationId: swarm.rootConversationId,
        conversationId, nativeKind: "swarm", includeClaimed: true });
      const postFor = candidate => (swarm.messages || []).findLast(message => message.seq > candidate.boardHead &&
        message.agent.toLowerCase() === member.name.toLowerCase() &&
        /@coordinator\s+\[done\]|agent-tower-spec-proposal/i.test(message.text));
      if (!ticket) {
        const waitingTicket = ctx.dispatch.findNativeHandoff({ rootConversationId: swarm.rootConversationId,
          swarmName: member.name, nativeKind: "swarm", role: "curator" });
        if (waitingTicket?.residentConversationId?.toLowerCase() === conversationId.toLowerCase() && postFor(waitingTicket)) {
          ticket = ctx.dispatch.claimNativeHandoff({ rootConversationId: swarm.rootConversationId,
            conversationId, swarmName: member.name, nativeKind: "swarm", freshOutput: true });
        }
      }
      if (ticket?.role !== "curator") continue;
      const thread = findThreadByHostConversationId(conversationId);
      if (!thread) continue;
      const post = postFor(ticket);
      const waiting = String(member.state).toLowerCase() === "waiting";
      ctx.specs.observeNativeCuration(ticket, thread, { rawText: post?.text,
        waiting, cancelled: member.killed, settled: member.killed || waiting && Boolean(post) });
    }
  }

  function syncNativeTurnTiming(thread, timing, workspace = "") {
    const isSwarmMemberThread = Boolean(thread?.meta?.isSwarmMember || thread?.isSwarmMember);
    const isSubagentThread = Boolean(thread?.parentThreadId || timing?.parentConversationId);
    const isCoordinator = thread?.role === "commander" || String(thread?.meta?.memberName || "").toLowerCase() === "coordinator";
    const turnStartedAt = Number(timing?.turnStartedAt || 0);
    if ((!isSubagentThread && !isSwarmMemberThread) || isCoordinator || turnStartedAt <= 0) return;
    const parsedCompletedAt = Number(timing?.turnCompletedAt || 0);
    const turnCompletedAt = parsedCompletedAt > 0 ? parsedCompletedAt : null;
    const turnDurationMs = turnCompletedAt
      ? Math.max(0, Number(timing?.turnDurationMs) || turnCompletedAt - turnStartedAt)
      : 0;
    const current = ctx.db.getThread(thread.id, { includeQueue: false });
    if (!current || (current.startedAt === turnStartedAt && (current.completedAt ?? null) === turnCompletedAt && Number(current.durationMs || 0) === turnDurationMs)) return;
    const updatedThread = enrichThreadForClient(ctx.db.upsertThread({
      id: thread.id,
      startedAt: turnStartedAt,
      completedAt: turnCompletedAt,
      durationMs: turnDurationMs,
    }));
    ctx.context.emitEvent({ type: "thread_updated", threadId: thread.id, workspace: workspace || thread.meta?.workspace || thread.cwd, thread: updatedThread });
  }

  function resolveNativeChildResumeState(childConvId) {
    const existing = findThreadByHostConversationId(childConvId);
    if (!existing || Number(existing.meta?.nativeTranscriptOffset || 0) <= 0) return null;
    return {
      fromByteOffset: Number(existing.meta.nativeTranscriptOffset),
      initialUsage: {
        inputTokens: existing.usage?.inputTokens || 0,
        cachedInputTokens: existing.usage?.cachedTokens || 0,
        outputTokens: existing.usage?.outputTokens || 0,
        reasoningOutputTokens: existing.usage?.reasoningTokens || 0,
        totalTokens: existing.usage?.totalTokens || 0,
      },
      ...resumeTurnTiming(existing),
    };
  }

  // A restart that resumes from a persisted offset must not wipe a settled member's last-turn timing.
  function resumeTurnTiming(existing) {
    return {
      initialTurnStartedAt: Number(existing.startedAt || 0),
      initialTurnSettled: existing.status === "completed" || existing.status === "waiting",
      initialTurnCompletedAt: existing.completedAt ?? null,
      initialTurnDurationMs: Number(existing.durationMs || 0),
    };
  }

  function persistNativeChildOffsets(watcher) {
    for (const [childConvId, rawOffset] of Object.entries(watcher.getChildOffsets?.() || {})) {
      const offset = Number(rawOffset || 0);
      const existing = findThreadByHostConversationId(childConvId);
      if (!existing || offset <= Number(existing.meta?.nativeTranscriptOffset || 0)) continue;
      ctx.db.upsertThread({ id: existing.id, meta: { nativeTranscriptOffset: offset } });
    }
  }

  async function syncNativeHostConversation(conversationId, { appDataDir = "", workspace = "" } = {}) {
    const convId = String(conversationId || "").trim();
    if (!convId || convId.length < 8) return null;

    const resolvedAppData = resolveDefaultAppDataDir(
      appDataDir || ctx.hostContext.appDataDir,
      buildHostEnvForDriver()
    );
    let entry = ctx.nativeWatchers.get(convId);

    if (!entry) {
      const existingThread = findThreadByHostConversationId(convId);
      const startOffset = Number(existingThread?.meta?.nativeTranscriptOffset || 0);
      const rootConvId = ctx.scopePolicy.policyRoot({ conversationId: convId, appDataDir: resolvedAppData }) || convId;
      const policy = ctx.scopePolicy.readConversationPolicy(rootConvId);
      const swarmSnap = readNativeSwarmSnapshot({ conversationId: convId, appDataDir: resolvedAppData });
      const normWs = nativeWorkspace(rootConvId, workspace);
      const hasInitializedDb = Boolean(normWs && existsSync(path.join(normWs, ".agent-tower", "conversations", "tower.sqlite")));
      if (!existingThread && !hasInitializedDb && policy.source !== "explicit" && policy.orchestrationMode === "direct" && !swarmSnap?.found &&
          !ctx.dispatch.findNativeHandoff({ rootConversationId: rootConvId, role: "curator", includeClaimed: true })) {
        const passiveKey = `${resolvedAppData}\0${convId.toLowerCase()}`;
        const passiveSnap = await readNativeTranscriptSnapshot({
          appDataDir: resolvedAppData,
          conversationId: convId,
          fromByteOffset: passiveDirectOffsets.get(passiveKey) || 0,
        });
        if (!(passiveSnap?.discoveredSubagents?.length > 0)) {
          if (passiveSnap?.nextByteOffset >= 0) {
            passiveDirectOffsets.set(passiveKey, passiveSnap.nextByteOffset);
            if (passiveDirectOffsets.size > 256) passiveDirectOffsets.delete(passiveDirectOffsets.keys().next().value);
          }
          return passiveSnap;
        }
        passiveDirectOffsets.delete(passiveKey);
      }

      const catchup = convId.toLowerCase() === rootConvId.toLowerCase() && !existingThread?.parentThreadId
        ? rootCatchupStart(resolveTranscriptPath(convId, resolvedAppData), startOffset)
        : null;
      const catchupTitle = catchup?.offset
        ? readNativeConversationTitle(convId, resolvedAppData, { skipRootResolve: true })
        : "";
      let initialCatchup = true;
      const watcher = ingestNativeConversation({
        appDataDir: resolvedAppData,
        conversationId: convId,
        fromByteOffset: catchup?.offset || startOffset,
        ...(existingThread && startOffset > 0 ? {
          initialUsage: {
            inputTokens: existingThread.usage?.inputTokens || 0,
            cachedInputTokens: existingThread.usage?.cachedTokens || 0,
            outputTokens: existingThread.usage?.outputTokens || 0,
            reasoningOutputTokens: existingThread.usage?.reasoningTokens || 0,
            totalTokens: existingThread.usage?.totalTokens || 0,
          },
          ...resumeTurnTiming(existingThread),
        } : {}),
        followSubagents: true,
        watch: true,
        pollIntervalMs: 800,
        resolveChildResumeState: resolveNativeChildResumeState,
        onSubagentDiscovered(sub) {
          ensureNativeHostThread(sub.childConversationId, {
            parentConvId: sub.parentConversationId || convId,
            subagentName: sub.subagentName,
            memberName: sub.memberName || sub.subagentName,
            role: sub.role,
            curationPrompt: sub.isSwarmMember ? undefined : sub.prompt,
            model: sub.model,
            killed: sub.killed === true,
            status: sub.state ? mapSwarmStateToThreadStatus(sub.state) : "",
            swarmState: sub.state || "",
            isSwarmMember: Boolean(sub.isSwarmMember),
            workspace,
          });
        },
        onEvent(ev) {
          if (ev.type === "swarm_snapshot" && ev.swarm?.found) {
            const projectWorkspace = materializeSwarmSnapshotThreads(ev.swarm, workspace, resolvedAppData);
            ctx.context.emitEvent({
              type: "swarm_snapshot",
              rootConversationId: ev.swarm?.rootConversationId || rootConvId,
              workspace: projectWorkspace,
              swarm: {
                found: true,
                rootConversationId: ev.swarm.rootConversationId,
                title: ev.swarm.title || "",
                head: Number(ev.swarm.head || 0),
                messageCount: Array.isArray(ev.swarm.messages) ? ev.swarm.messages.length : 0,
                edgeCount: Array.isArray(ev.swarm.edges) ? ev.swarm.edges.length : 0,
                members: (ev.swarm.members || []).map((m) => ({
                  name: m.name,
                  role: m.role,
                  state: m.state,
                  model: m.model,
                  model_display_name: m.model_display_name || "",
                  killed: Boolean(m.killed),
                  conversation_id: m.conversation_id || "",
                  lastPostSeq: m.lastPostSeq || 0,
                })),
              },
            });
            if (!initialCatchup) {
              observeSwarmCuration(ev.swarm);
              ctx.specs.scheduleAuto(ev.swarm.rootConversationId || rootConvId, projectWorkspace);
            }
            return;
          }

          const targetConvId = ev.conversationId || convId;
          // The caller immediately gets a fresh snapshot. Persist the tail's state and items
          // without replaying its high-frequency events or affecting child/live streams.
          const quietCatchup = initialCatchup && Boolean(catchup) && targetConvId === convId;
          const cachedHostTitle = (quietCatchup || ev.type === "title_updated") &&
            targetConvId.toLowerCase() === rootConvId.toLowerCase() ? peekCachedHostConversationTitle(rootConvId, resolvedAppData) : "";
          const initialTitle = quietCatchup ? cachedHostTitle || catchupTitle : "";
          const t = ensureNativeHostThread(targetConvId, {
            ...(initialTitle ? { title: initialTitle } : {}),
            parentConvId: ev.parentConversationId || "",
            memberName: ev.memberName || "",
            workspace,
          });
          if (t.archived) return;
          const curationTicket = !initialCatchup && targetConvId.toLowerCase() !== rootConvId.toLowerCase() &&
            ctx.dispatch.findNativeHandoff({ rootConversationId: rootConvId, conversationId: targetConvId, includeClaimed: true });
          if (curationTicket?.role === "curator") {
            const startedAt = curationTicket.admittedAt || curationTicket.createdAt;
            if (ev.type === "message_delta" && (ev.text || ev.delta) && ev.timestamp >= startedAt) {
              ctx.specs.observeNativeCuration(curationTicket, t, { rawText: String(ev.text || ev.delta) });
            } else if (ev.type === "settle_state" && ev.settled && (ev.turnCompletedAt || ev.timestamp) >= startedAt) {
              ctx.specs.observeNativeCuration(curationTicket, t, curationTicket.nativeKind === "subagent"
                ? { settled: true } : { transcriptSettled: true });
            }
          }
          const runId = `run_native_${targetConvId}`;
          const ws = t.meta?.workspace || t.cwd;
          syncNativeTurnTiming(t, ev, ws);

          if (!ctx.db.getRun(runId)) {
            ctx.db.upsertRun({
              id: runId,
              threadId: t.id,
              status: "completed",
              provider: "antigravity",
              model: t.model,
              effort: t.effort,
              nativeSessionId: targetConvId,
              prompt: "Native Antigravity Host Conversation",
              inputIntent: "native_host",
            });
          }

          if (ev.type === "settle_state") {
            const nextOffset = Number(ev.nextByteOffset || 0);
            const offsetPatch = nextOffset > Number(t.meta?.nativeTranscriptOffset || 0)
              ? { meta: { nativeTranscriptOffset: nextOffset } }
              : {};
            // 仅用于原生 invoke_subagent 子代理：根会话由 syncNativeHostConversation 管理，swarm 成员以花名册为准
            if (targetConvId !== convId && !(t.meta?.isSwarmMember || t.isSwarmMember)) {
              const nextStatus = ev.settled ? "completed" : "running";
              const cur = ctx.db.getThread(t.id, { includeQueue: false });
              if (cur && (cur.status !== nextStatus || offsetPatch.meta)) {
                const updatedT = enrichThreadForClient(ctx.db.upsertThread({ id: t.id, status: nextStatus, ...offsetPatch }));
                if (cur.status !== nextStatus) {
                  ctx.context.emitEvent({ type: "thread_updated", threadId: t.id, workspace: ws, thread: updatedT });
                }
              }
            } else if (targetConvId !== convId && offsetPatch.meta) {
              ctx.db.upsertThread({ id: t.id, ...offsetPatch });
            }
            if (!initialCatchup && targetConvId.toLowerCase() === rootConvId.toLowerCase()) {
              ctx.specs.onHostSettlement(rootConvId, ws, ev.settled);
            } else if (!initialCatchup && ev.settled) {
              ctx.specs.scheduleAuto(rootConvId, ws);
            }
            return;
          }

          if (ev.type === "title_updated" && ev.title) {
            const cur = ctx.db.getThread(t.id, { includeQueue: false });
            const title = cachedHostTitle || ev.title;
            if (
              cur && cur.title !== title &&
              (cachedHostTitle ||
                !cur.title ||
                cur.title.includes("宿主原生") ||
                cur.title.startsWith("原生子代理") ||
                cur.title.startsWith("Antigravity "))
            ) {
              const updatedT = enrichThreadForClient(ctx.db.upsertThread({ id: t.id, title }));
              ctx.context.emitEvent({
                type: "title_updated",
                threadId: t.id,
                runId,
                workspace: ws,
                title,
                thread: updatedT,
              });
            }
          } else if (ev.type === "user_message" && ev.text) {
            const itemId = ev.item?.id || `agy_user_${targetConvId}_${Date.now()}`;
            const savedItem = ctx.db.upsertTurnItem({
              id: itemId,
              threadId: t.id,
              runId,
              type: "user_message",
              role: "user",
              status: "completed",
              text: ev.text,
              createdAt: ev.timestamp,
            });
            if (!quietCatchup) ctx.context.emitEvent({ type: "turn_item", threadId: t.id, runId, workspace: ws, item: savedItem });
          } else if (ev.type === "reasoning_delta" && (ev.text || ev.delta)) {
            const itemId = `agy_think_${targetConvId}_${ev.stepIndex ?? Date.now()}`;
            const thinkText = String(ev.text || ev.delta || "").trim();
            ctx.db.upsertTurnItem({
              id: itemId,
              threadId: t.id,
              runId,
              type: "reasoning",
              title: "Host Thinking",
              status: "completed",
              text: thinkText,
              createdAt: ev.item?.createdAt ?? ev.timestamp,
              completedAt: ev.item?.completedAt ?? null,
              durationMs: Number(ev.item?.durationMs || 0),
            });
            // An empty delta is a timing back-fill of an existing reasoning item: DB only, no duplicate stream text.
            if (!quietCatchup && ev.delta !== "") ctx.context.emitEvent({
              type: "reasoning_delta",
              threadId: t.id,
              runId,
              workspace: ws,
              itemId,
              delta: ev.delta || `${thinkText}\n`,
            });
          } else if (ev.type === "tool_call") {
            const rawId = ev.toolCallId || ev.id || `agy_tc_${Date.now()}`;
            ctx.db.upsertTurnItem({
              id: rawId,
              threadId: t.id,
              runId,
              type: "tool_call",
              kind: ev.kind || "other",
              title: ev.title || ev.toolName || "Host Tool",
              status: ev.status || "completed",
              toolCallId: rawId,
              command: ev.command || "",
              filePath: ev.filePath || "",
              rawInput: ev.rawInput ?? ev.input,
              output: ev.output || "",
              createdAt: ev.timestamp,
              durationMs: ev.durationMs || 0,
            });
            if (!quietCatchup) ctx.context.emitEvent({
              type: "tool_call",
              threadId: t.id,
              runId,
              workspace: ws,
              itemId: rawId,
              toolCallId: rawId,
              toolName: ev.toolName || ev.name || "tool",
              kind: ev.kind || "other",
              title: ev.title || ev.toolName || "Host Tool",
              status: ev.status || "completed",
              command: ev.command || "",
              filePath: ev.filePath || "",
              input: ev.input ?? ev.rawInput,
              output: ev.output || "",
              durationMs: ev.durationMs || 0,
            });
          } else if (ev.type === "message_delta" && (ev.text || ev.delta)) {
            const itemId = ev.item?.id || ev.itemId || `agy_msg_${targetConvId}_${ev.stepIndex ?? Date.now()}`;
            const msgText = String(ev.text || ev.delta || "").trim();
            ctx.db.upsertTurnItem({
              id: itemId,
              threadId: t.id,
              runId,
              type: "assistant_message",
              role: "assistant",
              status: "completed",
              text: msgText,
              createdAt: ev.timestamp,
            });
            // swarm 成员的状态以宿主 swarm 花名册为准；历史 transcript 回放出的 message_delta 不能把它们改回「工作中」
            const isSwarmMemberThread = Boolean(t.meta?.isSwarmMember || t.isSwarmMember);
            const isRootHostThread = targetConvId === convId;
            const updatedT = enrichThreadForClient(
              ctx.db.upsertThread({
                id: t.id,
                ...(isSwarmMemberThread || isRootHostThread
                  ? {}
                  : { status: ev.phase === "final_answer" ? "completed" : "running" }),
                summary: summarizeOutput(msgText),
              })
            );
            if (!quietCatchup) ctx.context.emitEvent({
              type: "message_delta",
              threadId: t.id,
              runId,
              workspace: ws,
              itemId,
              delta: ev.delta || `${msgText}\n`,
              phase: ev.phase || "final_answer",
            });
            if (!quietCatchup) ctx.context.emitEvent({
              type: "thread_updated",
              threadId: t.id,
              workspace: ws,
              thread: updatedT,
            });
          } else if (ev.type === "usage_updated" && ev.usage) {
            const u = ev.usage;
            const usagePatch = {
              inputTokens: Number(u.inputTokens) || 0,
              cachedTokens: Number(u.cachedTokens ?? u.cachedInputTokens) || 0,
              reasoningTokens: Number(u.reasoningTokens ?? u.reasoningOutputTokens) || 0,
              outputTokens: Number(u.outputTokens) || 0,
              totalTokens: Number(u.totalTokens) || 0,
              contextUsed: Number(u.contextUsed) || 0,
              contextLimit: Number(u.contextLimit) || 1048576,
            };
            const updatedT = ctx.db.upsertThread({ id: t.id, usage: usagePatch });
            if (!quietCatchup) ctx.context.emitEvent({
              type: "usage_updated",
              threadId: t.id,
              runId,
              workspace: ws,
              usage: updatedT.usage,
            });
          }
        },
      });

      entry = { watcher, resolvedAppData };
      ctx.nativeWatchers.set(convId, entry);
      await watcher.initialSyncPromise;
      initialCatchup = false;
    } else {
      await entry.watcher.syncNow().catch(() => null);
    }
    persistNativeChildOffsets(entry.watcher);

    const snap = entry.watcher.getSnapshot?.();
    // Always sync native swarm roster & board even if the main conversationId is a worker or coordinator
    const swarmSnap = readNativeSwarmSnapshot({
      conversationId: convId,
      appDataDir: resolvedAppData,
    });
    if (swarmSnap?.found) {
      materializeSwarmSnapshotThreads(swarmSnap, workspace, resolvedAppData);
      observeSwarmCuration(swarmSnap);
    }

    if (snap?.found) {
      const hostThread = ensureNativeHostThread(convId, { workspace, title: peekCachedHostConversationTitle(convId, resolvedAppData) });
      if (hostThread.archived) return snap;
      // swarm 协调者的状态以花名册为准；isSettled 未知（null）时保持原状态，避免重启后误判为「工作中」
      const isSwarmCoordinator = Boolean(hostThread.meta?.isSwarmMember || hostThread.isSwarmMember);
      const settledStatus =
        !isSwarmCoordinator && typeof snap.isSettled === "boolean"
          ? snap.isSettled
            ? "completed"
            : "running"
          : undefined;
      const savedHost = ctx.db.upsertThread({
        id: hostThread.id,
        ...(settledStatus ? { status: settledStatus } : {}),
        meta: {
          ...(hostThread.meta || {}),
          isNativeHost: true,
          hostConversationId: convId,
          nativeTranscriptOffset: entry.watcher.getOffset?.() || 0,
        },
      });
      if (savedHost && settledStatus && hostThread.status !== savedHost.status) {
        ctx.context.emitEvent({
          type: "thread_updated",
          threadId: savedHost.id,
          workspace: savedHost.meta?.workspace || savedHost.cwd,
          thread: enrichThreadForClient(savedHost),
        });
      }
      syncNativeTurnTiming(savedHost, snap, savedHost?.meta?.workspace || savedHost?.cwd);
      const root = ctx.scopePolicy.threadPolicyRoot(savedHost);
      if (root?.toLowerCase() === convId.toLowerCase()) {
        const coordWorking = isSwarmCoordinator && swarmSnap?.found &&
          swarmSnap.members.some(m => (m.role === "coordinator" || String(m.conversation_id || "").toLowerCase() === convId.toLowerCase()) &&
            !m.killed && String(m.state || "").toLowerCase() === "working");
        ctx.specs.onHostSettlement(root, savedHost?.meta?.projectRoot || savedHost?.workspace || savedHost?.cwd,
          coordWorking ? false : snap.isSettled);
      }
    }

    return snap;
  }

  // Archive without cancelling a host turn or starting a watcher. A closed native conversation
  // may have a transcript but no Studio row if its parent was never opened in this pane.
  async function archiveThread({ threadId, appDataDir } = {}) {
    const match = /^thr_native_([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(threadId || "");
    if (!match) return ctx.cancellation.deleteThread({ threadId, cascade: false });
    const cid = match[1];
    const existing = findThreadByHostConversationId(cid);
    if (existing?.archived) return { archived: true, threadId: existing.id };
    if (!existing) {
      const root = resolveDefaultAppDataDir(appDataDir || ctx.hostContext.appDataDir, buildHostEnvForDriver());
      if (!(await stat(resolveTranscriptPath(cid, root)).catch(() => null))?.isFile()) {
        throw new Error(`找不到原生会话: ${cid}`);
      }
    }
    const t = ctx.db.upsertThread(existing ? { id: existing.id, archived: true } : {
      id: threadId, taskId: cid, provider: "antigravity", status: "archived", archived: true,
      nativeSessionId: cid, hostConversationId: cid, meta: { isNativeHost: true },
    });
    ctx.context.emitEvent({ type: "thread_archived", threadId: t.id, thread: enrichThreadForClient(t), workspace: t.workspace || t.cwd });
    return { archived: true, threadId: t.id };
  }

  function stopNativeWatchers() {
    for (const [, entry] of ctx.nativeWatchers) {
      try {
        entry.watcher?.stop?.();
      } catch {}
    }
    ctx.nativeWatchers.clear();
  }

  return {
    archiveThread,
    buildHostEnvForDriver,
    findThreadByHostConversationId,
    stopNativeWatchers,
    nativeTranscriptAvailable,
    syncNativeHostConversation,
  };
}
