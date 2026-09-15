import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, FileDown, GitMerge, Pencil, Sparkles, Trash2, Volume2 } from 'lucide-react';
import { KIND_LABEL } from '../wordbook.js';
import { dueLabel, scheduleOf } from '../review.js';
import { speak } from '../speak.js';

/** 一次渲染多少行；滚到底再放下一批 */
const PAGE = 60;

/**
 * 单词本视图：工具栏（搜索 / 筛选 / 排序 / 出题 / 导出）+ 词条列表。
 *
 * 列表为什么要分批渲染：300 个词条时整页 6000+ 个 DOM 节点、打开本子要 145ms，
 * 1000 词条会明显卡（都是同步渲染的）。这里先渲染 60 行，滚到底再放下一批，
 * 配合 CSS 的 content-visibility 把屏幕外的排版也省掉。
 * 不引入虚拟列表库：这个规模下"分批 + 浏览器自己跳过屏外内容"已经够，
 * 而虚拟列表会带来滚动位置跳动、Ctrl+F 搜不到内容这些新问题。
 */
export default function BookPane({
  book, entries, total, filters, sorts, query, setQuery, kindFilter, setKindFilter,
  sortMode, setSortMode, schedule, onOpenEntry, onDeleteEntry, onQuizForBook, onExportPdf,
  onRenameBook, onMergeBook, canMerge,
}) {
  const [shown, setShown] = useState(PAGE);
  const sentinelRef = useRef(null);

  // 换本子 / 换筛选条件时重置批次，否则从 300 条的筛选切到 3 条会"显示 300 条中的 3 条"
  useEffect(() => { setShown(PAGE); }, [book.id, query, kindFilter, sortMode]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || shown >= entries.length) return undefined;
    if (typeof IntersectionObserver === 'undefined') { setShown(entries.length); return undefined; }
    const io = new IntersectionObserver((list) => {
      if (list.some((x) => x.isIntersecting)) setShown((n) => Math.min(n + PAGE, entries.length));
    }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [shown, entries.length]);

  const visible = entries.slice(0, shown);

  return (
    <section className="editor">
      <div className="panel">
        <div className="panel-head">
          <h2>{book.name}</h2>
          <span className="muted small">
            {total} 个词条
            {entries.length !== total ? ` · 筛出 ${entries.length}` : ''}
          </span>
          {/* 改名 / 合并放在本子自己的页面：这里空间足、语义也对（正在看这个本子时才改它） */}
          <div className="book-ops">
            <button className="ghost-btn sm" onClick={onRenameBook} title="给这个本子改名"><Pencil size={13} />改名</button>
            {canMerge ? <button className="ghost-btn sm" onClick={onMergeBook} title="把这个本子并进另一个本子"><GitMerge size={13} />合并</button> : null}
          </div>
        </div>
        <div className="book-toolbar">
          <input className="fav-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="在本子里搜词条 / 释义 / 近义词" />
          <select className="ocr-mode" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} title="筛选">
            {filters.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          <select className="ocr-mode" value={sortMode} onChange={(e) => setSortMode(e.target.value)} title="排序">
            {sorts.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <button className="ghost-btn sm" onClick={onQuizForBook} disabled={!total}>
            <Sparkles size={14} />用这个本子出题
          </button>
          {/* 整本导出：**不受上面的筛选/搜索影响**，永远是本子的全部词条 ——
              "导出词汇本"就该是整本，导出到一半发现缺词才是坑 */}
          <button className="ghost-btn sm" onClick={onExportPdf} disabled={!total}
            title="把本子里全部词条导出成 PDF（不受筛选影响）">
            <FileDown size={14} />导出本子 PDF
          </button>
        </div>
        {total === 0 ? <div className="muted">这个本子还是空的：查一个词就能存进来</div> : null}
        {total > 0 && entries.length === 0 ? <div className="muted">没有符合条件的词条</div> : null}
        <div className="entry-list">
          {visible.map((e) => {
            const s = scheduleOf(schedule, e.id, e.createdAt);
            return (
              <div key={e.id} className="entry-row">
                <button className="entry-open" onClick={() => onOpenEntry(e)}>
                  <strong>{e.head}</strong>
                  {e.phonetic ? <span className="muted small">{e.phonetic}</span> : null}
                  <span className="muted small">{e.brief}</span>
                  {/* 到期时间用**人话**：原来只写"复习 3 次"，用户不知道下一次是什么时候 */}
                  <span className="due-tag" title={'下次复习：' + dueLabel(s)}>
                    {s.reps ? `复习 ${s.reps} 次 · ${dueLabel(s)}` : '新词'}
                    {KIND_LABEL[e.kind] ? ` · ${KIND_LABEL[e.kind]}` : ''}
                  </span>
                  <ChevronRight size={14} />
                </button>
                <button className="icon-btn" title="朗读" aria-label="朗读" onClick={() => speak(e.head)}><Volume2 size={14} /></button>
                <button className="icon-btn" onClick={() => onDeleteEntry(e)} title="删除" aria-label="删除词条"><Trash2 size={14} /></button>
              </div>
            );
          })}
        </div>
        {shown < entries.length ? (
          <div className="list-more" ref={sentinelRef}>
            <span className="muted small">已显示 {shown} / {entries.length}</span>
            <button className="ghost-btn sm" onClick={() => setShown((n) => n + PAGE)}>再看 {Math.min(PAGE, entries.length - shown)} 条</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
