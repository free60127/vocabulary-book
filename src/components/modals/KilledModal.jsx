import React from 'react';
import { RotateCcw, Skull, X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap.js';
import { useEscape } from '../../hooks/useEscape.js';

/**
 * 已斩掉的词：看一眼、必要时收回。
 *
 * 为什么要给恢复入口：斩掉是**不可逆**的语义（"以后别再问我"），
 * 但人一定会手滑（复习到一半连点、误触）。没有恢复入口的话，
 * 用户唯一的办法是把这个词删掉再重查一遍 —— 而那会把复习进度一起清掉。
 */
export default function KilledModal({ items, onClose, onRevive, onReviveAll }) {
  const trapRef = useFocusTrap();
  useEscape(onClose);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal killed-modal" role="dialog" ref={trapRef} aria-modal="true" aria-label="已斩掉的词" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>已斩掉的词（{items.length}）</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <p className="muted small">
          斩掉的词不会再出现在「今日待复习」里。点「收回」可以让它重新回到复习清单
          （排期还是原来那份，不会从头开始）。
        </p>
        {items.length === 0 ? <div className="muted">还没有斩掉任何词。</div> : (
          <>
            <ul className="killed-list">
              {items.map((it) => (
                <li key={it.key} className="killed-row">
                  <Skull size={13} className="killed-icon" />
                  <span className="killed-head">{it.head}</span>
                  {it.meaning ? <span className="muted small killed-meaning">{it.meaning}</span> : null}
                  <button className="ghost-btn sm" onClick={() => onRevive(it.head)}><RotateCcw size={13} />收回</button>
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button className="ghost-btn" onClick={onReviveAll}>全部收回</button>
              <button className="primary-btn" onClick={onClose}>知道了</button>
            </div>
          </>
        )}
        {items.length === 0 ? (
          <div className="modal-actions"><button className="primary-btn" onClick={onClose}>知道了</button></div>
        ) : null}
      </div>
    </div>
  );
}
