/**
 * 外观主题：跟随系统 / 亮色 / 暗色。
 *
 * 为什么要有选择：原来只跟随系统（`prefers-color-scheme`），但"跟随系统"不总对 ——
 * 白天在窗边用暗色看不清、晚上躺床上系统是白的又刺眼，用户需要能自己钉住一种。
 *
 * 实现要点：
 *  · 统一由 `<html data-theme="dark|light">` 驱动 CSS（不再维护一份媒体查询）；
 *  · 'system' 时监听 `matchMedia`，系统切换主题能实时跟上；
 *  · 首屏防闪：index.html 里有一小段同步脚本，在样式生效前就把 data-theme 写上
 *    （否则暗色用户会先看到一帧白屏）；
 *  · 顺带更新 `<meta name="theme-color">`（手机浏览器地址栏颜色）。
 */
export const THEMES = [
  { key: 'system', label: '跟随系统' },
  { key: 'light', label: '亮色' },
  { key: 'dark', label: '暗色' },
];

const DARK_BG = '#0f1418';
const LIGHT_BG = '#f4f6f8';

export const isThemeKey = (k) => THEMES.some((t) => t.key === k);

/** 用户偏好 → 实际生效的主题 */
export function resolveTheme(pref, prefersDark) {
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  return prefersDark ? 'dark' : 'light';
}

/** 写到 <html> 与 meta 上（不碰 React 状态，任何地方调用都安全） */
export function applyTheme(pref) {
  if (typeof document === 'undefined') return 'light';
  const prefersDark = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
  const theme = resolveTheme(pref, prefersDark);
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? DARK_BG : LIGHT_BG);
  return theme;
}
