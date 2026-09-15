/**
 * 时间显示格式化（历史列表等共用）。
 * 纯函数、无依赖 —— 抽出来的直接好处是能单测（见 tools/… 与 npm test 里的边界用例）。
 */

/** 本地时间「9/12 15:41」；空值返回空串 */
export function formatTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}
