import { useEffect, useRef } from 'react';

/**
 * 弹窗焦点管理：打开时把焦点移进来、Tab 只在弹窗里循环、关闭后焦点回到触发元素。
 *
 * 为什么要有：可用性审计实测 —— 弹窗打开后按 Tab 会一路跑到**弹窗背后的页面**上，
 * 键盘/读屏用户会迷失在背景内容里（`aria-modal="true"` 只是"声明"，浏览器不会替你拦住焦点）。
 * 这也是 WCAG 2.1 里 dialog 模式的基本要求。
 *
 * 用法：在弹窗组件里 `const ref = useFocusTrap();` 然后把 ref 挂到弹窗根节点。
 */
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useFocusTrap() {
  const ref = useRef(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    /** 关闭后要把焦点还回去，键盘用户才不会"掉到页面顶部" */
    const previous = document.activeElement;

    const focusables = () => [...node.querySelectorAll(FOCUSABLE)]
      .filter((el) => el.offsetParent !== null || el === document.activeElement);

    // 打开时：优先聚焦第一个可聚焦元素（一般是关闭按钮或输入框）
    const first = focusables()[0];
    if (first && typeof first.focus === 'function') first.focus({ preventScroll: true });

    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) { e.preventDefault(); return; }
      const firstEl = list[0];
      const lastEl = list[list.length - 1];
      const active = document.activeElement;
      // 焦点跑到弹窗外了 → 拉回弹窗里
      if (!node.contains(active)) { e.preventDefault(); firstEl.focus({ preventScroll: true }); return; }
      if (e.shiftKey && active === firstEl) { e.preventDefault(); lastEl.focus({ preventScroll: true }); }
      else if (!e.shiftKey && active === lastEl) { e.preventDefault(); firstEl.focus({ preventScroll: true }); }
    };

    node.addEventListener('keydown', onKey);
    return () => {
      node.removeEventListener('keydown', onKey);
      if (previous && typeof previous.focus === 'function' && document.body.contains(previous)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  return ref;
}
