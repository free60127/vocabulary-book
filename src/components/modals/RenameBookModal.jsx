import React, { useState } from 'react';
import { GitMerge, X } from 'lucide-react';
import { useEscape } from '../../hooks/useEscape.js';

/**
 * 给单词本改名。
 *
 * 为什么不用 window.prompt：手机上系统弹窗会被键盘顶掉一半，
 * 而且改名这种"改错了要能反悔"的操作，值得一个能看清、能对比的界面
 * （下面那行会实时显示"本子里有 N 个词条"）。
 */
export function RenameBookModal({ book, onClose, onSubmit }) {
  const [name, setName] = useState(book.name);
  useEscape(onClose);
  const clean = name.trim();
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal rename-modal" role="dialog" aria-modal="true" aria-label="重命名单词本" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>重命名</h2><button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button></div>
        <label>单词本名字
          <input value={name} autoFocus maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && clean) onSubmit(clean); }} />
        </label>
        <p className="muted small">这个本子里有 {book.entries.length} 个词条。改名只动名字，词条和复习进度都不受影响。</p>
        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose}>取消</button>
          <button className="primary-btn" onClick={() => onSubmit(clean)} disabled={!clean || clean === book.name}>保存</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 把一个本子并进另一个本子。
 *
 * 合并是**单向**的（A → B，A 会消失），所以必须让用户看清两个名字和各自的数量；
 * 被并掉的那个本子会留墓碑，否则下一次云同步又会被云端旧副本带回来。
 */
export function MergeBookModal({ from, books, onClose, onSubmit }) {
  const targets = books.filter((b) => b.id !== from.id);
  const [toId, setToId] = useState(targets[0] ? targets[0].id : '');
  useEscape(onClose);
  const to = targets.find((b) => b.id === toId);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal merge-modal" role="dialog" aria-modal="true" aria-label="合并单词本" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>合并单词本</h2><button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button></div>
        <p className="muted small">
          把「<b>{from.name}</b>」里的 {from.entries.length} 个词条移进另一个本子，然后删掉它。
          同词头的词条会就地覆盖（复习进度保留）。
        </p>
        <label>并进哪一个
          <select className="ocr-mode" value={toId} onChange={(e) => setToId(e.target.value)} style={{ marginLeft: 8 }}>
            {targets.map((b) => <option key={b.id} value={b.id}>{b.name}（{b.entries.length}）</option>)}
          </select>
        </label>
        {to ? (
          <p className="muted small">合并后：{to.name} 最多 {to.entries.length + from.entries.length} 个词条；「{from.name}」将不再出现在侧栏。</p>
        ) : null}
        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose}>取消</button>
          <button className="primary-btn" onClick={() => onSubmit(toId)} disabled={!toId}><GitMerge size={15} />合并</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 新建单词本的命名弹窗。
 *
 * 为什么不再用 window.prompt（可用性审计实测）：
 *  · 手机上系统 prompt 会被键盘顶掉一半，样式也无法控制；
 *  · 部分内嵌 WebView / 隐私模式会**直接拦截** prompt，返回 null；
 *  · 而原来的代码在拿到 null 时是"静默什么都不做" —— 用户点了「新建单词本并加入」，
 *    界面上一点反应都没有，只能以为按钮坏了。
 * 现在有正经界面：输入框默认带一个名字，回车即建，取消有明确反馈。
 */
export function NewBookModal({ defaultValue = '我的单词本', onSubmit, onClose, hint }) {
  const [name, setName] = useState(defaultValue);
  useEscape(onClose);
  const clean = name.trim();
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal rename-modal" role="dialog" aria-modal="true" aria-label="新建单词本" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>新建单词本</h2><button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button></div>
        <label>单词本名字
          <input value={name} autoFocus maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && clean) onSubmit(clean); }} />
        </label>
        <p className="muted small">{hint || '建好之后，查词时在卡片底部选它就能存进去。'}</p>
        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose}>取消</button>
          <button className="primary-btn" onClick={() => onSubmit(clean)} disabled={!clean}>新建</button>
        </div>
      </div>
    </div>
  );
}
