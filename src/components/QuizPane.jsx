import React from 'react';
import { Check, ClipboardCopy, Printer, RotateCcw, X, AlertCircle, Eraser, CheckCheck } from 'lucide-react';

const TYPE_LABEL = { choice: '选择', fill: '填空', translate: '翻译', correct: '改错', usage: '用法判断' };

/**
 * 自测题试卷。
 *
 * 三条刻意的设计（都是从"自己用"的角度定的）：
 *  · **可以直接作答**：选择题点选项、填空/改错/翻译输入文本；
 *  · **默认不显示答案**，点「显示答案」才展开 —— 否则一眼扫到答案，题就白做了；
 *  · 答完点「批改」：客观题（选择/填空）**本地秒判**，主观题（翻译/改错）交给模型逐题点评。
 *    答案与解析仍然统一放在最后，打印出来做题时不会提前看到。
 */
export default function QuizPane({
  quiz, showAnswers, busy, onToggleAnswers, onCopy, onRegenerate, onExit, onExportPdf,
  answers = {}, onAnswer, graded, grading, onGrade, onReset,
}) {
  const questions = (quiz && quiz.questions) || [];
  const resultOf = (i) => (graded ? (graded.results || []).find((r) => r.index === i) : null);
  const answeredCount = questions.filter((q, i) => {
    const a = answers[i] || {};
    return (a.choice !== undefined && a.choice !== null && a.choice >= 0) || String(a.text || '').trim();
  }).length;
  const correct = (graded && graded.objectiveRight) || 0;
  const total = (graded && graded.objectiveTotal) || 0;

  return (
    <section className="editor">
      <div className="result-toolbar">
        <button className="ghost-btn" onClick={onExit}><RotateCcw size={15} />返回</button>
        <button className="ghost-btn" onClick={onCopy} disabled={!questions.length}><ClipboardCopy size={15} />复制题目</button>
        {/* 导出走 App 的统一出口（隐藏的打印页 + 浏览器"另存为 PDF"）——
            以前这里直接 window.print()，打印的是当前页面；加上"导出词条/整本"之后再这么干，
            三处各写各的必然漏样式。现在都经过 printJob，一套 @media print 规则管住。 */}
        <button className="ghost-btn" onClick={() => (onExportPdf ? onExportPdf() : window.print())} disabled={!questions.length}><Printer size={15} />导出 PDF</button>
        <button className="ghost-btn" onClick={onRegenerate} disabled={busy}>{busy ? '出题中…' : '换一套'}</button>
        {answeredCount ? (
          <button className="ghost-btn" onClick={onReset} disabled={grading}><Eraser size={15} />清空作答</button>
        ) : null}
        <button className="ghost-btn" onClick={onToggleAnswers} disabled={!questions.length}>
          {showAnswers ? '隐藏答案' : '显示答案'}
        </button>
        <button className="primary-btn" onClick={() => onGrade && onGrade()} disabled={!questions.length || grading || !answeredCount}>
          {grading ? '批改中…' : <><CheckCheck size={16} />批改（{answeredCount}/{questions.length}）</>}
        </button>
      </div>

      <article className="sheet">
        <header className="sheet-title">
          <span className="eyebrow">SELF QUIZ · 单词本自测</span>
          <h1>{(quiz && quiz.title) || '自测题'}</h1>
          <p className="muted small">
            {questions.length} 题 · 选择点选项、其余直接输入，做完点右上「批改」
          </p>
          {graded ? (
            <p className={'quiz-score' + (total && correct === total ? ' full' : '')}>
              客观题 <b>{correct}</b> / {total} 正确
              {graded.comment ? <span className="muted small"> · {graded.comment}</span> : null}
            </p>
          ) : null}
          {grading ? <p className="muted small">{grading}</p> : null}
        </header>

        <ol className="quiz-list">
          {questions.map((q, i) => {
            const a = answers[i] || {};
            const r = resultOf(i);
            const hasOptions = Array.isArray(q.options) && q.options.length > 0;
            return (
              <li key={i} className={'quiz-item' + (r ? ' graded-' + r.status : '')}>
                <div className="quiz-head">
                  <span className="quiz-no">{i + 1}</span>
                  <span className="fav-kind">{TYPE_LABEL[q.type] || q.type}</span>
                  {r && r.status === 'right' ? <span className="quiz-badge ok"><Check size={13} />正确</span> : null}
                  {r && r.status === 'wrong' ? <span className="quiz-badge bad"><X size={13} />错误</span> : null}
                  {r && r.status === 'blank' ? <span className="quiz-badge muted-badge">未作答</span> : null}
                  {r && r.status === 'pending' ? <span className="quiz-badge muted-badge">等批改</span> : null}
                  {r && r.status === 'ungraded' ? <span className="quiz-badge muted-badge"><AlertCircle size={12} />没批到</span> : null}
                  {r && typeof r.score === 'number' ? <span className="quiz-badge score">{r.score} / 5</span> : null}
                </div>
                <div className="quiz-question">{q.stem}</div>

                {hasOptions ? (
                  <div className="quiz-options" role="group" aria-label={'第 ' + (i + 1) + ' 题选项'}>
                    {q.options.map((o, j) => {
                      const picked = a.choice === j;
                      const isAnswer = r && r.status !== 'blank' && normalize(q.answer) === normalize(o);
                      return (
                        <button key={j} type="button"
                          className={'quiz-option clickable' + (picked ? ' picked' : '') + (r && isAnswer ? ' answer' : '')}
                          aria-pressed={picked}
                          onClick={() => onAnswer && onAnswer(i, { choice: picked ? null : j })}>
                          <span className="quiz-opt-key">{'ABCDEFGH'[j]}</span>{o}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <textarea
                    className={'quiz-input' + (String(q.type) === 'translate' || String(q.type) === 'correct' ? ' long' : '')}
                    rows={String(q.type) === 'translate' || String(q.type) === 'correct' ? 3 : 1}
                    placeholder={String(q.type) === 'correct' ? '写出改正后的句子…' : '写出你的答案…'}
                    value={a.text || ''}
                    onChange={(e) => onAnswer && onAnswer(i, { text: e.target.value })}
                    aria-label={'第 ' + (i + 1) + ' 题作答'} />
                )}

                {/* 批改后立刻给反馈：错在哪、正确答案是什么、模型怎么点评 */}
                {r ? (
                  <div className="quiz-feedback">
                    {r.status !== 'right' && r.expected ? (
                      <p className="muted small">参考答案：<b>{r.expected}</b></p>
                    ) : null}
                    {r.comment ? <p className="muted small">{r.comment}</p> : null}
                    {r.better ? <p className="muted small">更地道的写法：<em>{r.better}</em></p> : null}
                    {q.explanation ? <p className="muted small">{q.explanation}</p> : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>

        {showAnswers ? (
          <section className="sheet-section quiz-answers">
            <div className="section-heading"><span className="label-dot" /><h2>答案与解析</h2></div>
            <ol className="quiz-list">
              {questions.map((q, i) => (
                <li key={i} className="quiz-item">
                  <div className="quiz-head"><span className="quiz-no">{i + 1}</span><span className="fav-level error">{q.answer}</span></div>
                  <div className="muted small">{q.explanation}</div>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </article>
    </section>
  );
}

/** 选项与答案的比较（只为高亮"哪个是正确答案"，宽松匹配即可） */
function normalize(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/^[a-h][.、)\s]+/, '');
}
