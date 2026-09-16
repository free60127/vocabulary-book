import React from 'react';
import { ArrowRight, Search, X } from 'lucide-react';

/**
 * 中文查词的"先选词"面板。
 *
 * 为什么必须有这一步：中文词和英文词不是一一对应 ——
 * "羽毛球"可能是 badminton（运动）、shuttlecock（那个球，英式）、birdie（美式口语）。
 * 直接把中文当成词头交给模型讲解，就会出现"词头是中文、音标却是 /ˈbædmɪntən/"这种自相矛盾的卡片
 * （线上真实事故）。所以先让用户挑，挑完再走正常的查词讲解。
 */
export default function ZhPicker({ term, items, lastPick, busy, error, onPick, onCancel }) {
  const sorted = [...items].sort((a, b) => {
    // 上次选过的排最前 —— 同一个词重复查时通常还是想要同一个
    const av = a.word === lastPick ? 0 : 1;
    const bv = b.word === lastPick ? 0 : 1;
    return av - bv;
  });

  return (
    <section className="editor">
      <div className="panel zh-picker">
        <div className="panel-head">
          <h2><Search size={16} />「{term}」对应哪个英文词？</h2>
          <button className="icon-btn" onClick={onCancel} aria-label="取消"><X size={16} /></button>
        </div>
        <p className="muted small">
          中文词和英文词不是一一对应，先挑一个再讲解 —— 挑错了讲解就会跑偏。
        </p>

        {error ? <div className="error-banner" role="alert"><span className="error-text">{error}</span></div> : null}
        {busy ? <p className="muted small">正在找出对应的英文词…</p> : null}

        <ul className="zh-list">
          {sorted.map((c) => (
            <li key={c.word}>
              <button className={'zh-item' + (c.word === lastPick ? ' last' : '')} onClick={() => onPick(c)}>
                <span className="zh-word">{c.word}</span>
                {c.phonetic ? <span className="phonetic">{c.phonetic}</span> : null}
                {c.pos ? <span className="chip tiny">{c.pos}</span> : null}
                {c.cn ? <span className="zh-cn">{c.cn}</span> : null}
                <span className="zh-tags">
                  {c.variant ? <span className="chip tiny">{c.variant}</span> : null}
                  {c.register ? <span className="chip tiny">{c.register}</span> : null}
                  {c.word === lastPick ? <span className="chip tiny gold">上次查的就是这个</span> : null}
                </span>
                <span className="zh-arrow"><ArrowRight size={15} /></span>
                {c.note ? <span className="zh-note">{c.note}</span> : null}
              </button>
            </li>
          ))}
        </ul>

        <div className="modal-actions">
          <button className="ghost-btn" onClick={onCancel}>回到查词</button>
        </div>
      </div>
    </section>
  );
}
