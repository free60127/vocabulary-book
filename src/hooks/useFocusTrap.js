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

    /**
     * 可聚焦元素列表（跳过真正隐藏的那些）。
     *
     * ⚠️ 不能用 `offsetParent === null` 当唯一判据：那是**布局相关**的，
     * 在 jsdom（组件测试）里所有元素都没有布局 → 全部被判为隐藏 → 列表里只剩"当前焦点元素"，
     * 于是"Tab 跳到第一个"退化成原地不动（组件测试就是这么发现的）。
     * 所以：先按 hidden / aria-hidden / computed display|visibility 判断（两种环境都可靠），
     * 只有真的一个都不剩时才退回完整列表。
     */
    const focusables = () => {
      const all = [...node.querySelectorAll(FOCUSABLE)];
      const isHidden = (el) => {
        if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
        if (el.style && el.style.display === 'none') return true;
        const cs = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : null;
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return true;
        return false;
      };
      const visible = all.filter((el) => !isHidden(el));
      return visible.length ? visible : all;
    };

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
      // 用下标判断而不是"是不是同一个元素"：焦点可能落在列表之外（浏览器的默认 Tab 顺序
      // 与我们的选择器未必一致，比如某个带 tabindex 的容器），那种情况也要能兜住
      const idx = list.indexOf(active);
      if (idx === -1) {
        e.preventDefault();
        (e.shiftKey ? lastEl : firstEl).focus({ preventScroll: true });
        return;
      }
      if (e.shiftKey && idx === 0) { e.preventDefault(); lastEl.focus({ preventScroll: true }); }
      else if (!e.shiftKey && idx === list.length - 1) { e.preventDefault(); firstEl.focus({ preventScroll: true }); }
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
