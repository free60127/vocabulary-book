/**
 * 朗读（浏览器自带 SpeechSynthesis，零后端）。
 *
 * 为什么包一层：iOS 上 "cancel() 紧跟着 speak()" 会偶发不发声，
 * 中间插一个 setTimeout 能稳定触发；不支持的环境直接静默返回 false，由调用方决定要不要提示。
 */
export function speak(text, lang = 'en-US') {
  const t = String(text || '').trim();
  if (!t) return false;
  try {
    if (typeof speechSynthesis === 'undefined') return false;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t);
    u.lang = lang;
    u.rate = 0.95;
    setTimeout(() => { try { speechSynthesis.speak(u); } catch { /* 忽略 */ } }, 0);
    return true;
  } catch { return false; }
}
