import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发代理目标可用 VITE_API_TARGET 覆盖（默认本机 8790，与 npm run server 的端口一致）
const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:8790';

// GitHub Pages 的**项目站点**挂在子路径下（https://<用户名>.github.io/<仓库名>/），
// 资源必须按这个前缀引用，否则 /assets/xxx.js 会 404。
// 用 VITE_BASE 覆盖；缺省 '/' —— Render 一体部署就是根路径。
const base = process.env.VITE_BASE || '/';

/**
 * 构建标识：显示在「更多」菜单与 AI 设置里。
 * 为什么值得单独做：Service Worker 一上线，"我打开的是哪一版"就变得看不出来了 ——
 * 用户遇到过"功能明明做了，页面上却没有"，实际是浏览器里还挂着旧的一份。
 * 有了这行字，回一句"你看的是 09-15 18:30 那版，刷新一下"就够了。
 */
const _d = new Date();
const _p = (n) => String(n).padStart(2, '0');
// 用**本机时间**：用户对着自己的钟看，"你刷新一下，应该显示 19:15 那版"才说得通
const buildId = process.env.VITE_BUILD_ID
  || `${_p(_d.getMonth() + 1)}-${_p(_d.getDate())} ${_p(_d.getHours())}:${_p(_d.getMinutes())}`;

export default defineConfig({
  base,
  plugins: [react()],
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
    },
  },
  build: {
    // 把体积大、更新频率低的依赖单独切块，首屏主包更小、缓存命中率更高。
    // mammoth 已在 handleDocx 内动态 import，Rollup 会自动把它切成独立 chunk。
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          icons: ['lucide-react'],
        },
      },
    },
    chunkSizeWarningLimit: 400,
  },
  /**
   * 前端单元测试（vitest）。
   * 为什么之前没有：所有测试都跑在纯 Node 里（server/*.test.mjs、test/*.test.mjs），
   * 而 hooks 依赖 React 运行时，纯 Node 加载不了 —— 于是 1800 多行 hooks 一行测试都没有，
   * 重构期间也因此出过两次线上白屏（漏 import、重复迁移）。这里补上这一层。
   * 环境用 jsdom（hooks 要碰 localStorage / matchMedia）。
   */
  test: {
    environment: 'jsdom',
    include: ['test/ui/**/*.test.jsx', 'test/ui/**/*.test.js'],
    globals: true,
    restoreMocks: true,
  },
});
