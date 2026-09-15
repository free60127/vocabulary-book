import React, { useState } from 'react';
import { Cloud, Download, LogIn, Upload, X } from 'lucide-react';
import { mergeSnapshot } from '../../storage.js';

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
  syncCode, syncTip, syncBusy, onNewCode, onUseCode, onCopyCode, onStopSync, onSyncNow, onForcePush,
  syncMeta, account, accountHasSync, onOpenAuth, onBindSync, onPullSync, localSnapshot,
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
          {/* 自检：把"本机实际会推上去多少"算出来。
              同步出问题时最要命的是**看不见**——本机明明有 1 个本子，云端却是空的，
              光看"同步完成"四个字完全无从判断。这里把三个数字并排摆出来：
              本机有几条 → 实际会推几条 → 有多少被删除墓碑挡住（差值就是原因）。 */}
          {localSnapshot ? (() => {
            const count = (books) => ({
              books: (books || []).length,
              entries: (books || []).reduce((n, b) => n + ((b.entries || []).length), 0),
            });
            const mine = count(localSnapshot.books);
            const would = count(mergeSnapshot(localSnapshot, {
              books: [], review: {}, days: [], history: [], deletedBooks: [], deletedEntries: [],
            }).books);
            const tombs = { books: (localSnapshot.deletedBooks || []).length, entries: (localSnapshot.deletedEntries || []).length };
            const blocked = mine.books - would.books;
            return (
              <p className="muted small" style={{ margin: '0 0 8px' }}>
                本机 <b>{mine.books}</b> 个本子（{mine.entries} 个词条） · 实际会推送 <b>{would.books}</b> 个本子（{would.entries} 个词条）
                {blocked > 0 ? <span className="warn-text"> · ⚠️ 有 {blocked} 个本子被删除标记挡住了，不会同步</span> : null}
                {tombs.books || tombs.entries ? <span> · 删除标记：{tombs.books} 个本子 / {tombs.entries} 个词条</span> : null}
              </p>
            );
          })() : null}
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
              {/* 同步出问题时，用户唯一能自己判断的就是"两边各有多少" ——
                  以前界面上一个数字都没有，只能看到一句"同步完成"，于是"手机没同步到"
                  既看不出原因、也不知道该点哪儿。这里把两个数摆出来。 */}
              {syncMeta && syncMeta.lastSyncAt ? (
                <p className="muted small" style={{ margin: '2px 0 0' }}>
                  本机 <b>{syncMeta.localEntries != null ? `${syncMeta.localBooks} 个本子（${syncMeta.localEntries} 个词条）` : '—'}</b>
                  {' · 同步前云端 '}
                  <b>{syncMeta.cloudBeforeEntries != null ? `${syncMeta.cloudBeforeBooks} 个本子（${syncMeta.cloudBeforeEntries} 个词条）` : '—'}</b>
                </p>
              ) : null}
              <div className="modal-actions">
                <button className="ghost-btn" onClick={onSyncNow} disabled={syncBusy}>{syncBusy ? '同步中…' : '立即同步'}</button>
                {/* 逃生口：合并逻辑一旦有一边不对劲（例如云端那串码被写成了空壳），
                    没有这个按钮用户就只能换码重来，等于把另一台设备的数据一起丢掉。 */}
                <button className="ghost-btn" onClick={onForcePush} disabled={syncBusy} title="不做合并，直接用本机这份替换云端">用本机覆盖云端</button>
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
