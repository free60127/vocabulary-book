import { useCallback, useEffect, useRef, useState } from 'react';
import {
  authConfig, bindSyncCode, changePassword as apiChangePassword, deleteAccount as apiDelete,
  fetchMe, forgot as apiForgot, loadToken, loadUser, resetPassword as apiReset,
  saveToken, saveUser, signIn, signOut as apiSignOut, signOutAll as apiSignOutAll, signUp,
} from '../account.js';
import { loadSyncCode, loadSyncMeta, saveSyncCode } from '../sync.js';
import { TIP_LONG_MS } from '../constants.js';

/**
 * 账号（注册 / 登录 / 改密 / 注销 / 找回）。
 *
 * ⚠️ 这条链路里同步码**只有明文形态在浏览器内流转**：
 * 发给服务端的永远是密文（用账号密码派生密钥加密），从服务端拿回来的要先用密码解开。
 * 移植时漏掉这一步会出两种真故障 —— 绑定必然 400，或者把密文当同步码用（换设备拉不到数据，
 * 还会把本机原来那串好码覆盖掉）。所以 afterAuth 一定要拿到的 `password` 就是这个用途。
 *
 * @param {object} o
 * @param {object} o.cloud   useCloud() 的返回值（要读写同步码、触发一次同步）
 * @param {(msg: string, ms?: number) => void} o.flash
 */
export function useAuth({ cloud, flash }) {
  const [account, setAccount] = useState(() => ({ token: loadToken(), ...loadUser() }));
  const [authCfg, setAuthCfg] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authTip, setAuthTip] = useState('');
  const [authOpen, setAuthOpen] = useState(false);
  /** 账号里是否存过同步码（启动时只拿得到这个事实 —— 解它需要密码，见 afterAuth） */
  const [accountHasSync, setAccountHasSync] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false }, []);

  /* cloud 的这几个函数身份会随 syncCode 变化，用 ref 取最新值，
     否则 afterAuth 的依赖会把整条登录链路连同界面一起重建 */
  const cloudRef = useRef(cloud);
  cloudRef.current = cloud;

  useEffect(() => { authConfig().then(setAuthCfg).catch(() => setAuthCfg({ enabled: false })); }, []);

  const afterAuth = useCallback(async (r, password) => {
    const c = cloudRef.current;
    if (!r.ok) { setAuthTip(r.error || '操作失败'); return; }
    const token = r.token || (loadToken()) || '';
    const email = r.email || (r.user && r.user.email) || '';
    setAccount({ token, email }); saveToken(token); saveUser({ email });
    setAccountHasSync(Boolean(r.hasSync));
    setAuthOpen(false); setAuthTip('');

    if (r.syncError) {
      setAuthTip(r.syncError);
      flash('已登录：' + email + '（同步码需重新设置）', TIP_LONG_MS);
      return;
    }
    // 解开账号里存的同步码 → 这台设备就接上了（换设备不用手抄）
    if (r.syncCode) {
      saveSyncCode(r.syncCode); c.setSyncCode(r.syncCode);
      c.setSyncTip('已从账号取回同步码');
      c.runSync(true, r.syncCode);
      flash('已登录：' + email);
      return;
    }
    // 账号里没存过同步码（首次登录 / 老账号）：
    //  · 本机有码 → **立刻绑上去**。不绑的话这台设备会一直用自己的码，和别的设备永远碰不上面；
    //  · 本机也没码（新设备先登录）→ 明确告诉用户下一步该做什么，别让他对着"已登录"发呆。
    const localCode = loadSyncCode();
    if (localCode && password) {
      const b = await bindSyncCode(token, localCode, password);
      c.setSyncTip(b.ok ? '已把本机同步码存进账号 —— 换设备登录后会自动带回来' : ('同步码保存失败：' + (b.error || '')));
    } else if (!localCode) {
      c.setSyncTip('这台设备还没有同步码。请先在**有数据的那台设备**上登录一次（会自动把码存进账号），再回到这里点「从账号取回同步码」。');
    }
    flash('已登录：' + email);
  }, [flash]);

  const doSignIn = useCallback(async (email, password) => {
    setAuthBusy(true); setAuthTip('');
    await afterAuth(await signIn({ email, password, device: loadSyncMeta().device || '' }), password);
    setAuthBusy(false);
  }, [afterAuth]);

  const doSignUp = useCallback(async (email, password) => {
    setAuthBusy(true); setAuthTip('');
    // 注册时顺手把本机同步码（如果有）一起带上去
    await afterAuth(await signUp({ email, password, syncCode: loadSyncCode() }), password);
    setAuthBusy(false);
  }, [afterAuth]);

  const clearAccount = useCallback(() => {
    setAccount({ token: '', email: '' }); saveToken(''); saveUser({});
  }, []);

  const doSignOut = useCallback(async () => {
    await apiSignOut(loadToken());
    clearAccount();
    flash('已退出登录');
  }, [clearAccount, flash]);

  const doSignOutAll = useCallback(async () => {
    await apiSignOutAll(loadToken());
    clearAccount();
    flash('已退出全部设备');
  }, [clearAccount, flash]);

  const doForgot = useCallback(async (email) => {
    setAuthBusy(true);
    const r = await apiForgot(email);
    setAuthTip(r.ok ? '验证码已发到邮箱（服务端未配 SMTP 时不可用）' : (r.error || '发送失败'));
    setAuthBusy(false);
  }, []);

  const doReset = useCallback(async (email, code, pw) => {
    setAuthBusy(true);
    const r = await apiReset(email, code, pw);
    setAuthTip(r.ok ? '密码已重设，请用新密码登录' : (r.error || '重设失败'));
    setAuthBusy(false);
  }, []);

  const doDeleteAccount = useCallback(async (pw) => {
    setAuthBusy(true);
    const r = await apiDelete(loadToken(), pw);
    if (r.ok) { clearAccount(); flash('账号已注销'); } else setAuthTip(r.error || '注销失败');
    setAuthBusy(false);
  }, [clearAccount, flash]);

  /* 改密码：**同时用新密码重新加密同步码**，否则别的设备再也解不开 */
  const doChangePassword = useCallback(async (oldPassword, newPassword) => {
    setAuthBusy(true);
    const r = await apiChangePassword({ token: loadToken(), oldPassword, newPassword, syncCode: cloudRef.current.syncCode });
    if (r.ok) {
      if (r.token) { saveToken(r.token); setAccount({ token: r.token, email: (loadUser().email || '') }); }
      setAuthTip('');
      flash('密码已修改' + (cloudRef.current.syncCode ? '（同步码已用新密码重新加密）' : ''));
    } else setAuthTip(r.error || '修改失败');
    setAuthBusy(false);
  }, [flash]);

  /* 已登录时拉一次用户信息（顺便验证令牌还有效） */
  useEffect(() => {
    const token = loadToken();
    if (!token) return;
    fetchMe(token).then((r) => {
      if (!aliveRef.current) return;
      if (r.ok) {
        const email = r.email || (r.user && r.user.email) || '';
        setAccount({ token, email }); saveUser({ email });
        // 这里**不能**把 r.sync 当同步码用：那是密文，解它需要账号密码（启动时没有）。
        // 只记下"账号里有码"这个事实，界面上提示用户登录一次即可自动取回。
        const hasSync = Boolean(r.hasSync);
        setAccountHasSync(hasSync);
        // 静默失败最伤人：已登录、本机有码、账号里却没有 —— 用户会以为"登录了就该自动同步"。
        if (!hasSync && loadSyncCode()) {
          flash('换设备同步还差一步：打开「备份/同步」→「把同步码存到账号」（需要账号密码）', TIP_LONG_MS * 2);
        }
      } else {
        // 令牌失效（改过密码 / 被踢）：清掉，免得后续请求一直 401
        saveToken(''); saveUser({}); setAccount({ token: '', email: '' });
      }
    });
  }, [flash]);

  return {
    account, authCfg, authBusy, authTip, setAuthTip, authOpen, setAuthOpen, accountHasSync,
    doSignIn, doSignUp, doSignOut, doSignOutAll, doForgot, doReset, doDeleteAccount, doChangePassword,
  };
}
