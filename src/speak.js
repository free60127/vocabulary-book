/**
 * 朗读（浏览器自带 SpeechSynthesis，零后端）。
 *
 * 为什么包一层：iOS 上 "cancel() 紧跟着 speak()" 会偶发不发声，
 * 中间插一个 setTimeout 能稳定触发；不支持的环境直接静默返回 false，由调用方决定要不要提示。
 *
 * 为什么必须**选 voice**、只设 lang 不够：中文安卓机常常只装了 zh-CN 的 TTS 引擎，
 * 只设 u.lang='en-US' 时引擎会拿中文语音逐字母怪读英文、或干脆不出声；
 * iOS 的 voices 列表还是异步加载的（首次 getVoices() 常为空）。所以：
 *  · 每次 speak 都现场挑一个目标语言的 voice（优先本地引擎，离线可用、延迟低）；
 *  · 首次调用时装一次 voiceschanged 监听 —— 列表异步就绪后，后续调用就能拿到。
 */
export function speak(text, lang = 'en-US') {
  const t = String(text || '').trim();
  if (!t) return false;
  try {
    if (typeof speechSynthesis === 'undefined') return false;
    // voices 异步加载：装一次监听即可（重复装也无妨，回调只是刷新缓存）
    if (typeof speechSynthesis.addEventListener === 'function') {
      speechSynthesis.addEventListener('voiceschanged', () => {});
    } else {
      speechSynthesis.onvoiceschanged = () => {};   // 老 Safari
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t);
    u.lang = lang;
    const voice = pickVoice(lang);
    if (voice) u.voice = voice;                     // 没有匹配的 voice 时退回 lang，多数引擎仍能读
    u.rate = 0.95;
    setTimeout(() => { try { speechSynthesis.speak(u); } catch { /* 忽略 */ } }, 0);
    return true;
  } catch { return false; }
}

/** 挑一个最合适的语音：目标语言 → 优先本地引擎 → 优先默认 */
function pickVoice(lang) {
  try {
    const want = String(lang || '').slice(0, 2).toLowerCase();
    const voices = speechSynthesis.getVoices() || [];
    if (!voices.length) return null;
    const same = voices.filter((v) => String(v.lang || '').toLowerCase().replace('_', '-').startsWith(want));
    if (!same.length) return null;                  // 没装目标语言：交给引擎按 lang 兜底
    return same.find((v) => v.default && v.localService)
      || same.find((v) => v.localService)
      || same[0];
  } catch { return null; }
}
