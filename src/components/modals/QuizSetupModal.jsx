import React from 'react';
import { Sparkles, X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap.js';
import { useEscape } from '../../hooks/useEscape.js';

/**
 * 生成自测题：选范围（当前本子 / 全部）与题量。
 */
export default function QuizSetupModal({
  activeBook, totalEntries, counts, scope, setScope, count, setCount, onStart, onClose,
}) {
  const trapRef = useFocusTrap();
  useEscape(onClose);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" role="dialog" ref={trapRef} aria-modal="true" aria-label="生成自测题" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>生成自测题</h2><button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button></div>
        <p className="muted small">围绕单词本里的词条出题，题型混搭：词义辨析 / 填空 / 中译英 / 改错 / 用法判断。</p>
        <label>出题范围
          <select className="ocr-mode" value={scope} onChange={(e) => setScope(e.target.value)} style={{ marginLeft: 8 }}>
            {activeBook ? <option value="book">当前本子：{activeBook.name}（{activeBook.entries.length}）</option> : null}
            <option value="all">全部词条（{totalEntries}）</option>
          </select>
        </label>
        <label>题目数量
          <select className="ocr-mode" value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ marginLeft: 8 }}>
            {counts.map((n) => <option key={n} value={n}>{n} 题</option>)}
          </select>
        </label>
        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose}>取消</button>
          <button className="primary-btn" onClick={onStart}><Sparkles size={15} />开始出题</button>
        </div>
      </div>
    </div>
  );
}
