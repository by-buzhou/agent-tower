/**
 * AgentTower Studio — 格式化与安全渲染纯函数 (`ui/format.js`)
 * 叶子纯模块：路径 / file:// URI 互转、HTML 转义、轻量 Markdown、Unified Diff 着色、数字与时长格式化。
 */
export function fileUriToPath(uri) {
  if (!uri || typeof uri !== 'string') return '';
  if (!uri.startsWith('file://')) return uri;
  try {
    const u = new URL(uri);
    let p = decodeURIComponent(u.pathname || '');
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    return p.replace(/\//g, '\\');
  } catch {
    return uri.replace(/^file:\/\/\/?/, '');
  }
}

export function pathToFileUri(rawPath, baseDir = '') {
  if (!rawPath) return '';
  if (rawPath.startsWith('file://')) return rawPath;
  let full = rawPath;
  const isAbsWin = /^[a-zA-Z]:[\\/]/.test(rawPath);
  const isAbsPosix = rawPath.startsWith('/');
  if (!isAbsWin && !isAbsPosix && baseDir) {
    const cleanBase = baseDir.replace(/[\\/]+$/, '');
    const cleanRel = rawPath.replace(/^[.\\/]+/, '');
    full = `${cleanBase}/${cleanRel}`;
  }
  const normalized = full.replace(/\\/g, '/');
  const encoded = normalized
    .split('/')
    .map((seg, idx) => (idx === 0 && /^[a-zA-Z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
  return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

export function normalizeProjectPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  let s = fileUriToPath(rawPath).trim().replace(/\\/g, '/');
  s = s.replace(/\/+$/, '');
  if (/^[a-z]:($|\/)/.test(s)) {
    s = s[0].toUpperCase() + s.slice(1);
  }
  return s;
}

export function projectPathKey(rawPath) {
  const norm = normalizeProjectPath(rawPath);
  if (!norm) return '';
  if (/^[A-Za-z]:/.test(norm)) return norm.toLowerCase();
  return norm;
}

export function basenameOfPath(p) {
  const norm = normalizeProjectPath(p);
  if (!norm) return '';
  const parts = norm.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : norm;
}

export function isWorktreeOrTempPath(p) {
  const low = String(p || '').replace(/\\/g, '/').toLowerCase();
  if (!low) return false;
  return (
    low.includes('/plugin_data/agent-tower/worktrees/') ||
    low.includes('/.agent-tower/worktrees/') ||
    low.includes('/appdata/local/temp/') ||
    low.startsWith('/tmp/') ||
    low.includes('/tmp/at-')
  );
}

/* ========================================================================
 * 13. 格式化、Markdown 轻量安全渲染、Unified Diff 语法着色工具
 * ======================================================================== */
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stripAnsi(str) {
  return String(str || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function formatPrettyFileLink(rawLabel, rawUrl) {
  const cleanUrl = String(rawUrl || '').trim();
  const hashIdx = cleanUrl.indexOf('#');
  const urlPathPart = hashIdx >= 0 ? cleanUrl.slice(0, hashIdx) : cleanUrl;
  const hashPart = hashIdx >= 0 ? cleanUrl.slice(hashIdx + 1) : '';
  const fsPath = fileUriToPath(urlPathPart) || urlPathPart;
  const base = basenameOfPath(fsPath) || fsPath;

  let display = String(rawLabel || '').trim();
  if (!display || display.startsWith('file://') || (/[\\/]/.test(display) && display.length > 26)) {
    display = base;
  }
  if (hashPart && /^L\d+/i.test(hashPart) && !display.includes(hashPart)) {
    display = `${display}:${hashPart}`;
  }
  return `<button type="button" class="md-file-link" data-open-file="${escapeHtml(fsPath)}" title="${escapeHtml(fsPath)}">📄 ${escapeHtml(display)}</button>`;
}

export function renderMarkdownSafe(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return '';

  const blocks = [];
  let staged = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = blocks.length;
    blocks.push(`<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`);
    return `\u0000CODE_${idx}\u0000`;
  });

  // 1. 提取 Markdown 链接 [label](file://... | https://...)，彻底消除百字裸露 file:/// URL
  const links = [];
  staged = staged.replace(/\[([^\]]+)\]\(((?:file:\/\/|https?:\/\/)[^)\s]+)\)/gi, (_m, label, url) => {
    const idx = links.length;
    if (/^file:\/\//i.test(url)) {
      links.push(formatPrettyFileLink(label, url));
    } else {
      links.push(`<a class="md-ext-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
    }
    return `\u0000LINK_${idx}\u0000`;
  });

  // 2. 提取裸露的 file:///... 路径并美化为可点击文件胶囊
  staged = staged.replace(/\b(file:\/\/[^\s<>"'`)\]]+)/gi, (_m, url) => {
    const idx = links.length;
    links.push(formatPrettyFileLink('', url));
    return `\u0000LINK_${idx}\u0000`;
  });

  const formatInline = (escapedLine) => {
    let s = escapedLine
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1<em>$2</em>');

    s = s.replace(/(^|[^\p{L}\p{N}_-])@([\p{L}\p{N}_-]+)/gu, (_m, pre, name) => {
      const cls = name.toLowerCase() === 'all' ? 'mention all' : 'mention';
      return `${pre}<span class="${cls}">@${name}</span>`;
    });

    s = s
      .replace(/(^|[^\p{L}\p{N}_&#/;-])#([1-9]\d{0,6})(?![\p{L}\p{N}_-])/gu, (_m, pre, digits) => {
        return `${pre}<button type="button" class="ref seq-ref" data-seq-ref="${digits}" title="跳转到 #${digits}">#${digits}</button>`;
      })
      .replace(/<code>(<button\b[^>]*\bseq-ref\b[^>]*>#[0-9]+<\/button>)<\/code>/g, '$1');

    return s;
  };

  const rawLines = staged.split('\n');
  const out = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (/^\u0000CODE_\d+\u0000$/.test(trimmed)) {
      closeList();
      out.push(trimmed);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      closeList();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${formatInline(escapeHtml(h[2]))}</h${lvl}>`);
      continue;
    }
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (li) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${formatInline(escapeHtml(li[1]))}</li>`);
      continue;
    }
    closeList();
    if (trimmed) {
      out.push(`<p>${formatInline(escapeHtml(line))}</p>`);
    }
  }
  closeList();

  let html = out.join('');
  for (let i = 0; i < links.length; i++) {
    html = html.replaceAll(`\u0000LINK_${i}\u0000`, links[i]);
  }
  for (let i = 0; i < blocks.length; i++) {
    html = html.replaceAll(`\u0000CODE_${i}\u0000`, blocks[i]);
  }
  return html;
}

function computeDiffLineStats(diffStr, fallbackAdd = 0, fallbackDel = 0) {
  if (!diffStr || fallbackAdd > 0 || fallbackDel > 0) {
    return { additions: fallbackAdd, deletions: fallbackDel };
  }
  let add = 0;
  let del = 0;
  for (const line of String(diffStr).split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++;
    else if (line.startsWith('-') && !line.startsWith('---')) del++;
  }
  return { additions: add, deletions: del };
}

export function parseUnifiedDiffIntoFiles(diffText, explicitFiles) {
  const out = [];
  if (diffText && diffText.includes('diff --git ')) {
    const parts = diffText.split(/(?=^diff --git )/m);
    for (const chunk of parts) {
      if (!chunk.trim()) continue;
      const m = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
      const filePath = m ? m[2].trim() : '变更文件';
      const isNew = /new file mode/.test(chunk);
      const isDel = /deleted file mode/.test(chunk);
      const st = computeDiffLineStats(chunk);
      out.push({ path: filePath, status: isNew ? 'A' : isDel ? 'D' : 'M', additions: st.additions, deletions: st.deletions, chunk });
    }
    return out;
  }
  if (Array.isArray(explicitFiles) && explicitFiles.length > 0) {
    return explicitFiles.map((f) => ({
      path: String(f.path || f.filePath || f.file || ''),
      status: String(f.status || f.kind || 'M').slice(0, 1).toUpperCase(),
      additions: Number(f.additions || 0),
      deletions: Number(f.deletions || 0),
      chunk: String(f.diff || diffText || ''),
    }));
  }
  if (diffText && diffText.trim()) {
    const st = computeDiffLineStats(diffText);
    out.push({ path: '工作区补丁汇总', status: 'M', additions: st.additions, deletions: st.deletions, chunk: diffText });
  }
  return out;
}

export function renderUnifiedDiffHtml(diffText) {
  const lines = String(diffText || '').split('\n');
  let oldLn = 0;
  let newLn = 0;
  const rows = [];
  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLn = Number(hunkMatch[1]);
      newLn = Number(hunkMatch[2]);
      rows.push(`<tr class="diff-line hunk"><td class="diff-ln">...</td><td class="diff-ln">...</td><td class="diff-code">${escapeHtml(line)}</td></tr>`);
      continue;
    }
    if (line.startsWith('+')) rows.push(`<tr class="diff-line add"><td class="diff-ln"></td><td class="diff-ln">${newLn++}</td><td class="diff-code">${escapeHtml(line)}</td></tr>`);
    else if (line.startsWith('-')) rows.push(`<tr class="diff-line del"><td class="diff-ln">${oldLn++}</td><td class="diff-ln"></td><td class="diff-code">${escapeHtml(line)}</td></tr>`);
    else rows.push(`<tr class="diff-line"><td class="diff-ln">${oldLn ? oldLn++ : ''}</td><td class="diff-ln">${newLn ? newLn++ : ''}</td><td class="diff-code">${escapeHtml(line)}</td></tr>`);
  }
  return `<table class="diff-table"><tbody>${rows.join('')}</tbody></table>`;
}

export function shortenModelName(modelId) {
  const s = String(modelId || '');
  return s.includes('/') ? s.split('/').pop() : s;
}

export function formatCatalogSourceLabel(source) {
  const s = String(source || '').trim();
  if (!s) return '';
  if (s === 'local-config-catalog' || s === 'cc-switch-catalog') return '本地配置目录';
  if (s === 'codex-rpc-live') return 'Codex 实时探测';
  if (s === 'kimi-config+acp' || s === 'kimi-config') return 'Kimi 配置同步';
  if (s === 'agy-live') return 'AGY 实时目录';
  if (s === 'agy-cache') return 'AGY 上次同步';
  if (s === 'builtin' || s === 'native-host') return '内置目录';
  if (s === 'extension' || s === 'custom-extension') return '扩展通道配置';
  if (s === 'fallback') return '离线兜底目录';
  return s;
}

export function shortenPath(p) {
  const s = String(p || '');
  if (s.length <= 34) return s;
  const parts = s.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return s;
  return `.../${parts.slice(-2).join('/')}`;
}

export function formatCompactNumber(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

export function formatExactNumber(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

export function formatDurationMs(ms) {
  const totalSec = Math.max(0, ms / 1000);
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function formatTimeShort(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}
