import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookMarked, ChevronRight, Cloud, FileDown, Flame, FolderPlus, LoaderCircle, LogIn,
  PanelLeftClose, PanelLeftOpen, Search, Settings, Sparkles, Star, Trash2, Volume2, X,
} from 'lucide-react'
import { getStatus, lookup, getLookupJob, quiz as quizApi, getQuizJob, pullCloudSync, pushCloudSync } from './api.js'
import {
  POLL_LOOKUP_MS, POLL_QUIZ_MS, TIMEOUT_LOOKUP_MS, TIMEOUT_QUIZ_MS, POLL_MAX_FAILURES,
  TIP_LONG_MS, TIP_NORMAL_MS,
} from './constants.js'
import { submitAndPoll } from './hooks/pollJob.js'
import {
  SIDE_STATE_KEY,
  LEVEL_KEY, loadBooks, loadDays, loadDeletedBooks, loadDeletedEntries, loadHistory,
  loadDeletedFavorites, loadFavorites, loadSchedule, loadSettings, localSnapshot, makeHistoryItem,
  mergeSnapshot, pushHistory, safeGet, saveDeletedFavorites, saveFavorites,
  safeSet, saveBooks, saveDays, saveDeletedBooks, saveDeletedEntries, saveHistory,
  saveSchedule, saveSettings,
} from './storage.js'
import {
  KIND_LABEL, allEntries, createBook, entryLabel, entryTombstoneKey, findEntryBook,
  removeBook, removeEntry, summarizeBooks, upsertEntry,
} from './wordbook.js'
import { GRADE_KEYS, GRADES, addStudyDay, dueEntries, gradeHint, scheduleOf, sm2Review, summarizeStreak } from './review.js'
import { FILTERS, SORTS, filterEntries, sortEntries } from './filterSort.js'
import { speak } from './speak.js'
import { addFavorite, attachEntryToFavorite, findFavorite, removeFavorite } from './favorites.js'
import { deviceId, loadSyncCode, loadSyncMeta, newSyncCode, saveSyncCode, saveSyncMeta, syncOnce } from './sync.js'
import {
  authConfig, bindSyncCode, changePassword as apiChangePassword, deleteAccount as apiDelete,
  fetchMe, forgot as apiForgot, loadToken, loadUser, pullSyncCode, resetPassword as apiReset,
  saveToken, saveUser, signIn, signOut as apiSignOut, signOutAll as apiSignOutAll, signUp,
} from './account.js'
import EntryCard from './components/EntryCard.jsx'
import PrintSheet from './components/PrintSheet.jsx'
import QuizPane from './components/QuizPane.jsx'
import BackupModal from './components/modals/BackupModal.jsx'
import AuthModal from './components/modals/AuthModal.jsx'
import FavoritesModal from './components/modals/FavoritesModal.jsx'

const LEVELS = ['小初', '高考英语', '四六级', '考研/专四', '专八']
const QUIZ_COUNTS = [5, 10, 15, 20]

export default function App() {
  /* ---------- 本机数据（全部经 safeGet/safeSet，无痕模式下不能白屏） ---------- */
  const [books, setBooks] = useState(loadBooks)
  const [schedule, setSchedule] = useState(loadSchedule)
  const [days, setDays] = useState(loadDays)
  const [history, setHistory] = useState(loadHistory)
  const [favorites, setFavorites] = useState(loadFavorites)
  const [deletedFavorites, setDeletedFavorites] = useState(loadDeletedFavorites)
  const [favOpen, setFavOpen] = useState(false)
  const [deletedBooks, setDeletedBooks] = useState(loadDeletedBooks)
  const [deletedEntries, setDeletedEntries] = useState(loadDeletedEntries)
  const [settings, setSettings] = useState(loadSettings)
  const [level, setLevel] = useState(() => localStorage.getItem(LEVEL_KEY) || '四六级')
  const [status, setStatus] = useState(null)

  /* ---------- 界面状态 ---------- */
  const [view, setView] = useState('search')          // search | review | book | quiz
  /* 侧栏开合。
   * ⚠️ 手机端必须**默认收起**：≤900px 时侧栏是 position:fixed 的整屏抽屉，
   * 默认展开就会把主界面整个盖住（实测在 390px 宽的手机上页面完全没法用）。
   * 桌面端则记住上次的选择。 */
  /* ---------- 打印 / 导出 PDF ----------
   * 统一的出口：词条、整本、自测题都走这里。屏幕上看不见的 .print-sheet 负责承载内容，
   * 打印那一刻由 body.printing 把主界面藏起来（见 styles.css 的 @media print）。
   * 早先只有自测题能导出，而且各写各的 window.print() —— 加一个"导出这个/整本"就必然漏样式。 */
  const [printJob, setPrintJob] = useState(null)
  useEffect(() => {
    if (!printJob) return undefined
    document.body.classList.add('printing')
    // afterprint 在"取消"和"打印完成"后都会触发，用它收尾最稳；
    // 再挂一个兜底定时器，防止某些环境不触发 afterprint 导致 body 永远停在 printing。
    const cleanup = () => { document.body.classList.remove('printing'); setPrintJob(null) }
    window.addEventListener('afterprint', cleanup)
    const fire = setTimeout(() => window.print(), 80)
    const safety = setTimeout(cleanup, 60_000)
    return () => {
      clearTimeout(fire); clearTimeout(safety)
      window.removeEventListener('afterprint', cleanup)
      document.body.classList.remove('printing')
    }
  }, [printJob])

  /* 上次同步时间的"显示用"副本：syncMeta 只在弹窗里读，顶栏也要能看到才安心 */
  const [lastSyncAt, setLastSyncAt] = useState(() => Number(loadSyncMeta().lastSyncAt) || 0)
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 900) return false
    return safeGet(SIDE_STATE_KEY, '') !== 'collapsed'
  })
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
  /* 账号里是否存过同步码（启动时只拿得到这个事实 —— 解它需要密码，见 afterAuth） */
  const [accountHasSync, setAccountHasSync] = useState(false)
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

  const toggleSidebar = useCallback(() => {
    const next = !sidebarOpen
    safeSet(SIDE_STATE_KEY, next ? 'open' : 'collapsed')
    setSidebarOpen(next)
  }, [sidebarOpen])
  /* 手机端选完东西要把抽屉收起来 —— 不然点开一个单词本，抽屉还压在上面，
     用户看到的还是侧栏，会以为"点了没反应"。（桌面端不动：侧栏本来就常驻。） */
  const closeSidebarOnMobile = useCallback(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 900) setSidebarOpen(false)
  }, [])

  /* ---------- 派生 ---------- */
  const persistBooks = useCallback((next) => { setBooks(next); saveBooks(next) }, [])
  const persistSchedule = useCallback((next) => { setSchedule(next); saveSchedule(next) }, [])
  const persistFavorites = useCallback((next) => { setFavorites(next); saveFavorites(next) }, [])
  const markStudied = useCallback(() => setDays((d) => { const n = addStudyDay(d); saveDays(n); return n }), [])
  const entries = useMemo(() => allEntries(books), [books])
  const stats = useMemo(() => summarizeBooks(books), [books])
  const streak = useMemo(() => summarizeStreak(days), [days])
  const due = useMemo(() => dueEntries(entries, schedule), [entries, schedule])
  const activeBook = books.find((b) => b.id === activeBookId) || null
  // 「能不能查」= 自己在设置里填了 Key，或者**服务端有 Key 且允许访客借用**。
  // 少了后半句的判断，ALLOW_SERVER_KEY=0 的站点会一直显示"AI 已配置"，
  // 用户点查询却收到一句让他去改服务端 .env 的报错 —— 那是给站长看的，不是给他看的。
  const hasKey = Boolean(settings.apiKey || (status?.hasKey && status?.serverKeyAllowed !== false))
  const local = useMemo(
    () => localSnapshot({ books, schedule, days, history, favorites, deletedBooks, deletedEntries, deletedFavorites }),
    [books, schedule, days, history, favorites, deletedBooks, deletedEntries, deletedFavorites],
  )

  /* ---------- 查词（核心链路：提交 → 轮询 → 卡片） ---------- */
  const runLookup = async (term, { saveToBookId } = {}) => {
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
      // 连词条快照一起存：点历史要能**直接回到这张卡片**，而不是把词填回搜索框再查一次
      const nextHistory = pushHistory(history, makeHistoryItem(e))
      setHistory(nextHistory); saveHistory(nextHistory)
      // 这个词如果是从收藏夹点过来查的，把完整词条补进那条收藏（之后「加入词库」就能一步完成）
      setFavorites((list) => {
        const next = attachEntryToFavorite(list, e)
        if (next !== list) saveFavorites(next)
        return next
      })
      // 从收藏夹点「查后加入」：查完直接落进选中的本子，省掉"再点一次保存"
      if (saveToBookId) {
        const { list, replaced } = upsertEntry(books, saveToBookId, e)
        persistBooks(list)
        if (!replaced) persistSchedule({ ...schedule, [e.id]: scheduleOf(schedule, e.id, e.createdAt) })
        const book = list.find((b) => b.id === saveToBookId)
        flash('已加入「' + (book ? book.name : '') + '」：' + e.head, TIP_LONG_MS)
        setActiveBookId(saveToBookId)
      }
      markStudied()
    } catch (err) {
      setError(err.message || '查询失败'); setProgress('')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 点「最近查过」：有快照就直接回到那张卡片，没有就重查一次。
   *
   * 为什么还要管"没有快照"的情况：这个功能上线前存下的历史只有 {id, head}，
   * 用户点它时预期是"跳转到查完的界面"，所以这里**自动补查**，而不是把词填回搜索框干等 ——
   * 老行为正是用户反馈的那句"点这个最近查过的单词不能直接跳转"。
   * 已经收进单词本的词条优先用本子里那份（可能被手动改过）。
   */
  const openHistory = (h) => {
    if (!h) return
    setQuery(h.head || '')
    setView('search')
    const saved = h.id ? findEntryBook(books, h.id) : null
    const inBook = saved ? (saved.entries || []).find((e) => e.id === h.id) : null
    if (inBook) { setEntry(inBook); setError(''); return }
    if (h.entry) { setEntry(h.entry); setError(''); return }
    runLookup(h.head)
  }

  /* ---------- 收藏夹 ----------
   * 收藏的是"待细看"的词：近义词行上点 ⭐ 就进来，回头点一下就有完整讲解。
   * 删除留墓碑（与词条同一套机制），否则删掉的收藏会在下一次同步里被云端旧副本复活。 */
  const isFavorite = useCallback((head) => Boolean(findFavorite(favorites, head)), [favorites])
  const toggleFavorite = useCallback((syn, fromEntry) => {
    const head = String((syn && syn.word) || '').trim()
    if (!head) return
    const existing = findFavorite(favorites, head)
    if (existing) {
      persistFavorites(removeFavorite(favorites, existing.id))
      const tomb = [...deletedFavorites, existing.id]
      setDeletedFavorites(tomb); saveDeletedFavorites(tomb)
      flash('已取消收藏：' + head)
      return
    }
    const next = addFavorite(favorites, {
      head,
      brief: (syn && syn.cn) || '',
      phonetic: (syn && syn.phonetic) || '',
      register: (syn && syn.register) || '',
      tone: (syn && syn.tone) || '',
      strength: (syn && syn.strength) || '',
      from: (fromEntry && fromEntry.head) || '',
    })
    persistFavorites(next)
    flash('已收藏「' + head + '」—— 在左侧收藏夹里可以点它查详细讲解，或直接加进单词本', TIP_LONG_MS)
  }, [favorites, deletedFavorites, persistFavorites, flash])

  /* 收藏夹里的词：查过就直接打开那张卡片，没查过就自动查一次。
     写成普通函数而不是 useCallback —— 它依赖 runLookup，而 runLookup 每次渲染都是新的身份，
     包成 useCallback 只会一路把依赖传染出去（和 openHistory 一样处理）。 */
  const openFavorite = (fav) => {
    if (!fav) return
    setFavOpen(false)
    closeSidebarOnMobile()
    if (fav.entry) {
      setEntry(fav.entry); setQuery(fav.head); setView('search'); setError('')
      return
    }
    setQuery(fav.head)
    runLookup(fav.head)
  }

  /**
   * 把收藏夹里的词加进某个单词本。
   * 没查过的话**先查再存**：本子里该放完整卡片，塞半成品只会把本子搞脏 ——
   * 但也不该让用户自己去别处查一遍再回来，点一次就把两件事做完。
   */
  const addFavoriteToBook = async (fav, bookId) => {
    if (!fav || !bookId) return
    if (fav.entry) {
      const { list, replaced } = upsertEntry(books, bookId, fav.entry)
      persistBooks(list)
      if (!replaced) persistSchedule({ ...schedule, [fav.entry.id]: scheduleOf(schedule, fav.entry.id, fav.entry.createdAt) })
      const book = list.find((b) => b.id === bookId)
      flash('已加入「' + (book ? book.name : '') + '」：' + fav.head, TIP_LONG_MS)
      setActiveBookId(bookId)
      return
    }
    setFavOpen(false)
    setQuery(fav.head)
    await runLookup(fav.head, { saveToBookId: bookId })
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
    persistFavorites(merged.favorites || [])
    setDeletedBooks(merged.deletedBooks); saveDeletedBooks(merged.deletedBooks)
    setDeletedEntries(merged.deletedEntries); saveDeletedEntries(merged.deletedEntries)
    setDeletedFavorites(merged.deletedFavorites || []); saveDeletedFavorites(merged.deletedFavorites || [])
    flash(`导入完成：新增 ${merged.added.booksAdded} 个单词本、${merged.added.entriesAdded} 个词条`
      + (merged.favorites && merged.favorites.length ? `、收藏夹共 ${merged.favorites.length} 条` : ''), TIP_LONG_MS)
  }

  /* ---------- 云同步 ---------- */
  const applyMerged = useCallback((merged) => {
    persistBooks(merged.books); persistSchedule(merged.review)
    persistFavorites(merged.favorites || [])
    setDays(merged.days); saveDays(merged.days)
    setHistory(merged.history); saveHistory(merged.history)
    setDeletedBooks(merged.deletedBooks); saveDeletedBooks(merged.deletedBooks)
    setDeletedEntries(merged.deletedEntries); saveDeletedEntries(merged.deletedEntries)
    setDeletedFavorites(merged.deletedFavorites || []); saveDeletedFavorites(merged.deletedFavorites || [])
  }, [persistBooks, persistSchedule, persistFavorites])

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
      const a = settled.added || {}
      const mine = { books: (settled.books || []).length, entries: (settled.books || []).reduce((n, b) => n + ((b.entries || []).length), 0) }
      const meta = {
        ...loadSyncMeta(), lastSyncAt: Date.now(), version: res.version,
        // 记下双方的数量：这是排查"为什么没同步过来"时唯一有用的两个数字，
        // 以前界面上一个都没有，只能靠猜（这次就吃了这个亏）
        localBooks: mine.books, localEntries: mine.entries,
        cloudBeforeBooks: res.cloudBefore ? res.cloudBefore.books : undefined,
        cloudBeforeEntries: res.cloudBefore ? res.cloudBefore.entries : undefined,
        pushedBooks: res.pushed ? res.pushed.books : undefined,
        pushedEntries: res.pushed ? res.pushed.entries : undefined,
      }
      // 推送后**回读校验**：这一条是为"推上去了但云端还是空的"那类静默故障加的。
      // 只信 pushCloudSync 的 200 是不够的 —— 数据可能在服务端被清洗掉、或写到了别的地方；
      // 回读一次拿真实数量对比，对不上就当场说出来（并给出「用本机覆盖云端」这条出路）。
      let verified = true
      try {
        const back = await pullCloudSync(code)
        const rb = (back && back.data && back.data.books) || []
        if (mine.books > 0 && rb.length < mine.books) verified = false
      } catch { /* 回读失败不影响本次同步结论，只是少一层确认 */ }
      meta.verified = verified
      saveSyncMeta(meta); setSyncMeta(meta); setLastSyncAt(meta.lastSyncAt)
      const localPart = `本机 ${mine.books} 个本子（${mine.entries} 个词条）`
      if (!verified) {
        setSyncTip(`⚠️ 同步异常：本机 ${mine.books} 个本子已上传，但云端回读只有更少的内容。`
          + '请点「用本机覆盖云端」把本机数据强制推上去，再在另一台设备点「立即同步」。')
      } else if (manual) {
        if (a.booksAdded || a.entriesAdded) setSyncTip(`同步完成：从云端新增 ${a.booksAdded} 个本子、${a.entriesAdded} 个词条 · ${localPart}`)
        else if (res.cloudBefore && res.cloudBefore.books === 0 && mine.books > 0) {
          // 本机有数据、云端却是空的 —— 这多半不是"已是最新"，而是哪里没对上，
          // 必须说出来（并给出"用本机数据覆盖云端"这条出路），不能粉饰成一句"已是最新"
          setSyncTip(`注意：云端这串码里是空的，本机有 ${mine.books} 个本子。已把本机数据推送上去；`
            + '若另一台设备仍看不到，请在那台设备上点「立即同步」。')
        } else setSyncTip(`同步完成：已是最新 · ${localPart}`)
      } else if (a.booksAdded || a.entriesAdded) flash('已从云端同步到新内容', TIP_LONG_MS)
    } catch (e) {
      setSyncTip('同步失败：' + (e.message || '网络错误'))
    } finally {
      syncBusyRef.current = false; setSyncBusy(false)
    }
  }, [syncCode, applyMerged, flash])

  /**
   * 用本机数据**覆盖**云端（不做合并）。
   * 这是同步类工具的标配逃生口：合并逻辑一旦有一边不对劲（比如云端那串码被写成了空壳），
   * 用户就完全没有办法把数据推上去 —— 只能换码重来，等于把另一台设备的数据也丢了。
   */
  const forcePush = async () => {
    if (!syncCode) { setSyncTip('还没有同步码'); return }
    const mine = { books: (localRef.current.books || []).length, entries: (localRef.current.books || []).reduce((n, b) => n + ((b.entries || []).length), 0) }
    if (!window.confirm(`用本机数据覆盖云端？

本机：${mine.books} 个本子（${mine.entries} 个词条）
`
      + '云端原有内容会被本机这份替换（另一台设备的旧数据不再保留，但两台设备各自的浏览器里仍有本地副本）。')) return
    if (syncBusyRef.current) return
    syncBusyRef.current = true; setSyncBusy(true); setSyncTip('正在上传本机数据…')
    try {
      const head = await pullCloudSync(syncCode).catch((e) => (e && e.status === 404
        ? { version: 0, data: {} }
        : Promise.reject(e)))
      const snap = localRef.current
      const r = await pushCloudSync(syncCode, {
        baseVersion: Number(head.version) || 0,
        device: deviceId(),
        data: {
          books: snap.books || [], review: snap.review || {}, days: snap.days || [],
          history: snap.history || [], favorites: snap.favorites || [],
          deletedBooks: snap.deletedBooks || [], deletedEntries: snap.deletedEntries || [],
          deletedFavorites: snap.deletedFavorites || [],
        },
      })
      if (!r.ok) { setSyncTip('覆盖失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status))); return }
      const meta = { ...loadSyncMeta(), lastSyncAt: Date.now(), version: r.data.version, localBooks: mine.books, localEntries: mine.entries }
      saveSyncMeta(meta); setSyncMeta(meta); setLastSyncAt(meta.lastSyncAt)
      setSyncTip(`已用本机数据覆盖云端：${mine.books} 个本子、${mine.entries} 个词条。另一台设备点「立即同步」即可拿到。`)
    } catch (e) {
      setSyncTip('覆盖失败：' + (e.message || '网络错误'))
    } finally {
      syncBusyRef.current = false; setSyncBusy(false)
    }
  }

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

  /* ---------- 账号 ----------
   * ⚠️ 这条链路里同步码**只有明文形态在浏览器内流转**：
   * 发给服务端的永远是密文（用账号密码派生密钥加密），从服务端拿回来的要先用密码解开。
   * 移植时漏掉这一步会出两种真故障 —— 绑定必然 400，或者把密文当同步码用（换设备拉不到数据，
   * 还会把本机原来那串好码覆盖掉）。所以 afterAuth 一定要拿的 `password` 就是这个用途。 */
  const afterAuth = useCallback(async (r, password) => {
    if (!r.ok) { setAuthTip(r.error || '操作失败'); return }
    const token = r.token || (account && account.token) || ''
    const email = r.email || (r.user && r.user.email) || (account && account.email) || ''
    setAccount({ token, email }); saveToken(token); saveUser({ email })
    setAccountHasSync(Boolean(r.hasSync))
    setAuthOpen(false); setAuthTip('')

    if (r.syncError) {
      setAuthTip(r.syncError)
      flash('已登录：' + email + '（同步码需重新设置）', TIP_LONG_MS)
      return
    }
    // 解开账号里存的同步码 → 这台设备就接上了（换设备不用手抄）
    if (r.syncCode) {
      saveSyncCode(r.syncCode); setSyncCode(r.syncCode)
      setSyncTip('已从账号取回同步码')
      runSync(true, r.syncCode)
      flash('已登录：' + email)
      return
    }
    // 账号里没存过同步码（首次登录 / 老账号）：
    //  · 本机有码 → **立刻绑上去**。不绑的话这台设备会一直用自己的码，和别的设备永远碰不上面；
    //  · 本机也没码（新设备先登录）→ 明确告诉用户下一步该做什么，别让他对着"已登录"发呆。
    if (syncCode && password) {
      const b = await bindSyncCode(token, syncCode, password)
      setSyncTip(b.ok ? '已把本机同步码存进账号 —— 换设备登录后会自动带回来' : ('同步码保存失败：' + (b.error || '')))
    } else if (!syncCode) {
      setSyncTip('这台设备还没有同步码。请先在**有数据的那台设备**上登录一次（会自动把码存进账号），再回到这里点「从账号取回同步码」。')
    }
    flash('已登录：' + email)
  }, [account, flash, runSync, syncCode])

  const doSignIn = async (email, password) => {
    setAuthBusy(true); setAuthTip('')
    // 已登录后 if/else 分支里要 await，所以这里不 setAuthBusy(false) 收尾会有竞态；
    // 交给 afterAuth 结束后统一收（它在 finally 里没机会，所以显式 await 完再收）。
    await afterAuth(await signIn({ email, password, device: loadSyncMeta().device || '' }), password)
    setAuthBusy(false)
  }
  const doSignUp = async (email, password) => {
    setAuthBusy(true); setAuthTip('')
    await afterAuth(await signUp({ email, password, syncCode }), password)
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
  /* 把本机同步码存进账号。**必须带账号密码** —— 服务端只存密文，加密要在本地做 */
  const doBindSync = async (password) => {
    if (!syncCode) return
    if (!password) { setSyncTip('请先填写账号密码（同步码要用它加密后才发出去）'); return }
    setSyncBusy(true)
    const r = await bindSyncCode(account.token, syncCode, password)
    setSyncTip(r.ok ? '同步码已加密存进账号 —— 换设备登录后会自动带回来' : ('保存失败：' + (r.error || '')))
    setSyncBusy(false)
  }
  /**
   * 从账号把同步码取回来（已登录、但本机还没码时用）。
   * 用户实际踩到的场景：手机上登录了同一个账号，却什么都没有同步 ——
   * 因为**账号里当时压根没有同步码**（那台有数据的设备还没把码存进去），
   * 而界面只会显示"已登录"，没有任何下一步提示。现在有这条明确路径 + 明确文案。
   */
  const doPullSync = async (password) => {
    if (!password) { setSyncTip('请填写账号密码（同步码是用它加密的，只有你能解开）'); return }
    setSyncBusy(true)
    const r = await pullSyncCode(account.token, password)
    if (r.ok) {
      saveSyncCode(r.syncCode); setSyncCode(r.syncCode)
      setSyncTip('已从账号取回同步码，正在同步…')
      await runSync(true, r.syncCode)
    } else setSyncTip(r.error || '取回失败')
    setSyncBusy(false)
  }

  /* 改密码：**同时用新密码重新加密同步码**，否则别的设备再也解不开 */
  const doChangePassword = async (oldPassword, newPassword) => {
    setAuthBusy(true)
    const r = await apiChangePassword({ token: account.token, oldPassword, newPassword, syncCode })
    if (r.ok) {
      if (r.token) { saveToken(r.token); setAccount({ token: r.token, email: account.email }) }
      setAuthTip('')
      flash('密码已修改' + (syncCode ? '（同步码已用新密码重新加密）' : ''))
    } else setAuthTip(r.error || '修改失败')
    setAuthBusy(false)
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
        // 这里**不能**把 r.sync 当同步码用：那是密文，解它需要账号密码（启动时没有）。
        // 只记下"账号里有码"这个事实，界面上提示用户登录一次即可自动取回。
        const hasSync = Boolean(r.hasSync)
        setAccountHasSync(hasSync)
        // 静默失败最伤人：已登录、本机有码、账号里却没有 —— 用户会以为"登录了就该自动同步"，
        // 实际换设备时什么都拿不到（用户就是这么踩到的）。给一句明确的下一步，别让他自己猜。
        if (!hasSync && loadSyncCode()) {
          flash('换设备同步还差一步：打开「备份/同步」→「把同步码存到账号」（需要账号密码）', TIP_LONG_MS * 2)
        }
      } else {
        // 令牌失效（改过密码 / 被踢）：清掉，免得后续请求一直 401
        saveToken(''); saveUser({}); setAccount({ token: '', email: '' })
      }
    })
    // flash 是 useCallback([]) —— 身份恒定，放进依赖只是为了让 exhaustive-deps 满意
  }, [flash])

  /* 打开页面自动同步一次（有码才跑） */
  const bootSyncedRef = useRef(false)
  useEffect(() => {
    if (bootSyncedRef.current || !syncCode) return
    bootSyncedRef.current = true
    runSync(false, syncCode)
  }, [syncCode, runSync])

  /**
   * 回到页面时自动同步 —— 用户的原话是"我想之后电脑新增词汇，手机自动同步，反之亦然"。
   * 只在启动时同步一次是不够的：手机上的页面经常一直开着（加到主屏后更是长期驻留），
   * 那样电脑新存的词永远不会自己出现，每次都得手动点「立即同步」。
   *
   * 触发时机：切回前台（visibilitychange）+ 窗口获得焦点 + **页面可见时每 60 秒一次**。
   * 两条节流：距上次同步不足 60 秒不重复跑；同步进行中 runSync 自己会拦。
   * 60 秒这个间隔是权衡过的：快照只有几 KB，一次拉取就是一条 GET ——
   * 一分钟一次、一天 1440 条，离 Upstash 免费额度（50 万条/月）还很远，
   * 换来的是"电脑存完词，手机最多一分钟就自己出现"，这才是用户心里的"自动同步"。
   * 用 runSync(false) —— 后台同步不该弹提示（没新内容时用户不该被打扰），
   * 只有真的同步到了新内容才会 flash 一句。
   */
  useEffect(() => {
    if (!syncCode) return
    const maybeSync = () => {
      if (document.visibilityState !== 'visible') return
      const last = Number(loadSyncMeta().lastSyncAt) || 0
      if (Date.now() - last < 60_000) return
      runSync(false, syncCode)
    }
    const onVisible = () => { if (document.visibilityState === 'visible') maybeSync() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', maybeSync)
    const timer = setInterval(maybeSync, 60_000)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', maybeSync)
      clearInterval(timer)
    }
  }, [syncCode, runSync])

  /* ---------- 本子内的筛选与排序 ---------- */
  const filteredBookEntries = useMemo(() => {
    const base = activeBook ? activeBook.entries : []
    return sortEntries(filterEntries(base, { query: bookQuery, filter: kindFilter }, schedule), sortMode, schedule)
  }, [activeBook, bookQuery, kindFilter, sortMode, schedule])

  return (
    <>
    <div className="app">
      {/* 手机端点侧栏外面任意处即可收起（桌面端这条规则 display:none，不生效） */}
      {sidebarOpen ? <div className="sidebar-backdrop" onClick={toggleSidebar} aria-hidden="true" /> : null}
      <aside className={'sidebar' + (sidebarOpen ? '' : ' collapsed')}>
        <button className="sidebar-close" onClick={toggleSidebar} aria-label="收起侧栏"><X size={18} /></button>
        <div className="brand"><div className="brand-mark">词</div><div><strong>单词本</strong><span>VOCABULARY BOOK</span></div></div>
        <button className="primary-btn" onClick={() => { closeSidebarOnMobile(); createAndSave() }}><FolderPlus size={16} />新建单词本</button>

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
                  closeSidebarOnMobile()
                }}>
                  <span className="lesson-title">{b.name}</span>
                  <span className="lib-count">{b.entries.length}</span>
                </button>
                <button className="lesson-del" onClick={() => deleteBook(b)} title="删除这个单词本" aria-label="删除单词本"><Trash2 size={12} /></button>
              </div>
            ))}
          </div>

          {favorites.length > 0 && (
            <>
              <div className="side-title fav-side-title">
                收藏夹（{favorites.length}）
                <button className="ghost-btn sm" onClick={() => { closeSidebarOnMobile(); setFavOpen(true) }}>管理</button>
              </div>
              <div className="lesson-list" style={{ maxHeight: 150 }}>
                {favorites.slice(0, 20).map((f) => (
                  <button key={f.id} className="lesson-item" onClick={() => openFavorite(f)}
                    title={f.entry ? '点一下看它的完整讲解' : '点一下自动查它'}>
                    <Star size={12} className="fav-side-star" />
                    <span className="lesson-title">{f.head}</span>
                    {f.entry ? null : <span className="muted small">待查</span>}
                  </button>
                ))}
              </div>
            </>
          )}

          {history.length > 0 && (
            <>
              <div className="side-title">最近查过</div>
              <div className="lesson-list" style={{ maxHeight: 150 }}>
                {history.slice(0, 20).map((h) => (
                  <button key={h.id} className="lesson-item" onClick={() => { closeSidebarOnMobile(); openHistory(h) }}
                    title={h.entry ? '点一下回到上次查到的讲解' : '点一下重新查这个词'}>
                    <span className="lesson-title">{h.head}</span>
                    {h.entry ? null : <span className="muted small">需重查</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="side-footer">
          <button className="ghost-btn" onClick={() => { closeSidebarOnMobile(); setSettingsOpen(true) }}><Settings size={15} />AI 设置</button>
          <button className="ghost-btn" onClick={() => { closeSidebarOnMobile(); setBackupOpen(true) }}><Cloud size={15} />备份/同步</button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="icon-btn side-toggle" onClick={toggleSidebar}
            title={sidebarOpen ? '收起侧栏' : '展开侧栏'} aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}>
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
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
            {status ? (hasKey ? 'AI 已配置' : (status.hasKey ? '需要你自己的 Key' : '未配置 API Key')) : '后端未连接'}
            <span className="chip-detail">
              {stats.entries} 个词条 · 连续 {streak.current} 天
              {/* 有同步码就把"上次同步时间"摆出来：用户要判断"手机到底同步了没有"，
                  以前只能打开弹窗看，而且看到的还是"同步完成"这种一次性文案 */}
              {syncCode ? ` · 同步 ${lastSyncAt ? new Date(lastSyncAt).toTimeString().slice(0, 5) : '未同步'}` : ''}
            </span>
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
            onExportPdf={() => setPrintJob({ kind: 'quiz', quiz })}
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
                {/* 整本导出：**不受上面的筛选/搜索影响**，永远是本子的全部词条 ——
                    "导出词汇本"就该是整本，导出到一半发现缺词才是坑 */}
                <button className="ghost-btn sm" onClick={() => setPrintJob({ kind: 'book', book: activeBook })}
                  disabled={!activeBook.entries.length} title="把本子里全部词条导出成 PDF（不受筛选影响）">
                  <FileDown size={14} />导出本子 PDF
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
                onExportPdf={(e) => setPrintJob({ kind: 'entry', entry: e })}
                onToggleFavorite={toggleFavorite} isFavorite={isFavorite} onLookupWord={runLookup}
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
          onStopSync={stopSync} onSyncNow={() => runSync(true)} onForcePush={forcePush}
          account={account} accountHasSync={accountHasSync} localSnapshot={local}
          onOpenAuth={() => setAuthOpen(true)} onBindSync={doBindSync} onPullSync={doPullSync} />
      ) : null}

      {authOpen ? (
        <AuthModal config={authCfg} account={account} busy={authBusy} tip={authTip}
          onClose={() => setAuthOpen(false)}
          onSignIn={doSignIn} onSignUp={doSignUp} onSignOut={doSignOut} onSignOutAll={doSignOutAll}
          onForgot={doForgot} onReset={doReset} onDeleteAccount={doDeleteAccount}
          onChangePassword={doChangePassword} />
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

      {favOpen ? (
        <FavoritesModal
          favorites={favorites} books={books} busy={busy}
          onClose={() => setFavOpen(false)}
          onLookup={(f) => { setFavOpen(false); openFavorite(f) }}
          onRemove={(f) => {
            persistFavorites(removeFavorite(favorites, f.id))
            const tomb = [...deletedFavorites, f.id]
            setDeletedFavorites(tomb); saveDeletedFavorites(tomb)
            flash('已从收藏夹移除：' + f.head)
          }}
          onAddToBook={addFavoriteToBook} />
      ) : null}

      {/* 打印页放在 .app 之外：body.printing 时把 .app 整个藏起来、只留它 */}
      <PrintSheet job={printJob} />
    </>
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
