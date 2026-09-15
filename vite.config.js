import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发代理目标可用 VITE_API_TARGET 覆盖（默认本机 8787，与 npm run server 一致）
const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:8787';

// GitHub Pages 的**项目站点**挂在子路径下（https://<用户名>.github.io/<仓库名>/），
// 资源必须按这个前缀引用，否则 /assets/xxx.js 会 404。
// 用 VITE_BASE 覆盖；缺省 '/' —— Render 一体部署就是根路径。
const base = process.env.VITE_BASE || '/';

export default defineConfig({
  base,
  plugins: [react()],
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
