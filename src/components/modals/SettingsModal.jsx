import React, { useState } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap.js';
import { useEscape } from '../../hooks/useEscape.js';
import { THEMES } from '../../theme.js';

/**
 * AI 接入设置。
 * 留空 = 用服务端 .env 里的配置；填了只存在本机浏览器（Key 不会上传）。
 */
export default function SettingsModal({ settings, theme = 'system', onThemeChange, onClose, onSave }) {
  const trapRef = useFocusTrap();
  const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '', ...settings });
  useEscape(onClose);
  const field = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" role="dialog" ref={trapRef} aria-modal="true" aria-label="AI 设置" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>AI 接入设置</h2><button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button></div>
        <label>外观
          <select className="ocr-mode" value={theme} onChange={(e) => onThemeChange && onThemeChange(e.target.value)} style={{ marginLeft: 8 }}>
            {THEMES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <label className="stream-toggle">
          <input type="checkbox" checked={form.streamLookup !== false}
            onChange={(e) => setForm((f) => ({ ...f, streamLookup: e.target.checked }))} />
          <span>流式输出（边生成边看）</span>
        </label>
        <p className="muted small">
          打开后：音标/释义/近义词…会**一块一块长出来**，不用等整张卡片写完；
          关掉则和以前一样，等全部生成完再显示。
          <b>关掉是排查问题的保险绳</b>——若某次生成看起来不对劲，可以先关掉再试。
        </p>
        <p className="muted small">留空就用服务端 .env 里的配置；填了就只存在本机浏览器。</p>
        <p className="muted small">前端版本：{typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'}
          <span className="muted small">（页面上没有刚做的新功能时，先按 Ctrl+F5 / Cmd+Shift+R 强制刷新）</span></p>
        <label>Base URL
          <input value={form.baseUrl} onChange={field('baseUrl')} placeholder="https://api.deepseek.com/v1" />
        </label>
        <label>模型
          <input value={form.model} onChange={field('model')} placeholder="deepseek-chat" />
        </label>
        <label>API Key
          <input value={form.apiKey} onChange={field('apiKey')} placeholder="sk-…（只存本机）" type="password" />
        </label>
        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose}>取消</button>
          <button className="primary-btn" onClick={() => onSave(form)}>保存</button>
        </div>
      </div>
    </div>
  );
}
