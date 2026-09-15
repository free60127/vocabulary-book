/**
 * 时间显示格式化（结果页 / 历史列表 / 计时器共用）。
 * 纯函数、无依赖 —— 抽出来的直接好处是能单测（见 tools/… 与 npm test 里的边界用例）。
 */

/** 本地时间「9/12 15:41」；空值返回空串 */
export function formatTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

/** 时长：不足 1 小时用 MM:SS，超过用 H:MM:SS（练习用时 / 对比差值都用它） */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
