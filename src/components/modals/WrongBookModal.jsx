import React from 'react';
import { RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap.js';
import { useEscape } from '../../hooks/useEscape.js';

const REASON_LABEL = { forgot: '复习时忘了', spell: '拼写错了', reveal: '看了答案' };

/**
 * 错词本。
 *
 * 它回答的是"我到底哪些词不行" —— 三天后到期的词里混着早就掌握的和一直错的，
 * 只看「今日待复习」分不出来；考前一小时该看什么，也只有这里能答。
 * 两个动作：**只练这些**（不动排期，练完按表现进出本）、**移出**（这个坎过去了）。
 */
export default function WrongBookModal({ items, onClose, onPractice, onRemove, onClearAll }) {
  const trapRef = useFocusTrap();
  useEscape(onClose);
  const inBook = items.filter((x) => x.exists).length;
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal wrong-modal" role="dialog" ref={trapRef} aria-modal="true" aria-label="错词本" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>错词本（{items.length}）</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <p className="muted small">
          复习里评「忘了」、拼写出错、或拼写时看了答案，都会自动进这里；
          <b>答对一次就自动出本</b>。{inBook < items.length ? `${items.length - inBook} 个词已经不在单词本里了（只剩记录）。` : ''}
        </p>
        {items.length === 0 ? (
          <div className="muted">还没有错词 —— 复习时答错会自动收进来。</div>
        ) : (
          <>
            <ul className="wrong-list">
              {items.map((w) => (
                <li key={w.key || w.head} className="wrong-row">
                  <div className="wrong-main">
                    <div className="wrong-head">
                      <strong>{w.head}</strong>
                      {w.phonetic ? <span className="muted small">{w.phonetic}</span> : null}
                      <span className="wrong-count" title="错了几次">×{w.count}</span>
                      <span className="wrong-reason">{REASON_LABEL[w.reason] || '答错'}</span>
                      {w.exists ? null : <span className="muted small">已不在单词本</span>}
                    </div>
                    {w.brief ? <div className="muted small wrong-brief">{w.brief}</div> : null}
                  </div>
                  <button className="ghost-btn sm" onClick={() => onRemove(w.head)} title="这个坎过去了，移出错词本">
                    <RotateCcw size={13} />移出
                  </button>
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button className="ghost-btn" onClick={onClearAll}><Trash2 size={14} />清空</button>
              <button className="primary-btn" onClick={() => onPractice(items)} disabled={!inBook}>
                <Sparkles size={15} />只练这 {items.length} 个
              </button>
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
