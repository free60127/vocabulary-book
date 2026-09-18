/**
 * 把 visualViewport 的**可视高度**实时写进 CSS 变量 `--vvh`。
 *
 * 为什么需要：弹窗是 `position:fixed; inset:0` 的全屏遮罩 + 居中内容。iOS 上聚焦弹窗里的
 * 输入框时软键盘一弹，布局视口不缩小，遮罩还是整屏高 —— 居中的输入框/底部按钮整个被
 * 键盘压在下面（登录、改名、建本弹窗全中招）。安卓 Chrome 的可视区也会被键盘压缩。
 *
 * 做法：`--vvh` 始终等于 visualViewport.height（键盘弹出就变小）。styles.css 里遮罩的
 * 高度与弹窗的 max-height 都引用它 —— 键盘弹出时遮罩自动收进"看得见的区域"，弹窗在
 * 可视区内居中，输入框永远够得着。老浏览器没有 visualViewport：变量不出现，走原 dvh/vh 兜底。
 *
 * 跑在 main.jsx 启动时；jsdom 没有 visualViewport，直接返回 undefined（组件测试无感）。
 */
export function watchVisualViewportHeight() {
  try {
    const vv = window.visualViewport;
    if (!vv || !document.documentElement) return undefined;
    const update = () => {
      const h = Math.round(vv.height);
      if (h <= 200) return;   // 异常 WebView 首帧可能报 0；200px 以下不可能是合法可视区
      if (vv.scale > 1.2) return;   // 双指缩放中：可视区变小是缩放造成的，不该让弹窗跟着跳
      document.documentElement.style.setProperty('--vvh', h + 'px');
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.documentElement.style.removeProperty('--vvh');
    };
  } catch { return undefined; }
}
