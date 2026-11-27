import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

/**
 * Studio 前端静态资源唯一白名单解析器（daemon / sidecar main / standalone / 集成测试四套静态服务共用）。
 *
 * 白名单：根目录 `index.html`、`styles.css`、`app.js`（路由 `/`、`/index.html`、`/styles.css`、`/app.js`），
 * 以及 `sidecars/studio/ui/` 下文件名匹配 `^[a-z0-9-]+\.js$` 的普通文件（路由 `/ui/<name>.js`）。
 * `ui/` 目录或其中条目为符号链接 / 目录联接、越出 Studio 目录、含 `..` / 反斜杠 / 百分号转义的路径一律拒绝。
 *
 * 总资产哈希按确定性字典序把全部白名单文件的「相对路径名 + 字节长度 + 内容字节」写入 SHA-256；
 * 缓存指纹包含文件清单与每个文件的 ino / size / mtime / ctime，增删改任一 `ui/*.js` 都会立即改变哈希触发热刷新。
 */

const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
const STUDIO_DIR = path.join(PACKAGE_DIR, 'sidecars', 'studio');
const UI_DIR = path.join(STUDIO_DIR, 'ui');
const ROOT_FILES = ['index.html', 'styles.css', 'app.js'];
const UI_MODULE_RE = /^[a-z0-9-]+\.js$/;
const HASH_PLACEHOLDER = '__AGENT_TOWER_ASSET_HASH__';
const VERSION_PLACEHOLDER = '__STUDIO_VERSION__';
const PLUGIN_MANIFEST = path.join(PACKAGE_DIR, 'plugin.json');
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
});

let cached;

function trustedDirectory(dir, expected) {
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && path.relative(expected, realpathSync(dir)) === '';
  } catch { return false; }
}

function studioRoot() {
  try {
    const expected = path.join(realpathSync(PACKAGE_DIR), 'sidecars', 'studio');
    return trustedDirectory(STUDIO_DIR, expected) ? expected : null;
  } catch { return null; }
}

function scanUiModules(root) {
  if (!trustedDirectory(UI_DIR, path.join(root, 'ui'))) return [];
  try {
    return readdirSync(UI_DIR, { withFileTypes: true })
      .filter(entry => entry.isFile() && UI_MODULE_RE.test(entry.name))
      .map(entry => `ui/${entry.name}`);
  } catch { return []; }
}

function fingerprint(st) {
  if (!st.isFile() || st.isSymbolicLink()) return null;
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

function readVerifiedAsset(root, name, stamp) {
  const file = path.join(STUDIO_DIR, name);
  let fd;
  try {
    const matchesPath = () => {
      const stat = lstatSync(file, { bigint: true });
      return fingerprint(stat) === stamp && path.relative(path.join(root, name), realpathSync(file)) === '';
    };
    if (!matchesPath()) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (fingerprint(fstatSync(fd, { bigint: true })) !== stamp || !matchesPath()) return null;
    const bytes = readFileSync(fd);
    return fingerprint(fstatSync(fd, { bigint: true })) === stamp && matchesPath() ? bytes : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

// This source tree uses only unaliased named imports and declaration exports.
// Keep the transform narrow; vm.Script rejects unsupported syntax and name clashes.
function bundleStudioApp(files, digest, version) {
  const seen = new Set();
  const visiting = new Set();
  const ordered = [];
  function visit(name) {
    if (seen.has(name)) return;
    if (visiting.has(name)) throw new Error(`Circular Studio import: ${name}`);
    const bytes = files.get(name);
    if (!bytes) throw new Error(`Missing Studio module: ${name}`);
    visiting.add(name);
    const source = bytes.toString('utf8').replace(
      /^import[\t ]+\{([\w$\s,]+)\}[\t \r\n]+from[\t ]+(['"])(\.[^'"\r\n]+)\2;[\t ]*\r?$/gm,
      (_line, bindings, _quote, specifier) => {
        const dependency = path.posix.join(path.posix.dirname(name), specifier);
        if (!/^\.\/(?:ui\/)?[a-z0-9-]+\.js$/.test(specifier) ||
            !dependency.startsWith('ui/') || !UI_MODULE_RE.test(dependency.slice(3)) ||
            !bindings.split(',').filter(binding => binding.trim()).every(binding => /^[\w$]+$/.test(binding.trim()))) {
          throw new Error(`Unsupported Studio import in ${name}: ${specifier}`);
        }
        visit(dependency);
        return '';
      }
    ).replace(/^export[\t ]+(?=(?:async[\t ]+)?function\b|const\b)/gm, '');
    visiting.delete(name);
    seen.add(name);
    ordered.push(`// ${name}\n${source}`);
  }
  visit('app.js');
  const bundled = `(function () {\n'use strict';\n// Studio assets: ${digest}\n${ordered.join('\n\n').replaceAll(VERSION_PLACEHOLDER, version)}\n})();\n`;
  new Script(bundled, { filename: 'studio/app.js' });
  return Buffer.from(bundled);
}

// plugin.json 是版本号唯一事实源；缺失、符号链接或损坏时回退空串（不阻断静态服务）。
function manifestStamp() {
  try { return fingerprint(lstatSync(PLUGIN_MANIFEST, { bigint: true })); } catch { return null; }
}

function readPluginVersion() {
  let fd;
  try {
    fd = openSync(PLUGIN_MANIFEST, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const { version } = JSON.parse(readFileSync(fd, 'utf8'));
    // Optional 4th hotfix segment (e.g. 0.2.7.1), matching the daemon handshake.
    return typeof version === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?$/.test(version) ? version : '';
  } catch { return ''; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function assets() {
  const root = studioRoot();
  const entries = new Map();
  if (root) {
    for (const name of [...ROOT_FILES, ...scanUiModules(root)].sort()) {
      try {
        const stamp = fingerprint(lstatSync(path.join(STUDIO_DIR, name), { bigint: true }));
        if (stamp) entries.set(name, stamp);
      } catch { /* The file may have disappeared since the scan. */ }
    }
  }
  const stamp = JSON.stringify([root, manifestStamp(), [...entries]]);
  if (stamp === cached?.stamp) return cached;

  const version = readPluginVersion();
  // 版本号纳入摘要：仅升版 plugin.json 也会改变资产哈希并触发前端热刷新。
  const hash = createHash('sha256').update(`plugin.json#version:${version}\n`);
  const files = new Map();
  for (const [name, fileStamp] of entries) {
    const bytes = readVerifiedAsset(root, name, fileStamp);
    if (!bytes) continue;
    hash.update(`${name}:${bytes.length}:`).update(bytes);
    files.set(name, bytes);
  }
  // v0.2.6 C09①：白名单条目正被覆写（读到残缺文件集）时回退上一份完整内存快照，
  // 绝不把残缺集合交给 bundleStudioApp 抛 `Missing Studio module` 导致 500。
  if (files.size < entries.size && cached) return cached;
  const digest = hash.digest('hex');
  if (files.has('app.js')) files.set('app.js', bundleStudioApp(files, digest, version));
  if (files.has('index.html')) {
    files.set('index.html', Buffer.from(files.get('index.html').toString('utf8').replace(HASH_PLACEHOLDER, digest).replaceAll(VERSION_PLACEHOLDER, version)));
  }
  const snapshot = { stamp, digest, files };
  if (files.size === entries.size) cached = snapshot;
  return snapshot;
}

/** 当前全部前端白名单资产 + plugin.json 版本号的 SHA-256（index.html 内的占位符替换前计算，升版即变）。 */
export function frontendAssetHash() { return assets().digest; }

/** 按白名单相对名读取资产字节：`index.html` | `styles.css` | `app.js` | `ui/<name>.js`。 */
export function readStudioAsset(name) {
  const asset = typeof name === 'string' && resolveStudioAsset(`/${name}`);
  if (!asset || asset.name !== name) throw new Error('Unknown Studio asset');
  return asset.content;
}

/** 全部可服务的 URL 路径：`/`、`/index.html`、`/styles.css`、`/app.js` 与每个 `/ui/<name>.js`。 */
export function listStudioAssetPaths() {
  const { files } = assets();
  return [...(files.has('index.html') ? ['/'] : []), ...ROOT_FILES.filter(name => files.has(name)).map(name => `/${name}`),
    ...[...files.keys()].filter(name => name.startsWith('ui/')).map(name => `/${name}`)];
}

/** Use the original request target; URL.pathname normalizes dot segments and backslashes. */
export function studioRequestPath(target) {
  if (typeof target !== 'string') return null;
  const pathname = target.split('?', 1)[0];
  if (!pathname.startsWith('/') || pathname.startsWith('//') || /\.\.|[\\%#\x00-\x20\x7f]/.test(pathname) || pathname.split('/').includes('.')) return null;
  return pathname;
}

/**
 * 把请求 pathname 解析为白名单资产；未知、越界或可疑路径返回 `null`（调用方继续走其它路由，不误吞 `/api/*`）。
 * @returns {{ name: string, contentType: string, content: Buffer } | null}
 */
export function resolveStudioAsset(pathname) {
  if (!pathname || studioRequestPath(pathname) !== pathname) return null;
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!ROOT_FILES.includes(name) && !(name.startsWith('ui/') && UI_MODULE_RE.test(name.slice(3)))) return null;
  const content = assets().files.get(name);
  if (!content) return null;
  return { name, contentType: CONTENT_TYPES[path.extname(name)], content: Buffer.from(content) };
}
