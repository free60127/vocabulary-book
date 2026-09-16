/**
 * 时间显示格式化（历史列表等共用）。
 * 纯函数、无依赖 —— 抽出来的直接好处是能单测（见 tools/… 与 npm test 里的边界用例）。
 */

/** 本地时间「9/12 15:41」；空值返回空串 */
export function formatTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

/**
 * 输入里有没有中文。
 *
 * 用途：中文要走"先给候选词"的路径 —— 中文词与英文词不是一一对应
 * （羽毛球 -> badminton / shuttlecock / birdie），直接当成词头讲解会得到自相矛盾的卡片。
 * 覆盖常用汉字区间 + 全角标点；纯英文/数字/连字符不受影响。
 */
export const hasCJK = (text) => {
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    // 汉字（含扩展 A 与兼容区）与全角字符：按码点判断，
    // 不用字面量字符类 —— 那会把全角空格写进源码，eslint 直接报 irregular whitespace
    if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff)) return true;
    if ((c >= 0xf900 && c <= 0xfaff) || (c >= 0xff01 && c <= 0xff60)) return true;
  }
  return false;
};
