import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
export const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
export function project(base, name) {
  const p = path.join(base, name);
  fs.mkdirSync(p);
  git(p, "init", "-b", "main");
  git(
    p,
    "-c",
    "user.name=AgentTower Test",
    "-c",
    "user.email=test@invalid.local",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  return p;
}
export const offlineCatalog = async () => ({
  providers: [],
  extensionTemplates: [],
});
