import React, { useState } from 'react';
import { X } from 'lucide-react';
import { validateCredentials } from '../../account.js';

/**
 * 账号弹窗（登录 / 注册 / 忘记密码 / 改密码 / 注销）。
 *
 * 与回译本同一套后端（server/accounts.mjs 原样复用）：
 * 邮箱 + 密码注册，登录后拿到令牌，可把同步码绑到账号上。
 * **账号是可选的**：不登录也能用全部功能，登录只是为了换设备时省去手抄同步码。
 */
export default function AuthModal({
  config, account, busy, tip, onClose,
  onSignIn, onSignUp, onSignOut, onSignOutAll, onForgot, onReset, onDeleteAccount, onChangePassword,
}) {
  const [mode, setMode] = useState('login');       // login | register | forgot | reset | change
  const [form, setForm] = useState({ email: '', password: '', code: '', newPassword: '' });
  const [localErr, setLocalErr] = useState('');
  const field = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = () => {
    setLocalErr('');
    if (mode === 'forgot') { onForgot(form.email); return; }
    if (mode === 'reset') {
      if (String(form.newPassword || '').length < 8) { setLocalErr('新密码至少 8 位'); return; }
      onReset(form.email, form.code, form.newPassword);
      return;
    }
    const bad = validateCredentials(form.email, form.password);
    if (bad) { setLocalErr(bad); return; }
    if (mode === 'login') onSignIn(form.email, form.password);
    else onSignUp(form.email, form.password);
  };

  const loggedIn = Boolean(account && account.email);

  return (
    <div className="modal-mask auth-mask" onClick={onClose}>
      <div className="modal auth-modal" role="dialog" aria-modal="true" aria-label="账号" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>账号</h2><button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button></div>

        {!config?.enabled ? (
          <p className="sync-lost">
            服务端没有启用账号功能（没有配置持久存储）。托管平台的磁盘是临时的，
            在那里开账号会导致重新部署后账号全丢，所以默认关闭 —— 配好
            UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 后自动开启。
            在开启之前，你仍然可以用「同步码」跨设备同步。
          </p>
        ) : null}

        {loggedIn ? (
          <>
            <p className="muted small">已登录：<b>{account.email}</b></p>
            <div className="modal-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
              <button className="ghost-btn" onClick={onSignOut} disabled={busy}>退出登录</button>
              <button className="ghost-btn" onClick={onSignOutAll} disabled={busy}>退出全部设备</button>
              <button className="ghost-btn" onClick={() => { setMode(mode === 'change' ? 'login' : 'change'); setLocalErr(''); }} disabled={busy}>修改密码</button>
              <button className="ghost-btn" onClick={() => { const p = window.prompt('输入当前密码以注销账号（不可恢复）'); if (p) onDeleteAccount(p); }} disabled={busy}>注销账号</button>
            </div>

            {mode === 'change' ? (
              <div className="auth-form" style={{ marginTop: 12 }}>
                <label className="auth-label">当前密码
                  <input type="password" value={form.password} onChange={field('password')} autoComplete="current-password" disabled={busy} />
                </label>
                <label className="auth-label">新密码（至少 8 位）
                  <input type="password" value={form.newPassword} onChange={field('newPassword')} autoComplete="new-password" disabled={busy} />
                </label>
                {/* 同步码是用**密码**加密后存在服务端的，服务端没有旧密码、代劳不了 ——
                    不在本地用新密码重新加密一遍，别的设备就再也解不开了。 */}
                <p className="muted small">改完密码，本机的同步码会用新密码重新加密一次（否则别的设备将解不开）。</p>
                <div className="modal-actions">
                  <button className="primary-btn" disabled={busy || !form.password || form.newPassword.length < 8}
                    onClick={() => { setLocalErr(''); onChangePassword(form.password, form.newPassword); setForm((f) => ({ ...f, password: '', newPassword: '' })); }}>
                    确认修改
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="mode-tabs" style={{ marginBottom: 12 }}>
              {[['login', '登录'], ['register', '注册'], ['forgot', '忘记密码']].map(([k, label]) => (
                <button key={k} className={mode === k ? 'active' : ''} onClick={() => { setMode(k); setLocalErr(''); }}>{label}</button>
              ))}
            </div>
            <div className="auth-form">
              <label className="auth-label">邮箱
                <input value={form.email} onChange={field('email')} placeholder="you@example.com" autoComplete="email" disabled={busy} />
              </label>
              {mode === 'reset' ? (
                <>
                  <label className="auth-label">邮件里的验证码
                    <input value={form.code} onChange={field('code')} placeholder="6 位数字" disabled={busy} />
                  </label>
                  <label className="auth-label">新密码
                    <input type="password" value={form.newPassword} onChange={field('newPassword')} placeholder="至少 8 位" autoComplete="new-password" disabled={busy} />
                  </label>
                </>
              ) : mode === 'forgot' ? (
                <p className="muted small">填邮箱后点下面的按钮，我们会把验证码发到你的邮箱（服务端需配好 SMTP）。</p>
              ) : (
                <label className="auth-label">密码
                  <input type="password" value={form.password} onChange={field('password')} placeholder="至少 8 位" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} disabled={busy} />
                </label>
              )}
            </div>
            {(localErr || tip) ? <div className="lib-tip" role="alert">{localErr || tip}</div> : null}
            <div className="modal-actions">
              <button className="primary-btn" onClick={submit} disabled={busy || !config?.enabled}>
                {busy ? '处理中…' : mode === 'login' ? '登录' : mode === 'register' ? '注册' : mode === 'forgot' ? '发送验证码' : '重设密码'}
              </button>
              {mode === 'forgot' ? <button className="ghost-btn" onClick={() => setMode('reset')}>我已收到验证码</button> : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
