import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { child, safeRoot } from "../core/storage-paths.mjs";
import { repo } from "./check.mjs";
import { resolveSharedDataDir } from "../core/daemon-client.mjs";
import { fileURLToPath } from "node:url";

export function clean(control, root, prune = false) {
  const settingsFile = child(control, "global-settings.json");
  // Read only the project registry, never serialize or log settings.
  const known = fs.existsSync(settingsFile)
    ? JSON.parse(fs.readFileSync(settingsFile, "utf8")).knownProjects
    : [];
  const result = { projects: 0, databases: 0, removedWorktrees: 0 };
  for (const project of new Set([root, ...(known || [])])) {
    if (!safeRoot(project, null, control)) continue;
    const studio = child(project, ".agent-tower");
    if (!fs.existsSync(studio)) continue;
    result.projects++;
    for (const area of ["tmp", "test-runs"]) {
      const dir = child(studio, area);
      if (!fs.existsSync(dir)) continue;
      for (const leaf of fs.readdirSync(dir))
        fs.rmSync(child(dir, leaf), {
          recursive: true,
          force: true,
          maxRetries: 3,
        });
    }
    for (const name of [
      "daemon.log",
      "tower.log",
      "daemon.log.1",
      "tower.log.1",
    ]) {
      const file = child(studio, "logs", name);
      if (fs.existsSync(file)) fs.truncateSync(file);
    }
    const file = child(studio, "conversations", "tower.sqlite");
    if (!fs.existsSync(file)) continue;
    const db = new DatabaseSync(file);
    try {
      db.exec(
        "PRAGMA busy_timeout=5000; DELETE FROM events WHERE seq <= (SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET 1500)",
      );
      const testThreads = db
        .prepare("SELECT id FROM threads WHERE cwd LIKE '%/.agent-tower/test-runs/%' OR cwd LIKE '%\\.agent-tower\\test-runs\\%' OR worktree_path LIKE '%/.agent-tower/test-runs/%' OR worktree_path LIKE '%\\.agent-tower\\test-runs\\%'")
        .all();
      for (const { id } of testThreads) {
        db.prepare("DELETE FROM runtime_requests WHERE thread_id = ?").run(id);
        db.prepare("DELETE FROM turn_items WHERE thread_id = ?").run(id);
        db.prepare("DELETE FROM runs WHERE thread_id = ?").run(id);
        db.prepare("DELETE FROM threads WHERE id = ?").run(id);
      }
      if (db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy)
        throw Error("SQLite checkpoint busy");
      result.databases++;
      if (!prune) continue;
      const linked = new Set(
        db
          .prepare(
            "SELECT worktree_path AS p FROM threads WHERE worktree_path<>''",
          )
          .all()
          .map((r) => path.resolve(r.p).toLowerCase()),
      );
      const area = child(studio, "worktrees");
      if (!fs.existsSync(area)) continue;
      const git = (cwd, args) =>
        execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      for (const e of fs.readdirSync(area, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const wt = child(area, e.name);
        if (
          linked.has(wt.toLowerCase()) ||
          Date.now() - fs.statSync(wt).mtimeMs < 7 * 86400000
        )
          continue;
        if (
          !fs.existsSync(child(wt, ".git")) ||
          git(wt, ["status", "--porcelain", "--ignored"]).trim()
        )
          continue;
        git(project, ["worktree", "remove", "--", wt]);
        result.removedWorktrees++;
      }
    } finally {
      db.close();
    }
  }
  return result;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(
    clean(
      resolveSharedDataDir(),
      repo,
      process.argv.includes("--prune-worktrees"),
    ),
  );
