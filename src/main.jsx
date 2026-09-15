import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { installErrorReporting, reportError } from './errorReport.js';
import './styles.css';

// 全局兜底：window.onerror / unhandledrejection 都送到自家后端（详见 errorReport.js）
installErrorReporting();

/**
 * 兜底错误边界。
 * React 在渲染期抛异常会卸载整棵树 —— 用户看到的就是「整页白屏」且无法自救。
 * 白屏最常见的根因：历史结果里存了模型返回的脏数据（数组里混进 null），
 * 而 URL 上的 #job= 恢复入口会把同一份坏数据再灌回来，于是 F5 变成循环白屏。
 * 这里提供两条自救路径：重试 / 只清结果缓存（不动收藏、历史与 API Key）。
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('[回译本] 渲染崩溃:', error, info?.componentStack);
    // 渲染崩溃 = 白屏，是最该被看到的错误类型：连组件栈一起报上去
    reportError('react', error, { stack: (error && error.stack) + '\n--- componentStack ---\n' + (info?.componentStack || '') });
  }
  render() {
    if (!this.state.error) return this.props.children;
    // 只清结果缓存（bt-result-*），收藏 / 历史 / 设置 / 计时都不动
    const clearResultCache = () => {
      try {
        for (const key of Object.keys(localStorage)) if (key.startsWith('bt-result-')) localStorage.removeItem(key);
      } catch { /* 存储不可用时忽略 */ }
      if (location.hash) location.hash = '';
      location.reload();
    };
    const retry = () => {
      if (location.hash) location.hash = '';
      location.reload();
    };
    return (
      <div style={{ maxWidth: 580, margin: '12vh auto', padding: '0 20px', fontFamily: 'system-ui, -apple-system, sans-serif', lineHeight: 1.75, color: '#1c2733' }}>
        <h1 style={{ fontSize: 20, margin: '0 0 12px' }}>页面渲染出错了</h1>
        <p style={{ color: '#5b6875', margin: '0 0 12px' }}>
          多半是上一次 AI 返回的数据结构不完整导致的。先点「重试」；如果还是这一页，就点「清除结果缓存」——
          它<b>只会清掉本机的结果缓存</b>，你的收藏、历史记录、API Key 和计时都不会动。
        </p>
        <pre style={{ background: '#f5f7f9', padding: 12, borderRadius: 8, fontSize: 12, overflow: 'auto', maxHeight: 160, margin: '0 0 16px' }}>
          {String(this.state.error?.message || this.state.error)}
        </pre>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={retry} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #cfd8e0', background: '#fff', cursor: 'pointer', fontSize: 14 }}>重试</button>
          <button onClick={clearResultCache} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#10222e', color: '#fff', cursor: 'pointer', fontSize: 14 }}>清除结果缓存并重载</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
