import React, { useState } from 'react';
import { Check, Plus, Star, Volume2 } from 'lucide-react';
import { KIND_LABEL } from '../wordbook.js';
import { speak } from '../speak.js';

/**
 * 词条卡片：把 AI 讲解按"能直接用"的顺序排出来。
 *
 * 排序有讲究：**先给结论（释义/词性/色彩），再给用法（场景/搭配），最后才是对比与例句**。
 * 学习者是先想知道"这词什么意思、能不能用"，再关心"和近义词差在哪"。
 */
export default function EntryCard({ entry, books, existing, onSave, onCreateBook }) {
  const [bookId, setBookId] = useState(existing?.id || books[0]?.id || '');
  const saved = Boolean(existing);
  const m = entry.mnemonic || {};

  return (
    <article className="sheet entry-card">
      <header className="sheet-title">
        <span className="eyebrow">{KIND_LABEL[entry.kind] || '单词'}{entry.level ? ' · ' + entry.level : ''}</span>
        <h1>
          {entry.head}
          {entry.phonetic ? <span className="phonetic">{entry.phonetic}</span> : null}
          <button className="icon-btn" title="朗读" aria-label="朗读" onClick={() => speak(entry.head)}><Volume2 size={16} /></button>
        </h1>
        <div className="chips chips-meta">
          {entry.pos ? <span className="chip">{entry.pos}</span> : null}
          {entry.register ? <span className="chip">{entry.register}</span> : null}
          {entry.tone ? <span className="chip">{entry.tone}</span> : null}
          {entry.strength ? <span className="chip">强度 {entry.strength}</span> : null}
        </div>
        {entry.brief ? <p className="entry-brief">{entry.brief}</p> : null}
      </header>

      {(entry.meanings || []).length ? (
        <section className="sheet-section">
          <div className="section-heading"><span className="label-dot" /><h2>释义</h2></div>
          {entry.meanings.map((x, i) => (
            <div key={i} className="meaning-row">
              {x.pos ? <span className="fav-kind">{x.pos}</span> : null}
              <div>
                <strong>{x.cn}</strong>
                {x.en ? <div className="muted small">{x.en}</div> : null}
                {x.note ? <div className="muted small">{x.note}</div> : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {(m.parts || m.image || m.hook || m.family) ? (
        <section className="sheet-section vocab-morph">
          {m.parts ? <div className="morph-line"><b>词根词缀</b>：{m.parts}</div> : null}
          {m.image ? <div className="morph-line"><b>助记画面</b>：<span className="morph-image">{m.image}</span></div> : null}
          {m.hook ? <div className="morph-line"><b>记忆钩子</b>：{m.hook}</div> : null}
          {m.family ? <div className="morph-line"><b>同根词</b>：{m.family}</div> : null}
        </section>
      ) : null}

      {((entry.scenes || []).length || entry.avoid) ? (
        <section className="sheet-section">
          <div className="section-heading"><span className="label-dot" /><h2>使用场景</h2></div>
          {(entry.scenes || []).map((s, i) => <div key={i} className="scene-line"><Check size={13} />{s}</div>)}
          {entry.avoid ? <div className="scene-line warn">✕ {entry.avoid}</div> : null}
        </section>
      ) : null}

      {(entry.synonyms || []).length ? (
        <section className="sheet-section">
          <div className="section-heading"><span className="label-dot" /><h2>近义词对比</h2><span className="muted small">重点是"什么时候用哪个"</span></div>
          {entry.synonyms.map((s, i) => (
            <div key={i} className="syn-row">
              <div className="syn-head">
                <strong className="syn-word">{s.word}</strong>
                {s.phonetic ? <span className="muted small">{s.phonetic}</span> : null}
                <button className="icon-btn" title="朗读" aria-label="朗读" onClick={() => speak(s.word)}><Volume2 size={13} /></button>
                {s.register ? <span className="syn-meta">{s.register}</span> : null}
                {s.tone ? <span className="syn-meta">{s.tone}</span> : null}
                {s.strength ? <span className="syn-meta">{s.strength}</span> : null}
              </div>
              {s.cn ? <div className="syn-meaning">{s.cn}</div> : null}
              {s.diff ? <div className="syn-usage"><b>差别</b>：{s.diff}</div> : null}
              {s.usage ? <div className="syn-usage">{s.usage}</div> : null}
              {s.example ? (
                <div className="example-line">
                  <em>{s.example}</em>
                  <button className="icon-btn" title="朗读例句" aria-label="朗读例句" onClick={() => speak(s.example)}><Volume2 size={12} /></button>
                  {s.exampleCn ? <span>{s.exampleCn}</span> : null}
                </div>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      {(entry.collocations || []).length ? (
        <section className="sheet-section">
          <div className="section-heading"><span className="label-dot" /><h2>常用搭配</h2></div>
          <div className="chips">{entry.collocations.map((c, i) => <span key={i} className="chip">{c}</span>)}</div>
        </section>
      ) : null}

      {(entry.examples || []).length ? (
        <section className="sheet-section">
          <div className="section-heading"><span className="label-dot" /><h2>例句</h2></div>
          {entry.examples.map((x, i) => (
            <div key={i} className="summary-card">
              <div className="example-line">
                <em>{x.en}</em>
                <button className="icon-btn" title="朗读例句" aria-label="朗读例句" onClick={() => speak(x.en)}><Volume2 size={12} /></button>
                <span>{x.cn}</span>
              </div>
              {x.note ? <div className="muted small">{x.note}</div> : null}
            </div>
          ))}
        </section>
      ) : null}

      {entry.confusions ? (
        <section className="sheet-section">
          <div className="section-heading"><span className="label-dot" /><h2>易混点</h2></div>
          <p>{entry.confusions}</p>
        </section>
      ) : null}
      {entry.usageNotes ? (
        <section className="sheet-section">
          <div className="section-heading"><span className="label-dot" /><h2>用法要点</h2></div>
          <p>{entry.usageNotes}</p>
        </section>
      ) : null}
      {entry.examTips ? (
        <section className="sheet-section">
          <div className="section-heading"><span className="label-dot" /><h2>考试怎么考</h2></div>
          <p>{entry.examTips}</p>
        </section>
      ) : null}

      <div className="save-bar">
        {saved ? <span className="saved-flag"><Star size={14} fill="currentColor" />已在「{existing.name}」里</span> : null}
        {books.length ? (
          <select className="ocr-mode" value={bookId} onChange={(e) => setBookId(e.target.value)} title="选一个单词本">
            {books.map((b) => <option key={b.id} value={b.id}>{b.name}（{b.entries.length}）</option>)}
          </select>
        ) : null}
        <button className="primary-btn" onClick={() => (books.length ? onSave(bookId) : onCreateBook())}>
          <Plus size={16} />{books.length ? (saved ? '更新到单词本' : '加入单词本') : '新建单词本并加入'}
        </button>
      </div>
    </article>
  );
}
