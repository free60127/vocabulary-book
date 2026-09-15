import React, { useState } from 'react';
import { ArrowRight, BookPlus, Star, Trash2, X } from 'lucide-react';

/**
 * 收藏夹：攒下"在别人的近义词里看到、想回头细看"的词。
 *
 * 两种状态在这里要区分得很清楚（否则用户不知道该点哪儿）：
 *  · **还没查过**（只有词头 + 一行释义）→ 主按钮是「查详细讲解」；
 *  · **查过了**（挂着完整词条）→ 可以直接「加入词库」。
 * 允许"先查再加入"是刻意的：本子里存的应该是完整卡片，塞半成品进去只会把本子搞脏。
 */
export default function FavoritesModal({ favorites, books, busy, onClose, onRemove, onAddToBook, onLookup }) {
  const [bookId, setBookId] = useState(books[0]?.id || '');

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal favorites-modal" role="dialog" aria-modal="true" aria-label="收藏夹" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>收藏夹（{favorites.length}）</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <p className="muted small">
          在词条的「近义词对比」里点 ⭐ 就能收进来。收进来的词可以点「查详细讲解」看完整卡片，
          查过之后就能直接加进单词本。
        </p>

        {books.length ? (
          <div className="sync-row" style={{ marginBottom: 10 }}>
            <span className="muted small">加入哪个本子：</span>
            <select className="ocr-mode" value={bookId} onChange={(e) => setBookId(e.target.value)} title="选一个单词本">
              {books.map((b) => <option key={b.id} value={b.id}>{b.name}（{b.entries.length}）</option>)}
            </select>
          </div>
        ) : (
          <p className="muted small">还没有单词本：先查一个词，保存时会自动建一个。</p>
        )}

        {favorites.length === 0 ? (
          <p className="muted">收藏夹是空的。</p>
        ) : (
          <ul className="fav-list">
            {favorites.map((f) => (
              <li key={f.id} className="fav-row">
                <div className="fav-row-main">
                  <div className="fav-row-head">
                    <Star size={13} fill="currentColor" />
                    <strong>{f.head}</strong>
                    {f.phonetic ? <span className="muted small">{f.phonetic}</span> : null}
                    {f.brief ? <span className="muted small">· {f.brief}</span> : null}
                  </div>
                  {/* 单独一个 class：这一行是状态说明，别和上面的音标（同样是 muted small）混在一起 ——
                      测试里就因此抓错了元素 */}
                  <div className="muted small fav-row-note">
                    {f.from ? `来自「${f.from}」` : '手动收藏'}
                    {f.entry ? ' · 已查到完整讲解' : ' · 还没查过'}
                  </div>
                </div>
                <div className="fav-row-acts">
                  {f.entry ? null : (
                    <button className="ghost-btn sm" onClick={() => onLookup(f)} disabled={busy}>
                      <ArrowRight size={13} />查详细讲解
                    </button>
                  )}
                  <button className="ghost-btn sm" disabled={busy || !books.length}
                    title={f.entry ? '把完整词条加进选中的本子' : '还没查过：加进去会先查一次，拿到完整讲解再存入'}
                    onClick={() => onAddToBook(f, bookId)}>
                    <BookPlus size={13} />{f.entry ? '加入词库' : '查后加入'}
                  </button>
                  <button className="icon-btn" title="从收藏夹移除" aria-label="移除" onClick={() => onRemove(f)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
