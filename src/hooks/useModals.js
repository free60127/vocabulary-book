/**
 * 弹窗状态 + 键盘可达性（role=dialog / Esc 关闭 / 焦点陷阱）。
 *
 * 抽出来的原因：8 个弹窗的开关、3 个弹窗内的提示、以及那段"哪个弹窗在最上层"的
 * 焦点管理逻辑，全都散在 App 里 —— 加一个弹窗要在四处登记（state、优先级、closers、
 * 依赖数组）。现在只有这一处需要改。
 *
 * 注意：这里**只管开关与焦点**，弹窗的渲染仍在各自的组件里（components/modals/*）。
 */
import { useEffect, useRef, useState } from 'react'

export function useModals({ getCloseCamera, getMaterialBusy, getAuthOpen, closeAuth }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [materialOpen, setMaterialOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [favOpen, setFavOpen] = useState(false);
  const [libModalOpen, setLibModalOpen] = useState(false);
  const [newJobOpen, setNewJobOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [camOpen, setCamOpen] = useState(false);
  const [lessonEdit, setLessonEdit] = useState(null); // { libId, lid, lesson }
  const [backupTip, setBackupTip] = useState('');
  const [libTip, setLibTip] = useState('');

  const modalRefs = useRef({});

  // 键盘可达性：把「哪个弹窗开着」做成一件事，Esc 关闭、Tab 只在弹窗内循环。
  // 优先级顺序 = 屏幕上的层级顺序（后打开的排前面）。
  const authOpen = Boolean(getAuthOpen && getAuthOpen());
  const open = camOpen ? 'cam' : materialOpen ? 'material' : newJobOpen ? 'newjob' : libModalOpen ? 'lib' : lessonEdit ? 'lessonEdit' : backupOpen ? 'backup' : historyOpen ? 'history' : favOpen ? 'fav' : authOpen ? 'auth' : settingsOpen ? 'settings' : null;

  /**
   * 回调统一放 ref，下面的 effect 只依赖 `open` 这个字符串，不依赖父组件传进来的函数身份。
   *
   * 为什么必须这样（实测 bug，用户反馈"AI 生成训练素材里中文输入法一打字就闪退"）：
   * 父组件原来传的是 `closeAuth: () => ...` 这种内联箭头，**每次渲染都是新函数**；
   * 它一旦出现在依赖数组里，effect 就会在每次重渲染时重跑，而 effect 末尾有一句
   * "把焦点送进弹窗" —— 用户每敲一个字母（触发 setState → 重渲染）焦点就被抢到
   * 弹窗里第一个可聚焦元素上，**中文输入法的组合被强行打断**，待上屏的字母直接以
   * 英文落进输入框。PoC 实测：敲 'w' 后 activeElement 从 textarea 变成关闭按钮。
   */
  const latest = useRef({});
  latest.current = { getCloseCamera, getMaterialBusy, closeAuth };

  useEffect(() => {
    if (!open) return undefined;
    const closers = {
      cam: () => { const f = latest.current.getCloseCamera; if (f && f()) f()(); },
      material: () => { const f = latest.current.getMaterialBusy; if (!(f && f())) setMaterialOpen(false); },
      newjob: () => setNewJobOpen(false),
      lib: () => setLibModalOpen(false),
      lessonEdit: () => setLessonEdit(null),
      backup: () => setBackupOpen(false),
      history: () => setHistoryOpen(false),
      fav: () => setFavOpen(false),
      auth: () => { const f = latest.current.closeAuth; if (f) f(); },
      settings: () => setSettingsOpen(false),
    };
    const onKeyDown = (e) => {
      // 输入法正在组合时，按键先归输入法：
      //  · Escape 在组合中是"取消候选词"，不该顺手把弹窗关掉（用户会丢掉正在填的内容）
      //  · isComposing / keyCode 229 是各浏览器通用的"这次按键已被输入法接管"标记
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); const close = closers[open]; if (close) close(); return; }
      if (e.key !== 'Tab') return;
      const node = modalRefs.current[open];
      if (!node) return;
      const focusables = Array.from(node.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!node.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  /**
   * 把焦点送进刚打开的弹窗 —— 只在 open 变化时做一次（不是每次渲染）。
   * 两条讲究：① 焦点已经在弹窗内就不抢（用户手已经点到输入框上了）；
   *          ② 优先聚焦输入控件而不是第一个按钮（原来会落在"关闭"上）。
   */
  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => {
      const node = modalRefs.current[open];
      if (!node || node.contains(document.activeElement)) return;
      const target = node.querySelector('input, textarea, select')
        || node.querySelector('button, [href], [tabindex]:not([tabindex="-1"])');
      if (target) target.focus();
    }, 40);
    return () => clearTimeout(timer);
  }, [open]);

  /**
   * 弹窗打开时锁住背景滚动。
   *
   * 为什么需要：`.modal-mask` 是 position:fixed，但它只挡住了点击，不阻断**滚动链** ——
   * 手机上在遮罩空白处滑动（桌面是滚轮），背后那条长页面照样被滚走；关掉弹窗后
   * 用户已经不在原来的阅读位置。实测（390×844，打开收藏夹后在遮罩上滚）：
   * scrollY 60 → 660。详见 tools/qa-probe-mobile-desktop.mjs 的滚动穿透断言。
   *
   * 为什么要在关闭时还原 scrollY：给 <html> 设 overflow:hidden 会让滚动偏移被钳到 0，
   * 不还原就等于"关掉弹窗被扔回页面顶部"。移动端整页滚动时滚的是 <html>（见 styles.css
   * 的 max-width:900px 块），桌面端滚的是 .editor/.result 内部容器，所以两处都要锁。
   *
   * 依赖用布尔值而不是 `open` 字符串：弹窗之间互相切换（如备份 → 账号）时
   * 字符串会变，effect 重跑会把滚动位置先还回去再锁上，用户会看到页面跳一下。
   */
  const anyModal = open !== null;
  useEffect(() => {
    if (!anyModal) return undefined;
    const html = document.documentElement;
    const { body } = document;
    const prev = { html: html.style.overflow, body: body.style.overflow, y: window.scrollY };
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    // 上锁这一下，Chromium 实测**不会**动滚动位置；但 Safari 在 overflow:hidden 时会把
    // 偏移钳到 0（页面看起来"跳回顶部"）。这里补一次，代价是一行、且幂等。
    if (window.scrollY !== prev.y) window.scrollTo(0, prev.y);

    return () => {
      html.style.overflow = prev.html;
      body.style.overflow = prev.body;
      if (window.scrollY !== prev.y) window.scrollTo(0, prev.y);
    };
  }, [anyModal]);

  /** 有没有任何弹窗开着（用于全局快捷键 / 滚动锁定这类判断） */
  const anyOpen = Boolean(camOpen || materialOpen || newJobOpen || libModalOpen || lessonEdit || backupOpen || historyOpen || favOpen || settingsOpen);

  return {
    settingsOpen, setSettingsOpen,
    materialOpen, setMaterialOpen,
    historyOpen, setHistoryOpen,
    favOpen, setFavOpen,
    libModalOpen, setLibModalOpen,
    newJobOpen, setNewJobOpen,
    backupOpen, setBackupOpen,
    camOpen, setCamOpen,
    lessonEdit, setLessonEdit,
    backupTip, setBackupTip,
    libTip, setLibTip,
    modalRefs, anyOpen,
  };
}
