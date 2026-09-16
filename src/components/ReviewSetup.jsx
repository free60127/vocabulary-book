import React from 'react';
import { Flame, PenLine, Sparkles, X } from 'lucide-react';

/**
 * 复习前的模式选择。
 *
 * 为什么要有这一步（两次用户反馈合起来才看清）：
 *  ① 最早是"勾上拼写就当场变成拼写题" → 用户说"不是现在开启后就变成拼写"；
 *  ② 改成"勾上=预约，本轮做完再拼" → 用户又说"强制做完一轮才能拼写，不符合使用习惯"。
 * 真正的诉求是：**模式在进去之前就定好，进去直接按那个模式跑**（和造句练习一样）。
 * 所以这里不放进任何"即时切换"，只做一件事：选模式 → 开始。
 */
const MODES = [
  {
    key: 'review',
    icon: Sparkles,
    label: '复习模式',
    hint: '看词回想 → 翻面核对 → 三档评分，写复习排期',
  },
  {
    key: 'spell',
    icon: PenLine,
    label: '拼写模式',
    hint: '看中文释义拼出单词，拼对才进下一个；这一轮只练不写排期',
  },
];

export default function ReviewSetup({ queue, mix, mode, setMode, kind, onStart, onExit, busy }) {
  const n = queue.length;
  const empty = n === 0;

  return (
    <section className="editor">
      <div className="panel review-setup">
        <div className="panel-head">
          <h2><Flame size={16} />{kind === 'today' ? '今日加练' : '今日待复习'}</h2>
          <button className="icon-btn" onClick={onExit} aria-label="关闭"><X size={16} /></button>
        </div>

        {empty ? (
          <p className="muted small">今天还没有学过的词 —— 先去查几个新词，或在收藏夹里收几个。</p>
        ) : (
          <>
            <p className="muted small">
              这一批 <b>{n}</b> 个词
              {mix ? `（本子 ${mix.book} · 收藏 ${mix.fav}）` : ''}
              {kind === 'today' ? ' · 今天的复习已完成，这里是加练（不改变排期）' : ''}
            </p>

            <div className="mode-picker">
              {MODES.map((m) => {
                const Icon = m.icon;
                return (
                  <button key={m.key} className={'mode-card' + (mode === m.key ? ' active' : '')}
                    onClick={() => setMode(m.key)}>
                    <strong><Icon size={14} />{m.label}</strong>
                    <span className="muted small">{m.hint}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="ghost-btn" onClick={onExit}>回到查词</button>
          <button className="primary-btn" onClick={() => onStart(mode)} disabled={empty || busy}>
            <Sparkles size={15} />
            开始（{n} 个词 · {MODES.find((m) => m.key === mode)?.label}）
          </button>
        </div>
      </div>
    </section>
  );
}
