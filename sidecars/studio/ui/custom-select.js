/**
 * AgentTower Studio — 自绘下拉弹层 (`ui/custom-select.js`)
 * 通过 initCustomSelect({ getOptions, onChoose, onOpenChange }) 注入回调，严禁反向 import 配置视图或动作模块。
 */
export function initCustomSelect({ getOptions, onChoose, onOpenChange }) {
  let pop, target, active;
  function control(node) {
    const el = node.closest?.('select,.at-select-trigger') || node.closest?.('label')?.control;
    return el?.matches('select,.at-select-trigger') && !el.disabled && !el.multiple && !(el.size > 1) ? el : null;
  }
  function consume(e) { e.preventDefault(); e.stopImmediatePropagation(); }
  function closePop() {
    if (!pop) return;
    target.setAttribute('aria-expanded', 'false');
    target.removeAttribute('aria-controls');
    target.removeAttribute('aria-activedescendant');
    pop.remove();
    pop = target = active = null;
    onOpenChange(false);
  }
  function choose(item) {
    if (!item || item.matches('.is-disabled')) return;
    const el = target, value = item.dataset.value;
    closePop();
    if (!el.isConnected || el.value === value) return;
    if (el.matches('.at-select-trigger')) return onChoose(el, value);
    if (![...el.options].some(o => o.value === value && !o.disabled && !o.closest('optgroup:disabled'))) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function position(sel) {
    if (!pop) return;
    const r = sel.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, 180), vw - 16);
    const below = vh - r.bottom - 8;
    const above = r.top - 8;
    const openUp = below < 180 && above > below;
    const maxH = Math.max(120, Math.min(340, openUp ? above : below));
    pop.style.width = `${width}px`;
    pop.style.maxHeight = `${maxH}px`;
    pop.style.left = `${Math.min(Math.max(8, r.left), vw - width - 8)}px`;
    if (openUp) {
      pop.style.top = '';
      pop.style.bottom = `${vh - r.top + 4}px`;
    } else {
      pop.style.bottom = '';
      pop.style.top = `${r.bottom + 4}px`;
    }
  }
  function highlight(item) {
    active?.classList.remove('is-active');
    active = item;
    if (!item) return;
    item.classList.add('is-active');
    target.setAttribute('aria-activedescendant', item.id);
    item.scrollIntoView({ block: 'nearest' });
  }
  function openPop(el) {
    closePop();
    target = el;
    onOpenChange(true);
    el.focus({ preventScroll: true });
    pop = document.createElement('div');
    pop.className = 'at-select-pop';
    pop.id = 'at-open-listbox';
    pop.setAttribute('role', 'listbox');
    el.setAttribute('aria-expanded', 'true');
    el.setAttribute('aria-controls', pop.id);
    const options = el.matches('select') ? Array.from(el.options).filter(o => !o.hidden && !o.parentElement.hidden).map(o => ({
      value: o.value, label: o.label, disabled: o.disabled || o.parentElement.matches('optgroup:disabled'), group: o.closest('optgroup')?.label,
    })) : getOptions(el);
    let lastGroup;
    for (const [i, opt] of options.entries()) {
      if (opt.group && opt.group !== lastGroup) {
        const g = document.createElement('div'); g.className = 'at-select-group'; g.textContent = opt.group; pop.append(g);
      }
      lastGroup = opt.group;
      const item = document.createElement('div');
      item.id = `at-list-option-${i}`;
      item.className = 'at-select-opt';
      item.setAttribute('role', 'option');
      item.dataset.value = opt.value;
      item.textContent = item.title = opt.label;
      item.classList.toggle('is-disabled', !!opt.disabled);
      item.setAttribute('aria-disabled', String(!!opt.disabled));
      item.classList.toggle('is-selected', opt.value === el.value);
      item.setAttribute('aria-selected', String(opt.value === el.value));
      pop.append(item);
    }
    document.body.append(pop);
    position(el);
    highlight(pop.querySelector('.is-selected:not(.is-disabled)') || pop.querySelector('.at-select-opt:not(.is-disabled)'));
  }
  // The click is the sole activation. Suppress native press AND label forwarding.
  for (const type of ['pointerdown', 'mousedown', 'click']) {
    document.addEventListener(type, e => {
      if (e.button !== 0) return;
      const inside = pop?.contains(e.target);
      const el = control(e.target);
      if (!inside && !el) { if (type !== 'click') closePop(); return; }
      consume(e);
      if (type !== 'click') return;
      if (inside) choose(e.target.closest('.at-select-opt'));
      else if (target === el) closePop();
      else openPop(el);
    }, true);
  }
  document.addEventListener('keydown', e => {
    const el = control(e.target);
    if (pop && e.key === 'Tab') { closePop(); return; }
    if (pop && e.key === 'Escape') { consume(e); closePop(); return; }
    if (!el || !['ArrowUp','ArrowDown','Enter',' ','F4'].includes(e.key)) return;
    consume(e);
    if (el !== target) return openPop(el);
    if (e.key === 'Enter' || e.key === ' ') return choose(active);
    if (e.key === 'F4') return closePop();
    const opts = [...pop.querySelectorAll('.at-select-opt:not(.is-disabled)')];
    highlight(opts[Math.max(0, Math.min(opts.length - 1, opts.indexOf(active) + (e.key === 'ArrowUp' ? -1 : 1)))]);
  }, true);
  function reposition() { if (pop) target.isConnected ? position(target) : closePop(); }
  document.addEventListener('scroll', e => { if (!pop?.contains(e.target)) reposition(); }, true);
  window.addEventListener('resize', reposition);
}
