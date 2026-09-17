import React from 'react';
import { Flame, LoaderCircle, Search, Sparkles, X } from 'lucide-react';
import EntryCard from './EntryCard.jsx';
import ZhCandidates from './ZhCandidates.jsx';

/**
 * 查词视图：搜索栏 → 引导 → 词条卡片。
 *
 * 三种状态在界面上要分得很清楚：
 *   ① 什么都没查（`.start-guide` 说明"能查到什么"，而不是一片空白）；
 *   ② 正在查（按钮转圈 + 一行进度，用户知道还要等）；
 *   ③ 出错（红条 + 可关闭，文案是给人看的）。
 */
export default function SearchPane({
  query, setQuery, onLookup, level, setLevel, levels,
  busy, progress, error, onDismissError,
  entry, existing, books, onExportPdf, onToggleFavorite, isFavorite,
  onSave, onCreateBook, onLookupWord, searchRef,
  onAsk, askBusy, askError, followups, onClearFollowups,
  zhTerm, zhItems, onPickZh, onDismissZh,
}) {
  return (
    <section className="editor">
      <div className="search-bar">
        <Search size={18} />
        {/* 输入框 + 一键清空：手机上挨个 delete 太难受（用户反馈，参照有道词典） */}
        <span className="search-input-wrap">
          <input className="search-input" ref={searchRef} value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onLookup(query);
              // Esc 也清空：键盘用户不用去够那个 ×
              if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); }
            }}
            placeholder="输入单词、短语或句型，回车生成讲解（如 object / pull off / no sooner ... than）· 中文也行（会先让你选对应的英文词）" />
          {query ? (
            <button className="icon-btn input-clear" type="button" aria-label="清空输入" title="清空"
              onClick={() => { setQuery(''); if (searchRef.current) searchRef.current.focus(); }}>
              <X size={14} />
            </button>
          ) : null}
        </span>
        <select className="ocr-mode" value={level} onChange={(e) => setLevel(e.target.value)} title="讲解深度">
          {levels.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <button className="primary-btn" onClick={() => onLookup(query)} disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{busy ? '讲解中…' : '查一下'}
        </button>
      </div>

      {error ? (
        <div className="error-banner" role="alert">
          <Flame size={15} />
          <span className="error-text">{error}</span>
          <button className="icon-btn err-close" onClick={onDismissError} aria-label="关闭"><X size={15} /></button>
        </div>
      ) : null}
      {progress ? <div className="muted small" role="status">{progress}</div> : null}

      {/* 中文查词：候选词**就地**列在搜索栏下面 —— 不跳到另一个视图，
          这样输入框还在，改个词重搜不用先返回（原来的做法要按「回到查词」才能改） */}
      {zhItems && zhItems.length ? (
        <ZhCandidates term={zhTerm} items={zhItems} onPick={onPickZh} onDismiss={onDismissZh} />
      ) : null}

      {!entry && !busy && !error && !(zhItems && zhItems.length) ? (
        <div className="start-guide" role="note">
          <div className="start-guide-main">
            <span className="start-guide-title">查一个词，得到什么</span>
            <ol className="start-guide-steps">
              <li>意思与词性 · 褒贬色彩 · 情感强度 · 语域</li>
              <li>词根词缀拆解 + 助记画面；适用场景与不该用的场合</li>
              <li>近义词逐个讲清差别（什么时候用哪个）+ 体现差别的例句</li>
              <li>存进单词本 → 按间隔重复安排每日复习；到期了在顶栏「今日待复习」里练</li>
            </ol>
          </div>
        </div>
      ) : null}

      {/* 「已在哪个本子里」按 **id 或词头** 找：同一个词再查一次会拿到新的服务端 id，
          只按 id 找的话卡片会重新显示"加入单词本"，点下去本子里就多一条一样的 */}
      {entry ? (
        <EntryCard entry={entry} books={books} existing={existing}
          onExportPdf={onExportPdf}
          onToggleFavorite={onToggleFavorite} isFavorite={isFavorite}
          onSave={onSave} onCreateBook={onCreateBook} onLookupWord={onLookupWord}
          onAsk={onAsk} askBusy={askBusy} askError={askError}
          followups={followups} onClearFollowups={onClearFollowups} />
      ) : null}
    </section>
  );
}
