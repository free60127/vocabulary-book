import React, { useState } from 'react';
import { ArrowRight, Check, FileDown, LoaderCircle, MessageCircleQuestion, Plus, ShieldCheck, Star, Volume2 } from 'lucide-react';
import { KIND_LABEL } from '../wordbook.js';
import { speak } from '../speak.js';

/**
 * 词典核对条：一行字说明"这条讲解有多少是查过词典的"。
 *
 * 为什么要摆在最上面而不是塞进末尾的小字里：用户查词最大的顾虑是"AI 会不会编"。
 * 这个结论必须**第一眼看到**，否则他会一直怀疑音标和"四六级常考"这类话。
 */
function DictBadge({ dict, conflicts }) {
  if (!dict) return null;
  const fixed = conflicts?.phonetics?.length;
  const missing = conflicts?.missingPos || [];
  const parts = [];
  if (fixed) parts.push('音标已按词典校正');
  else if (dict.phonetics?.uk || dict.phonetics?.us) parts.push('音标一致');
  if (missing.length) parts.push('词典还标了 ' + missing.join(' / '));
  if (dict.examTypes?.length) parts.push('大纲：' + dict.examTypes.slice(0, 4).join('/'));
  return (
    <div className={'dict-badge' + (fixed || missing ? ' warn' : '')} role="note">
      <ShieldCheck size={14} />
      <span>已用有道词典核对</span>
      {parts.length ? <span className="muted small">{parts.join(' · ')}</span> : null}
    </div>
  );
}

/** 追问的快捷入口：用户九成会问的就这几句，点一下比打字快 */
const ASK_PRESETS = ['和近义词的区别？', '给我 3 个例句', '常见搭配有哪些', '考试容易怎么考'];

/**
 * 词典原文：把"权威事实"原文列出来，让用户能自己复核 AI 的讲解。
 *
 * 这里刻意**不重新排版成好听的样式** —— 它就是词典怎么说，一字不改。
 * 卡片其余部分都是 AI 的加工，这一块是原始事实，两者的区别要看得出来。
 */
function DictSection({ dict }) {
  if (!dict) return null;
  const perPos = (dict.perPosPhonetics || []);
  const uk = [...new Set(perPos.filter((x) => x.lang === 'uk').map((x) => `${x.phone}（${x.pos}.）`))];
  const us = [...new Set(perPos.filter((x) => x.lang === 'us').map((x) => `${x.phone}（${x.pos}.）`))];
  return (
    <section className="sheet-section dict-section">
      <div className="section-heading">
        <span className="label-dot" />
        <h2>词典核对</h2>
        <span className="muted small">{dict.source === 'youdao' ? '有道词典' : dict.source}</span>
      </div>
      <dl className="dict-facts">
        {uk.length || dict.phonetics?.uk ? (
          <div><dt>英</dt><dd>{uk.length ? uk.join('，') : dict.phonetics.uk}</dd></div>
        ) : null}
        {us.length || dict.phonetics?.us ? (
          <div><dt>美</dt><dd>{us.length ? us.join('，') : dict.phonetics.us}</dd></div>
        ) : null}
        {(dict.senses || []).map((s, i) => (
          <div key={i}><dt>{s.pos || '—'}</dt><dd>{s.cn}</dd></div>
        ))}
        {dict.forms?.length ? <div><dt>词形</dt><dd>{dict.forms.join('、')}</dd></div> : null}
        {dict.examTypes?.length ? <div><dt>大纲</dt><dd>{dict.examTypes.join('、')}</dd></div> : null}
        {dict.phrases?.length ? (
          <div><dt>搭配</dt><dd>{dict.phrases.slice(0, 8).map((p) => `${p.en}（${p.cn}）`).join('；')}</dd></div>
        ) : null}
      </dl>
    </section>
  );
}

/**
 * 词条卡片：把 AI 讲解按"能直接用"的顺序排出来。
 *
 * 排序有讲究：**先给结论（释义/词性/色彩），再给用法（场景/搭配），最后才是对比与例句**。
 * 学习者是先想知道"这词什么意思、能不能用"，再关心"和近义词差在哪"。
 */
export default function EntryCard({ entry, books = [], existing, onSave, onCreateBook, onExportPdf, variant = 'screen',
  streaming = false, streamProgress = '', streamLabels = [],
  onToggleFavorite, isFavorite, onLookupWord, onAsk, askBusy, askError, followups, onClearFollowups }) {
  const [bookId, setBookId] = useState(existing?.id || books[0]?.id || '');
  const [askText, setAskText] = useState('');
  const saved = Boolean(existing);
  // 打印/导出 PDF 时去掉一切交互件：朗读按钮、保存栏在纸上毫无意义，只会占地方。
  // 用 variant 显式区分，而不是靠 @media print 去 display:none —— 那样很容易漏（漏了就是
  // PDF 里印出一排按钮），而且组件单测也测不到。
  const forPrint = variant === 'print';
  const m = entry.mnemonic || {};
  const dict = entry.dict || null;
  const conflicts = entry.dictConflicts || null;
  // AI 没给搭配时，用词典的兜底 —— 宁可少而准，也不要空着
  const collocations = (entry.collocations || []).length
    ? entry.collocations
    : (dict?.phrases || []).map((p) => p.en);

  return (
    <article className="sheet entry-card">
      <header className="sheet-title">
        <span className="eyebrow">{KIND_LABEL[entry.kind] || '单词'}{entry.level ? ' · ' + entry.level : ''}</span>
        <h1>
          {entry.head}
          {entry.phonetic ? <span className="phonetic">{entry.phonetic}</span> : null}
          {forPrint ? null : <button className="icon-btn" title="朗读" aria-label="朗读" onClick={() => speak(entry.head)}><Volume2 size={16} /></button>}
        </h1>
        <DictBadge dict={dict} conflicts={conflicts} />
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
                {forPrint ? null : <button className="icon-btn" title="朗读" aria-label="朗读" onClick={() => speak(s.word)}><Volume2 size={13} /></button>}
                {s.register ? <span className="syn-meta">{s.register}</span> : null}
                {s.tone ? <span className="syn-meta">{s.tone}</span> : null}
                {s.strength ? <span className="syn-meta">{s.strength}</span> : null}
                {/* 收藏 / 查它：近义词是"看到一个新词"的高频入口，
                    以前只能眼睛记下来、回头再去搜索框敲一遍 —— 这两个按钮把这条路缩短成一次点击 */}
                {forPrint ? null : (
                  <span className="syn-acts">
                    <button className={'icon-btn' + (isFavorite && isFavorite(s.word) ? ' on' : '')}
                      title={isFavorite && isFavorite(s.word) ? '已在收藏夹里（点一下取消）' : '收藏这个词，回头细看'}
                      aria-label="收藏" aria-pressed={Boolean(isFavorite && isFavorite(s.word))}
                      onClick={() => onToggleFavorite && onToggleFavorite(s, entry)}>
                      <Star size={14} fill={isFavorite && isFavorite(s.word) ? 'currentColor' : 'none'} />
                    </button>
                    <button className="icon-btn" title={'直接查 ' + s.word + ' 的详细讲解'}
                      aria-label="查这个词" onClick={() => onLookupWord && onLookupWord(s.word)}>
                      <ArrowRight size={14} />
                    </button>
                  </span>
                )}
              </div>
              {s.cn ? <div className="syn-meaning">{s.cn}</div> : null}
              {s.diff ? <div className="syn-usage"><b>差别</b>：{s.diff}</div> : null}
              {s.usage ? <div className="syn-usage">{s.usage}</div> : null}
              {s.example ? (
                <div className="example-line">
                  <em>{s.example}</em>
                  {forPrint ? null : <button className="icon-btn" title="朗读例句" aria-label="朗读例句" onClick={() => speak(s.example)}><Volume2 size={12} /></button>}
                  {s.exampleCn ? <span>{s.exampleCn}</span> : null}
                </div>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      {collocations.length ? (
        <section className="sheet-section">
          <div className="section-heading">
            <span className="label-dot" /><h2>常用搭配</h2>
            {!(entry.collocations || []).length && dict?.phrases?.length
              ? <span className="muted small">取自词典</span> : null}
          </div>
          <div className="chips">{collocations.map((c, i) => <span key={i} className="chip">{c}</span>)}</div>
        </section>
      ) : null}

      {(entry.examples || []).length ? (
        <section className="sheet-section">
          <div className="section-heading"><span className="label-dot" /><h2>例句</h2></div>
          {entry.examples.map((x, i) => (
            <div key={i} className="summary-card">
              <div className="example-line">
                <em>{x.en}</em>
                {forPrint ? null : <button className="icon-btn" title="朗读例句" aria-label="朗读例句" onClick={() => speak(x.en)}><Volume2 size={12} /></button>}
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

      <DictSection dict={dict} />

      {/* ---------- 追问 ----------
          看完卡片常见的是"再问一句"：这两个词到底差在哪、能不能造个句子、考试会怎么考。
          以前只能重新查一次（还会生成一整张新卡），或者干脆算了。
          这里复用异步任务 + 轮询那条链路（弱网与手机端已经验证过），答案是纯文本。 */}
      {forPrint || !onAsk || streaming ? null : (
        <section className="sheet-section ask-section">
          <div className="section-heading">
            <span className="label-dot" />
            <h2>追问一句</h2>
            <span className="muted small">就这个词再问点具体的</span>
          </div>
          {followups && followups.length ? (
            <ul className="ask-list">
              {followups.map((it, i) => (
                <li key={i} className="ask-item">
                  <div className="ask-q">{it.q}</div>
                  <div className="ask-a">{it.a}</div>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="ask-chips">
            {ASK_PRESETS.map((p) => (
              <button key={p} className="chip-btn" disabled={askBusy} onClick={() => onAsk(p)}>{p}</button>
            ))}
          </div>
          <form className="ask-row" onSubmit={(e) => {
            e.preventDefault();
            const v = askText.trim();
            if (!v || askBusy) return;
            setAskText('');
            onAsk(v);
          }}>
            <input className="ask-input" value={askText} onChange={(e) => setAskText(e.target.value)}
              placeholder="例如：和 oppose 到底怎么选？给我 3 个例句。" maxLength={200} disabled={askBusy} />
            <button className="primary-btn" type="submit" disabled={askBusy || !askText.trim()}>
              {askBusy ? <LoaderCircle className="spin" size={15} /> : <MessageCircleQuestion size={15} />}
              {askBusy ? '回答中…' : '问'}
            </button>
          </form>
          {askError ? <p className="ask-error small" role="alert">{askError}</p> : null}
          {followups && followups.length ? (
            <p className="muted small ask-foot">
              追问记录只存在这台设备（不占同步体积）。
              <button className="link-btn" onClick={onClearFollowups}>清空记录</button>
            </p>
          ) : null}
        </section>
      )}

      {/* 流式进度：边生成边告诉用户已经到哪一块了（不然"卡片在长大"会显得莫名其妙） */}
      {streaming && !forPrint ? (
        <div className="stream-bar" role="status" aria-live="polite">
          <span className="stream-dot" aria-hidden="true" />
          <span className="stream-text">{streamProgress || '正在生成…'}</span>
          {streamLabels.length ? <span className="stream-done">已完成：{streamLabels.join(' · ')}</span> : null}
        </div>
      ) : null}

      {forPrint ? null : (
      <div className="save-bar">
        {saved ? <span className="saved-flag"><Star size={14} fill="currentColor" />已在「{existing.name}」里</span> : null}
        {onExportPdf ? (
          <button className="ghost-btn" onClick={() => onExportPdf(entry)} disabled={streaming}
            title={streaming ? '等讲解生成完再导出（否则导出的是一半内容）' : '导出这一个词条的 PDF（在打印对话框里选「另存为 PDF」）'}>
            <FileDown size={15} />导出 PDF
          </button>
        ) : null}
        {books.length ? (
          <select className="ocr-mode" value={bookId} onChange={(e) => setBookId(e.target.value)} disabled={streaming} title="选一个单词本">
            {books.map((b) => <option key={b.id} value={b.id}>{b.name}（{b.entries.length}）</option>)}
          </select>
        ) : null}
        <button className="primary-btn" onClick={() => (books.length ? onSave(bookId) : onCreateBook())} disabled={streaming}
          title={streaming ? '等讲解生成完再存（现在存下来的会缺内容）' : ''}>
          <Plus size={16} />{streaming ? '生成中…' : (books.length ? (saved ? '更新到单词本' : '加入单词本') : '新建单词本并加入')}
        </button>
      </div>
      )}
    </article>
  );
}
