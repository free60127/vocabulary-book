import React from 'react';
import { ClipboardCopy, Printer, RotateCcw } from 'lucide-react';

const TYPE_LABEL = { choice: '选择', fill: '填空', translate: '翻译', correct: '改错', usage: '用法判断' };

/**
 * 自测题试卷。
 *
 * 两条刻意的设计（都是从"自己用"的角度定的）：
 *  · **默认不显示答案**，点「显示答案」才展开 —— 否则一眼扫到答案，题就白做了；
 *  · 答案与解析**统一放在最后**，不是跟在每题下面 —— 打印出来做题时不会提前看到。
 */
export default function QuizPane({ quiz, showAnswers, busy, onToggleAnswers, onCopy, onRegenerate, onExit }) {
  const questions = (quiz && quiz.questions) || [];
  return (
    <section className="editor">
      <div className="result-toolbar">
        <button className="ghost-btn" onClick={onExit}><RotateCcw size={15} />返回</button>
        <button className="ghost-btn" onClick={onCopy} disabled={!questions.length}><ClipboardCopy size={15} />复制题目</button>
        <button className="ghost-btn" onClick={() => window.print()} disabled={!questions.length}><Printer size={15} />导出 PDF</button>
        <button className="ghost-btn" onClick={onRegenerate} disabled={busy}>{busy ? '出题中…' : '换一套'}</button>
        <button className="primary-btn" onClick={onToggleAnswers} disabled={!questions.length}>
          {showAnswers ? '隐藏答案' : '显示答案'}
        </button>
      </div>

      <article className="sheet">
        <header className="sheet-title">
          <span className="eyebrow">SELF QUIZ · 单词本自测</span>
          <h1>{(quiz && quiz.title) || '自测题'}</h1>
          <p className="muted small">{questions.length} 题 · 先做完再看答案（答案与解析在最后）</p>
        </header>

        <ol className="quiz-list">
          {questions.map((q, i) => (
            <li key={i} className="quiz-item">
              <div className="quiz-head">
                <span className="quiz-no">{i + 1}</span>
                <span className="fav-kind">{TYPE_LABEL[q.type] || q.type}</span>
              </div>
              <div className="quiz-question">{q.stem}</div>
              {q.options.length ? (
                <div className="quiz-options">
                  {q.options.map((o, j) => (
                    <div key={j} className="quiz-option">
                      <span className="quiz-opt-key">{'ABCDEFGH'[j]}</span>{o}
                    </div>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
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
