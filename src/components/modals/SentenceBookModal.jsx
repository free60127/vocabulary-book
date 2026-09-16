import React, { useState } from 'react';
import { NotebookPen, Trash2, Volume2, X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap.js';
import { useEscape } from '../../hooks/useEscape.js';
import { speak } from '../../speak.js';

/**
 * 错句本：自己收藏起来的造句练习。
 *
 * 定位（和错词本的区别）：
 *  · 错词本 = **词**层面的薄弱项，由系统自动进出（评忘了 / 拼错 / 造句低分自动进）；
 *  · 错句本 = **句子**层面的私人收藏，**完全由用户决定**收不收（用户明确要求"可以自己选择"）——
 *    一句自己写得得意、或一句被批得很惨的句子，都值得留下来回头再看。
 *
 * 所以这里不做任何自动进出，只提供：看、朗读、再练一次这个词、删。
 */
export default function SentenceBookModal({ items, onClose, onDelete, onPracticeWord }) {
  const trapRef = useFocusTrap();
  useEscape(onClose, true);
  const [openId, setOpenId] = useState('');

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal sentence-book" role="dialog" ref={trapRef} aria-label="错句本" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3><NotebookPen size={16} />错句本{items.length ? `（${items.length}）` : ''}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>

        {!items.length ? (
          <p className="muted small">
            还没有收藏的句子。造句练习里批改完，点「收进错句本」就会出现在这儿 ——
            自己写得好的、或者被批得狠的，都值得留下来。
          </p>
        ) : (
          <ul className="sentence-book-list">
            {items.map((it) => (
              <li key={it.id} className="sentence-book-item">
                <div className="sb-head">
                  <strong>{it.head}</strong>
                  {it.phonetic ? <span className="phonetic">{it.phonetic}</span> : null}
                  <span className={'sb-score tone-' + (it.score >= 85 ? 'great' : it.score >= 70 ? 'good' : it.score >= 50 ? 'fair' : 'poor')}>
                    {it.score} 分
                  </span>
                  <span className="muted small">{it.mode === 'translate' ? '翻译造句' : '自由造句'}{it.difficulty ? ' · ' + it.difficulty : ''}</span>
                  <span className="sb-ops">
                    <button className="icon-btn" title="朗读我的句子" aria-label="朗读我的句子" onClick={() => speak(it.sentence)}><Volume2 size={14} /></button>
                    <button className="icon-btn" title="再练一次这个词" aria-label="再练一次这个词" onClick={() => onPracticeWord(it)}><NotebookPen size={14} /></button>
                    <button className="icon-btn danger" title="从错句本移除" aria-label="从错句本移除" onClick={() => onDelete(it.id)}><Trash2 size={14} /></button>
                  </span>
                </div>
                {it.cn ? <p className="muted small sb-cn">原句：{it.cn}</p> : null}
                <p className="sb-mine">我写的：{it.sentence}</p>
                {it.corrected && it.corrected !== it.sentence ? <p className="sb-fixed">改对后：{it.corrected}</p> : null}
                {it.verdict ? (
                  <p className={'muted small sb-verdict' + (openId === it.id ? '' : ' clamp')} onClick={() => setOpenId(openId === it.id ? '' : it.id)}>
                    {it.verdict}
                  </p>
                ) : null}
                {it.suggestion && it.suggestion !== it.corrected ? (
                  <p className="muted small sb-suggest">更地道：{it.suggestion}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <div className="modal-actions">
          <button className="primary-btn" onClick={onClose}>知道了</button>
        </div>
      </div>
    </div>
  );
}
