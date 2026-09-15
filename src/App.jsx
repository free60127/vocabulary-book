import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookMarked, Check, ChevronRight, Flame, FolderPlus, LoaderCircle, Plus, Search,
  Settings, Sparkles, Star, Trash2, X, Volume2,
} from 'lucide-react'
import { getStatus, lookup, getLookupJob } from './api.js'
import { POLL_LOOKUP_MS, TIMEOUT_LOOKUP_MS, POLL_MAX_FAILURES, TIP_LONG_MS, TIP_NORMAL_MS } from './constants.js'
import { submitAndPoll } from './hooks/pollJob.js'
import {
  loadBooks, saveBooks, loadSchedule, saveSchedule, loadDays, saveDays,
  loadHistory, saveHistory, loadDeletedBooks, saveDeletedBooks,
  loadDeletedEntries, saveDeletedEntries, loadSettings, saveSettings, safeSet,
} from './storage.js'
import { LEVEL_KEY } from './storage.js'
import {
  KIND_LABEL, allEntries, createBook, entryLabel, entryTombstoneKey, findEntryBook,
  removeBook, removeEntry, summarizeBooks, upsertEntry,
} from './wordbook.js'
import {
  GRADE_KEYS, GRADES, addStudyDay, dueEntries, gradeHint, scheduleOf, sm2Review, summarizeStreak,
} from './review.js'

const LEVELS = ['小初', '高考英语', '四六级', '考研/专四', '专八']

export default function App() {
  /* ---------- 本机数据（全部走 safeGet/safeSet：无痕模式下不能白屏） ---------- */
  const [books, setBooks] = useState(loadBooks)
  const [schedule, setSchedule] = useState(loadSchedule)
  const [days, setDays] = useState(loadDays)
  const [history, setHistory] = useState(loadHistory)
  const [deletedBooks, setDeletedBooks] = useState(loadDeletedBooks)
  const [deletedEntries, setDeletedEntries] = useState(loadDeletedEntries)
  const [settings, setSettings] = useState(loadSettings)
  const [level, setLevel] = useState(() => localStorage.getItem(LEVEL_KEY) || '四六级')

  const [status, setStatus] = useState(null)
  const [query, setQuery] = useState('')
  const [entry, setEntry] = useState(null)       // 刚查出来的词条（还没入库）
  const [activeBookId, setActiveBookId] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [tip, setTip] = useState('')
  const [view, setView] = useState('search')     // search | review | book
  const [reviewQueue, setReviewQueue] = useState(null)
  const [reviewIndex, setReviewIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  const flash = (msg, ms = TIP_NORMAL_MS) => { setTip(msg); const t = setTimeout(() => setTip(''), ms); if (t.unref) t.unref(); };

  useEffect(() => { getStatus().then(setStatus).catch(() => setStatus(null)) }, []);
  useEffect(() => { safeSet(LEVEL_KEY, level) }, [level]);

  /* 落盘：每个 state 变化都写回（这里没有后端数据库，本机就是唯一真相；
     云同步是"复制一份到云端"，不是权威源）。 */
  const persistBooks = useCallback((next) => { setBooks(next); saveBooks(next) }, []);
  const persistSchedule = useCallback((next) => { setSchedule(next); saveSchedule(next) }, []);

  const entries = useMemo(() => allEntries(books), [books]);
  const stats = useMemo(() => summarizeBooks(books), [books]);
  const streak = useMemo(() => summarizeStreak(days), [days]);
  const due = useMemo(() => dueEntries(entries, schedule), [entries, schedule]);

  /* ---------- 查词（核心链路） ---------- */
  const runLookup = async (term) => {
    const q = String(term || '').trim();
    if (!q) { setError('请先输入要查的单词或短语'); return; }
    setError(''); setBusy(true); setEntry(null); setProgress('正在提交…');
    try {
      const out = await submitAndPoll({
        submit: () => lookup({ term: q, level, baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey }),
        fetchJob: getLookupJob,
        intervalMs: POLL_LOOKUP_MS,
        timeoutMs: TIMEOUT_LOOKUP_MS,
        maxFailures: POLL_MAX_FAILURES,
        netError: '网络不稳定，暂时取不到结果，请重试',
        timeoutError: '等待超时。任务可能还在后台跑：稍后重新查一次即可；若反复失败请换个模型试试。',
        isAlive: () => aliveRef.current,
        onProgress: () => setProgress('AI 正在讲解这个词…'),
      });
      if (out.aborted) return;
      const e = out.data && out.data.entry;
      if (!e) throw new Error('模型没有返回词条，请重试');
      setEntry(e);
      // 查过的词留个记录（列表里能一键重查）
      const nextHistory = [{ id: e.id, head: e.head, brief: e.brief, at: Date.now() }, ...history.filter((h) => h.head !== e.head)].slice(0, 200);
      setHistory(nextHistory); saveHistory(nextHistory);
      setDays((d) => { const n = addStudyDay(d); saveDays(n); return n; });
      setProgress('');
    } catch (err) {
      setError(err.message || '查询失败');
      setProgress('');
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 存入单词本 ---------- */
  const saveToBook = (bookId) => {
    if (!entry) return;
    const { list, replaced } = upsertEntry(books, bookId, entry);
    persistBooks(list);
    // 新词条排期：立刻进复习队列（当天就能练）
    if (!replaced) {
      const next = { ...schedule, [entry.id]: scheduleOf(schedule, entry.id, entry.createdAt) };
      persistSchedule(next);
    }
    const book = list.find((b) => b.id === bookId);
    flash((replaced ? '已更新：' : '已加入「' + (book ? book.name : '') + '」：') + entry.head, TIP_LONG_MS);
    setActiveBookId(bookId);
  };

  const createAndSave = () => {
    const name = window.prompt('新建单词本的名字', '我的单词本');
    if (!name) return;
    const list = createBook(books, name);
    persistBooks(list);
    saveToBook(list[list.length - 1].id);
  };

  /* ---------- 删除（留墓碑：否则云同步会把删掉的并回来） ---------- */
  const deleteEntry = (bookId, e) => {
    if (!window.confirm('删除「' + entryLabel(e) + '」？')) return;
    persistBooks(removeEntry(books, bookId, e.id));
    const tomb = [...deletedEntries, entryTombstoneKey(bookId, e.id)];
    setDeletedEntries(tomb); saveDeletedEntries(tomb);
    const nextSchedule = { ...schedule }; delete nextSchedule[e.id];
    persistSchedule(nextSchedule);
    flash('已删除');
  };
  const deleteBook = (b) => {
    if (!window.confirm('删除单词本「' + b.name + '」？里面的词条会一起删掉。')) return;
    persistBooks(removeBook(books, b.id));
    const tomb = [...deletedBooks, b.id];
    setDeletedBooks(tomb); saveDeletedBooks(tomb);
    if (activeBookId === b.id) setActiveBookId('');
    flash('已删除「' + b.name + '」');
  };

  /* ---------- 复习 ---------- */
  const startReview = () => {
    const q = due.map((x) => x.entry);
    if (!q.length) { flash('今天没有到期的词条 —— 去查几个新词吧'); return; }
    setReviewQueue(q); setReviewIndex(0); setRevealed(false); setView('review');
  };
  const grade = (g) => {
    const cur = reviewQueue[reviewIndex];
    if (!cur) return;
    const next = { ...schedule, [cur.id]: sm2Review(scheduleOf(schedule, cur.id, cur.createdAt), g) };
    persistSchedule(next);
    setDays((d) => { const n = addStudyDay(d); saveDays(n); return n; });
    if (reviewIndex + 1 >= reviewQueue.length) {
      setView('search'); setReviewQueue(null);
      flash('这一轮复习完成，共 ' + reviewQueue.length + ' 个词条', TIP_LONG_MS);
      return;
    }
    setReviewIndex((i) => i + 1); setRevealed(false);
  };

  const activeBook = books.find((b) => b.id === activeBookId) || null;
  const hasKey = Boolean(status?.hasKey || settings.apiKey);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">词</div><div><strong>单词本</strong><span>VOCABULARY BOOK</span></div></div>
        <button className="primary-btn" onClick={createAndSave}><FolderPlus size={16} />新建单词本</button>

        <div className="side-section">
          <div className="side-title">我的单词本（{stats.books}）</div>
          <div className="lesson-list">
            {books.length === 0 && <div className="muted">还没有单词本：查一个词就能存进来</div>}
            {books.map((b) => (
              <div key={b.id} className={'lesson-row' + (activeBookId === b.id ? ' active' : '')}>
                <button className="lesson-item" onClick={() => { setActiveBookId(b.id === activeBookId ? '' : b.id); setView('book') }}>
                  <span className="lesson-title">{b.name}</span>
                  <span className="lib-count">{b.entries.length}</span>
                </button>
                <button className="lesson-del" onClick={() => deleteBook(b)} title="删除这个单词本" aria-label="删除单词本"><Trash2 size={12} /></button>
              </div>
            ))}
          </div>

          {history.length > 0 && (
            <>
              <div className="side-title">最近查过</div>
              <div className="lesson-list" style={{ maxHeight: 160 }}>
                {history.slice(0, 20).map((h) => (
                  <button key={h.id} className="lesson-item" onClick={() => { setView('search'); setQuery(h.head); }} title="点一下重新查这个">
                    <span className="lesson-title">{h.head}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="side-footer">
          <button className="ghost-btn" onClick={() => setSettingsOpen(true)}><Settings size={15} />AI 设置</button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-left"><BookMarked size={16} /><strong>单词本</strong></div>
          <button className={'ghost-btn due-btn' + (due.length ? ' has-due' : '')} onClick={startReview}>
            <Flame size={15} />今日待复习{due.length ? ` (${due.length})` : ''}
          </button>
          <div className="status-chip" title={status ? status.model + ' @ ' + status.baseUrl : '后端未连接'}>
            <span className={'dot ' + (status ? 'ok' : 'err')} />
            {status ? (hasKey ? 'AI 已配置' : '未配置 API Key') : '后端未连接'}
            <span className="chip-detail">{stats.entries} 个词条 · 连续 {streak.current} 天</span>
          </div>
        </header>

        {tip ? <div className="fav-tip toast" role="status" aria-live="polite">{tip}</div> : null}

        {view === 'review' && reviewQueue ? (
          <ReviewPane
            queue={reviewQueue} index={reviewIndex} revealed={revealed} schedule={schedule}
            onReveal={() => setRevealed(true)} onGrade={grade}
            onExit={() => { setView('search'); setReviewQueue(null) }}
          />
        ) : view === 'book' && activeBook ? (
          <BookPane
            book={activeBook} schedule={schedule} level={level} onLevel={setLevel}
            onOpen={(e) => { setEntry(e); setView('search') }}
            onDelete={(e) => deleteEntry(activeBook.id, e)}
          />
        ) : (
          <section className="editor">
            <div className="search-bar">
              <Search size={18} />
              <input
                className="search-input" value={query} autoFocus
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runLookup(query) }}
                placeholder="输入单词、短语或句型，回车生成讲解（如 object / pull off / no sooner ... than）"
              />
              <select className="ocr-mode" value={level} onChange={(e) => setLevel(e.target.value)} title="讲解深度">
                {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
              <button className="primary-btn" onClick={() => runLookup(query)} disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{busy ? '讲解中…' : '查一下'}
              </button>
            </div>

            {error ? <div className="error-banner" role="alert"><Flame size={15} /><span className="error-text">{error}</span><button className="icon-btn err-close" onClick={() => setError('')} aria-label="关闭"><X size={15} /></button></div> : null}
            {progress ? <div className="muted small" role="status">{progress}</div> : null}

            {!entry && !busy && !error ? (
              <div className="start-guide" role="note">
                <div className="start-guide-main">
                  <span className="start-guide-title">查一个词，得到什么</span>
                  <ol className="start-guide-steps">
                    <li>意思与词性 · 褒贬色彩 · 情感强度 · 语域</li>
                    <li>词根词缀拆解 + 助记画面；适用场景与<b>不该用的场合</b></li>
                    <li>近义词逐个讲清差别（什么时候用哪个）+ 体现差别的例句</li>
                    <li>存进单词本 → 按间隔重复安排每日复习</li>
                  </ol>
                </div>
              </div>
            ) : null}

            {entry ? (
              <EntryCard
                entry={entry} books={books} activeBookId={activeBookId}
                existing={findEntryBook(books, entry.id)}
                onSave={saveToBook} onCreateBook={createAndSave}
              />
            ) : null}
          </section>
        )}
      </main>

      {settingsOpen ? <SettingsModal settings={settings} onClose={() => setSettingsOpen(false)} onSave={(s) => { setSettings(s); saveSettings(s); setSettingsOpen(false); getStatus().then(setStatus).catch(() => {}) }} /> : null}
    </div>
  )
}

/* ================= 词条卡片 ================= */
function EntryCard({ entry, books, existing, onSave, onCreateBook }) {
  const [bookId, setBookId] = useState(existing?.id || books[0]?.id || '');
  const saved = Boolean(existing);
  return (
    <article className="sheet entry-card">
      <header className="sheet-title">
        <span className="eyebrow">{KIND_LABEL[entry.kind] || '单词'} · {entry.level || ''}</span>
        <h1>
          {entry.head}
          {entry.phonetic ? <span className="phonetic">{entry.phonetic}</span> : null}
        </h1>
        <div className="chips">
          {entry.pos ? <span className="chip">{entry.pos}</span> : null}
          {entry.register ? <span className="chip">{entry.register}</span> : null}
          {entry.tone ? <span className="chip">{entry.tone}</span> : null}
          {entry.strength ? <span className="chip">强度 {entry.strength}</span> : null}
        </div>
        {entry.brief ? <p className="entry-brief">{entry.brief}</p> : null}
      </header>

      <section className="sheet-section">
        <div className="section-heading"><span className="label-dot" /><h2>释义</h2></div>
        {(entry.meanings || []).map((m, i) => (
          <div key={i} className="meaning-row">
            {m.pos ? <span className="fav-pos">{m.pos}</span> : null}
            <div><strong>{m.cn}</strong>{m.en ? <div className="muted small">{m.en}</div> : null}{m.note ? <div className="muted small">{m.note}</div> : null}</div>
          </div>
        ))}
      </section>

      {entry.mnemonic && (entry.mnemonic.image || entry.mnemonic.parts) ? (
        <section className="sheet-section vocab-morph">
          {entry.mnemonic.parts ? <div className="morph-line"><b>词根词缀</b>：{entry.mnemonic.parts}</div> : null}
          {entry.mnemonic.image ? <div className="morph-line"><b>助记画面</b>：<span className="morph-image">{entry.mnemonic.image}</span></div> : null}
          {entry.mnemonic.family ? <div className="morph-line"><b>同根词</b>：{entry.mnemonic.family}</div> : null}
        </section>
      ) : null}

      {(entry.scenes || []).length || entry.avoid ? (
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
                {s.register ? <span className="syn-meta">{s.register}</span> : null}
                {s.tone ? <span className="syn-meta">{s.tone}</span> : null}
                {s.strength ? <span className="syn-meta">{s.strength}</span> : null}
              </div>
              {s.cn ? <div className="syn-meaning">{s.cn}</div> : null}
              {s.diff ? <div className="syn-usage"><b>差别</b>：{s.diff}</div> : null}
              {s.usage ? <div className="syn-usage">{s.usage}</div> : null}
              {s.example ? <div className="example-line"><em>{s.example}</em>{s.exampleCn ? <span>{s.exampleCn}</span> : null}</div> : null}
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
            <div key={i} className="example-card">
              <div className="example-line"><em>{x.en}</em><span>{x.cn}</span></div>
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
          <select className="ocr-mode" value={bookId} onChange={(e) => setBookId(e.target.value)}>
            {books.map((b) => <option key={b.id} value={b.id}>{b.name}（{b.entries.length}）</option>)}
          </select>
        ) : null}
        <button className="primary-btn" onClick={() => (books.length ? onSave(bookId) : onCreateBook())}>
          <Plus size={16} />{books.length ? (saved ? '更新到单词本' : '加入单词本') : '新建单词本并加入'}
        </button>
      </div>
    </article>
  )
}

/* ================= 单词本 ================= */
function BookPane({ book, schedule, onOpen, onDelete }) {
  return (
    <section className="editor">
      <div className="panel">
        <div className="panel-head"><h2>{book.name}</h2><span className="muted small">{book.entries.length} 个词条</span></div>
        {book.entries.length === 0 ? <div className="muted">这个本子还是空的：查一个词就能存进来</div> : null}
        <div className="entry-list">
          {book.entries.map((e) => {
            const s = scheduleOf(schedule, e.id, e.createdAt);
            return (
              <div key={e.id} className="entry-row">
                <button className="entry-open" onClick={() => onOpen(e)}>
                  <strong>{e.head}</strong>
                  {e.phonetic ? <span className="muted small">{e.phonetic}</span> : null}
                  <span className="muted small">{e.brief}</span>
                  <span className="due-tag">{s.reps ? `复习 ${s.reps} 次` : '新词'}</span>
                  <ChevronRight size={14} />
                </button>
                <button className="icon-btn" onClick={() => onDelete(e)} title="删除" aria-label="删除词条"><Trash2 size={14} /></button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  )
}

/* ================= 复习 ================= */
function ReviewPane({ queue, index, revealed, schedule, onReveal, onGrade, onExit }) {
  const cur = queue[index];
  if (!cur) return null;
  const s = scheduleOf(schedule, cur.id, cur.createdAt);
  return (
    <section className="editor">
      <div className="panel review-pane">
        <div className="panel-head">
          <h2>复习 {index + 1} / {queue.length}</h2>
          <button className="ghost-btn sm" onClick={onExit}>退出复习</button>
        </div>
        <div className="review-word">
          <strong>{cur.head}</strong>
          {cur.phonetic ? <span className="phonetic">{cur.phonetic}</span> : null}
          <button className="icon-btn" title="朗读" aria-label="朗读"
            onClick={() => { try { const u = new SpeechSynthesisUtterance(cur.head); u.lang = 'en-US'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch { /* 不支持就算了 */ } }}>
            <Volume2 size={16} />
          </button>
        </div>
        <p className="muted small">先回想它的意思与用法，再翻面核对。</p>

        {revealed ? (
          <div className="review-answer">
            <div className="chips">
              {cur.pos ? <span className="chip">{cur.pos}</span> : null}
              {cur.register ? <span className="chip">{cur.register}</span> : null}
              {cur.tone ? <span className="chip">{cur.tone}</span> : null}
            </div>
            <p><strong>{(cur.meanings && cur.meanings[0] && cur.meanings[0].cn) || cur.brief}</strong></p>
            {cur.brief ? <p className="muted">{cur.brief}</p> : null}
            {cur.synonyms && cur.synonyms[0] ? (
              <p className="muted small">与 <b>{cur.synonyms[0].word}</b> 的差别：{cur.synonyms[0].diff}</p>
            ) : null}
            {cur.examples && cur.examples[0] ? (
              <p className="muted small">{cur.examples[0].en} —— {cur.examples[0].cn}</p>
            ) : null}
            <div className="grade-bar">
              {GRADE_KEYS.map((g) => (
                <button key={g} className={'ghost-btn grade-' + GRADES[g].tone} onClick={() => onGrade(g)}>
                  {GRADES[g].label}<span className="muted small">{gradeHint(s, g)}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button className="primary-btn big" onClick={onReveal}><Check size={16} />显示答案</button>
        )}
      </div>
    </section>
  )
}

/* ================= 设置 ================= */
function SettingsModal({ settings, onClose, onSave }) {
  const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '', ...settings });
  const field = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="AI 设置" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>AI 接入设置</h2><button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button></div>
        <p className="muted small">与回译本一致：留空就用服务端 .env 里的配置；填了就只存在本机浏览器。</p>
        <label>Base URL<input value={form.baseUrl} onChange={field('baseUrl')} placeholder="https://api.deepseek.com/v1" /></label>
        <label>模型<input value={form.model} onChange={field('model')} placeholder="deepseek-chat" /></label>
        <label>API Key<input type="password" value={form.apiKey} onChange={field('apiKey')} placeholder="sk-..." autoComplete="off" /></label>
        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose}>取消</button>
          <button className="primary-btn" onClick={() => onSave(form)}>保存</button>
        </div>
      </div>
    </div>
  )
}
