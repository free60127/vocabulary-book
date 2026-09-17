import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { lookup, getLookupJob, quiz as quizApi, getQuizJob, followup, getFollowupJob } from './api.js'
import {
  POLL_LOOKUP_MS, POLL_QUIZ_MS, POLL_FOLLOWUP_MS, TIMEOUT_LOOKUP_MS, TIMEOUT_QUIZ_MS,
  TIMEOUT_FOLLOWUP_MS, POLL_MAX_FAILURES,
  TIP_LONG_MS, TIP_NORMAL_MS,
} from './constants.js'
import { submitAndPoll } from './hooks/pollJob.js'
import { useEscape } from './hooks/useEscape.js'
import { useBooks } from './hooks/useBooks.js'
import { useCloud } from './hooks/useCloud.js'
import { useAuth } from './hooks/useAuth.js'
import {
  SIDE_STATE_KEY, ZH_PICK_KEY, loadFollowups, loadSettings, loadTheme, safeGet, safeSet,
  saveFollowups, saveSettings, saveTheme,
} from './storage.js'
import { applyTheme } from './theme.js'
import { toTop } from './scroll.js'
import { findBookByHead, findEntryBook } from './wordbook.js'
import { hasCJK } from './format.js'
import { useBackendStatus } from './hooks/useBackendStatus.js'
import { headKey, killedSet, nextDueAt } from './review.js'
import { FILTERS, SORTS, filterEntries, sortEntries } from './filterSort.js'
import PrintSheet from './components/PrintSheet.jsx'
import QuizPane from './components/QuizPane.jsx'
import Sidebar from './components/Sidebar.jsx'
import Topbar from './components/Topbar.jsx'
import SearchPane from './components/SearchPane.jsx'
import BookPane from './components/BookPane.jsx'
import ReviewPane from './components/ReviewPane.jsx'
import BackupModal from './components/modals/BackupModal.jsx'
import AuthModal from './components/modals/AuthModal.jsx'
import FavoritesModal from './components/modals/FavoritesModal.jsx'
import SettingsModal from './components/modals/SettingsModal.jsx'
import QuizSetupModal from './components/modals/QuizSetupModal.jsx'
import PrintHintModal from './components/modals/PrintHintModal.jsx'
import { MergeBookModal, NewBookModal, RenameBookModal } from './components/modals/RenameBookModal.jsx'
import KilledModal from './components/modals/KilledModal.jsx'
import WrongBookModal from './components/modals/WrongBookModal.jsx'
import SafetyBanner from './components/SafetyBanner.jsx'
import BackToTop from './components/BackToTop.jsx'
import SentencePane from './components/SentencePane.jsx'
import { useSentencePractice } from './hooks/useSentencePractice.js'
import { useReviewSession } from './hooks/useReviewSession.js'
import { usePrintJob } from './hooks/usePrintJob.js'
import { useLookupStream } from './hooks/useLookupStream.js'
import SentenceBookModal from './components/modals/SentenceBookModal.jsx'
import ReviewSetup from './components/ReviewSetup.jsx'

const LEVELS = ['小初', '高考英语', '四六级', '考研/专四', '专八']
const QUIZ_COUNTS = [5, 10, 15, 20]

/**
 * 界面编排层。
 *
 * 数据与副作用已经分到三个 hook 里（useBooks / useCloud / useAuth），
 * 各个视图也各自成组件（Sidebar / Topbar / EntryCard / QuizPane / modals）——
 * 这里只留"点这个按钮之后发生什么"和"当前在哪一屏"。
 */
export default function App() {
  /* ---------- 轻提示 ----------
   * 定时器只留一个：连续两条提示时，第一条的定时器会把第二条提前清掉
   * （实测第二条只活了 1.6 秒而不是 2.6 秒）。 */
  const [tip, setTip] = useState('')
  const tipTimerRef = useRef(null)
  const flash = useCallback((msg, ms = TIP_NORMAL_MS) => {
    setTip(msg)
    if (tipTimerRef.current) clearTimeout(tipTimerRef.current)
    tipTimerRef.current = setTimeout(() => { tipTimerRef.current = null; setTip('') }, ms)
  }, [])
  useEffect(() => () => { if (tipTimerRef.current) clearTimeout(tipTimerRef.current) }, [])

  /* ---------- 三层：本机数据 / 云同步 / 账号 ---------- */
  const store = useBooks({ flash })
  const {
    books, schedule, history, favorites, local,
    entries, stats, streak, due, todayQueue, sentences, addSentence, deleteSentence,
    markStudied, applyMerged,
    saveEntry, newBook, deleteEntry: dropEntry, deleteBook: dropBook, renameBook, mergeBooksInto,
    pushHistoryEntry, attachFavoriteEntry,
    isFavorite, toggleFavorite, removeFavoriteById,
    killed, revived, killWord, reviveWord, wrongItems, markWrong, clearWrongWord, wrongQueue,
    gradeEntry, exportBackup, importBackup,
  } = store

  /* 外观：跟随系统 / 亮色 / 暗色（首屏由 index.html 的内联脚本先定，这里负责后续切换） */
  const [theme, setTheme] = useState(loadTheme)
  const [settings, setSettings] = useState(loadSettings)
  // ⚠️ 必须走 safeGet：Safari 无痕 / 关闭站点数据时裸调 localStorage 会抛 SecurityError，
  // 而这里在**首次 render 的惰性初始化**里 —— 一抛就是整页白屏。
  const [level, setLevel] = useState(() => safeGet('vb-level', '') || '四六级')
  /* 后端状态：会退避重试、切回页面重试，并且任何一次真实请求成功都会立刻纠正它 */
  const { status, checking: statusChecking, retry: retryStatus, markUp: markBackendUp } = useBackendStatus()

  /* ---------- 界面状态 ---------- */
  const [view, setView] = useState('search')          // search | review | book | quiz
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  const [quizSetupOpen, setQuizSetupOpen] = useState(false)
  const [quizCount, setQuizCount] = useState(10)
  const [quizScope, setQuizScope] = useState('all')
  const [quiz, setQuiz] = useState(null)
  const [quizShow, setQuizShow] = useState(false)
  const [quizBusy, setQuizBusy] = useState(false)
  const [favOpen, setFavOpen] = useState(false)
  const [bookQuery, setBookQuery] = useState('')
  const [kindFilter, setKindFilter] = useState('all')
  const [sortMode, setSortMode] = useState('default')
  const [renameTarget, setRenameTarget] = useState(null)
  const [mergeTarget, setMergeTarget] = useState(null)
  const [killedOpen, setKilledOpen] = useState(false)
  const [wrongOpen, setWrongOpen] = useState(false)
  /* 数据安全横幅：关掉只记本次会话 —— "你的数据只在这台浏览器里"值得重复提醒 */
  const [safetyHidden, setSafetyHidden] = useState(() => {
    try { return sessionStorage.getItem('vb-safety-hidden') === '1'; } catch { return false; }
  })
  const hideSafety = () => {
    setSafetyHidden(true)
    try { sessionStorage.setItem('vb-safety-hidden', '1'); } catch { /* 无痕模式忽略 */ }
  }
  /* 追问：答案只留本机（不进云同步），按词条 id 存 */
  const [followups, setFollowups] = useState(loadFollowups)
  const [askBusy, setAskBusy] = useState(false)
  const [askError, setAskError] = useState('')
  const cloud = useCloud({ getLocal: () => local, applyMerged, flash })
  const {
    syncCode, syncMeta, syncTip, syncBusy, lastSyncAt,
    runSync, forcePush, startNewSync, useExistingCode, copySyncCode, stopSync,
  } = cloud
  /* 中文查词：先给候选词（内联在搜索栏下面），用户挑一个再讲解 */
  const [zhQuery, setZhQuery] = useState('')
  const [zhCandidates, setZhCandidates] = useState([])

  /** 卸载后不要再 setState（轮询回调可能在卸载之后才回来） */
  const aliveRef = useRef(true)
  /** 流式查词：边生成边看（不可用时自动回退到下面的轮询链路） */
  const stream = useLookupStream({ aliveRef })

  /* 造句练习：抽词口径与复习一致（本子 + 收藏，斩掉的排除） */
  const sentencePool = useMemo(
    () => [...new Map([...due, ...todayQueue].map((x) => [x.key, x])).values()],
    [due, todayQueue],
  )
  const sentence = useSentencePractice({
    pool: sentencePool,
    fallbackWords: entries.map((e) => ({ key: e.id, head: e.head, entry: e, kind: 'entry' })),
    aliveRef, level, settings, markWrong, clearWrongWord, addSentence, sentences,
  })

  const auth = useAuth({ cloud, flash })
  const {
    account, authCfg, authBusy, authTip, authOpen, setAuthOpen, accountHasSync,
    doSignIn, doSignUp, doSignOut, doSignOutAll, doForgot, doReset, doDeleteAccount, doChangePassword,
  } = auth
  const doBindSync = useCallback((pw) => cloud.bindCode(account.token, pw), [cloud, account.token])
  const doPullSync = useCallback((pw) => cloud.pullCode(account.token, pw), [cloud, account.token])

  /* 打印 / 导出 PDF：平台差异与收尾逻辑都在 hook 里 */
  const print = usePrintJob()

  useEffect(() => () => { aliveRef.current = false }, [])

  /* 内联弹窗的 ESC 出口；设置、备份、账号、收藏夹在各自组件里 */
  useEscape(() => setQuizSetupOpen(false), quizSetupOpen)
  useEscape(() => print.setHint(null), Boolean(print.hint))
  useEscape(() => setRenameTarget(null), Boolean(renameTarget))
  useEscape(() => setMergeTarget(null), Boolean(mergeTarget))
  useEscape(() => setKilledOpen(false), killedOpen)
  useEscape(() => setWrongOpen(false), wrongOpen)

  useEffect(() => { safeSet('vb-level', level) }, [level])
  /* 主题：写 <html data-theme>；选"跟随系统"时，系统主题变了要立刻跟上 */
  useEffect(() => {
    saveTheme(theme)
    applyTheme(theme)
    if (theme !== 'system' || typeof window === 'undefined' || !window.matchMedia) return undefined
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme('system')
    if (mq.addEventListener) mq.addEventListener('change', onChange)
    else mq.addListener(onChange)          // 老 Safari
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange)
      else mq.removeListener(onChange)
    }
  }, [theme])
  useEffect(() => { saveFollowups(followups) }, [followups])

  /* 搜索框自动聚焦：**只在桌面端**。
     手机上 autoFocus 会在页面刚打开时就弹出软键盘，把首屏那句"查一个词，得到什么"的
     引导说明盖掉一大半 —— 用户第一眼看到的是键盘而不是产品。 */
  const searchRef = useRef(null)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const coarse = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
      || window.innerWidth <= 900
    if (!coarse) searchRef.current?.focus()
  }, [])

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      safeSet(SIDE_STATE_KEY, open ? 'collapsed' : 'open')
      return !open
    })
  }, [])
  /* 手机端选完东西要把抽屉收起来 —— 不然点开一个单词本，抽屉还压在上面，
     用户看到的还是侧栏，会以为"点了没反应"。（桌面端不动：侧栏本来就常驻。） */
  const closeSidebarOnMobile = useCallback(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 900) setSidebarOpen(false)
  }, [])

  /* 手机端抽屉打开时锁住背后的滚动。 */
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const mobile = typeof window !== 'undefined' && window.innerWidth <= 900
    document.body.classList.toggle('drawer-open', Boolean(mobile && sidebarOpen))
    return () => document.body.classList.remove('drawer-open')
  }, [sidebarOpen])

  /* ---------- 返回键 / 历史记录 ----------
   * 手机上"返回"是系统级手势或实体键。SPA 不接管的话它直接退出整个页面：
   * 复习到一半按一下返回 = 关掉应用。做法：把「当前视图 + 打开的弹窗」压进历史，
   * popstate 时按状态还原 —— 返回键的语义变成"回到上一个界面"，一路退到头才真的离开。 */
  const NAV_KEY = 'vbNav'
  const modalName = settingsOpen ? 'settings' : backupOpen ? 'backup' : authOpen ? 'auth'
    : favOpen ? 'favorites' : quizSetupOpen ? 'quiz' : print.hint ? 'printHint'
      : killedOpen ? 'killed' : wrongOpen ? 'wrong' : renameTarget ? 'rename' : mergeTarget ? 'merge' : ''
  const applyNavState = useCallback((st) => {
    if (!st) return
    setView(st.view || 'search')
    setActiveBookId(st.bookId || '')
    // 复习队列是会话内的（刷新后重建），历史里只恢复视图/本子/弹窗
    
    setSettingsOpen(st.modal === 'settings')
    setBackupOpen(st.modal === 'backup')
    setAuthOpen(st.modal === 'auth')
    setFavOpen(st.modal === 'favorites')
    setQuizSetupOpen(st.modal === 'quiz')
    setKilledOpen(st.modal === 'killed')
    setWrongOpen(st.modal === 'wrong')
    if (st.modal !== 'printHint') print.setHint(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- print.setHint 是稳定引用（useCallback 包装）
  }, [setAuthOpen])
  const navPushedRef = useRef(false)
  const navSkipPushRef = useRef(false)
  const prevModalRef = useRef('')
  /* 弹窗被**界面**关掉（点 X / 点遮罩 / 按 ESC / 提交完成）时，历史里那条"弹窗"记录还在 ——
     不弹掉的话，用户下一次按返回会遇到一条"什么都不发生"的记录（实测：按了没反应）。
     这里统一收口：只要上一个状态是弹窗、现在是空，就把那条记录 back() 掉。 */
  useEffect(() => {
    const prev = prevModalRef.current
    prevModalRef.current = modalName
    if (typeof window === 'undefined' || !window.history) return
    if (!prev || modalName) return
    const st = window.history.state && window.history.state[NAV_KEY]
    if (!st || st.modal !== prev) return
    const sameView = st.view === view && (st.bookId || '') === (activeBookId || '')
    if (sameView) {
      // 只是把弹窗关掉：这条记录退回去即可（退到的状态与当前完全一致，界面不会动）
      navSkipPushRef.current = true
      window.history.back()
    } else {
      // ⚠️ 关弹窗的同时还切了视图（典型：点「开始出题」→ 关弹窗 + 跳试卷页）。
      // 这种情况**不能** back()：退回去的是"开弹窗之前"那一屏，会把刚设好的视图覆盖掉 ——
      // 实测表现为"点了开始出题，结果回到搜索页，试卷永远不出现"。
      // 改成把这条"弹窗记录"就地改写成新视图的记录，栈里不留死记录，也不会触发 popstate。
      window.history.replaceState({ [NAV_KEY]: { view, bookId: activeBookId || '', modal: '' } }, '')
    }
    // 只关心 modalName 的"从有到无"这一次跃迁；view/activeBookId 用当前渲染里的值即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalName])
  useEffect(() => {
    if (typeof window === 'undefined' || !window.history) return
    if (navSkipPushRef.current) { navSkipPushRef.current = false; return }
    const snapshot = { view, bookId: activeBookId || '', modal: modalName }
    const cur = window.history.state && window.history.state[NAV_KEY]
    // 第一条用 replaceState：否则用户一进来就多出一条"空白历史"，
    // 按返回时要先按一次没反应的，第二次才真的离开。
    if (!navPushedRef.current) {
      navPushedRef.current = true
      window.history.replaceState({ [NAV_KEY]: snapshot }, '')
      return
    }
    if (cur && cur.view === snapshot.view && (cur.bookId || '') === snapshot.bookId && (cur.modal || '') === snapshot.modal) return
    window.history.pushState({ [NAV_KEY]: snapshot }, '')
  }, [view, activeBookId, modalName])
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onPop = (e) => {
      navSkipPushRef.current = false
      const st = e.state && e.state[NAV_KEY]
      // 不是本应用压的条目：交给浏览器，正常离开页面
      if (!st) return
      setRenameTarget(null); setMergeTarget(null)
      applyNavState(st)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [applyNavState])

  /* ---------- 派生 ---------- */
  const activeBook = books.find((b) => b.id === activeBookId) || null
  // 「能不能查」= 自己在设置里填了 Key，或者**服务端有 Key 且允许访客借用**。
  // 少了后半句，ALLOW_SERVER_KEY=0 的站点会一直显示"AI 已配置"，用户点查询却收到
  // 一句让他去改服务端 .env 的报错 —— 那是给站长看的，不是给他看的。
  const hasKey = Boolean(settings.apiKey || (status?.hasKey && status?.serverKeyAllowed !== false))
  const nextDue = useMemo(() => nextDueAt(entries, schedule), [entries, schedule])
  /**
   * 队列构成：本子里多少个 + 收藏夹多少个（"为什么是 46 而不是 15"一眼能答）。
   * ⚠️ 复习进行中必须按**这一轮的队列**算，不能按"此刻还到期的"——
   * 后者会随着每评一张卡一路缩水，出现"复习 19/43 但本子 0 · 收藏 25"这种自相矛盾的数字（实测）。
  /* 已斩掉的词（带释义，便于在管理弹窗里认出是哪个词） */
  const killedList = useMemo(() => {
    const keys = killedSet(killed, revived)
    if (!keys.size) return []
    const seen = new Map()
    for (const e of entries) if (keys.has(headKey(e.head))) seen.set(headKey(e.head), { key: headKey(e.head), head: e.head, meaning: (e.meanings && e.meanings[0] && e.meanings[0].cn) || e.brief || '' })
    for (const f of favorites) if (keys.has(headKey(f.head))) seen.set(headKey(f.head), { key: headKey(f.head), head: f.head, meaning: f.brief || '' })
    // 斩掉之后词条可能已经被删了：把"只在斩掉表里"的也列出来，用户才能收回
    for (const k of keys) if (!seen.has(k)) seen.set(k, { key: k, head: k, meaning: '' })
    return [...seen.values()].sort((a, b) => a.head.localeCompare(b.head))
  }, [killed, revived, entries, favorites])

  /* ---------- 查词（核心链路：提交 → 轮询 → 卡片） ---------- */
  /** 中文查词第一步：只取候选词，不讲解（挑完再走查词） */
  const runZhLookup = async (q) => {
    setError(''); setBusy(true); setEntry(null); setProgress('正在找对应的英文词…')
    setZhQuery(q); setZhCandidates([]); setView('search')
    try {
      const out = await submitAndPoll({
        submit: () => lookup({ term: q, zh: true, level, baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey }),
        fetchJob: getLookupJob,
        intervalMs: POLL_LOOKUP_MS,
        timeoutMs: TIMEOUT_LOOKUP_MS,
        maxFailures: POLL_MAX_FAILURES,
        netError: '网络不稳定，没拿到候选词，请重试',
        timeoutError: '等待超时，稍后再点一次「查一下」即可',
        isAlive: () => aliveRef.current,
        onProgress: () => setProgress('AI 正在找对应的英文词…'),
      })
      if (out.aborted) return
      markBackendUp()
      const list = (out.data && out.data.candidates) || []
      if (!list.length) throw new Error('没找出对应的英文词 —— 换个更具体的说法再试（比如"羽毛球拍"）')
      // 标出"上次选的是哪个"，并把上次选的排到最前（同一个词重复查时通常还是想要同一个）
      const lastPick = (() => { try { return JSON.parse(safeGet(ZH_PICK_KEY, '{}'))[q] || '' } catch { return '' } })()
      setZhCandidates(list.map((c) => ({ ...c, last: c.word === lastPick }))
        .sort((a, b) => (a.last === b.last ? 0 : a.last ? -1 : 1)))
      setProgress('')
    } catch (e) {
      setError(e.message || '找词失败')
      setProgress('')
    } finally {
      setBusy(false)
    }
  }

  const runLookup = async (term, { saveToBookId } = {}) => {
    const q = String(term || '').trim()
    if (!q) { setError('请先输入要查的单词或短语'); return }
    // 长度上限：查词是"一个词/短语"，不是整段文字。超长直接说清楚，
    // 而不是把它发给模型等半天（审计里 500 字中文会白等一轮）
    if (q.length > 120) {
      setError('输入太长了（' + q.length + ' 个字符）—— 查词一次只处理一个词或短语，请截短到 120 字以内')
      return
    }
    // 中文输入 → 先给候选词（中文词与英文词不是一一对应，直接讲解会得到自相矛盾的卡片）
    if (hasCJK(q)) { await runZhLookup(q); return }
    setError(''); setBusy(true); setEntry(null); setProgress('正在提交…')
    try {
      /**
       * 流式优先：边生成边看。
       * 失败或 6 秒没首段 → 回退到轮询（**同一个 jobId** 继续等，不重复提交、不重复计费）。
       * 设置里可以关掉（settings.streamLookup === false）。
       */
      if (settings.streamLookup !== false) {
        const sres = await stream.run({ term: q, level, settings })
        if (sres.aborted) return
        if (sres.error) throw sres.error
        if (!sres.fallback) {
          const se = sres.data && sres.data.entry
          if (!se) throw new Error('模型没有返回词条，请重试')
          setEntry(se); setView('search'); setProgress('')
          markBackendUp()
          requestAnimationFrame(() => toTop({ smooth: false }))
          pushHistoryEntry(se)
          attachFavoriteEntry(se)
          if (saveToBookId) {
            const { bookName } = saveEntry(saveToBookId, se)
            flash('已加入「' + bookName + '」：' + se.head, TIP_LONG_MS)
            setActiveBookId(saveToBookId)
          }
          markStudied()
          if (sres.streamIncomplete) flash('这次讲解中途断了，可能有内容缺失 —— 可以再查一次补全', TIP_LONG_MS)
          return
        }
        setProgress('正在讲解这个词…')
      }
      const out = await submitAndPoll({
        submit: () => lookup({ term: q, level, baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey }),
        fetchJob: getLookupJob,
        intervalMs: POLL_LOOKUP_MS,
        timeoutMs: TIMEOUT_LOOKUP_MS,
        maxFailures: POLL_MAX_FAILURES,
        netError: '网络不稳定，暂时取不到结果，请重试',
        timeoutError: '等待超时。任务可能还在后台跑：稍后重新查一次即可；若反复失败请换个模型试试。',
        isAlive: () => aliveRef.current,
        onProgress: (info) => {
          // 让等待"可预期"：显示已等秒数 + 说明可以切走（任务在服务端跑，回来还在）
          const sec = Math.round((Number(info && info.elapsedMs) || 0) / 1000)
          setProgress(sec >= 6
            ? `AI 正在讲解这个词…已等 ${sec} 秒（通常 20~60 秒；可以先去做别的，回来结果还在）`
            : 'AI 正在讲解这个词…')
        },
      })
      if (out.aborted) return
      const e = out.data && out.data.entry
      if (!e) throw new Error('模型没有返回词条，请重试')
      setEntry(e); setView('search'); setProgress('')
      markBackendUp()          // 这次查词成功 = 后端活着（比探活更可信）
      // 新卡片顶到最上面：不然用户还停在上一屏（引导说明那一块），
      // 得自己往下滚才看得到刚查到的词
      requestAnimationFrame(() => toTop({ smooth: false }))
      // 连词条快照一起存：点历史要能**直接回到这张卡片**，而不是把词填回搜索框再查一次
      pushHistoryEntry(e)
      // 这个词如果是从收藏夹点过来查的，把完整词条补进那条收藏（之后「加入词库」就能一步完成）
      attachFavoriteEntry(e)
      // 从收藏夹点「查后加入」：查完直接落进选中的本子，省掉"再点一次保存"
      if (saveToBookId) {
        const { bookName } = saveEntry(saveToBookId, e)
        flash('已加入「' + bookName + '」：' + e.head, TIP_LONG_MS)
        setActiveBookId(saveToBookId)
      }
      markStudied()
    } catch (err) {
      setError(err.message || '查询失败'); setProgress('')
    } finally {
      setBusy(false)
    }
  }

  /** 用户在候选里挑了一个词：记下"上次选的是它"，然后走正常查词讲解 */
  const pickZhWord = (word) => {
    try {
      const map = JSON.parse(safeGet(ZH_PICK_KEY, '{}'))
      map[zhQuery] = word
      safeSet(ZH_PICK_KEY, JSON.stringify(map))
    } catch { /* 存不下就算了，不影响查词 */ }
    setQuery(word)
    setZhCandidates([])
    runLookup(word)
  }

  /* ---------- 追问 ----------
   * 复用"提交 → 轮询"那条链路：追问和查词是同一类耗时操作，
   * 再写一套流式实现只会多一处会挂的地方。答案是纯文本，按词条 id 留档在本机。 */
  const askFollowup = async (question) => {
    const q = String(question || '').trim()
    if (!q || !entry) return
    setAskError(''); setAskBusy(true)
    const id = entry.id
    try {
      const out = await submitAndPoll({
        submit: () => followup({
          head: entry.head,
          brief: entry.brief || (entry.meanings && entry.meanings[0] && entry.meanings[0].cn) || '',
          pos: entry.pos || '',
          // 把卡片上已有的讲解摘要一起递过去：模型知道"学生已经看过什么"，才不会又讲一遍
          context: [
            entry.brief,
            (entry.synonyms || []).slice(0, 3).map((x) => x.word + (x.diff ? '：' + x.diff : '')).join('；'),
            entry.confusions,
          ].filter(Boolean).join(' | ').slice(0, 600),
          question: q,
          level,
          baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
        }),
        fetchJob: getFollowupJob,
        intervalMs: POLL_FOLLOWUP_MS,
        timeoutMs: TIMEOUT_FOLLOWUP_MS,
        maxFailures: POLL_MAX_FAILURES,
        netError: '网络不稳定，没拿到回答，请再问一次',
        timeoutError: '回答超时了。可以换个更短的问题再试一次。',
        isAlive: () => aliveRef.current,
      })
      if (out.aborted) return
      const answer = out.data && out.data.answer
      if (!answer) throw new Error('模型没有给出回答，请换个说法再问一次')
      setFollowups((prev) => {
        const list = [...(prev[id] || []), { q, a: answer, at: Date.now() }].slice(-20)
        return { ...prev, [id]: list }
      })
    } catch (e) {
      setAskError(e.message || '追问失败')
    } finally {
      setAskBusy(false)
    }
  }
  const clearFollowups = () => {
    if (!entry) return
    setFollowups((prev) => {
      const next = { ...prev }
      delete next[entry.id]
      return next
    })
  }

  /**
   * 点「最近查过」：有快照就直接回到那张卡片，没有就重查一次。
   *
   * 为什么还要管"没有快照"的情况：这个功能上线前存下的历史只有 {id, head}，
   * 用户点它时预期是"跳转到查完的界面"，所以这里**自动补查**，而不是把词填回搜索框干等。
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

  /* 收藏夹里的词：查过就直接打开那张卡片，没查过就自动查一次。 */
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
      const { bookName } = saveEntry(bookId, fav.entry)
      flash('已加入「' + bookName + '」：' + fav.head, TIP_LONG_MS)
      setActiveBookId(bookId)
      return
    }
    setFavOpen(false)
    setQuery(fav.head)
    await runLookup(fav.head, { saveToBookId: bookId })
  }

  /* ---------- 存入 / 删除 / 改名 / 合并 ---------- */
  const saveToBook = (bookId, base = books) => {
    if (!entry) return
    const { replaced, bookName } = saveEntry(bookId, entry, base)
    flash((replaced ? '已更新：' : '已加入「' + bookName + '」：') + entry.head, TIP_LONG_MS)
    setActiveBookId(bookId)
  }
  /**
   * 问本子名字（应用内弹窗，Promise 化）。
   *
   * 以前用 window.prompt：手机上被键盘顶掉、内嵌 WebView 里会被直接拦截，
   * 而拦截后返回 null、代码静默什么都不做 —— 用户点「新建单词本并加入」毫无反应（审计实测）。
   * 取消时给一句反馈，用户才知道"是取消了"而不是"按钮坏了"。
   */
  const [nameAsk, setNameAsk] = useState(null)
  const askBookName = (hint) => new Promise((resolve) => {
    setNameAsk({
      hint,
      resolve: (name) => {
        setNameAsk(null)
        if (name === null) { flash('已取消，没有新建单词本', TIP_NORMAL_MS); resolve(null); return }
        resolve(name)
      },
    })
  })
  /**
   * 侧栏的「新建单词本」= **只建一个空本子**。
   * 这里曾经走的是"新建并把当前卡片存进去"（等于卡片上那颗按钮）——
   * 结果用户只是想建个本子，手里那张卡却被悄悄存了一份（实测：同一个词因此出现在两个本子里，
   * 复习排期也跟着裂成两份）。按钮名字说什么，就只做什么。
   */
  const createBookOnly = async () => {
    const name = await askBookName()
    if (!name) return
    const same = books.find((b) => b.name === name)
    if (same) { flash('已经有叫「' + name + '」的本子了', TIP_LONG_MS); return }
    newBook(name)
    flash('已新建「' + name + '」—— 查词时在卡片底部选它就能存进去', TIP_LONG_MS)
  }
  /** 卡片上的「新建单词本并加入」：建 + 把当前这张卡存进去 */
  const createAndSave = async () => {
    const name = await askBookName('建好后会把「' + ((entry && entry.head) || '这个词') + '」直接存进去。')
    if (!name) return
    // 同名时复用已有的本子：重名本子在侧边栏里长得一模一样，用户分不清哪个是哪个
    const same = books.find((b) => b.name === name)
    if (same) { saveToBook(same.id); return }
    const { list, id } = newBook(name)
    if (entry) saveToBook(id, list)
  }
  const deleteEntry = (bookId, e) => {
    if (!window.confirm('删除「' + (e.head || e.brief || '(无词条)') + '」？')) return
    dropEntry(bookId, e)
    flash('已删除')
  }
  const deleteBook = (b) => {
    if (!window.confirm('删除单词本「' + b.name + '」？里面的词条会一起删掉。')) return
    dropBook(b)
    if (activeBookId === b.id) setActiveBookId('')
    flash('已删除「' + b.name + '」')
  }
  /* 改名与合并都走弹窗（不再用 window.prompt/confirm）：
     手机上系统弹窗会被键盘顶掉一半，而且改名这种"改错了要能反悔"的操作值得一个能看清的界面。 */
  const submitRename = (name) => {
    if (!renameTarget) return
    const clean = String(name || '').trim()
    if (!clean) { flash('名字不能为空', TIP_LONG_MS); return }
    const clash = books.find((b) => b.name === clean && b.id !== renameTarget.id)
    if (clash) { flash('已经有一个叫「' + clean + '」的本子了', TIP_LONG_MS); return }
    if (!renameBook(renameTarget.id, clean)) { flash('改名失败', TIP_LONG_MS); return }
    setRenameTarget(null)
    flash('已改名：' + clean, TIP_NORMAL_MS)
  }
  const submitMerge = (toId) => {
    if (!mergeTarget || !toId) return
    const { moved, skipped } = mergeBooksInto(mergeTarget.id, toId)
    const to = books.find((b) => b.id === toId)
    setMergeTarget(null)
    if (activeBookId === mergeTarget.id) setActiveBookId(toId)
    flash(`已把「${mergeTarget.name}」并进「${to ? to.name : ''}」：`
      + `移入 ${moved} 个词条${skipped ? `，覆盖同词头 ${skipped} 个` : ''}`, TIP_LONG_MS)
  }

  /* ---------- 复习 ---------- */
  /**
   * 复习会话（模式、队列、评分、斩掉、错词练习）整个交给 hook。
   * 「今日待复习」的语义：有到期的词 → 今天的队列；今天已复习完 → 今日加练（只练不写排期）；
   * 今天一个词都没碰过 → 提示。两种情况都先让用户**选模式**再开跑。
   */
  const review = useReviewSession({
    due, todayQueue, wrongQueue, gradeEntry, markStudied,
    markWrong, clearWrongWord, killWord, flash,
  })
  const openReview = () => { if (review.openSetup() === 'setup') setView('review-setup') }

  const beginReview = (mode) => { review.begin(mode); setView('review') }
  const startWrongReview = () => { if (review.startWrong()) { setWrongOpen(false); setView('review') } }
  const exitReview = () => {
    const n = review.exit()
    setView('search')
    if (n > 0) flash('这一轮复习完成，共 ' + n + ' 个词', TIP_LONG_MS)
  }

  const queueMix = useMemo(() => {
    const src = (view === 'review' && review.queue) ? review.queue : due
    return {
      book: src.filter((x) => x.kind === 'entry').length,
      fav: src.filter((x) => x.kind === 'favorite').length,
    }
  }, [due, view, review.queue])


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

  /* ---------- 本子内的筛选与排序 ---------- */
  const filteredBookEntries = useMemo(() => {
    const base = activeBook ? activeBook.entries : []
    return sortEntries(filterEntries(base, { query: bookQuery, filter: kindFilter }, schedule), sortMode, schedule)
  }, [activeBook, bookQuery, kindFilter, sortMode, schedule])

  /* 侧栏与顶栏要的一堆小东西，打包传下去，免得 20 个 prop 铺满 JSX */
  const topbarProps = {
    sidebarOpen, onToggleSidebar: toggleSidebar,
    dueCount: due.length, onStartReview: openReview, nextDue,
    statusChecking,
    onRetryStatus: retryStatus,
    onOpenQuiz: () => setQuizSetupOpen(true), quizDisabled: !entries.length,
    onOpenSentence: () => { sentence.reset(); setView('sentence') },
    sentenceDisabled: !entries.length && !favorites.length,
    account, onOpenAuth: () => setAuthOpen(true),
    status, hasKey, stats, streak, syncCode, lastSyncAt,
    onOpenSettings: () => { closeSidebarOnMobile(); setSettingsOpen(true) },
    onOpenBackup: () => { closeSidebarOnMobile(); setBackupOpen(true) },
    onOpenFavorites: () => { closeSidebarOnMobile(); setFavOpen(true) },
    favoritesCount: favorites.length,
    onOpenKilled: () => { closeSidebarOnMobile(); setKilledOpen(true) },
    killedCount: killedList.length,
  }
  const sidebarProps = {
    open: sidebarOpen, onToggle: toggleSidebar,
    books, activeBookId, view, stats,
    onOpenBook: (b) => {
      const isCurrent = b.id === activeBookId && view === 'book'
      setActiveBookId(isCurrent ? '' : b.id)
      setView(isCurrent ? 'search' : 'book')
      closeSidebarOnMobile()
    },
    onDeleteBook: deleteBook,
    onRenameBook: (b) => setRenameTarget(b),
    onMergeBook: (b) => setMergeTarget(b),
    onNewBook: createBookOnly,
    favorites, onOpenFavorite: openFavorite, onManageFavorites: () => { closeSidebarOnMobile(); setFavOpen(true) },
    history,
    onOpenHistory: (h) => { closeSidebarOnMobile(); openHistory(h) },
    onOpenSettings: () => { closeSidebarOnMobile(); setSettingsOpen(true) },
    onOpenBackup: () => { closeSidebarOnMobile(); setBackupOpen(true) },
  }

  return (
    <>
    <div className="app">
      {/* 手机端点侧栏外面任意处即可收起（桌面端这条规则 display:none，不生效） */}
      {sidebarOpen ? <div className="sidebar-backdrop" onClick={toggleSidebar} aria-hidden="true" /> : null}
      <Sidebar {...sidebarProps} />

      <main className="main">
        <Topbar {...topbarProps} />

        {tip ? <div className="fav-tip toast" role="status" aria-live="polite">{tip}</div> : null}

        {!safetyHidden ? (
          <SafetyBanner
            entries={stats.entries} syncCode={syncCode}
            accountEmail={account.email} accountHasSync={accountHasSync}
            onMakeCode={() => { hideSafety(); startNewSync() }}
            onOpenBackup={() => setBackupOpen(true)}
            onDismiss={hideSafety} />
        ) : null}

        {view === 'review' && review.queue ? (
          <ReviewPane queue={review.queue} index={review.index} revealed={review.revealed} schedule={schedule}
            mode={review.mode} onSwitchMode={review.switchMode}
            practice={review.practice} killedCount={killedList.length} wrongCount={wrongItems.length}
            practiceLabel={[
              review.mode === 'spell' ? '拼写练习' : '',
              review.kind === 'wrong' ? '错词练习' : review.kind === 'today' ? '今日加练' : '',
            ].filter(Boolean).join(' · ')}
            mix={review.practice ? null : queueMix}
            onRestartSpell={review.restartSpell}
            onManageKilled={() => setKilledOpen(true)} onManageWrong={() => setWrongOpen(true)}
            onSpellWrong={review.noteSpellWrong}
            onReveal={() => review.setRevealed(true)} onGrade={review.grade} onKill={review.kill} onExit={exitReview} />
        ) : view === 'review-setup' ? (
          <ReviewSetup queue={(review.pending && review.pending.items) || []} mix={queueMix}
            kind={review.pending ? review.pending.kind : 'due'}
            mode={review.mode} setMode={review.setMode}
            onStart={beginReview}
            onExit={() => { review.setPending(null); setView('search') }} />
        ) : view === 'sentence' ? (
          <SentencePane
            items={sentence.items} index={sentence.index} mode={sentence.mode} setMode={sentence.setMode}
            busy={sentence.busy} grading={sentence.grading} grade={sentence.grade} error={sentence.error}
            count={sentence.count} setCount={sentence.setCount}
            difficulty={sentence.difficulty} setDifficulty={sentence.setDifficulty}
            onSaveSentence={sentence.save} isSaved={sentence.isSaved}
            bookCount={sentence.bookCount} onOpenBook={() => sentence.setBookOpen(true)}
            onStart={(m) => { sentence.start(m).then(() => setView('sentence')) }}
            onGrade={sentence.submit} onNext={sentence.next}
            onExit={() => { setView('search'); sentence.reset() }}
            onRetryGrade={() => sentence.grade && sentence.submit(sentence.grade.sentence)} />
        ) : view === 'quiz' ? (
          <QuizPane quiz={quiz} showAnswers={quizShow} busy={quizBusy}
            onToggleAnswers={() => setQuizShow((v) => !v)} onCopy={copyQuiz}
            onExportPdf={() => print.start({ kind: 'quiz', quiz })}
            onRegenerate={() => setQuizSetupOpen(true)} onExit={() => setView('search')} />
        ) : view === 'book' && activeBook ? (
          <BookPane
            book={activeBook} entries={filteredBookEntries} total={activeBook.entries.length}
            filters={FILTERS} sorts={SORTS}
            query={bookQuery} setQuery={setBookQuery}
            kindFilter={kindFilter} setKindFilter={setKindFilter}
            sortMode={sortMode} setSortMode={setSortMode}
            schedule={schedule}
            onOpenEntry={(e) => { setEntry(e); setView('search') }}
            onDeleteEntry={(e) => deleteEntry(activeBook.id, e)}
            onQuizForBook={() => { setQuizScope('book'); setQuizSetupOpen(true) }}
            onExportPdf={() => print.start({ kind: 'book', book: activeBook })}
            onRenameBook={() => setRenameTarget(activeBook)}
            onMergeBook={() => setMergeTarget(activeBook)}
            canMerge={books.length > 1} />
        ) : (
          <SearchPane
            query={query} setQuery={setQuery} onLookup={runLookup}
            level={level} setLevel={setLevel} levels={LEVELS}
            busy={busy} progress={progress} error={error} onDismissError={() => setError('')}
            searchRef={searchRef}
            entry={entry} books={books}
            existing={entry ? (findEntryBook(books, entry.id) || findBookByHead(books, entry.head)) : null}
            onExportPdf={(e) => print.start({ kind: 'entry', entry: e })}
            onToggleFavorite={toggleFavorite} isFavorite={isFavorite}
            onSave={saveToBook} onCreateBook={createAndSave} onLookupWord={runLookup}
            entry={entry || stream.partial}
            streaming={!entry && Boolean(stream.partial)}
            streamProgress={stream.progress}
            streamLabels={stream.labels}
            zhTerm={zhQuery} zhItems={zhCandidates}
            onPickZh={(c) => pickZhWord(c.word)}
            onDismissZh={() => { setZhCandidates([]); setZhQuery('') }}
            onAsk={askFollowup} askBusy={askBusy} askError={askError}
            followups={entry ? (followups[entry.id] || []) : []} onClearFollowups={clearFollowups} />
        )}
      </main>

      {settingsOpen ? (
        <SettingsModal settings={settings} theme={theme} onThemeChange={setTheme}
          onClose={() => setSettingsOpen(false)}
          onSave={(s) => { setSettings(s); saveSettings(s); setSettingsOpen(false); retryStatus() }} />
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
        <QuizSetupModal
          activeBook={activeBook} totalEntries={stats.entries}
          counts={QUIZ_COUNTS} scope={quizScope} setScope={setQuizScope}
          count={quizCount} setCount={setQuizCount}
          onStart={runQuiz} onClose={() => setQuizSetupOpen(false)} />
      ) : null}

      {nameAsk ? (
        <NewBookModal hint={nameAsk.hint}
          onSubmit={(name) => nameAsk.resolve(name)}
          onClose={() => nameAsk.resolve(null)} />
      ) : null}

      {renameTarget ? (
        <RenameBookModal book={renameTarget} onClose={() => setRenameTarget(null)} onSubmit={submitRename} />
      ) : null}

      {mergeTarget ? (
        <MergeBookModal from={mergeTarget} books={books} onClose={() => setMergeTarget(null)} onSubmit={submitMerge} />
      ) : null}

      {sentence.bookOpen ? (
        <SentenceBookModal items={sentences} onClose={() => sentence.setBookOpen(false)}
          onDelete={deleteSentence}
          onPracticeWord={(it) => { sentence.practiceWord(it); setView('sentence') }} />
      ) : null}

      {wrongOpen ? (
        <WrongBookModal items={wrongItems} onClose={() => setWrongOpen(false)}
          onPractice={startWrongReview}
          onRemove={(head) => { clearWrongWord(head); flash('已移出错词本：' + head); }}
          onClearAll={() => { wrongItems.forEach((w) => clearWrongWord(w.head)); flash('错词本已清空'); }} />
      ) : null}

      {killedOpen ? (
        <KilledModal items={killedList} onClose={() => setKilledOpen(false)}
          onRevive={(head) => { reviveWord(head); flash('已收回：' + head); }}
          onReviveAll={() => { killedList.forEach((it) => reviveWord(it.head)); flash('已全部收回，下次复习会重新出现', TIP_LONG_MS); }} />
      ) : null}
    </div>

      {print.hint ? (
        <PrintHintModal onCancel={() => print.setHint(null)}
          onContinue={() => print.confirmHint()} />
      ) : null}

      {favOpen ? (
        <FavoritesModal
          favorites={favorites} books={books} busy={busy}
          onClose={() => setFavOpen(false)}
          onLookup={(f) => { setFavOpen(false); openFavorite(f) }}
          onRemove={removeFavoriteById}
          onAddToBook={addFavoriteToBook} />
      ) : null}

      {/* 回到顶部：查完长卡片后想翻回上面最常用的动作 */}
      <BackToTop />

      {/* 打印页放在 .app 之外：body.printing 时把 .app 整个藏起来、只留它 */}
      <PrintSheet job={print.job} />
    </>
  )
}
