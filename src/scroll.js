/**
 * 滚动位置工具。
 *
 * 这个应用有两个滚动容器：桌面端是 `.editor`（overflow-y: auto），
 * 手机端是整页（body/滚动根）—— 所有"回到顶部"都必须同时处理这两个，
 * 否则会出现"点了按钮没反应 / 只动了一半"。
 */

/** 当前滚动位置（取两个容器里更大的那个） */
export function scrollTop() {
  if (typeof document === 'undefined') return 0;
  const root = document.scrollingElement || document.documentElement;
  const ed = document.querySelector('.editor');
  return Math.max(root ? root.scrollTop : 0, ed ? ed.scrollTop : 0);
}

/** 回到顶部。smooth=false 时立刻到位（查完词把新卡片顶到最上面用这个） */
export function toTop({ smooth = true } = {}) {
  if (typeof document === 'undefined') return;
  const behavior = smooth ? 'smooth' : 'auto';
  const ed = document.querySelector('.editor');
  if (ed && ed.scrollTop > 0) {
    if (ed.scrollTo) ed.scrollTo({ top: 0, behavior });
    else ed.scrollTop = 0;
  }
  const root = document.scrollingElement || document.documentElement;
  if (root && root.scrollTop > 0) {
    if (root.scrollTo) root.scrollTo({ top: 0, behavior });
    else root.scrollTop = 0;
  }
}
