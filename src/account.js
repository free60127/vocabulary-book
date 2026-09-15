/**
 * 账号（与回译本同一套后端：server/accounts.mjs 原样复用）。
 *
 * 这里只管三件事：令牌落盘、调接口、把错误文案变成人话。
 * 账号是**可选**的：不登录也能用全部功能，登录只是为了把同步码跟着账号走（换设备不用手抄）。
 */
import { authConfig as apiAuthConfig, authPost } from './api.js';
import { safeGet, safeSet } from './storage.js';

const TOKEN_KEY = 'vb-token';
const USER_KEY = 'vb-user';

export const loadToken = () => safeGet(TOKEN_KEY, '');
export const saveToken = (t) => { if (t) safeSet(TOKEN_KEY, t); else { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } } };
export function loadUser() {
  try {
    const u = JSON.parse(safeGet(USER_KEY, '{}'));
    return u && typeof u === 'object' ? u : {};
  } catch { return {}; }
}
export const saveUser = (u) => safeSet(USER_KEY, JSON.stringify(u || {}));

export const authConfig = () => apiAuthConfig().catch(() => ({ enabled: false }));

const call = async (action, payload = {}, token = '') => {
  try {
    const r = await authPost(action, payload, token);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message || '请求失败', status: e.status };
  }
};

export const signUp = (email, password) => call('register', { email, password });
export const signIn = (email, password, device = '') => call('login', { email, password, device });
export const signOut = (token) => call('logout', {}, token);
export const signOutAll = (token) => call('logout-all', {}, token);
export const fetchMe = (token) => call('me', {}, token);
export const changePassword = (token, oldPassword, newPassword) => call('change-password', { oldPassword, newPassword }, token);
export const deleteAccount = (token, password) => call('delete-account', { password }, token);
export const forgot = (email) => call('forgot', { email });
export const resetPassword = (email, code, newPassword) => call('reset-password', { email, code, newPassword });
/** 把同步码绑到账号上：换设备登录后能自动取回来 */
export const bindSync = (token, sync) => call('sync', { sync }, token);

/** 校验一下邮箱/密码格式，省一次网络往返（也是给用户更快的反馈） */
export function validateCredentials(email, password) {
  const e = String(email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return '邮箱格式不正确';
  if (String(password || '').length < 8) return '密码至少 8 位';
  return '';
}
