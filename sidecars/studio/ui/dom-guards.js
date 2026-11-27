/**
 * AgentTower Studio — DOM 护栏与通用 DOM 工具 (`ui/dom-guards.js`)
 * 防闪烁 innerHTML 护栏（由 app.js 在启动时显式安装，模块加载本身不改写原型）、交互焦点探测、setText。
 */
/* ========================================================================
 * 0. 防闪烁护栏：轮询每 250ms~1.2s 触发一次整页重绘，若内容未变化则跳过 innerHTML 重写，
 *    避免悬停元素被替换（hover 闪烁）、已展开的原生 <select> 下拉框被销毁（下拉框自动消失）。
 * ======================================================================== */
export function installInnerHtmlNoopGuard() {
  try {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (!desc || !desc.set || !desc.get || Element.prototype.__atHtmlGuard) return;
    Object.defineProperty(Element.prototype, 'innerHTML', {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        return desc.get.call(this);
      },
      set(value) {
        const next = String(value ?? '');
        if (
          this.__atLastHtml === next &&
          this.__atLastChildCount === this.childNodes.length &&
          this.isConnected
        ) {
          return;
        }
        desc.set.call(this, next);
        this.__atLastHtml = next;
        this.__atLastChildCount = this.childNodes.length;
      },
    });
    Element.prototype.__atHtmlGuard = true;
  } catch {}
}

export function isUserInteractingWithin(rootEl) {
  const ae = document.activeElement;
  if (!rootEl || !ae || ae === document.body) return false;
  if (!rootEl.contains(ae)) return false;
  const tag = String(ae.tagName || '').toUpperCase();
  return tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA';
}

export function setText(id, text) {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
}
