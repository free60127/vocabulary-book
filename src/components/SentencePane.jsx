import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Lightbulb, LoaderCircle, RefreshCw, Send, Sparkles, Volume2, X } from 'lucide-react';
import { speak } from '../speak.js';

/**
 * 造句练习。
 *
 * 为什么值得单独做一块：复习（认词）和自测题（选/填）都是**识别型**练习 ——
 * 认得出不等于用得出。造句是产出型：要同时决定"用哪个词性、配什么介词、什么语域"，
 * 而 AI 批改能把"用词 / 语法 / 语境"三条分开讲清楚，这是纸质练习册给不了的。
 *
 * 两种模式（用户要的）：
 *  · **自由模式**：自己造一句，只要用上目标词；
 *  · **翻译模式**：系统给一句中文（它的自然英译一定会用到目标词），学生译出来。
 *
 * 一条纪律：批改**只给最小修改**，不重写学生的整句 —— 否则用户学到的是"AI 的句子"，
 * 而不是"我错在哪"。
 */
const MODES = [
  { key: 'free', label: '自由造句', hint: '自己写一句话，用上这个词就行' },
  { key: 'translate', label: '翻译造句', hint: '把给的中文译成英文，必须用上这个词' },
];

const KIND_LABEL = { word: '用词', grammar: '语法', context: '语境' };

/** 分数配色：80+ 好、60+ 一般、以下要再看一眼 */
function scoreTone(score) {
  if (score >= 85) return 'great';
  if (score >= 70) return 'good';
  if (score >= 50) return 'fair';
  return 'poor';
}

export default function SentencePane({
  items, index, mode, setMode, busy, error,
  onStart, onGrade, onNext, onExit, grade, grading, onRetryGrade,
}) {
  const [text, setText] = useState('');
  const boxRef = useRef(null);
  const cur = items[index];

  useEffect(() => { setText(''); }, [index, mode]);
  useEffect(() => {
    if (grading && boxRef.current) boxRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [grading]);

  const done = !cur;
  const canGrade = Boolean(text.trim()) && !grading;

  /* ---------- 还没开始：选模式、看作息 ---------- */
  if (!items.length) {
    return (
      <section className="editor">
        <div className="panel sentence-setup">
          <div className="panel-head"><h2>造句练习</h2></div>
          <p className="muted small">
            从**单词本 + 收藏夹**里抽词，用 AI 批改你的句子：用词是否准确、语法对不对、语境贴不贴。
            每个词都只给最小修改建议，不会替你重写整句。
          </p>
          <div className="mode-picker">
            {MODES.map((m) => (
              <button key={m.key} className={'mode-card' + (mode === m.key ? ' active' : '')} onClick={() => setMode(m.key)}>
                <strong>{m.label}</strong>
                <span className="muted small">{m.hint}</span>
              </button>
            ))}
          </div>
          {error ? <div className="error-banner" role="alert"><X size={15} /><span className="error-text">{error}</span></div> : null}
          <div className="modal-actions">
            <button className="ghost-btn" onClick={onExit}>回到查词</button>
            <button className="primary-btn" onClick={() => onStart(mode)} disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              {busy ? '正在出题…' : `开始（${mode === 'translate' ? '翻译造句' : '自由造句'}）`}
            </button>
          </div>
        </div>
      </section>
    );
  }

  /* ---------- 一轮结束：小结 ---------- */
  if (done) {
    return (
      <section className="editor">
        <div className="panel sentence-setup">
          <div className="panel-head"><h2>这一轮造句完成</h2></div>
          <p className="muted small">共练了 {items.length} 个词。错得多的词会自动进错词本，下次复习优先出现。</p>
          <div className="modal-actions">
            <button className="ghost-btn" onClick={onExit}>回到查词</button>
            <button className="primary-btn" onClick={() => onStart(mode)}><RefreshCw size={15} />再来一轮</button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="editor">
      <div className="panel sentence-pane">
        <div className="panel-head">
          <h2>造句 {index + 1} / {items.length}
            <span className="muted small"> · {mode === 'translate' ? '翻译造句' : '自由造句'}</span>
          </h2>
          <button className="ghost-btn sm" onClick={onExit}>退出练习</button>
        </div>

        {/* 题目 */}
        <div className="sentence-task">
          <div className="sentence-word">
            <strong>{cur.head}</strong>
            {cur.phonetic ? <span className="phonetic">{cur.phonetic}</span> : null}
            <button className="icon-btn" title="朗读" aria-label="朗读" onClick={() => speak(cur.head)}><Volume2 size={16} /></button>
          </div>
          {cur.meaning ? <p className="muted small sentence-meaning">{cur.meaning}</p> : null}
          {mode === 'translate' && cur.cn ? (
            <div className="sentence-cn">
              <span className="sentence-cn-label">译成英文（用上 {cur.head}）</span>
              <p>{cur.cn}</p>
              {cur.tip ? <p className="muted small">提示：{cur.tip}</p> : null}
            </div>
          ) : (
            <p className="muted small">用 <b>{cur.head}</b> 写一句你自己的话（能体现它的用法最好）。</p>
          )}
        </div>

        {/* 作答 */}
        <textarea
          ref={boxRef}
          className="sentence-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={mode === 'translate' ? '把你的英文译文写在这里…' : `用 ${cur.head} 造一句英文…`}
          rows={3}
          spellCheck={false}
          disabled={grading}
        />
        <div className="sentence-actions">
          <span className="muted small">{text.trim() ? text.trim().split(/\s+/).length + ' 个词' : ''}</span>
          <button className="ghost-btn sm" onClick={onNext} disabled={grading}>跳过这个词 <ArrowRight size={13} /></button>
          <button className="primary-btn" onClick={() => onGrade(text)} disabled={!canGrade}>
            {grading ? <LoaderCircle className="spin" size={16} /> : <Send size={15} />}
            {grading ? '批改中…' : '提交批改'}
          </button>
        </div>

        {/* 批改结果 */}
        {grade ? (
          <div className={'sentence-grade tone-' + scoreTone(grade.score)}>
            <div className="grade-head">
              <div className="grade-score">
                <b>{grade.score}</b><span>分</span>
              </div>
              <div className="grade-verdict">
                {!grade.usesTarget ? <span className="grade-flag">句子里没有用上「{cur.head}」</span> : null}
                <p>{grade.verdict || '（没有结论）'}</p>
              </div>
            </div>

            {grade.problems && grade.problems.length ? (
              <ul className="grade-problems">
                {grade.problems.map((p, i) => (
                  <li key={i} className={'grade-problem kind-' + p.kind}>
                    <span className="problem-kind">{KIND_LABEL[p.kind] || '问题'}</span>
                    <span className="problem-issue">{p.issue}</span>
                    {p.fix ? <span className="problem-fix">{p.fix}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="grade-clean"><Check size={14} />没有挑出问题 —— 这句可以。</p>
            )}

            {grade.corrected && grade.corrected !== text.trim() ? (
              <div className="grade-line"><span className="grade-label">改对后</span><p>{grade.corrected}</p>
                <button className="icon-btn" title="朗读" aria-label="朗读" onClick={() => speak(grade.corrected)}><Volume2 size={13} /></button>
              </div>
            ) : null}
            {grade.suggestion ? (
              <div className="grade-line"><span className="grade-label">更地道的说法</span><p>{grade.suggestion}</p>
                <button className="icon-btn" title="朗读" aria-label="朗读" onClick={() => speak(grade.suggestion)}><Volume2 size={13} /></button>
              </div>
            ) : null}
            {grade.reference ? (
              <div className="grade-line"><span className="grade-label">参考译文</span><p>{grade.reference}</p></div>
            ) : null}

            <div className="sentence-actions">
              <button className="ghost-btn sm" onClick={onRetryGrade} disabled={grading}><RefreshCw size={13} />重新批改</button>
              <button className="primary-btn" onClick={onNext}>
                {index + 1 >= items.length ? '完成这一轮' : '下一个词'} <ArrowRight size={15} />
              </button>
            </div>
          </div>
        ) : null}

        {error ? <div className="error-banner" role="alert"><X size={15} /><span className="error-text">{error}</span></div> : null}
        {busy ? <p className="muted small"><Lightbulb size={13} /> 正在为你准备题目…</p> : null}
      </div>
    </section>
  );
}
