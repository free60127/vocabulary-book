import React, { useEffect, useRef, useState } from 'react';
import {
  BookMarked, Cloud, Flame, LogIn, MoreVertical, PanelLeftClose, PanelLeftOpen, PenLine, Settings, Skull,
  Sparkles, Star,
} from 'lucide-react';

/**
 * 顶栏。
 *
 * 手机端为什么要有「更多」菜单：实测 390×664 的屏幕上，四个按钮 + 状态条会把顶栏
 * 撑成 **148px（占 22%）**，iPhone SE 上更是 26% —— 复习时每翻一张卡都要先滑过它。
 * 现在手机上只留「今日待复习」(学习主循环) + 「更多」，其余收进菜单，
 * 状态条压成一个小圆点（完整信息在菜单里）；桌面端一切照旧（屏幕宽，不存在这个问题）。
 */
export default function Topbar({
  sidebarOpen, onToggleSidebar, dueCount, onStartReview, nextDue,
  onOpenQuiz, quizDisabled, onOpenSentence, sentenceDisabled, account, onOpenAuth,
  status, hasKey, stats, streak, syncCode, lastSyncAt,
  onOpenSettings, onOpenBackup, onOpenFavorites, favoritesCount, onOpenKilled, killedCount,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef(null);

  /* 点外面 / 按 ESC 关掉菜单（菜单不是弹窗，用轻量做法，不进历史栈） */
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  const statusText = status
    ? (hasKey ? 'AI 已配置' : (status.hasKey ? '需要你自己的 Key' : '未配置 API Key'))
    : '后端未连接';
  const dueTitle = nextDue
    ? `今天到期 ${dueCount} 个；下一次：${new Date(nextDue).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`
    : `今天到期 ${dueCount} 个`;

  const run = (fn) => () => { setMenuOpen(false); fn(); };

  return (
    <header className="topbar">
      <button className="icon-btn side-toggle" onClick={onToggleSidebar}
        title={sidebarOpen ? '收起侧栏' : '展开侧栏'} aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}>
        {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
      </button>
      <div className="topbar-left"><BookMarked size={16} /><strong>单词本</strong></div>

      {/* 手机上按钮文案缩短为「待复习」：390px 一行放不下「今日待复习 + 单词本 + 状态点 + 更多」，
          挤到最后标题被截成"单…"（截图里实测） */}
      <button className={'ghost-btn due-btn' + (dueCount ? ' has-due' : '')} onClick={onStartReview} title={dueTitle}>
        <Flame size={15} /><span className="due-label-full">今日待复习</span><span className="due-label-short">待复习</span>{dueCount ? ` (${dueCount})` : ''}
      </button>

      {/* 桌面端：全部按钮常显 */}
      <button className="ghost-btn desktop-only" onClick={onOpenQuiz} disabled={quizDisabled}>
        <Sparkles size={15} />自测题
      </button>
      <button className="ghost-btn desktop-only" onClick={onOpenSentence} disabled={sentenceDisabled}
        title="从单词本和收藏夹抽词，写句子让 AI 批改">
        <PenLine size={15} />造句
      </button>
      {account.email
        ? <button className="ghost-btn desktop-only" onClick={onOpenAuth} title={account.email}><LogIn size={15} />{account.email.split('@')[0]}</button>
        : <button className="ghost-btn desktop-only" onClick={onOpenAuth}><LogIn size={15} />登录</button>}

      <div className="status-chip" title={status ? status.model + ' @ ' + status.baseUrl : '后端未连接'}>
        <span className={'dot ' + (status ? 'ok' : 'err')} />
        <span className="chip-text">{statusText}</span>
        <span className="chip-detail">
          {stats.entries} 个词条 · 连续 {streak.current} 天
          {syncCode ? ` · 同步 ${lastSyncAt ? new Date(lastSyncAt).toTimeString().slice(0, 5) : '未同步'}` : ''}
        </span>
      </div>

      {/* 手机端：其余入口收进「更多」 */}
      <div className="topbar-more" ref={wrapRef}>
        <button className="icon-btn" onClick={() => setMenuOpen((v) => !v)} aria-haspopup="menu"
          aria-expanded={menuOpen} aria-label="更多功能" title="更多功能">
          <MoreVertical size={18} />
        </button>
        {menuOpen ? (
          <div className="more-menu" role="menu">
            <button role="menuitem" onClick={run(onOpenQuiz)} disabled={quizDisabled}><Sparkles size={15} />自测题</button>
            <button role="menuitem" onClick={run(onOpenSentence)} disabled={sentenceDisabled}><PenLine size={15} />造句练习</button>
            <button role="menuitem" onClick={run(onOpenFavorites)}><Star size={15} />收藏夹{favoritesCount ? `（${favoritesCount}）` : ''}</button>
            {killedCount ? (
              <button role="menuitem" onClick={run(onOpenKilled)}><Skull size={15} />已斩掉的词<span className="menu-count">{killedCount}</span></button>
            ) : null}
            <button role="menuitem" onClick={run(onOpenAuth)}><LogIn size={15} />{account.email ? account.email : '登录 / 注册'}</button>
            <button role="menuitem" onClick={run(onOpenSettings)}><Settings size={15} />AI 设置</button>
            <button role="menuitem" onClick={run(onOpenBackup)}><Cloud size={15} />备份 / 同步</button>
            <div className="more-menu-info">
              <span className={'dot ' + (status ? 'ok' : 'err')} />
              <span>{statusText}</span>
              <em>{stats.entries} 个词条 · 连续 {streak.current} 天{syncCode ? ` · 同步 ${lastSyncAt ? new Date(lastSyncAt).toTimeString().slice(0, 5) : '未同步'}` : ''}</em>
            </div>
          </div>
        ) : null}
      </div>
    </header>
  );
}
