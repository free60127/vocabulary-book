/**
 * 账号（与回译本同一套后端：server/accounts.mjs 原样复用）。
 *
 * 这里管三件事：令牌落盘、调接口、把错误文案变成人话。
 * 账号是**可选**的：不登录也能用全部功能，登录只是为了把同步码跟着账号走（换设备不用手抄）。
 *
 * ⚠️ 同步码在这条链路上**从不以明文离开浏览器**：
 * 服务端只存 `{salt, iv, c}` 密文（用你的密码派生密钥加密），它自己也解不开。
 * 所以这里的 seal/open 不是可选项 —— 少一步就是两种真故障：
 *   · 绑定时发明文 → 服务端直接 400「同步码密文格式不正确」（"存到账号"永远失败）；
 *   · 登录时把服务端返回的**密文**当成同步码用 → 换设备同步码变成一串乱码，
 *     什么也拉不到，还会把本机原来那串好码覆盖掉。
 *   （这两条都是在真实部署上冒烟时被逮住的：移植时只搬了调用，漏了加解密。）
 */
import { authConfig as apiAuthConfig, authPost } from './api.js';
import { safeGet, safeSet } from './storage.js';
import { isBox, openText, sealText } from './secretBox.js';

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

/** 同步码 → 密文。没有码、或浏览器不支持 WebCrypto 时返回 null（调用方据此降级） */
async function sealSync(syncCode, password) {
  if (!syncCode) return null;
  try { return await sealText(syncCode, password); }
  catch { return null; }
}

/**
 * 注册。本机已有同步码时**顺带加密存进账号** —— 换设备登录就能拿回来。
 * 加密失败不挡注册（最多这次没带上码，之后再点「存到账号」）。
 */
export async function signUp({ email, password, syncCode }) {
  const sync = await sealSync(syncCode, password);
  const r = await call('register', { email, password, sync });
  return r.ok ? { ...r, syncCode: syncCode || '' } : r;
}

/**
 * 登录 → 用密码把账号里的同步码**解开**。
 * @returns {{ok:true, syncCode, hasSync:boolean, syncError?:string}}
 *   hasSync=false：账号里压根没存过同步码 —— 调用方应当立刻把本机的码绑上去，
 *   否则这台设备会一直用自己的那串，和别的设备永远碰不上面。
 *   syncError 有值：登录成功但码解不开（上次重置过密码），**照常登录**，只是同步要重设。
 */
export async function signIn({ email, password, device = '' }) {
  const r = await call('login', { email, password, device });
  if (!r.ok) return r;
  const hasSync = isBox(r.sync);
  let syncCode = '';
  let syncError = '';
  if (hasSync) {
    const plain = await openText(r.sync, password);
    if (plain) syncCode = plain;
    else syncError = '账号里的同步码解不开（可能是重置过密码）。已登录，但需要重新设置同步码。';
  }
  return { ...r, syncCode, hasSync, syncError };
}

export const signOut = (token) => call('logout', {}, token);
export const signOutAll = (token) => call('logout-all', {}, token);

/** 校验本地令牌还有效；失效时顺手清掉。返回值里带 hasSync（**不含明文码**，解它需要密码） */
export async function fetchMe(token) {
  const r = await call('me', {}, token);
  return r.ok ? { ...r, hasSync: isBox(r.sync) } : r;
}

/**
 * 从账号里**取回**同步码（这台设备已经登录、但本机还没有码时用）。
 *
 * 为什么不复用 signIn：用户可能早就登录了（令牌还在），这时再走一次登录既多余、
 * 又会把旧会话换掉。这个函数就地读回密文、用密码解开。
 * @returns {{ok:true, syncCode:string}|{ok:false, error:string}}
 */
export async function pullSyncCode(token, password) {
  const r = await call('me', {}, token);
  if (!r.ok) return { ok: false, error: r.error || '读取账号失败，请重新登录' };
  if (!isBox(r.sync)) return { ok: false, error: '账号里还没有同步码 —— 请先在**有数据的那台设备**上登录一次（它会自动存进去），或在那台设备点「把同步码存到账号」' };
  const plain = await openText(r.sync, password);
  if (!plain) return { ok: false, error: '密码不对，或这串码是用旧密码加密的（改过密码的话需要在原设备重新存一次）' };
  return { ok: true, syncCode: plain };
}

/** 把当前同步码加密后存进账号（换设备/首次绑定时用）。密码必须是**账号密码** */
export async function bindSyncCode(token, syncCode, password) {
  const box = await sealSync(syncCode, password);
  if (!box) return { ok: false, error: '没有可绑定的同步码' };
  return call('sync', { sync: box }, token);
}

/**
 * 改密码。
 * **必须同时提交用新密码重新加密的同步码** —— 服务端没有旧密码，代劳不了；
 * 不带的话旧密文就永远解不开了（别的设备登录会一直提示"同步码解不开"）。
 */
export async function changePassword({ token, oldPassword, newPassword, syncCode }) {
  const sync = await sealSync(syncCode, newPassword);
  const r = await call('change-password', { oldPassword, newPassword, sync }, token);
  return r;
}

export const deleteAccount = (token, password) => call('delete-account', { password }, token);
export const forgot = (email) => call('forgot', { email });
export const resetPassword = ({ email, code, newPassword, syncCode }) =>
  call('reset-password', { email, code, newPassword, sync: syncCode ? sealSync(syncCode, newPassword) : null });

/** 校验一下邮箱/密码格式，省一次网络往返（也是给用户更快的反馈） */
export function validateCredentials(email, password) {
  const e = String(email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return '邮箱格式不正确';
  if (String(password || '').length < 8) return '密码至少 8 位';
  return '';
}
