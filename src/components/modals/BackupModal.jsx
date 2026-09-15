import React, { useState } from 'react';
import { Cloud, Download, LogIn, Upload, X } from 'lucide-react';

/**
 * 备份与恢复：本机导出/导入 + 云同步（同步码）。
 *
 * 为什么要三样都有：
 *  · **导出/导入** —— 不依赖任何服务器，换设备/清缓存前自己存一份；
 *  · **同步码** —— 多设备自动对齐，码本身就是凭证（按密码对待，别外传）；
 *  · **账号**（见 AuthModal）—— 让同步码跟着账号走，换设备不用手抄那 32 位。
 */
export default function BackupModal({
  onClose, summary, onExport, onImport,
  syncCode, syncTip, syncBusy, onNewCode, onUseCode, onCopyCode, onStopSync, onSyncNow,
  syncMeta, account, accountHasSync, onOpenAuth, onBindSync, onPullSync,
}) {
  const [codeInput, setCodeInput] = useState('');
  const [binding, setBinding] = useState(false);   // 是否展开"输入密码以绑定同步码"
  const [bindPw, setBindPw] = useState('');
  const [pulling, setPulling] = useState(false);   // 是否展开"从账号取回同步码"
  const [pullPw, setPullPw] = useState('');
  const [importErr, setImportErr] = useState('');
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal backup-modal" role="dialog" aria-modal="true" aria-label="备份与恢复" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>备份与恢复</h2><button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button></div>
        <p className="muted small">单词本、复习排期、学习天数都只存在本机浏览器里：换设备、换浏览器、清缓存都会丢。</p>
        <div className="lib-preview">
          <div><span className="muted">当前数据</span><strong>{summary}</strong></div>
        </div>

        <div className="modal-actions">
          <button className="ghost-btn" onClick={onExport}><Download size={15} />导出备份文件</button>
          <label className="ghost-btn">
            <Upload size={15} />导入备份
            <input type="file" accept="application/json,.json" hidden onChange={async (e) => {
              const f = e.target.files && e.target.files[0];
              e.target.value = '';
              if (!f) return;
              setImportErr('');
              try { await onImport(f); } catch (err) { setImportErr(err.message || '导入失败'); }
            }} />
          </label>
        </div>
        {importErr ? <div className="lib-tip" role="alert">{importErr}</div> : null}

        <div className="sync-block">
          <div className="sync-title"><Cloud size={15} />云同步（多设备）</div>
          {syncCode ? (
            <>
              <div className="sync-row">
                <code className="sync-code">{syncCode}</code>
                <button className="ghost-btn sm" onClick={onCopyCode}>复制</button>
              </div>
              <p className="muted small">
                在另一台设备的这一栏里粘贴这串码即可双向同步。
                {syncMeta && syncMeta.lastSyncAt ? ` 上次同步：${new Date(syncMeta.lastSyncAt).toLocaleString()}` : ' 还没同步过。'}
              </p>
              <div className="modal-actions">
                <button className="ghost-btn" onClick={onSyncNow} disabled={syncBusy}>{syncBusy ? '同步中…' : '立即同步'}</button>
                <button className="ghost-btn" onClick={onNewCode} disabled={syncBusy}>换码</button>
                <button className="ghost-btn" onClick={onStopSync} disabled={syncBusy}>停用</button>
              </div>
            </>
          ) : (
            <>
              <div className="modal-actions">
                <button className="primary-btn" onClick={onNewCode} disabled={syncBusy}>{syncBusy ? '生成中…' : '生成同步码'}</button>
              </div>
              <div className="sync-row">
                <input value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder="或粘贴另一台设备的 32 位同步码" />
                <button className="ghost-btn sm" onClick={() => onUseCode(codeInput)} disabled={syncBusy}>使用</button>
              </div>
            </>
          )}
          {syncTip ? <div className="muted small" role="status" aria-live="polite">{syncTip}</div> : null}

          <div className="sync-row" style={{ marginTop: 10, flexDirection: 'column', alignItems: 'stretch' }}>
            {account && account.email ? (
              <>
                <div className="sync-row">
                  <span className="muted small">已登录：{account.email}</span>
                  {/* 状态要**说清楚现在处于哪一步**，不能只显示"已登录"。
                      用户实际踩到的坑：手机上登录了同一个账号却什么都没同步 ——
                      因为账号里当时压根没有同步码，而界面没告诉他下一步该干嘛。 */}
                  {syncCode
                    ? <span className="muted small">{accountHasSync ? '· 本机同步码已存进账号 ✓' : '· 本机同步码还没存进账号'}</span>
                    : <span className="warn-text small">{accountHasSync ? '· 账号里有同步码，本机还没有 → 点右边「从账号取回」' : '· 账号里还没有同步码'}</span>}
                  {syncCode ? (
                    binding ? null : (
                      <button className="ghost-btn sm" onClick={() => { setBinding(true); setPulling(false); }} disabled={syncBusy}>
                        {accountHasSync ? '重新存入' : '把同步码存到账号'}
                      </button>
                    )
                  ) : null}
                  {!syncCode && accountHasSync && !pulling ? (
                    <button className="primary-btn sm" onClick={() => { setPulling(true); setBinding(false); }} disabled={syncBusy}>从账号取回同步码</button>
                  ) : null}
                </div>

                {binding ? (
                  <div className="sync-row">
                    {/* 同步码要在**本地**用账号密码加密后才发出去（服务端只存密文、它自己也解不开），
                        所以这一步必须问用户要密码 —— 不是多余的一步。 */}
                    <input className="fav-search" type="password" autoComplete="current-password"
                      placeholder="账号密码（用来加密同步码）" value={bindPw}
                      onChange={(e) => setBindPw(e.target.value)} disabled={syncBusy} />
                    <button className="primary-btn sm" disabled={syncBusy || !bindPw}
                      onClick={() => { onBindSync(bindPw); setBindPw(''); setBinding(false); }}>确认存入</button>
                    <button className="ghost-btn sm" onClick={() => { setBinding(false); setBindPw(''); }}>取消</button>
                  </div>
                ) : null}

                {pulling ? (
                  <div className="sync-row">
                    <input className="fav-search" type="password" autoComplete="current-password"
                      placeholder="账号密码（用来解开同步码）" value={pullPw}
                      onChange={(e) => setPullPw(e.target.value)} disabled={syncBusy} />
                    <button className="primary-btn sm" disabled={syncBusy || !pullPw}
                      onClick={() => { onPullSync(pullPw); setPullPw(''); setPulling(false); }}>确认取回</button>
                    <button className="ghost-btn sm" onClick={() => { setPulling(false); setPullPw(''); }}>取消</button>
                  </div>
                ) : null}

                {!syncCode && !accountHasSync ? (
                  <p className="muted small" style={{ margin: 0 }}>
                    账号里还没有同步码。请在**有数据的那台设备**上打开本页并登录一次 ——
                    它会自动把同步码加密存进账号，然后回到这台设备点「从账号取回同步码」。
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <span className="muted small">
                  {accountHasSync
                    ? '账号里已存过同步码：登录一次即可自动取回（不用手抄）。'
                    : '登录后同步码会跟着账号走，换设备不用手抄。'}
                </span>
                <button className="ghost-btn sm" onClick={onOpenAuth}><LogIn size={14} />登录 / 注册</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
