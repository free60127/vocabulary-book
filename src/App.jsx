import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookMarked, ChevronRight, Cloud, Flame, FolderPlus, LoaderCircle, LogIn,
  Search, Settings, Sparkles, Trash2, Volume2, X,
} from 'lucide-react'
import { getStatus, lookup, getLookupJob, quiz as quizApi, getQuizJob } from './api.js'
import {
  POLL_LOOKUP_MS, POLL_QUIZ_MS, TIMEOUT_LOOKUP_MS, TIMEOUT_QUIZ_MS, POLL_MAX_FAILURES,
  TIP_LONG_MS, TIP_NORMAL_MS,
} from './constants.js'
import { submitAndPoll } from './hooks/pollJob.js'
import {
  LEVEL_KEY, loadBooks, loadDays, loadDeletedBooks, loadDeletedEntries, loadHistory,
  loadSchedule, loadSettings, localSnapshot, mergeSnapshot, safeSet, saveBooks, saveDays,
  saveDeletedBooks, saveDeletedEntries, saveHistory, saveSchedule, saveSettings,
} from './storage.js'
import {
  KIND_LABEL, allEntries, createBook, entryLabel, entryTombstoneKey, findEntryBook,
  removeBook, removeEntry, summarizeBooks, upsertEntry,
} from './wordbook.js'
import { GRADE_KEYS, GRADES, addStudyDay, dueEntries, gradeHint, scheduleOf, sm2Review, summarizeStreak } from './review.js'
import { FILTERS, SORTS, filterEntries, sortEntries } from './filterSort.js'
import { speak } from './speak.js'
import { loadSyncCode, loadSyncMeta, newSyncCode, saveSyncCode, saveSyncMeta, syncOnce } from './sync.js'
import {
  authConfig, bindSync, deleteAccount as apiDelete, fetchMe, forgot as apiForgot,
  loadToken, loadUser, resetPassword as apiReset, saveToken, saveUser,
  signIn, signOut as apiSignOut, signOutAll as apiSignOutAll, signUp,
} from './account.js'
import EntryCard from './components/EntryCard.jsx'
import QuizPane from './components/QuizPane.jsx'
import BackupModal from './components/modals/BackupModal.jsx'
import AuthModal from './components/modals/AuthModal.jsx'

const LEVELS = ['小初', '高考英语', '四六级', '考研/专四', '专八']
const QUIZ_COUNTS = [5, 10, 15, 20]

export default function App() {
  /* ---------- 本机数据（全部经 safeGet/safeSet，无痕模式下不能白屏） ---------- */
  const [books, setBooks] = useState(loadBooks)
  const [schedule, setSchedule] = useState(loadSchedule)
  const [days, setDays] = useState(loadDays)
  const [history, setHistory] = useState(loadHistory)
  const [deletedBooks, setDeletedBooks] = useState(loadDeletedBooks)
  const [deletedEntries, setDeletedEntries] = useState(loadDeletedEntries)
  const [settings, setSettings] = useState(loadSettings)
  const [level, setLevel] = useState(() => localStorage.getItem(LEVEL_KEY) || '四六级')
  const [status, setStatus] = useState(null)

  /* ---------- 界面状态 ---------- */
  const [view, setView] = useState('search')          // search | review | book | quiz
  const [query, setQuery] = useState('')
  const [entry, setEntry] = useState(null)
  const [activeBookId, setActiveBookId] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [tip, setTip] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [quizSetupOpen, setQuizSetupOpen] = useState(false)
  const [quizCount, setQuizCount] = useState(10)
  const [quizScope, setQuizScope] = useState('all')
  const [quiz, setQuiz] = useState(null)
  const [quizShow, setQuizShow] = useState(false)
  const [quizBusy, setQuizBusy] = useState(false)
  const [reviewQueue, setReviewQueue] = useState(null)
  const [reviewIndex, setReviewIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [bookQuery, setBookQuery] = useState('')
  const [kindFilter, setKindFilter] = useState('all')
  const [sortMode, setSortMode] = useState('default')

  /* ---------- 云同步 / 账号 ---------- */
  const [syncCode, setSyncCode] = useState(loadSyncCode)
  const [syncMeta, setSyncMeta] = useState(loadSyncMeta)
  const [syncTip, setSyncTip] = useState('')
  const [syncBusy, setSyncBusy] = useState(false)
  const [account, setAccount] = useState(() => ({ token: loadToken(), ...loadUser() }))
  const [authCfg, setAuthCfg] = useState(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [authTip, setAuthTip] = useState('')

  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  const flash = useCallback((msg, ms = TIP_NORMAL_MS) => {
    setTip(msg)
    const t = setTimeout(() => setTip(''), ms)
    if (t.unref) t.unref()
  }, [])

  useEffect(() => { getStatus().then(setStatus).catch(() => setStatus(null)) }, [])
  useEffect(() => { safeSet(LEVEL_KEY, level) }, [level])
  useEffect(() => { authConfig().then(setAuthCfg).catch(() => setAuthCfg({ enabled: false })) }, [])

  /* ---------- 派生 ---------- */
  const persistBooks = useCallback((next) => { setBooks(next); saveBooks(next) }, [])
  const persistSchedule = useCallback((next) => { setSchedule(next); saveSchedule(next) }, [])
  const markStudied = useCallback(() => setDays((d) => { const n = addStudyDay(d); saveDays(n); return n }), [])
  const entries = useMemo(() => allEntries(books), [books])
  const stats = useMemo(() => summarizeBooks(books), [books])
  const streak = useMemo(() => summarizeStreak(days), [days])
  const due = useMemo(() => dueEntries(entries, schedule), [entries, schedule])
  const activeBook = books.find((b) => b.id === activeBookId) || null
  const hasKey = Boolean(status?.hasKey || settings.apiKey)
  const local = useMemo(
    () => localSnapshot({ books, schedule, days, history, deletedBooks, deletedEntries }),
    [books, schedule, days, history, deletedBooks, deletedEntries],
  )

  /* ---------- 查词（核心链路：提交 → 轮询 → 卡片） ---------- */
  const runLookup = async (term) => {
    const q = String(term || '').trim()
    if (!q) { setError('请先输入要查的单词或短语'); return }
    setError(''); setBusy(true); setEntry(null); setProgress('正在提交…')
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
      })
      if (out.aborted) return
      const e = out.data && out.data.entry
      if (!e) throw new Error('模型没有返回词条，请重试')
      setEntry(e); setView('search'); setProgress('')
      const nextHistory = [{ id: e.id, head: e.head, brief: e.brief, at: Date.now() }, ...history.filter((h) => h.head !== e.head)].slice(0, 200)
      setHistory(nextHistory); saveHistory(nextHistory)
      markStudied()
    } catch (err) {
      setError(err.message || '查询失败'); setProgress('')
    } finally {
      setBusy(false)
    }
  }

  /* ---------- 存入 / 删除 ---------- */
  // base 必须能显式传入：`books` 是本次渲染的闭包快照，`createAndSave` 里刚 `createBook`
  // 出来的新本子并不在 `books` 里。若沿用闭包，`upsertEntry([], bookId, entry)` 会返回空数组，
  // 紧接着 `persistBooks([])` 把**刚建好的本子连同词条一起抹掉** —— 用户看到的就是
  // "点了新建单词本并加入，什么都没有发生"。（e2e 抓到的就是这个。）
  const saveToBook = (bookId, base = books) => {
    if (!entry) return
    const { list, replaced } = upsertEntry(base, bookId, entry)
    persistBooks(list)
    // 新词条给一个"立刻到期"的排期，这样它当天就能进复习队列
    if (!replaced) persistSchedule({ ...schedule, [entry.id]: scheduleOf(schedule, entry.id, entry.createdAt) })
    const book = list.find((b) => b.id === bookId)
    flash((replaced ? '已更新：' : '已加入「' + (book ? book.name : '') + '」：') + entry.head, TIP_LONG_MS)
    setActiveBookId(bookId)
  }
  const createAndSave = () => {
    const raw = window.prompt('新建单词本的名字', '我的单词本')
    if (raw === null) return                       // 点了"取消"：什么都不做才是对的
    const name = raw.trim()
    // 空名字以前是静默 return —— 用户按了"新建单词本并加入"，界面上一点反应都没有，
    // 看起来就是"按钮坏了"（e2e 第一次就是这么翻车的）。必须给出反馈。
    if (!name) { flash('名字不能为空，没有新建', TIP_LONG_MS); return }
    // 同名时复用已有的本子：重名本子在侧边栏里长得一模一样，用户分不清哪个是哪个
    const same = books.find((b) => b.name === name)
    if (same) { saveToBook(same.id); return }
    const list = createBook(books, name)
    persistBooks(list)
    saveToBook(list[list.length - 1].id, list)
  }
  const deleteEntry = (bookId, e) => {
    if (!window.confirm('删除「' + entryLabel(e) + '」？')) return
    persistBooks(removeEntry(books, bookId, e.id))
    const tomb = [...deletedEntries, entryTombstoneKey(bookId, e.id)]
    setDeletedEntries(tomb); saveDeletedEntries(tomb)
    const nextSchedule = { ...schedule }
    delete nextSchedule[e.id]
    persistSchedule(nextSchedule)
    flash('已删除')
  }
  const deleteBook = (b) => {
    if (!window.confirm('删除单词本「' + b.name + '」？里面的词条会一起删掉。')) return
    persistBooks(removeBook(books, b.id))
    const tomb = [...deletedBooks, b.id]
    setDeletedBooks(tomb); saveDeletedBooks(tomb)
    if (activeBookId === b.id) setActiveBookId('')
    flash('已删除「' + b.name + '」')
  }

  /* ---------- 复习 ---------- */
  const startReview = () => {
    const q = due.map((x) => x.entry)
    if (!q.length) { flash('今天没有到期的词条 —— 去查几个新词吧'); return }
    setReviewQueue(q); setReviewIndex(0); setRevealed(false); setView('review')
  }
  const grade = (g) => {
    const cur = reviewQueue[reviewIndex]
    if (!cur) return
    persistSchedule({ ...schedule, [cur.id]: sm2Review(scheduleOf(schedule, cur.id, cur.createdAt), g) })
    markStudied()
    if (reviewIndex + 1 >= reviewQueue.length) {
      setView('search'); setReviewQueue(null)
      flash('这一轮复习完成，共 ' + reviewQueue.length + ' 个词条', TIP_LONG_MS)
      return
    }
    setReviewIndex((i) => i + 1); setRevealed(false)
  }

  /* ---------- 自测题 ---------- */
  const runQuiz = async () => {
    const scope = quizScope === 'book' && activeBook ? activeBook.entries : entries
    const source = scope.length ? scope : entries
    if (!source.length) { flash('还没有词条可以出题 —— 先查几个词'); return }
    setQuizSetupOpen(false); setQuizBusy(true); setQuiz(null); setQuizShow(false); setView('quiz')
    try {
      // 每个词条压成一行给模型。**带上近义词的差别**是关键：只给同义词列表，
      // 模型只能出"这个词什么意思"这种浅题；带上差别才能出"哪个更正式"这类辨析题。
      const points = source.slice(0, 60).map((e) => [
        e.head, e.pos,
        e.brief || (e.meanings && e.meanings[0] && e.meanings[0].cn) || '',
        (e.synonyms || []).slice(0, 3).map((s) => s.word + (s.diff ? '（' + s.diff + '）' : '')).join('；'),
      ].filter(Boolean).join('｜'))
      const out = await submitAndPoll({
        submit: () => quizApi({ points, count: quizCount, level, baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey }),
        fetchJob: getQuizJob,
        intervalMs: POLL_QUIZ_MS,
        timeoutMs: TIMEOUT_QUIZ_MS,
        maxFailures: POLL_MAX_FAILURES,
        netError: '网络不稳定，暂时取不到题目，请重试',
        timeoutError: '出题超时。任务可能还在后台跑：稍后再点一次「换一套」即可。',
        isAlive: () => aliveRef.current,
      })
      if (out.aborted) return
      const data = out.data
      if (!data || !Array.isArray(data.questions) || !data.questions.length) {
        throw new Error('模型没有生成有效题目（返回格式不对），请换一套再试')
      }
      setQuiz(data); markStudied()
    } catch (e) {
      setError(e.message || '出题失败')
      setView('search')
    } finally {
      setQuizBusy(false)
    }
  }
  const copyQuiz = async () => {
    if (!quiz) return
    const text = [
      quiz.title, '',
      ...quiz.questions.map((q, i) => [(i + 1) + '. ' + q.stem, ...(q.options || []).map((o, j) => '   ' + 'ABCDEFGH'[j] + '. ' + o)].join('\n')),
      '', '【答案与解析】',
      ...quiz.questions.map((q, i) => (i + 1) + '. ' + q.answer + (q.explanation ? ' —— ' + q.explanation : '')),
    ].join('\n')
    try { await navigator.clipboard.writeText(text); flash('已复制题目与答案', TIP_LONG_MS) } catch { flash('复制失败：请手动选中复制（或改用 https 访问）', TIP_LONG_MS) }
  }

  /* ---------- 备份导出 / 导入 ---------- */
  const exportBackup = () => {
    const payload = { app: 'vocabulary-book', version: 1, exportedAt: new Date().toISOString(), ...local }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'vocabulary-book-' + new Date().toISOString().slice(0, 10) + '.json'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1500)
    flash('已导出备份文件', TIP_LONG_MS)
  }
  const importBackup = async (file) => {
    const data = JSON.parse(await file.text())
    if (!data || typeof data !== 'object') throw new Error('文件格式不正确')
    if (!Array.isArray(data.books) && !Array.isArray(data.history)) throw new Error('这个文件里没有可导入的单词本数据')
    const merged = mergeSnapshot(local, data)
    persistBooks(merged.books); persistSchedule(merged.review)
    setDays(merged.days); saveDays(merged.days)
    setHistory(merged.history); saveHistory(merged.history)
    setDeletedBooks(merged.deletedBooks); saveDeletedBooks(merged.deletedBooks)
    setDeletedEntries(merged.deletedEntries); saveDeletedEntries(merged.deletedEntries)
    flash(`导入完成：新增 ${merged.added.booksAdded} 个单词本、${merged.added.entriesAdded} 个词条`, TIP_LONG_MS)
  }

  /* ---------- 云同步 ---------- */
  const applyMerged = useCallback((merged) => {
    persistBooks(merged.books); persistSchedule(merged.review)
    setDays(merged.days); saveDays(merged.days)
    setHistory(merged.history); saveHistory(merged.history)
    setDeletedBooks(merged.deletedBooks); saveDeletedBooks(merged.deletedBooks)
    setDeletedEntries(merged.deletedEntries); saveDeletedEntries(merged.deletedEntries)
  }, [persistBooks, persistSchedule])

  const localRef = useRef(local); localRef.current = local
  const syncBusyRef = useRef(false)
  const runSync = useCallback(async (manual = true, codeOverride) => {
    const code = codeOverride || syncCode
    if (!code) { if (manual) setSyncTip('还没有同步码：先生成一个，或在另一台设备上把码填进来'); return }
    if (syncBusyRef.current) { if (manual) setSyncTip('正在同步中，请稍候'); return }
    syncBusyRef.current = true; setSyncBusy(true)
    if (manual) setSyncTip('正在同步…')
    try {
      const res = await syncOnce({ code, local: localRef.current })
      if (!res.ok) { setSyncTip(res.error || '同步失败'); return }
      // ⚠️ 用**此刻**的本机数据再合并一次：res.merged 是"发起同步那一刻"的快照，
      // 请求在飞的这段时间里用户可能又存了词条 —— 直接写回会把它们抹掉（回译本上实测过）。
      const settled = mergeSnapshot(localRef.current, res.merged)
      applyMerged(settled)
      const meta = { ...loadSyncMeta(), lastSyncAt: Date.now(), version: res.version }
      saveSyncMeta(meta); setSyncMeta(meta)
      const a = settled.added || {}
      if (manual) setSyncTip((a.booksAdded || a.entriesAdded) ? `同步完成：新增 ${a.booksAdded} 个本子、${a.entriesAdded} 个词条` : '同步完成：已是最新')
      else if (a.booksAdded || a.entriesAdded) flash('已从云端同步到新内容', TIP_LONG_MS)
    } catch (e) {
      setSyncTip('同步失败：' + (e.message || '网络错误'))
    } finally {
      syncBusyRef.current = false; setSyncBusy(false)
    }
  }, [syncCode, applyMerged, flash])

  const startNewSync = async () => {
    if (syncBusyRef.current) { setSyncTip('正在同步中，请稍候'); return }
    if (syncCode && !window.confirm('换一串新码？\n\n其它设备需要重新填新码才能继续同步；本机数据不受影响。')) return
    syncBusyRef.current = true; setSyncBusy(true); setSyncTip('')
    try {
      const r = await newSyncCode()
      if (!r || !r.code) throw new Error('服务器未返回同步码')
      saveSyncCode(r.code); setSyncCode(r.code)
      syncBusyRef.current = false; setSyncBusy(false)
      await runSync(true, r.code)
    } catch (e) {
      setSyncTip('生成同步码失败：' + (e.message || '网络错误'))
      syncBusyRef.current = false; setSyncBusy(false)
    }
  }
  const useExistingCode = async (input) => {
    const code = String(input || '').trim().toLowerCase()
    if (!/^[a-f0-9]{32}$/.test(code)) { setSyncTip('同步码应为 32 位十六进制字符，请检查是否复制完整'); return }
    saveSyncCode(code); setSyncCode(code)
    await runSync(true, code)
  }
  const copySyncCode = async () => {
    try { await navigator.clipboard.writeText(syncCode); setSyncTip('同步码已复制 —— 在另一台设备的这一栏粘贴即可') } catch { setSyncTip('复制失败，请手动选中复制') }
  }
  const stopSync = () => {
    if (!window.confirm('停用云同步？\n\n本机数据不受影响。云端那份仍在这串码下，以后填回来还能继续用。')) return
    saveSyncCode(''); setSyncCode(''); setSyncTip('已停用云同步（本机数据保留）')
  }

  /* ---------- 账号 ---------- */
  const afterAuth = useCallback((r) => {
    if (!r.ok) { setAuthTip(r.error || '操作失败'); return }
    const token = r.token || (account && account.token) || ''
    const email = r.email || (r.user && r.user.email) || (account && account.email) || ''
    const next = { token, email }
    setAccount(next); saveToken(token); saveUser({ email })
    setAuthOpen(false); setAuthTip('')
    flash('已登录：' + email)
    // 账号里存了同步码就自动接上（换设备时不用手抄）
    if (r.sync) { saveSyncCode(r.sync); setSyncCode(r.sync); runSync(true, r.sync) }
  }, [account, flash, runSync])

  const doSignIn = async (email, password) => {
    setAuthBusy(true); setAuthTip('')
    afterAuth(await signIn(email, password, loadSyncMeta().device || ''))
    setAuthBusy(false)
  }
  const doSignUp = async (email, password) => {
    setAuthBusy(true); setAuthTip('')
    afterAuth(await signUp(email, password))
    setAuthBusy(false)
  }
  const doSignOut = async () => {
    await apiSignOut(account.token)
    setAccount({ token: '', email: '' }); saveToken(''); saveUser({})
    flash('已退出登录')
  }
  const doSignOutAll = async () => {
    await apiSignOutAll(account.token)
    setAccount({ token: '', email: '' }); saveToken(''); saveUser({})
    flash('已退出全部设备')
  }
  const doForgot = async (email) => {
    setAuthBusy(true)
    const r = await apiForgot(email)
    setAuthTip(r.ok ? '验证码已发到邮箱（服务端未配 SMTP 时不可用）' : (r.error || '发送失败'))
    setAuthBusy(false)
  }
  const doReset = async (email, code, pw) => {
    setAuthBusy(true)
    const r = await apiReset(email, code, pw)
    setAuthTip(r.ok ? '密码已重设，请用新密码登录' : (r.error || '重设失败'))
    setAuthBusy(false)
  }
  const doDeleteAccount = async (pw) => {
    setAuthBusy(true)
    const r = await apiDelete(account.token, pw)
    if (r.ok) { setAccount({ token: '', email: '' }); saveToken(''); saveUser({}); flash('账号已注销') } else setAuthTip(r.error || '注销失败')
    setAuthBusy(false)
  }
  const doBindSync = async () => {
    if (!syncCode) return
    setSyncBusy(true)
    const r = await bindSync(account.token, syncCode)
    setSyncTip(r.ok ? '同步码已存到账号 —— 换设备登录后会自动带回来' : ('保存失败：' + (r.error || '')))
    setSyncBusy(false)
  }

  /* 已登录时拉一次用户信息（顺便验证令牌还有效） */
  useEffect(() => {
    const token = loadToken()
    if (!token) return
    fetchMe(token).then((r) => {
      if (!aliveRef.current) return
      if (r.ok) {
        const email = r.email || (r.user && r.user.email) || ''
        setAccount({ token, email }); saveUser({ email })
        if (r.sync && !loadSyncCode()) { saveSyncCode(r.sync); setSyncCode(r.sync) }
      } else {
        // 令牌失效（改过密码 / 被踢）：清掉，免得后续请求一直 401
        saveToken(''); saveUser({}); setAccount({ token: '', email: '' })
      }
    })
  }, [])

  /* 打开页面自动同步一次（有码才跑） */
  const bootSyncedRef = useRef(false)
  useEffect(() => {
    if (bootSyncedRef.current || !syncCode) return
    bootSyncedRef.current = true
    runSync(false, syncCode)
  }, [syncCode, runSync])

  /* ---------- 本子内的筛选与排序 ---------- */
  const filteredBookEntries = useMemo(() => {
    const base = activeBook ? activeBook.entries : []
    return sortEntries(filterEntries(base, { query: bookQuery, filter: kindFilter }, schedule), sortMode, schedule)
  }, [activeBook, bookQuery, kindFilter, sortMode, schedule])

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
                {/* 侧边栏这一项既是"打开"也是"收起"。只按 activeBookId 判断会翻车：
                    刚存完词时 activeBookId 已经指向这个本子，用户从搜索页点过来本意是"打开它"，
                    却被 toggle 成空 → activeBook 为 null → 页面原地不动，看起来又是"点了没反应"。
                    所以只有**当前正开在这个本子上**时才收起。 */}
                <button className="lesson-item" onClick={() => {
                  const isCurrent = b.id === activeBookId && view === 'book'
                  setActiveBookId(isCurrent ? '' : b.id)
                  setView(isCurrent ? 'search' : 'book')
                }}>
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
              <div className="lesson-list" style={{ maxHeight: 150 }}>
                {history.slice(0, 20).map((h) => (
                  <button key={h.id} className="lesson-item" onClick={() => { setView('search'); setQuery(h.head) }} title="点一下填回搜索框">
                    <span className="lesson-title">{h.head}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="side-footer">
          <button className="ghost-btn" onClick={() => setSettingsOpen(true)}><Settings size={15} />AI 设置</button>
          <button className="ghost-btn" onClick={() => setBackupOpen(true)}><Cloud size={15} />备份/同步</button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-left"><BookMarked size={16} /><strong>单词本</strong></div>
          <button className={'ghost-btn due-btn' + (due.length ? ' has-due' : '')} onClick={startReview}>
            <Flame size={15} />今日待复习{due.length ? ` (${due.length})` : ''}
          </button>
          <button className="ghost-btn" onClick={() => setQuizSetupOpen(true)} disabled={!entries.length}>
            <Sparkles size={15} />自测题
          </button>
          {account.email
            ? <button className="ghost-btn" onClick={() => setAuthOpen(true)} title={account.email}><LogIn size={15} />{account.email.split('@')[0]}</button>
            : <button className="ghost-btn" onClick={() => setAuthOpen(true)}><LogIn size={15} />登录</button>}
          <div className="status-chip" title={status ? status.model + ' @ ' + status.baseUrl : '后端未连接'}>
            <span className={'dot ' + (status ? 'ok' : 'err')} />
            {status ? (hasKey ? 'AI 已配置' : '未配置 API Key') : '后端未连接'}
            <span className="chip-detail">{stats.entries} 个词条 · 连续 {streak.current} 天</span>
          </div>
        </header>

        {tip ? <div className="fav-tip toast" role="status" aria-live="polite">{tip}</div> : null}

        {view === 'review' && reviewQueue ? (
          <ReviewPane queue={reviewQueue} index={reviewIndex} revealed={revealed} schedule={schedule}
            onReveal={() => setRevealed(true)} onGrade={grade}
            onExit={() => { setView('search'); setReviewQueue(null) }} />
        ) : view === 'quiz' ? (
          <QuizPane quiz={quiz} showAnswers={quizShow} busy={quizBusy}
            onToggleAnswers={() => setQuizShow((v) => !v)} onCopy={copyQuiz}
            onRegenerate={() => setQuizSetupOpen(true)} onExit={() => setView('search')} />
        ) : view === 'book' && activeBook ? (
          <section className="editor">
            <div className="panel">
              <div className="panel-head">
                <h2>{activeBook.name}</h2>
                <span className="muted small">
                  {activeBook.entries.length} 个词条
                  {filteredBookEntries.length !== activeBook.entries.length ? ` · 筛出 ${filteredBookEntries.length}` : ''}
                </span>
              </div>
              <div className="book-toolbar">
                <input className="fav-search" value={bookQuery} onChange={(e) => setBookQuery(e.target.value)} placeholder="在本子里搜词条 / 释义 / 近义词" />
                <select className="ocr-mode" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} title="筛选">
                  {FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
                <select className="ocr-mode" value={sortMode} onChange={(e) => setSortMode(e.target.value)} title="排序">
                  {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                <button className="ghost-btn sm" onClick={() => { setQuizScope('book'); setQuizSetupOpen(true) }} disabled={!activeBook.entries.length}>
                  <Sparkles size={14} />用这个本子出题
                </button>
              </div>
              {activeBook.entries.length === 0 ? <div className="muted">这个本子还是空的：查一个词就能存进来</div> : null}
              {activeBook.entries.length > 0 && filteredBookEntries.length === 0 ? <div className="muted">没有符合条件的词条</div> : null}
              <div className="entry-list">
                {filteredBookEntries.map((e) => {
                  const s = scheduleOf(schedule, e.id, e.createdAt)
                  return (
                    <div key={e.id} className="entry-row">
                      <button className="entry-open" onClick={() => { setEntry(e); setView('search') }}>
                        <strong>{e.head}</strong>
                        {e.phonetic ? <span className="muted small">{e.phonetic}</span> : null}
                        <span className="muted small">{e.brief}</span>
                        <span className="due-tag">{s.reps ? `复习 ${s.reps} 次 · ${KIND_LABEL[e.kind] || ''}` : '新词'}</span>
                        <ChevronRight size={14} />
                      </button>
                      <button className="icon-btn" title="朗读" aria-label="朗读" onClick={() => speak(e.head)}><Volume2 size={14} /></button>
                      <button className="icon-btn" onClick={() => deleteEntry(activeBook.id, e)} title="删除" aria-label="删除词条"><Trash2 size={14} /></button>
                    </div>
                  )
                })}
              </div>
            </div>
          </section>
        ) : (
          <section className="editor">
            <div className="search-bar">
              <Search size={18} />
              <input className="search-input" value={query} autoFocus
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runLookup(query) }}
                placeholder="输入单词、短语或句型，回车生成讲解（如 object / pull off / no sooner ... than）" />
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
                    <li>词根词缀拆解 + 助记画面；适用场景与不该用的场合</li>
                    <li>近义词逐个讲清差别（什么时候用哪个）+ 体现差别的例句</li>
                    <li>存进单词本 → 按间隔重复安排每日复习；到期了在顶栏「今日待复习」里练</li>
                  </ol>
                </div>
              </div>
            ) : null}

            {entry ? (
              <EntryCard entry={entry} books={books} existing={findEntryBook(books, entry.id)}
                onSave={saveToBook} onCreateBook={createAndSave} />
            ) : null}
          </section>
        )}
      </main>

      {settingsOpen ? (
        <SettingsModal settings={settings} onClose={() => setSettingsOpen(false)}
          onSave={(s) => { setSettings(s); saveSettings(s); setSettingsOpen(false); getStatus().then(setStatus).catch(() => {}) }} />
      ) : null}

      {backupOpen ? (
        <BackupModal
          onClose={() => setBackupOpen(false)}
          summary={`${stats.books} 个单词本（${stats.entries} 个词条） · 连续 ${streak.current} 天 · 最近查过 ${history.length} 次`}
          onExport={exportBackup} onImport={importBackup}
          syncCode={syncCode} syncTip={syncTip} syncBusy={syncBusy} syncMeta={syncMeta}
          onNewCode={startNewSync} onUseCode={useExistingCode} onCopyCode={copySyncCode}
          onStopSync={stopSync} onSyncNow={() => runSync(true)}
          account={account} onOpenAuth={() => setAuthOpen(true)} onBindSync={doBindSync} />
      ) : null}

      {authOpen ? (
        <AuthModal config={authCfg} account={account} busy={authBusy} tip={authTip}
          onClose={() => setAuthOpen(false)}
          onSignIn={doSignIn} onSignUp={doSignUp} onSignOut={doSignOut} onSignOutAll={doSignOutAll}
          onForgot={doForgot} onReset={doReset} onDeleteAccount={doDeleteAccount} />
      ) : null}

      {quizSetupOpen ? (
        <div className="modal-mask" onClick={() => setQuizSetupOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="生成自测题" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>生成自测题</h2><button className="icon-btn" onClick={() => setQuizSetupOpen(false)} aria-label="关闭"><X size={16} /></button></div>
            <p className="muted small">围绕单词本里的词条出题，题型混搭：词义辨析 / 填空 / 中译英 / 改错 / 用法判断。</p>
            <label>出题范围
              <select className="ocr-mode" value={quizScope} onChange={(e) => setQuizScope(e.target.value)} style={{ marginLeft: 8 }}>
                {activeBook ? <option value="book">当前本子：{activeBook.name}（{activeBook.entries.length}）</option> : null}
                <option value="all">全部词条（{stats.entries}）</option>
              </select>
            </label>
            <label>题目数量
              <select className="ocr-mode" value={quizCount} onChange={(e) => setQuizCount(Number(e.target.value))} style={{ marginLeft: 8 }}>
                {QUIZ_COUNTS.map((n) => <option key={n} value={n}>{n} 题</option>)}
              </select>
            </label>
            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => setQuizSetupOpen(false)}>取消</button>
              <button className="primary-btn" onClick={runQuiz}><Sparkles size={15} />开始出题</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ================= 复习 ================= */
function ReviewPane({ queue, index, revealed, schedule, onReveal, onGrade, onExit }) {
  const cur = queue[index]
  if (!cur) return null
  const s = scheduleOf(schedule, cur.id, cur.createdAt)
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
          <button className="icon-btn" title="朗读" aria-label="朗读" onClick={() => speak(cur.head)}><Volume2 size={16} /></button>
        </div>
        <p className="muted small">先回想它的意思与用法，再翻面核对。</p>

        {revealed ? (
          <div className="review-answer">
            <div className="chips">
              {cur.pos ? <span className="chip">{cur.pos}</span> : null}
              {cur.register ? <span className="chip">{cur.register}</span> : null}
              {cur.tone ? <span className="chip">{cur.tone}</span> : null}
              {cur.strength ? <span className="chip">强度 {cur.strength}</span> : null}
            </div>
            <p><strong>{(cur.meanings && cur.meanings[0] && cur.meanings[0].cn) || cur.brief}</strong></p>
            {cur.brief ? <p className="muted">{cur.brief}</p> : null}
            {cur.synonyms && cur.synonyms[0] ? (
              <p className="muted small">与 <b>{cur.synonyms[0].word}</b> 的差别：{cur.synonyms[0].diff}</p>
            ) : null}
            {cur.examples && cur.examples[0] ? (
              <div className="example-line">
                <em>{cur.examples[0].en}</em>
                <button className="icon-btn" title="朗读例句" aria-label="朗读例句" onClick={() => speak(cur.examples[0].en)}><Volume2 size={12} /></button>
                <span>{cur.examples[0].cn}</span>
              </div>
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
          <button className="primary-btn big" onClick={onReveal}>显示答案</button>
        )}
      </div>
    </section>
  )
}

/* ================= AI 设置（与回译本一致） ================= */
function SettingsModal({ settings, onClose, onSave }) {
  const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '', ...settings })
  const field = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
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
