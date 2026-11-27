import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repo } from "./check.mjs";
import { child as inside } from "../core/storage-paths.mjs";
import { RUNTIME_WHITELIST, RUNTIME_JUNK, runtimeTreeHash } from "./publish-plugin.mjs";

const RELEASE_EXTRA_ENTRIES = [
  "package.json",
  "SECURITY.md",
  ".gitattributes",
  "scripts/check.mjs",
  "scripts/publish-plugin.mjs",
  "scripts/stage-files.ps1",
];

const PUBLIC_RELEASE_SCRIPTS = new Set([
  "check",
  "setup",
  "publish:plugin",
  "status:plugin",
]);

const BINARY_EXT = /\.(?:png|ico|zip|jpg|jpeg|gif|webp|woff2?|pdf|exe|dll|node)$/i;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function normalizeFileBuffer(posixRel, raw) {
  if (posixRel === "package.json") {
    const pkg = JSON.parse(raw.toString("utf8"));
    if (pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object") {
      pkg.scripts = Object.fromEntries(
        Object.entries(pkg.scripts).filter(([name]) => PUBLIC_RELEASE_SCRIPTS.has(name)),
      );
    }
    return Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  }
  if (BINARY_EXT.test(posixRel) || raw.includes(0)) return raw;
  const lf = raw.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/\.ps1$/i.test(posixRel)) return Buffer.from(lf.replace(/\n/g, "\r\n"), "utf8");
  return Buffer.from(lf, "utf8");
}

function collectReleaseFiles(sourceDir) {
  const entries = new Map();
  function visit(rel) {
    const full = inside(sourceDir, rel);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported in release: ${rel}`);
    if (stat.isFile()) {
      const posixRel = rel.split(path.sep).join("/");
      entries.set(posixRel, normalizeFileBuffer(posixRel, fs.readFileSync(full)));
      return;
    }
    if (!stat.isDirectory()) throw new Error(`Unsupported release entry: ${rel}`);
    for (const leaf of fs.readdirSync(full).sort()) {
      if (leaf === ".git" || RUNTIME_JUNK.test(leaf)) continue;
      visit(path.join(rel, leaf));
    }
  }
  for (const rel of RUNTIME_WHITELIST) {
    if (!fs.existsSync(inside(sourceDir, rel))) {
      throw new Error(`Missing required runtime entry: ${rel}`);
    }
    visit(rel);
  }
  for (const rel of RELEASE_EXTRA_ENTRIES) {
    if (fs.existsSync(inside(sourceDir, rel))) visit(rel);
  }
  return new Map([...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Deterministic PKZIP 2.0 writer (fixed DOS timestamp 1980-01-01 00:00:00, UTF-8 names, DEFLATE/STORE).
 * Compatible with Windows tar.exe -xf, PowerShell Expand-Archive, unzip, and 7-Zip.
 */
function buildDeterministicZip(fileMap) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const dosTime = 0x0000;
  const dosDate = 0x0021; // 1980-01-01
  const utf8Flag = 0x0800;

  for (const [name, data] of fileMap) {
    const nameBuf = Buffer.from(name, "utf8");
    const checksum = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(utf8Flag, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // Unix creator, version 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(utf8Flag, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuf, body);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(fileMap.size, 8);
  eocd.writeUInt16LE(fileMap.size, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

function resolveCommit(sourceDir, version) {
  if (!fs.existsSync(inside(sourceDir, ".git"))) return `nogit-${version}`;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceDir,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }).trim();
  } catch {
    return `nogit-${version}`;
  }
}

export function buildReleaseBundle({
  sourceDir = repo,
  outDir = path.join(repo, ".agent-tower", "tmp", "release"),
  tag = "",
} = {}) {
  const source = path.resolve(sourceDir);
  const output = path.resolve(outDir);
  const pluginJson = JSON.parse(fs.readFileSync(inside(source, "plugin.json"), "utf8"));
  const version = String(pluginJson.version || "").trim();
  if (!/^\d+(?:\.\d+){2,3}$/.test(version)) {
    throw new Error(`Invalid plugin.json version: ${version}`);
  }
  const releaseTag = String(tag || "").trim() || `v${version}`;
  const commit = resolveCommit(source, version);
  const fileMap = collectReleaseFiles(source);

  const files = {};
  const treePairs = [];
  for (const [posixRel, buf] of fileMap) {
    const hash = sha256(buf);
    files[posixRel] = { sha256: hash, size: buf.length };
    if (RUNTIME_WHITELIST.includes(posixRel.split("/")[0])) treePairs.push([posixRel, hash]);
  }
  const treeHash = runtimeTreeHash(treePairs);

  const zipName = `agent-tower-v${version}.zip`;
  const zipBytes = buildDeterministicZip(fileMap);
  const zipSha256 = sha256(zipBytes);

  const manifest = {
    format: "agent-tower-release-v1",
    version,
    tag: releaseTag,
    commit,
    studioProtocolRevision: 1,
    minNode: ">=24.0.0",
    requiresHostReload: false,
    rollbackSafe: true,
    treeHash,
    asset: {
      name: zipName,
      size: zipBytes.length,
      sha256: zipSha256,
    },
    files,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha256 = sha256(Buffer.from(manifestText, "utf8"));
  const checksumsText = `${zipSha256}  ${zipName}\n${manifestSha256}  release-manifest.json\n`;

  fs.mkdirSync(output, { recursive: true });
  const zipPath = path.join(output, zipName);
  const manifestPath = path.join(output, "release-manifest.json");
  const checksumsPath = path.join(output, "SHA256SUMS");
  fs.writeFileSync(zipPath, zipBytes);
  fs.writeFileSync(manifestPath, manifestText, "utf8");
  fs.writeFileSync(checksumsPath, checksumsText, "utf8");

  return {
    version,
    tag: releaseTag,
    commit,
    outDir: output,
    zipPath,
    manifestPath,
    checksumsPath,
    fileCount: fileMap.size,
    manifest,
  };
}

function parseArgs(argv) {
  const opts = {
    sourceDir: repo,
    outDir: path.join(repo, ".agent-tower", "tmp", "release"),
    tag: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out-dir") {
      if (!argv[i + 1]) throw new Error("--out-dir requires a directory");
      opts.outDir = path.resolve(argv[++i]);
    } else if (arg.startsWith("--out-dir=")) {
      const val = arg.slice("--out-dir=".length);
      if (!val) throw new Error("--out-dir requires a directory");
      opts.outDir = path.resolve(val);
    } else if (arg === "--source") {
      if (!argv[i + 1]) throw new Error("--source requires a directory");
      opts.sourceDir = path.resolve(argv[++i]);
    } else if (arg.startsWith("--source=")) {
      const val = arg.slice("--source=".length);
      if (!val) throw new Error("--source requires a directory");
      opts.sourceDir = path.resolve(val);
    } else if (arg === "--tag") {
      if (!argv[i + 1]) throw new Error("--tag requires a value");
      opts.tag = argv[++i];
    } else if (arg.startsWith("--tag=")) {
      opts.tag = arg.slice("--tag=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = buildReleaseBundle(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({
      version: result.version,
      tag: result.tag,
      commit: result.commit,
      outDir: result.outDir,
      zipPath: result.zipPath,
      manifestPath: result.manifestPath,
      checksumsPath: result.checksumsPath,
      fileCount: result.fileCount,
      treeHash: result.manifest.treeHash,
      asset: result.manifest.asset,
    }));
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
