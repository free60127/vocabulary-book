import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { installErrorReporting, reportError } from './errorReport.js';
import { watchVisualViewportHeight } from './visualViewport.js';
import './styles.css';

// 全局兜底：window.onerror / unhandledrejection 都送到自家后端（详见 errorReport.js）
installErrorReporting();
// 把 visualViewport 的可视高度写进 CSS 变量 --vvh：软键盘弹出时弹窗收进可视区（详见 visualViewport.js）
watchVisualViewportHeight();

/**
 * 兜底错误边界。
 * React 在渲染期抛异常会卸载整棵树 —— 用户看到的就是「整页白屏」且无法自救。
 * 白屏最常见的两个根因（本机实测）：
 *   ① 浏览器**禁用了站点数据**（Safari 无痕 / 关闭 Cookie / 被 iframe 嵌入）：
 *      localStorage 读写会抛 SecurityError，而它在首次 render 的惰性初始化里；
 *   ② 本机存的历史/同步快照里有脏数据（数组里混进 null）。
 * 这里把两条都告诉用户，并给两条自救路径。
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
    console.error('[单词本] 渲染崩溃:', error, info?.componentStack);
    // 渲染崩溃 = 白屏，是最该被看到的错误类型：连组件栈一起报上去
    reportError('react', error, { stack: (error && error.stack) + '\n--- componentStack ---\n' + (info?.componentStack || '') });
  }
  render() {
    if (!this.state.error) return this.props.children;
    const msg = String(this.state.error?.message || this.state.error || '');
    const storageBlocked = /SecurityError|insecure|localStorage|storage/i.test(msg)
      || this.state.error?.name === 'SecurityError';
    const retry = () => location.reload();
    // 只清本机缓存的入口：词条与排期都在 localStorage 里，清之前必须问一声
    const clearLocal = () => {
      if (!window.confirm('会清掉本机保存的单词本、复习进度与历史（云端同步的副本不受影响）。确定吗？')) return;
      try {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith('vb-') && key !== 'vb-settings' && key !== 'vb-account' && key !== 'vb-token') {
            localStorage.removeItem(key);
          }
        }
      } catch { /* 存储本身不可用时忽略 */ }
      location.reload();
    };
    return (
      <div style={{ maxWidth: 580, margin: '12vh auto', padding: '0 20px', fontFamily: 'system-ui, -apple-system, sans-serif', lineHeight: 1.75, color: '#1c2733' }}>
        <h1 style={{ fontSize: 20, margin: '0 0 12px' }}>页面渲染出错了</h1>
        {storageBlocked ? (
          <p style={{ color: '#5b6875', margin: '0 0 12px' }}>
            浏览器<b>不允许本页保存数据</b>（无痕模式、关闭了 Cookie / 站点数据，或页面被嵌在别处）。
            请用普通窗口打开，或在浏览器设置里允许本站保存数据，然后点「重试」。
          </p>
        ) : (
          <p style={{ color: '#5b6875', margin: '0 0 12px' }}>
            多半是本机存的历史或同步数据里有坏掉的记录（比如某次 AI 返回的结构不完整）。
            先点「重试」；还是这一页就点「清空本机数据」—— 它**只清本机**，云端同步的副本不受影响。
          </p>
        )}
        <pre style={{ background: '#f5f7f9', padding: 12, borderRadius: 8, fontSize: 12, overflow: 'auto', maxHeight: 160, margin: '0 0 16px' }}>
          {msg}
        </pre>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={retry} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #cfd8e0', background: '#fff', cursor: 'pointer', fontSize: 14 }}>重试</button>
          {storageBlocked ? null : (
            <button onClick={clearLocal} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#10222e', color: '#fff', cursor: 'pointer', fontSize: 14 }}>清空本机数据并重载</button>
          )}
        </div>
      </div>
    );
  }
}

/* ---------- 离线可用（Service Worker） ----------
 * 只在**生产构建**里注册：开发时 vite 的模块是即时编译的，SW 缓存会把热更新搅乱。
 * 作用：断网时页面仍能从缓存里打开 —— 复习本来就不需要网络（数据都在本机），
 * 没有它的话地铁里打开就是一张"无法连接"的错误页。
 * 注册失败不影响任何功能（离线能力是加分项，不是依赖）。 */
if (import.meta.env.PROD && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(async () => {
      const reg = await navigator.serviceWorker.ready.catch(() => null);
      if (!reg) return;
      // 把这一屏用到的同源资源交给 SW 预热缓存。
      // 不这么做的话，第一次访问的 JS/CSS 压根没经过 SW（那时它还没接管），
      // 缓存里只有 index.html —— 断网刷新就是白屏。
      const urls = performance.getEntriesByType('resource')
        .map((e) => e.name)
        .filter((u) => u.startsWith(location.origin));
      const target = navigator.serviceWorker.controller || reg.active;
      if (target) target.postMessage({ type: 'warm', urls });
    }).catch(() => { /* 忽略：无 SW 也能正常用 */ });
  });
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
