import React from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap.js';
import { useEscape } from '../../hooks/useEscape.js';

/**
 * 手机端导出 PDF 前的说明。
 *
 * Android/iOS 的 window.print() 直接弹系统打印界面，而"存成文件"藏在右上角
 * ⋮ 菜单里。不先说清楚，用户只会看到一个"未选择打印机"的界面，以为功能坏了。
 */
export default function PrintHintModal({ onCancel, onContinue }) {
  const trapRef = useFocusTrap();
  useEscape(onCancel);
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal print-hint-modal" role="dialog" ref={trapRef} aria-modal="true" aria-label="导出 PDF" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>导出 PDF</h2><button className="icon-btn" onClick={onCancel} aria-label="关闭"><X size={16} /></button></div>
        <p>接下来会打开系统的打印界面。<b>手机上系统默认没有打印机</b>，保存成文件的入口在右上角：</p>
        <ol className="print-hint-steps">
          <li>点右上角的 <b>⋮</b>（三个点）</li>
          <li>选「<b>保存为 PDF</b>」或「<b>存储为 PDF</b>」</li>
        </ol>
        <p className="muted small">排版已经按 A4 纸设好，手机上预览时看着小是正常的（它会缩放到纸张宽度）。</p>
        <div className="modal-actions">
          <button className="ghost-btn" onClick={onCancel}>取消</button>
          <button className="primary-btn" onClick={onContinue}>知道了，继续</button>
        </div>
      </div>
    </div>
  );
}
