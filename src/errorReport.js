/**
 * 前端错误上报（自建，零依赖、不上第三方 SDK）。
 *
 * 为什么需要：线上出问题时，现在只能等用户截图反馈 —— 属于"盲飞"。
 * 上报到自己的后端 `/api/report`：错误栈里可能有内部路径，不该送给第三方。
 *
 * 三条纪律：
 *  1) **绝不打扰用户**：上报失败静默吞掉，不弹提示、不重试到卡界面；
 *  2) **绝不刷爆后端**：同一会话最多 5 条、同一条消息只报一次、两条之间至少隔 2 秒；
 *  3) **绝不泄隐私**：只发错误消息/堆栈/路径，路径去掉 hash 与查询串
 *     （结果页的 `#job=xxx` 是分享凭证，不能进日志），不发任何用户输入内容。
 */

const MAX_PER_SESSION = 5;
const MIN_INTERVAL_MS = 2000;
const MAX_MESSAGE = 2000;

let sentCount = 0;
let lastSentAt = 0;
const seenMessages = new Set();

/** 只保留 origin + pathname：#job= 是分享凭证，?query 可能有用户标识 */
function safePath() {
  try {
    return location.origin + location.pathname;
  } catch {
    return '';
  }
}

function toText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    if (value instanceof Error) return String(value.message || value.name || 'Error');
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return '[unserializable]';
  }
}

/**
 * 上报一条前端错误。任何情况下都不抛异常、不返回 Promise（调用方不需要 await）。
 * @param {'window'|'promise'|'react'|'manual'} kind
 * @param {unknown} error
 * @param {{stack?: string}} [extra]
 */
export function reportError(kind, error, extra = {}) {
  try {
    if (sentCount >= MAX_PER_SESSION) return;

    const message = toText(error).slice(0, MAX_MESSAGE);
    if (!message) return;
    // 同一条消息只报一次（渲染循环里同错会疯狂重复）
    if (seenMessages.has(message)) return;

    const now = Date.now();
    if (now - lastSentAt < MIN_INTERVAL_MS) return;

    seenMessages.add(message);
    sentCount += 1;
    lastSentAt = now;

    const stack = String(extra.stack || (error && error.stack) || '').slice(0, 4000);
    const payload = JSON.stringify({ kind, message, stack, path: safePath() });

    // keepalive：页面正在卸载（白屏后用户点重试/刷新）时也尽量把这条送出去
    // 用裸 fetch 而不是 api()：这里要的是"发不出去就算了"，不能引入超时/重试逻辑
    fetch((import.meta.env?.VITE_API_BASE || '').replace(/\/+$/, '') + '/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => { /* 静默：上报失败不影响用户 */ });
  } catch { /* 上报本身绝不能成为新的错误源 */ }
}

/** 装上全局兜底监听（window.onerror / unhandledrejection）。幂等。 */
let installed = false;
export function installErrorReporting() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => {
    reportError('window', e.error || e.message, { stack: e.error && e.error.stack });
  });
  window.addEventListener('unhandledrejection', (e) => {
    reportError('promise', e.reason, { stack: e.reason && e.reason.stack });
  });
}
