import fs from "node:fs";
import path from "node:path";
import { child, studioDir } from "../../core/storage-paths.mjs";
export const repoRoot = path.resolve(import.meta.dirname, "../..");
export const runsRoot = () => studioDir(repoRoot, "test-runs");
function pruneFailures(base) {
  const failed = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = child(base, e.name);
      const stamp = fs.statSync(child(dir, ".failed"), {
        throwIfNoEntry: false,
      });
      return { dir, time: stamp?.mtimeMs };
    })
    .filter((e) => e.time !== undefined)
    .sort((a, b) => b.time - a.time || b.dir.localeCompare(a.dir));
  for (const { dir } of failed.slice(3))
    fs.rmSync(child(base, path.basename(dir)), {
      recursive: true,
      force: true,
      maxRetries: 4,
    });
}
export async function withProjectSandbox(testName, action, base = runsRoot()) {
  if (path.relative(runsRoot(), base) !== "")
    child(runsRoot(), path.relative(runsRoot(), base));
  fs.mkdirSync(base, { recursive: true });
  const prefix =
    String(testName)
      .replace(/[^a-z0-9_-]/gi, "_")
      .slice(0, 32) || "test";
  const dir = fs.mkdtempSync(child(base, prefix + "-"));
  let passed = false;
  try {
    const result = await action(dir);
    passed = true;
    return result;
  } finally {
    if (passed)
      fs.rmSync(child(base, path.basename(dir)), {
        recursive: true,
        force: true,
        maxRetries: 6,
        retryDelay: 100,
      });
    else {
      fs.writeFileSync(child(dir, ".failed"), "");
      pruneFailures(base);
    }
  }
}
