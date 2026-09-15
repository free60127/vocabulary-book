import React from 'react';
import { AlertTriangle, CloudUpload, Download, Link2, X } from 'lucide-react';

/**
 * 数据安全横幅。
 *
 * 为什么要有：这个应用的数据**只存在这台浏览器里**，而"清浏览数据 / 换浏览器 / 无痕"
 * 是用户的常规操作 —— 真实事故：用户清了浏览数据，一天的 15 个词条和 31 个收藏全没了，
 * 因为当时**没有同步码**（云端没有副本），登录的账号里也没绑过码，于是无从恢复。
 *
 * 所以这里做三件事，按紧急程度排序：
 *  ① 有数据却没有同步码 → 明确说"现在丢了就找不回来"，并给"生成同步码 / 导出备份"两个动作；
 *  ② 有同步码但没存进账号 → 提醒存一次，换设备不用手抄；
 *  ③ 两个都有 → 不出现（不打扰）。
 * 关掉只记一个会话（sessionStorage），下次打开还会再说一次 —— 这件事值得重复提醒。
 */
export default function SafetyBanner({ entries, syncCode, accountEmail, accountHasSync, onMakeCode, onOpenBackup, onDismiss }) {
  // 有**任何一个**词条就算有数据了：风险从第一个词就开始（用户的真实事故就发生在某一天结束时）。
  // 只看数量的话，恰好是"刚开始用、最该知道这件事"的人看不到提醒。
  const risky = entries >= 1 && !syncCode;
  const unbound = !risky && Boolean(syncCode) && Boolean(accountEmail) && !accountHasSync;
  if (!risky && !unbound) return null;

  return (
    <div className={'safety-banner' + (risky ? ' danger' : ' warn')} role="status">
      {risky ? <AlertTriangle size={16} className="safety-icon" /> : <Link2 size={16} className="safety-icon" />}
      <div className="safety-body">
        {risky ? (
          <>
            <strong>这 {entries} 个词条只存在这台浏览器里</strong>
            <span className="muted small">
              换浏览器、清浏览数据、无痕模式都会让它消失，而且<b>没有云端副本可以恢复</b>。
              生成一个同步码（或导出一份备份）就有退路了。
            </span>
          </>
        ) : (
          <>
            <strong>同步码还没存进账号</strong>
            <span className="muted small">
              存一次之后，换设备登录同一个账号就能自动取回，不用手抄那 32 位。
            </span>
          </>
        )}
      </div>
      <div className="safety-actions">
        {risky ? (
          <>
            <button className="primary-btn sm" onClick={onMakeCode}><CloudUpload size={14} />生成同步码</button>
            <button className="ghost-btn sm" onClick={onOpenBackup}><Download size={14} />导出备份</button>
          </>
        ) : (
          <button className="primary-btn sm" onClick={onOpenBackup}><Link2 size={14} />去存进账号</button>
        )}
        <button className="icon-btn" onClick={onDismiss} aria-label="知道了"><X size={15} /></button>
      </div>
    </div>
  );
}
