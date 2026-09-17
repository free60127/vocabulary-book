import React from 'react';
import { Camera, Cloud, FolderPlus, GitMerge, Pencil, Settings, Star, Trash2, X } from 'lucide-react';
import { formatTime } from '../format.js';

/**
 * 侧栏：单词本列表 / 收藏夹 / 最近查过 / 底部两个入口。
 *
 * 本子行上有四个动作：打开、改名、合并、删除。
 * 改名与合并是这轮补上的 —— `wordbook.js` 里早就写好了 `renameBook`，但一直没有界面，
 * 用户建错名字只能删掉重建（连带把复习进度一起丢了）。
 * 手机上这几颗按钮**常显**（@media (hover:none)），桌面端悬停才显形但**始终占位**：
 * 原来用 display:none，悬停时行内突然插入按钮，手指底下会长出一个删除键。
 */
export default function Sidebar({ onImportImages, 
  open, onToggle, books, activeBookId, view, stats,
  onOpenBook, onDeleteBook, onRenameBook, onMergeBook, onNewBook,
  favorites, onOpenFavorite, onManageFavorites, history, onOpenHistory,
  onOpenSettings, onOpenBackup,
}) {
  return (
    <aside className={'sidebar' + (open ? '' : ' collapsed')}>
      <button className="sidebar-close" onClick={onToggle} aria-label="收起侧栏"><X size={18} /></button>
      <div className="brand"><div className="brand-mark">词</div><div><strong>单词本</strong><span>VOCABULARY BOOK</span></div></div>
      <button className="primary-btn" onClick={onNewBook}><FolderPlus size={16} />新建单词本</button>
      {/* 拍照导入：手写单词表的主要入口（手机端最顺手，所以放在最上面第一屏） */}
      <button className="ghost-btn side-import" onClick={onImportImages}>
        <Camera size={16} />拍照 / 上传导入
      </button>

      <div className="side-section">
        <div className="side-title">我的单词本（{stats.books}）</div>
        <div className="lesson-list">
          {books.length === 0 && <div className="muted">还没有单词本：查一个词就能存进来</div>}
          {books.map((b) => (
            <div key={b.id} className={'lesson-row' + (activeBookId === b.id ? ' active' : '')}>
              {/* 这一项既是"打开"也是"收起"：只有**当前正开在这个本子上**时才收起，
                  否则从搜索页点过来会被 toggle 成空、页面原地不动（看起来就是"点了没反应"）。 */}
              <button className="lesson-item" onClick={() => onOpenBook(b)}
                title={b.id === activeBookId && view === 'book' ? '收起这个本子' : '打开这个本子'}>
                <span className="lesson-title">{b.name}</span>
                <span className="lib-count">{b.entries.length}</span>
              </button>
              {/* 改名 / 合并只在桌面端出现在行内（那里有 hover、行也宽）；
                  手机端这两个动作在**本子自己的页面**顶部（侧栏只有 268px，
                  三个 44px 的图标按钮会把本子名挤成三四个字 —— 实测被当成"看不到单词本"）。
                  删除留在行内：清空一个本子是高频动作，藏在二级页面反而别扭。 */}
              <button className="lesson-edit" onClick={() => onRenameBook(b)} title="给这个本子改名" aria-label={'重命名 ' + b.name}><Pencil size={12} /></button>
              {books.length > 1 ? (
                <button className="lesson-merge" onClick={() => onMergeBook(b)} title="把这个本子并进另一个本子" aria-label={'合并 ' + b.name}><GitMerge size={12} /></button>
              ) : null}
              <button className="lesson-del" onClick={() => onDeleteBook(b)} title="删除这个单词本" aria-label={'删除单词本 ' + b.name}><Trash2 size={12} /></button>
            </div>
          ))}
        </div>

        {favorites.length > 0 && (
          <>
            <div className="side-title fav-side-title">
              收藏夹（{favorites.length}）
              <button className="ghost-btn sm" onClick={onManageFavorites}>管理</button>
            </div>
            <div className="lesson-list scroll-capped" style={{ maxHeight: 150 }}>
              {favorites.slice(0, 20).map((f) => (
                <button key={f.id} className="lesson-item" onClick={() => onOpenFavorite(f)}
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
            <div className="lesson-list scroll-capped" style={{ maxHeight: 170 }}>
              {history.slice(0, 20).map((h) => (
                <button key={h.id} className="lesson-item" onClick={() => onOpenHistory(h)}
                  title={h.entry ? '点一下回到上次查到的讲解' : '点一下重新查这个词（' + formatTime(h.at) + '）'}>
                  <span className="lesson-title">{h.head}</span>
                  <span className="muted small history-when">{formatTime(h.at)}</span>
                  {h.entry ? null : <span className="muted small">需重查</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="side-footer">
        <button className="ghost-btn" onClick={onOpenSettings}><Settings size={15} />AI 设置</button>
        <button className="ghost-btn" onClick={onOpenBackup}><Cloud size={15} />备份/同步</button>
      </div>
    </aside>
  );
}
