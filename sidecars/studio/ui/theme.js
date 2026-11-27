/**
 * AgentTower Studio — 界面外观主题：用户偏好 + 宿主亮暗桥接 (`ui/theme.js`)
 *
 * <html> 上同时维护两个属性：
 * - data-theme-mode="auto|dark|light"：用户偏好（localStorage `at-theme-mode`，Webview 存储受限时回退内存 state.themeMode）；
 * - data-theme="dark|light"：当前实际生效的视觉主题。
 * styles.css 中 data-theme-mode="dark|light" 两套色板全部为纯字面值，不引用 --background / --foreground 等宿主变量，
 * 因此即使宿主在 <html style> 内联注入暗色变量，手动切亮色依然 100% 生效；仅 auto 模式桥接宿主变量，
 * 并由 MutationObserver 跟随宿主内联样式变化重新探测亮暗。
 */
import { setText } from './dom-guards.js';
import { state } from './state.js';

export const THEME_MODES = ['auto', 'dark', 'light'];
export const THEME_STORAGE_KEY = 'at-theme-mode';
const THEME_LABELS = { auto: '跟随宿主', dark: '暗色', light: '亮色' };

export function normalizeThemeMode(raw) {
  return THEME_MODES.includes(raw) ? raw : 'auto';
}

export function readStoredThemeMode() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored) return normalizeThemeMode(stored);
  } catch { /* Storage is optional in restricted Webviews. */ }
  return normalizeThemeMode(state.themeMode);
}

function storeThemeMode(mode) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch { /* 存储受限：偏好仅保留在内存 state.themeMode */ }
}

const LIGHT_SCHEME_QUERY = '(prefers-color-scheme: light)';

/** 独立网页端（无 window.sidecar 且宿主未在 <html style> 注入 --background）：auto 模式跟随系统亮暗偏好。 */
function isStandaloneWithoutHostTheme(root) {
  if (typeof window === 'undefined' || window.sidecar) return false;
  try {
    return !String(root?.style?.getPropertyValue?.('--background') || '').trim();
  } catch {
    return false;
  }
}

function prefersLightScheme() {
  try {
    return Boolean(window.matchMedia?.(LIGHT_SCHEME_QUERY)?.matches);
  } catch {
    return false;
  }
}

/** 探测宿主注入的 --background 亮度（auto 模式专用）；独立网页端跟随 prefers-color-scheme；探测失败回落暗色。 */
export function detectHostTheme() {
  const root = document.documentElement;
  if (isStandaloneWithoutHostTheme(root)) return prefersLightScheme() ? 'light' : 'dark';
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;color:var(--background, #0e1116)';
  root.appendChild(probe);
  const computed = getComputedStyle(probe).color || '';
  probe.remove();
  const nums = (computed.match(/[\d.]+/g) || []).map(Number);
  if (nums.length < 3) return 'dark';
  const scale = computed.startsWith('color(') ? 1 : 255;
  const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5 ? 'dark' : 'light';
}

/** 把 state.themeMode 施加到 <html>，并同步右上角月亮 / 太阳图标与无障碍文案。 */
export function applyStudioTheme() {
  const root = document.documentElement;
  const mode = normalizeThemeMode(state.themeMode);
  const theme = mode === 'auto' ? detectHostTheme() : mode;
  if (root.dataset.themeMode !== mode) root.dataset.themeMode = mode;
  if (root.dataset.theme !== theme) root.dataset.theme = theme;
  setText('theme-toggle-icon', theme === 'dark' ? '🌙' : '☀️');
  // 配置页「界面外观主题」三选一与偏好同步（不依赖配置页是否已渲染）
  document.querySelectorAll('#theme-mode-seg [data-theme-mode]').forEach((seg) => {
    const on = seg.dataset.themeMode === mode;
    seg.setAttribute('aria-checked', String(on));
    seg.tabIndex = on ? 0 : -1;
  });
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) {
    const next = theme === 'dark' ? '亮色' : '暗色';
    const label = `当前${THEME_LABELS[theme]}${mode === 'auto' ? '（跟随宿主）' : ''}，点击切换为${next}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  return theme;
}

/** 设置主题偏好（配置页「界面外观主题」三选一 / 顶栏切换共用）：写入 localStorage 并立即生效。 */
export function setThemeMode(mode) {
  state.themeMode = normalizeThemeMode(mode);
  storeThemeMode(state.themeMode);
  return applyStudioTheme();
}

/** 顶栏 #btn-theme-toggle：直接按当前已生效的 data-theme 翻转为相反色，任何宿主环境下第一下即变色。 */
export function toggleStudioTheme() {
  // auto 模式先同步重新探测（宿主变量 / 系统偏好可能刚变化而 MutationObserver 尚未回调），保证按真实生效色翻转
  if (normalizeThemeMode(state.themeMode) === 'auto') applyStudioTheme();
  const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  return setThemeMode(current === 'dark' ? 'light' : 'dark');
}

export function setupHostThemeSync() {
  state.themeMode = readStoredThemeMode();
  applyStudioTheme();
  // 宿主切换亮暗时会改写 <html style> 内联变量：auto 模式下重新探测（只写 data-* 属性，不会自触发）
  const obs = new MutationObserver(() => {
    if (normalizeThemeMode(state.themeMode) === 'auto') applyStudioTheme();
  });
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  // 独立网页端：系统亮暗偏好变化时 auto 模式自动跟随（宿主内由 --background 探测主导，detectHostTheme 自行判定）
  try {
    const mq = window.matchMedia?.(LIGHT_SCHEME_QUERY);
    const onSchemeChange = () => {
      if (normalizeThemeMode(state.themeMode) === 'auto') applyStudioTheme();
    };
    if (mq?.addEventListener) mq.addEventListener('change', onSchemeChange);
    else mq?.addListener?.(onSchemeChange);
  } catch { /* 受限 Webview 不支持 matchMedia 时忽略 */ }
  window.__applyStudioTheme = applyStudioTheme;
}
