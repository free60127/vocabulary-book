import React from 'react';
import { ArrowRight, Search, X } from 'lucide-react';

/**
 * 中文查词的"先选词"面板（内联在搜索栏下方）。
 *
 * 为什么必须有这一步：中文词和英文词不是一一对应 ——
 * "羽毛球"可能是 badminton（运动）、shuttlecock（那个球，英式）、birdie（美式口语）。
 * 直接把中文当成词头交给模型讲解，就会出现"词头是中文、音标却是 /ˈbædmɪntən/"这种自相矛盾的卡片。
 *
 * 为什么是内联而不是单独一个视图（用户反馈 + 可用性审计）：
 * 单独视图里**没有搜索框** —— 想改个词重搜，得先按「回到查词」再重新输入。
 * 现在它长在搜索栏下面：改词、重搜、换候选都在同一屏完成。
 */
export default function ZhCandidates({ term, items, onPick, onDismiss }) {
  return (
    <div className="zh-picker" role="region" aria-label="选择要查的英文词">
      <div className="zh-head">
        <span className="zh-title"><Search size={15} />「{term}」对应哪个英文词？</span>
        <span className="muted small">中文与英文不是一一对应，挑一个再讲解</span>
        <button className="icon-btn" onClick={onDismiss} aria-label="关闭候选"><X size={15} /></button>
      </div>
      <ul className="zh-list">
        {items.map((c) => (
          <li key={c.word}>
            <button className={'zh-item' + (c.last ? ' last' : '')} onClick={() => onPick(c)}>
              <span className="zh-word">{c.word}</span>
              {c.phonetic ? <span className="phonetic">{c.phonetic}</span> : null}
              {c.pos ? <span className="chip tiny">{c.pos}</span> : null}
              {c.cn ? <span className="zh-cn">{c.cn}</span> : null}
              <span className="zh-tags">
                {c.variant ? <span className="chip tiny">{c.variant}</span> : null}
                {c.register ? <span className="chip tiny">{c.register}</span> : null}
                {c.last ? <span className="chip tiny gold">上次查的就是这个</span> : null}
              </span>
              <span className="zh-arrow"><ArrowRight size={15} /></span>
              {c.note ? <span className="zh-note">{c.note}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
