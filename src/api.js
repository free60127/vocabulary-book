/**
 * 后端接口封装。
 *
 * 超时分两档：普通请求快、**提交生成任务**也快（服务端立刻返回任务号，真正的模型调用在后台），
 * 只有真正等模型的那一步是慢的 —— 靠轮询，不靠长连接（手机端/弱网下长请求会被挂起）。
 */
import { API_BASE as BASE } from './apiBase.js';

const TIMEOUT = { fast: 15000, normal: 30000 };

async function api(path, opts = {}, timeoutMs = TIMEOUT.normal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(BASE + path, { ...opts, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new Error('请求超时，请检查网络或稍后重试');
    throw new Error('无法连接服务器（请确认后端已启动：npm run server）');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* 非 JSON（例如 502 页面） */ }
  if (!res.ok) {
    const err = new Error(data.error || ('请求失败：HTTP ' + res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ---------- 状态 ---------- */
export const getStatus = () => api('/api/status', {}, TIMEOUT.fast);

/* ---------- 查词：提交 → 轮询 ---------- */
export const lookup = (payload) => api('/api/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ?? {}) });
export const getLookupJob = (jobId) => api('/api/lookup/' + jobId, {}, TIMEOUT.fast);

/* ---------- 自测题 ---------- */
export const quiz = (payload) => api('/api/quiz', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ?? {}) });
export const getQuizJob = (jobId) => api('/api/quiz/' + jobId, {}, TIMEOUT.fast);

/* ---------- 音标兜底 ---------- */
export const getPhonetic = (word) => api('/api/phonetic?word=' + encodeURIComponent(word), {}, TIMEOUT.fast);

/* ---------- 云同步 ---------- */
export const getSyncInfo = () => api('/api/sync/info', {}, TIMEOUT.fast);
export const createSyncCode = () => api('/api/sync/new', { method: 'POST' }, TIMEOUT.normal);
export const pullCloudSync = (code) => api('/api/sync/' + code, {}, TIMEOUT.normal);

/** 推送快照。409 时不抛错，把云端最新版本回给调用方，让它重新合并再推。 */
export async function pushCloudSync(code, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT.normal);
  let res;
  try {
    res = await fetch(BASE + '/api/sync/' + code, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return { ok: false, status: 0, data: { error: '网络错误，同步失败' } };
  } finally { clearTimeout(timer); }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
  if (res.ok) return { ok: true, status: res.status, data };
  return { ok: false, status: res.status, data };
}

/* ---------- 账号 ---------- */
const authHeaders = (token) => (token ? { Authorization: 'Bearer ' + token } : {});
export const authConfig = () => api('/api/auth/config', {}, TIMEOUT.fast);
export const authPost = (action, payload = {}, token = '') => api('/api/auth/' + action, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
  body: JSON.stringify(payload),
});

/* ---------- 错误上报（失败不影响用户） ---------- */
export const reportClientError = (payload) => {
  try {
    return fetch(BASE + '/api/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true,
    }).catch(() => {});
  } catch { return Promise.resolve(); }
};
