import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { crc32, inflateRawSync } from "node:zlib";
import { atomicJson, child, inside } from "./storage-paths.mjs";

const OFFICIAL_FEED = "https://api.github.com/repos/by-buzhou/agent-tower/releases?per_page=10";
const CHECK_INTERVAL = 12 * 60 * 60 * 1000;
const CHECK_JITTER = 60 * 60 * 1000;
const INSTALL_ORIGINS = new Set(["dev", "git-clone", "zip"]);
const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;
const RELEASE_VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2,3}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MIRROR_TEMP = /^\.agent-tower-update-[a-f0-9-]{36}\.tmp$/;
const MAX_FILES = 1024;
const MAX_RUNTIME_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_BYTES = MAX_RUNTIME_BYTES + 2 * 1024 * 1024;
const runNode = promisify(execFile);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const updateWriteWait = new Int32Array(new SharedArrayBuffer(4));

export const RUNTIME_WHITELIST = [
  "hooks.json", "plugin.json", "mcp_config.json", "README.md", "LICENSE",
  "assets", "core", "sidecars", "skills", "rules",
];
export const RUNTIME_JUNK =
  /(?:\.bak.*|\.tmp)$|^archive-legacy$|^\.env|^config\.json$|^auth\.json$|lease.*\.json$|\.sqlite|\.db$/i;
export const UPDATE_INTERNAL = Symbol("Internal update RPC");

export function updateError(code, message) {
  return Object.assign(new Error(message), { code });
}

const integrity = () => updateError("UPDATE_INTEGRITY_FAILED", "Release files failed integrity validation");
const checksum = () => updateError("UPDATE_CHECKSUM_MISMATCH", "Release download checksum did not match");
const busy = () => updateError("UPDATE_IN_PROGRESS", "A system update is already in progress");

export function parseUpdateVersion(version) {
  const match = typeof version === "string" && VERSION.exec(version.trim());
  return match ? match.slice(1).map(value => BigInt(value || 0)) : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export function updatePath(dataDir, ...parts) {
  const resolved = path.resolve(dataDir);
  return child(path.parse(resolved).root, resolved, "updates", ...parts);
}

export function hasUpdateProbation(dataDir) {
  return fs.existsSync(updatePath(dataDir, "probation.json"));
}

export function readUpdateRecord(dataDir, ...parts) {
  let fd;
  try {
    const file = updatePath(dataDir, ...parts);
    if (!fs.lstatSync(file).isFile()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const value = JSON.parse(fs.readFileSync(fd, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function writeUpdateRecord(dataDir, name, value) {
  fs.mkdirSync(path.dirname(updatePath(dataDir, name)), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try { return atomicJson(updatePath(dataDir, name), value); }
    catch (error) {
      if (process.platform !== "win32" || attempt === 4 || !["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
      Atomics.wait(updateWriteWait, 0, 0, 10 * (2 ** attempt));
    }
  }
}

export function runtimeTreeHash(files) {
  const entries = Array.from(files, ([relative, hash]) => [relative.replaceAll("\\", "/"), hash]);
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return digest(JSON.stringify(entries));
}

function readRegularFile(file) {
  if (!fs.lstatSync(file).isFile()) throw integrity();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { return fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
}

function runtimeFiles(root, { allowEmpty = false } = {}) {
  const files = new Map();
  const directories = new Set();
  function visit(relative) {
    const file = child(root, relative);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      directories.add(relative);
      for (const name of fs.readdirSync(file)) visit(path.join(relative, name));
    } else if (allowEmpty && stat.isFile() && MIRROR_TEMP.test(path.basename(relative))) {
      fs.unlinkSync(file);
    } else if (stat.isFile() && !RUNTIME_JUNK.test(path.basename(relative))) {
      files.set(relative, digest(readRegularFile(file)));
    } else throw integrity();
  }
  if (allowEmpty && !fs.existsSync(root)) return { files, directories };
  for (const name of fs.readdirSync(root)) {
    if (!RUNTIME_WHITELIST.includes(name) && !(allowEmpty && MIRROR_TEMP.test(name))) throw integrity();
    visit(name);
  }
  if (!allowEmpty && RUNTIME_WHITELIST.some(name => !directories.has(name) && !files.has(name))) throw integrity();
  return { files, directories };
}

export function checkedRuntime(root, version, hash) {
  const { files, directories } = runtimeFiles(root);
  if (!SHA256.test(hash) || runtimeTreeHash(files) !== hash ||
      JSON.parse(readRegularFile(child(root, "plugin.json"))).version !== version) throw integrity();
  return { files, directories };
}

export function replaceRuntime(source, target, version, hash) {
  const { files, directories } = checkedRuntime(source, version, hash);
  const previous = runtimeFiles(target, { allowEmpty: true });
  for (const name of previous.files.keys()) {
    if (!files.has(name)) fs.unlinkSync(child(target, name));
  }
  for (const name of [...previous.directories].reverse()) {
    if (!directories.has(name)) fs.rmdirSync(child(target, name));
  }
  fs.mkdirSync(target, { recursive: true });
  for (const name of directories) fs.mkdirSync(child(target, name), { recursive: true });
  for (const [name, hash] of files) {
    if (previous.files.get(name) === hash) continue;
    const destination = child(target, name);
    // The temporary file lives on the destination volume, so the final rename remains atomic.
    const temporary = child(path.dirname(destination), `.agent-tower-update-${randomUUID()}.tmp`);
    try {
      fs.copyFileSync(child(source, name), temporary, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temporary, destination);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  checkedRuntime(target, version, hash);
}

export function validateUpdateTarget(dataDir, targetDir) {
  if (typeof targetDir !== "string" || !path.isAbsolute(targetDir)) throw integrity();
  const resolved = path.resolve(targetDir);
  const testRoot = process.env.AGENT_TOWER_TEST_ROOT;
  const mounted = path.join(homedir(), ".gemini", "config", "plugins", "agent-tower");
  if ((testRoot ? !inside(testRoot, resolved) || !inside(testRoot, dataDir) : path.relative(mounted, resolved) !== "") ||
      !inside(path.parse(resolved).root, resolved) || path.relative(path.resolve(dataDir), resolved) === "" ||
      inside(dataDir, resolved) || inside(resolved, dataDir)) throw integrity();
  return child(path.parse(resolved).root, resolved);
}

export function installedRuntime(dataDir, currentVersion, fallbackTarget = path.dirname(import.meta.dirname)) {
  const install = readUpdateRecord(dataDir, "install.json");
  if (!["zip", "git-clone"].includes(install?.origin)) {
    throw updateError("UPDATE_UNSUPPORTED_INSTALL", "This installation does not support online updates");
  }
  try {
    if (install.version !== currentVersion) throw integrity();
    const targetDir = validateUpdateTarget(dataDir, install.targetDir ?? fallbackTarget);
    checkedRuntime(targetDir, install.version, install.treeHash);
    return { ...install, targetDir };
  } catch {
    throw updateError("UPDATE_TARGET_MODIFIED", "Installed runtime differs from its recorded files");
  }
}

function releaseNotes(body) {
  const text = String(body ?? "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[^]*?-->|<[^>]*>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?)/gm, "")
    .replace(/`{1,3}|\*\*|__/g, "")
    .trim();
  return Array.from(text).slice(0, 2000).join("");
}

function assetDigest(asset) {
  return /^sha256:([\da-f]{64})$/i.exec(asset?.digest ?? "")?.[1].toLowerCase() ?? "";
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

function selectRelease(releases) {
  let latest;
  for (const release of releases) {
    if (release?.draft || release?.prerelease) continue;
    const tuple = parseUpdateVersion(release?.tag_name);
    if (tuple && (!latest || compareVersions(tuple, latest.tuple) > 0)) latest = { tuple, release };
  }
  if (!latest) return {};
  const { release } = latest;
  const latestVersion = release.tag_name.trim().replace(/^v/i, "").split("+")[0];
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const zip = assets.find(asset => asset?.name === `agent-tower-v${latestVersion}.zip`);
  const manifest = assets.find(asset => asset?.name === "release-manifest.json");
  return {
    latestVersion,
    releaseUrl: httpsUrl(release.html_url),
    releaseNotes: releaseNotes(release.body),
    assetSha256: assetDigest(zip),
    manifestSha256: assetDigest(manifest),
    assetUrl: typeof zip?.browser_download_url === "string" ? zip.browser_download_url : "",
    manifestUrl: typeof manifest?.browser_download_url === "string" ? manifest.browser_download_url : "",
  };
}

function downloadUrl(value, loopback) {
  try {
    const url = new URL(value);
    if (!url.username && !url.password &&
        ((url.protocol === "http:" && url.origin === loopback) || (url.protocol === "https:" && !url.port &&
          (url.hostname === "github.com" || url.hostname.endsWith(".githubusercontent.com"))))) return url;
  } catch {}
  throw updateError("UPDATE_NOT_AVAILABLE", "Release download source is unavailable");
}

async function download(request, value, loopback, signal, maxBytes, onChunk) {
  let url = downloadUrl(value, loopback);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await request(url.href, { redirect: "manual", signal, headers: { "User-Agent": "AgentTower-Updater" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const next = response.headers.get("location");
        if (!next) break;
        url = downloadUrl(new URL(next, url), loopback);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        break;
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        length += chunk.byteLength;
        if (length > maxBytes) throw checksum();
        chunks.push(Buffer.from(chunk));
        onChunk?.(length);
      }
      return Buffer.concat(chunks, length);
    }
  } catch (error) {
    if (signal.aborted || error.code?.startsWith("UPDATE_")) throw error;
  }
  throw updateError("UPDATE_NOT_AVAILABLE", "Release download failed");
}

function validateManifest(bytes, release, current) {
  if (release.manifestSha256 && digest(bytes) !== release.manifestSha256) throw checksum();
  let manifest;
  try { manifest = JSON.parse(bytes); } catch { throw integrity(); }
  const version = manifest?.version;
  const minimum = /^(?:>=)?(\d+\.\d+\.\d+)$/.exec(manifest?.minNode)?.[1];
  if (!RELEASE_VERSION.test(version) || version !== release.latestVersion ||
      compareVersions(parseUpdateVersion(version), current) <= 0 ||
      manifest.format !== "agent-tower-release-v1" || manifest.studioProtocolRevision !== 1 ||
      !minimum || !parseUpdateVersion(minimum) ||
      compareVersions(parseUpdateVersion(process.versions.node), parseUpdateVersion(minimum)) < 0 ||
      manifest.requiresHostReload === true || !SHA256.test(manifest.treeHash) ||
      manifest.asset?.name !== `agent-tower-v${version}.zip` || !SHA256.test(manifest.asset?.sha256) ||
      !Number.isSafeInteger(manifest.asset?.size) || manifest.asset.size < 22 || manifest.asset.size > MAX_ZIP_BYTES ||
      !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw integrity();
  if (release.assetSha256 && manifest.asset.sha256 !== release.assetSha256) throw checksum();
  return manifest;
}

function safeZipName(bytes) {
  if (bytes.length > 4096) throw integrity();
  const name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const parts = name.replace(/\/$/, "").split("/");
  if (parts.length > 32 || parts.some(part => !part || part.length > 255 || part === "." || part === ".." ||
      /[\x00-\x1f\x7f-\x9f<>:"\\|?*]|[ .]$/u.test(part) ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³]) *(?:\.|$)/iu.test(part))) throw integrity();
  return name;
}

function unpackRuntime(zip, manifest, runtime) {
  // The release writer produces a single-disk ZIP 2.0 archive with local sizes and no data descriptors.
  const end = zip.length - 22;
  if (zip.readUInt32LE(end) !== 0x06054b50 || zip.readUInt32LE(end + 4) !== 0 ||
      zip.readUInt16LE(end + 20) !== 0) throw integrity();
  const count = zip.readUInt16LE(end + 10);
  const central = zip.readUInt32LE(end + 16);
  if (count === 0 || count > MAX_FILES || count !== zip.readUInt16LE(end + 8) ||
      central + zip.readUInt32LE(end + 12) !== end) throw integrity();
  const paths = new Map();
  const ranges = [];
  const seenFiles = new Set();
  let expanded = 0;
  let cursor = central;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) throw integrity();
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressed = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const attributes = zip.readUInt32LE(cursor + 38);
    const type = attributes >>> 28;
    const local = zip.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
    if (next > end || local + 30 > central || zip.readUInt32LE(local) !== 0x04034b50 ||
        zip.readUInt16LE(cursor + 6) > 20 || zip.readUInt16LE(cursor + 34) !== 0 ||
        (flags & ~0x0800) || (method !== 0 && method !== 8) ||
        (type !== 0 && type !== 8 && type !== 4) || (attributes & 0x400) ||
        (expanded += size) > MAX_RUNTIME_BYTES) throw integrity();
    const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameLength);
    cursor = next;
    const name = safeZipName(nameBytes);
    const directory = name.endsWith("/");
    const start = local + 30 + nameLength + zip.readUInt16LE(local + 28);
    if ((directory ? (size !== 0 || type === 8) : type === 4 || (attributes & 0x10)) ||
        start + compressed > central || zip.readUInt16LE(local + 4) > 20 ||
        zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method ||
        zip.readUInt32LE(local + 14) !== crc || zip.readUInt32LE(local + 18) !== compressed ||
        zip.readUInt32LE(local + 22) !== size || zip.readUInt16LE(local + 26) !== nameLength ||
        !nameBytes.equals(zip.subarray(local + 30, local + 30 + nameLength))) throw integrity();
    ranges.push([local, start + compressed]);
    const parts = name.replace(/\/$/, "").split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join("/");
      const folded = prefix.normalize("NFC").toLowerCase();
      const leaf = depth === parts.length;
      const kind = !leaf || directory ? "directory" : "file";
      const previous = paths.get(folded);
      if (previous && (previous.prefix !== prefix || previous.kind !== kind || (leaf && previous.entry))) throw integrity();
      paths.set(folded, { prefix, kind, entry: leaf || previous?.entry });
    }
    const body = zip.subarray(start, start + compressed);
    const data = method === 0 ? body : inflateRawSync(body, { maxOutputLength: Math.max(1, size) });
    if (data.length !== size || crc32(data) !== crc) throw integrity();
    if (directory) continue;
    const listed = Object.hasOwn(manifest.files, name) && manifest.files[name];
    if (listed?.size !== size || digest(data) !== listed.sha256) throw integrity();
    seenFiles.add(name);
    if (!RUNTIME_WHITELIST.includes(parts[0])) continue;
    if (parts.some(part => RUNTIME_JUNK.test(part))) throw integrity();
    const file = child(runtime, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data, { flag: "wx" });
  }
  let expectedOffset = 0;
  for (const [start, end] of ranges.sort(([a], [b]) => a - b)) {
    if (start !== expectedOffset) throw integrity();
    expectedOffset = end;
  }
  if (expectedOffset !== central || cursor !== end ||
      Object.keys(manifest.files).some(name => !seenFiles.has(name))) throw integrity();
  return checkedRuntime(runtime, manifest.version, manifest.treeHash);
}

const SYNTAX_CHECK = `
  import fs from "node:fs";
  import vm from "node:vm";
  for (const file of JSON.parse(fs.readFileSync("syntax-files.json", "utf8"))) {
    const code = fs.readFileSync(file, "utf8");
    if (file.endsWith(".mjs")) new vm.SourceTextModule(code, { identifier: file });
    else {
      try { new vm.Script(code, { filename: file }); }
      catch { new vm.SourceTextModule(code, { identifier: file }); }
    }
  }
`;

async function preflight(stage, runtime, files, signal) {
  const sandbox = child(stage, "self-test");
  fs.mkdirSync(sandbox);
  const env = { ...process.env, HOME: sandbox, USERPROFILE: sandbox, APPDATA: sandbox,
    LOCALAPPDATA: sandbox, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox,
    AGENT_TOWER_DATA_DIR: child(sandbox, "control"), AGENT_TOWER_DEFAULT_ROOT: sandbox,
    ANTIGRAVITY_APP_DATA_DIR: sandbox, AGENT_TOWER_DISABLE_UPDATE_CHECK: "1" };
  delete env.NODE_OPTIONS;
  const opts = { cwd: sandbox, env, timeout: 15_000, signal, windowsHide: true };
  const permissions = ["--permission", `--allow-fs-read=${runtime}`, `--allow-fs-read=${sandbox}`, `--allow-fs-write=${sandbox}`];
  try {
    const scripts = [...files.keys()].filter(name => /\.m?js$/.test(name)).map(name => child(runtime, name));
    fs.writeFileSync(child(sandbox, "syntax-files.json"), JSON.stringify(scripts));
    await runNode(process.execPath, [...permissions, "--experimental-vm-modules", "--no-warnings", "--input-type=module", "-e", SYNTAX_CHECK], opts);
    await runNode(process.execPath, [...permissions, child(runtime, "core", "daemon.mjs"), "--self-test"], opts);
  } catch {
    signal.throwIfAborted();
    throw updateError("UPDATE_PREFLIGHT_FAILED", "Release failed the isolated daemon self-test");
  } finally { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
}

export function createUpdater({
  dataDir, currentVersion, feedUrl, fetchImpl, autoCheck = () => true,
  isUpdating = () => false, onChange = () => {}, log = () => {}, existingDaemon,
}) {
  const target = feedUrl || OFFICIAL_FEED;
  let loopback;
  if (typeof feedUrl === "string" && /^http:\/\/127\.0\.0\.1:\d+(?:[/?#]|$)/.test(feedUrl)) {
    try { loopback = new URL(feedUrl).origin; } catch {}
  }
  if (target !== OFFICIAL_FEED && !loopback) throw updateError("UPDATE_NOT_AVAILABLE", "Release feed source is unavailable");
  const disabled = (process.env.NODE_TEST_CONTEXT !== undefined || process.env.AGENT_TOWER_DISABLE_UPDATE_CHECK === "1") &&
    !fetchImpl && !feedUrl;
  const request = fetchImpl || globalThis.fetch;
  const current = parseUpdateVersion(currentVersion);
  let cache = readUpdateRecord(dataDir, "state.json") || {};
  let pending;
  let abort;
  let timer;
  let closed = false;
  let operation;

  function refresh() {
    cache = readUpdateRecord(dataDir, "state.json") || {};
    onChange(status());
    schedule();
  }

  function status() {
    const install = readUpdateRecord(dataDir, "install.json");
    const lock = readUpdateRecord(dataDir, "apply.lock");
    const backup = readUpdateRecord(dataDir, "rollback", "backup-meta.json");
    const lastResult = readUpdateRecord(dataDir, "state.json")?.lastResult || cache.lastResult || {};
    const installOrigin = INSTALL_ORIGINS.has(install?.origin) ? install.origin : "unknown";
    const latest = parseUpdateVersion(cache.latestVersion);
    const previous = parseUpdateVersion(backup?.version);
    const hasUpdate = Boolean(current && latest && compareVersions(latest, current) > 0);
    const phase = operation?.progress.phase || lock?.phase || "";
    const transitioning = ["downloading", "verifying", "quiescing", "applying", "rolling_back"].includes(phase);
    const state = transitioning ? phase : isUpdating() ? "quiescing" : pending ? "checking" : cache.unavailable ? "unavailable"
      : hasUpdate ? "available" : latest ? "up_to_date" : "idle";
    return {
      state, currentVersion, latestVersion: latest ? cache.latestVersion : "", hasUpdate,
      dismissedVersion: cache.dismissedVersion || "", releaseUrl: httpsUrl(cache.releaseUrl),
      releaseNotes: cache.releaseNotes || "", assetSha256: cache.assetSha256 || "",
      installOrigin, autoUpdateSupported: installOrigin === "git-clone" || installOrigin === "zip",
      lastCheckedAt: cache.lastCheckedAt || 0, error: cache.error || "",
      cancellable: !operation?.controller.signal.aborted && (state === "downloading" ||
        (lock?.phase === "quiescing" && !fs.existsSync(updatePath(dataDir, "cancel.json")))),
      progress: { phase: transitioning ? phase : "", percent: null, downloadedBytes: 0, totalBytes: 0,
        message: "", ...(operation?.progress || {}) },
      rollback: { available: Boolean(current && previous && RELEASE_VERSION.test(backup.version) && compareVersions(previous, current) < 0), version: backup?.version || "",
        backedUpAt: backup?.backedUpAt || "", rollbackSafe: backup?.rollbackSafe !== false },
      lastResult: { status: lastResult.status || "", fromVersion: lastResult.fromVersion || "",
        toVersion: lastResult.toVersion || "", at: lastResult.at || 0, message: lastResult.message || "" },
    };
  }

  function persist(patch) {
    cache = { ...cache, ...readUpdateRecord(dataDir, "state.json"), ...patch };
    try { writeUpdateRecord(dataDir, "state.json", cache); }
    catch { log("Unable to save update state"); }
  }

  function schedule() {
    clearTimeout(timer);
    if (closed || disabled || !autoCheck() || pending || isUpdating() || fs.existsSync(updatePath(dataDir, "apply.lock"))) return;
    const delay = Math.max(0, Number(cache.nextCheckAt || 0) - Date.now());
    timer = setTimeout(() => { if (autoCheck() && !isUpdating()) void check(); }, Math.min(delay, CHECK_INTERVAL + CHECK_JITTER));
    timer.unref?.();
  }

  function check() {
    if (closed || disabled || isUpdating() || fs.existsSync(updatePath(dataDir, "apply.lock"))) return Promise.resolve(status());
    if (pending) return pending;
    clearTimeout(timer);
    abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]);
    pending = Promise.resolve().then(async () => {
      const lastCheckedAt = Date.now();
      const timing = { lastCheckedAt, nextCheckAt: lastCheckedAt + CHECK_INTERVAL + Math.floor(Math.random() * CHECK_JITTER) };
      let result;
      try {
        const headers = { "User-Agent": "AgentTower-Updater", Accept: "application/vnd.github+json" };
        if (cache.etag && Object.hasOwn(cache, "assetUrl") && Object.hasOwn(cache, "manifestUrl")) headers["If-None-Match"] = cache.etag;
        const response = await request(target, { headers, signal, redirect: "error" });
        if (response.status === 304) {
          result = { unavailable: !cache.latestVersion, error: "" };
        } else if (response.status === 404 || response.status === 403 || response.status === 429) {
          result = { latestVersion: "", releaseUrl: "", releaseNotes: "", assetSha256: "", manifestSha256: "",
            assetUrl: "", manifestUrl: "", etag: "", unavailable: true, error: "" };
        } else {
          if (!response.ok) throw new Error("Update feed request failed");
          const releases = await response.json();
          if (!Array.isArray(releases)) throw new Error("Invalid update feed");
          const release = selectRelease(releases);
          result = {
            latestVersion: "", releaseUrl: "", releaseNotes: "", assetSha256: "", manifestSha256: "", assetUrl: "", manifestUrl: "",
            ...release, etag: response.headers.get("etag") || "", unavailable: !release.latestVersion, error: "",
          };
        }
      } catch {
        result = { unavailable: true, error: "Unable to check for updates" };
      }
      if (!closed && !isUpdating()) persist({ ...result, ...timing });
      pending = undefined;
      abort = undefined;
      if (!closed) onChange(status());
      schedule();
      return status();
    });
    onChange(status());
    return pending;
  }

  function dismiss(version = cache.latestVersion) {
    if (parseUpdateVersion(version)) {
      persist({ dismissedVersion: version.trim().replace(/^v/i, "").split("+")[0] });
      onChange(status());
    }
    return status();
  }

  function setProgress(phase, progress = {}) {
    operation.progress = { ...operation.progress, ...progress, phase };
    onChange(status());
  }

  async function startOperation(mode, requestedVersion) {
    const lockPath = updatePath(dataDir, "apply.lock");
    if (operation || pending || isUpdating() || fs.existsSync(lockPath)) throw busy();
    const install = installedRuntime(dataDir, currentVersion, existingDaemon?.targetDir);
    const release = { ...cache };
    const backup = mode === "rollback" ? readUpdateRecord(dataDir, "rollback", "backup-meta.json") : null;
    const targetVersion = mode === "apply" ? release.latestVersion : backup?.version;
    if (mode === "apply") {
      if (release.unavailable || !current || !RELEASE_VERSION.test(targetVersion) ||
          compareVersions(parseUpdateVersion(targetVersion), current) <= 0 ||
          (requestedVersion !== undefined && requestedVersion !== targetVersion && requestedVersion !== `v${targetVersion}`)) {
        throw updateError("UPDATE_NOT_AVAILABLE", "No matching release is available");
      }
      downloadUrl(release.assetUrl, loopback);
      downloadUrl(release.manifestUrl, loopback);
    } else {
      try {
        if (!current || !RELEASE_VERSION.test(targetVersion) || compareVersions(parseUpdateVersion(targetVersion), current) >= 0 || backup.rollbackSafe === false ||
            (requestedVersion !== undefined && requestedVersion !== targetVersion && requestedVersion !== `v${targetVersion}`) ||
            !["zip", "git-clone"].includes(backup.install?.origin) || backup.install.version !== targetVersion ||
            backup.install.treeHash !== backup.treeHash) throw integrity();
        checkedRuntime(updatePath(dataDir, "rollback", "runtime"), targetVersion, backup.treeHash);
      } catch {
        throw updateError("UPDATE_ROLLBACK_UNAVAILABLE", "No verified rollback version is available");
      }
    }
    const lock = { id: randomUUID(), pid: process.pid, daemonPid: existingDaemon?.pid ?? process.pid, mode, fromVersion: currentVersion,
      toVersion: targetVersion, targetDir: install.targetDir, phase: mode === "apply" ? "downloading" : "quiescing",
      startedAt: Date.now() };
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    try { fs.writeFileSync(lockPath, JSON.stringify(lock), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code === "EEXIST") throw busy(); throw error; }

    const controller = new AbortController();
    operation = { controller, progress: { phase: lock.phase } };
    const staging = updatePath(dataDir, "staging");
    let worker;
    let handedOff = false;
    try {
      fs.rmSync(updatePath(dataDir, "cancel.json"), { force: true });
      onChange(status());
      if (mode === "apply") {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
        const stage = updatePath(dataDir, "staging", targetVersion);
        const runtime = child(stage, "runtime");
        fs.mkdirSync(runtime, { recursive: true });
        const bytes = await download(request, release.manifestUrl, loopback, signal, 1024 * 1024);
        const manifest = validateManifest(bytes, release, current);
        let lastPercent = -1;
        const zip = await download(request, release.assetUrl, loopback, signal, manifest.asset.size, downloadedBytes => {
          const percent = Math.floor(downloadedBytes * 100 / manifest.asset.size);
          const progress = { percent, downloadedBytes, totalBytes: manifest.asset.size };
          if (percent !== lastPercent) {
            lastPercent = percent;
            setProgress("downloading", progress);
          } else Object.assign(operation.progress, progress);
        });
        writeUpdateRecord(dataDir, "apply.lock", { ...lock, phase: "verifying" });
        setProgress("verifying", { percent: null, message: "Verifying release files" });
        if (zip.length !== manifest.asset.size || digest(zip) !== manifest.asset.sha256) throw checksum();
        let inventory;
        try { inventory = unpackRuntime(zip, manifest, runtime); }
        catch { throw integrity(); }
        await preflight(stage, runtime, inventory.files, signal);
        checkedRuntime(runtime, manifest.version, manifest.treeHash);
        atomicJson(child(stage, "release.json"), { version: manifest.version, commit: manifest.commit,
          treeHash: manifest.treeHash, rollbackSafe: manifest.rollbackSafe !== false });
      }
      controller.signal.throwIfAborted();
      worker = spawn(process.execPath, [path.join(import.meta.dirname, "update-worker.mjs"), dataDir, lock.id],
        { cwd: dataDir, detached: true, windowsHide: true, stdio: "ignore" });
      await new Promise((resolve, reject) => { worker.once("spawn", resolve); worker.once("error", reject); });
      writeUpdateRecord(dataDir, "apply.lock", { ...lock, pid: worker.pid, phase: "quiescing" });
      handedOff = true;
      worker.unref();
      operation = undefined;
      onChange(status());
      return status();
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (!handedOff) {
        worker?.kill();
        fs.rmSync(staging, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
        fs.rmSync(lockPath, { force: true });
        operation = undefined;
        refresh();
      }
    }
    return status();
  }

  function cancel() {
    const lock = readUpdateRecord(dataDir, "apply.lock");
    if (operation && operation.progress.phase === "downloading") {
      operation.controller.abort();
    } else if (lock?.phase === "quiescing") {
      writeUpdateRecord(dataDir, "cancel.json", { id: lock.id, at: Date.now() });
    } else if (lock?.phase === "applying" || lock?.phase === "rolling_back") {
      throw updateError("UPDATE_ALREADY_COMMITTING", "The daemon switch is already committing");
    } else return false;
    onChange(status());
    return true;
  }

  return {
    status, check, dismiss, schedule, refresh, cancel,
    apply: version => startOperation("apply", version),
    rollback: version => startOperation("rollback", version),
    close() {
      closed = true;
      clearTimeout(timer);
      abort?.abort();
      operation?.controller.abort();
    },
  };
}
