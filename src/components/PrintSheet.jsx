import React from 'react';
import EntryCard from './EntryCard.jsx';
import QuizPane from './QuizPane.jsx';

/**
 * 打印 / 导出 PDF 的专用视图。
 *
 * 为什么走"隐藏的打印页 + 浏览器打印"而不是自己生成 PDF 文件：
 *  · 零依赖：不引入 jsPDF/puppeteer 这类几百 KB 到几十 MB 的东西，纯前端项目不该为此变重；
 *  · 复用同一套卡片渲染：PDF 里的内容和屏幕上是**同一个组件**，
 *    以后卡片加了新板块（比如「词典核对」），导出的 PDF 自动跟上 ——
 *    另写一套 HTML 拼装是必然要漂移的；
 *  · 用户拿到的就是浏览器原生的"另存为 PDF"，中文字体、分页、缩放都由它处理，比自己排版更稳。
 *
 * 工作方式：屏幕上看不见（`.print-sheet { display: none }`），
 * 点导出时给 body 加 `printing`，打印那一刻只显示这一块（见 styles.css 的 @media print）。
 */
export default function PrintSheet({ job }) {
  if (!job) return null;
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  if (job.kind === 'quiz') {
    return (
      <div className="print-sheet">
        {/* 答案与解析统一印在最后 —— 屏幕上藏着的，导出 PDF 时要带上（做题的人可以撕下来对答案） */}
        <QuizPane quiz={job.quiz} showAnswers busy={false}
          onToggleAnswers={() => {}} onCopy={() => {}} onRegenerate={() => {}} onExit={() => {}} />
      </div>
    );
  }

  if (job.kind === 'book') {
    const book = job.book;
    const entries = (book && book.entries) || [];
    return (
      <div className="print-sheet">
        <header className="print-cover">
          <div className="print-cover-eyebrow">单词本 · VOCABULARY BOOK</div>
          <h1>{book.name}</h1>
          <p className="muted">
            共 {entries.length} 个词条 · 导出于 {stamp}
          </p>
        </header>
        {entries.map((e) => (
          <EntryCard key={e.id} entry={e} variant="print" />
        ))}
        {entries.length === 0 ? <p className="muted">这个本子还是空的。</p> : null}
      </div>
    );
  }

  // 单个词条
  return (
    <div className="print-sheet">
      <EntryCard entry={job.entry} variant="print" />
    </div>
  );
}
