/**
 * ESLint 配置（平铺式，ESLint 9）。
 *
 * 为什么必须有：App 里写着 `// eslint-disable-next-line react-hooks/exhaustive-deps`
 * 这类注释，但仓库里**没有 linter** —— 注释写给空气。而 60+ 个 state、20 个 ref、
 * 8 个 effect 正是 hooks 出错的高发区（依赖漏写、条件调用、陈旧闭包），
 * 这类 bug 的表现是"偶尔不对"，靠人眼和手测都很难发现。
 *
 * 规则取舍：只开**真能抓到 bug** 的（hooks 两条 + 基础语法），不做格式化风格检查
 * （那类规则噪音大、收益低，交给人自己写）。
 */
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'remotion-demo/**', 'tools/shotter/**', 'auth-worker/node_modules/**', '.dsh-recover/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks, react },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // ★ 这两条是 JSX 场景的关键：核心 no-undef/no-unused-vars 都看不懂 JSX 里的标识符 ——
      //   jsx-uses-vars：把 <Foo /> 记成"用到了 Foo"（否则全部误报为未使用）
      //   jsx-no-undef：<Foo /> 里用了没导入的组件/图标时报错（这是构建期看不出来的运行时崩溃）
      'react/jsx-uses-vars': 'error',
      'react/jsx-no-undef': 'error',
      'react/jsx-uses-react': 'off', // 新 JSX runtime 不需要每文件 import React
      // 未使用变量是重构残留的信号（模块搬走后 import 忘删）—— 但允许下划线前缀显式忽略
      // React 默认导入在自动 JSX runtime 下是多余的（Vite 不需要），忽略它避免满屏噪音
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^(React|_)$', caughtErrors: 'none' }],
      // 下面的规则对现有代码噪音太大，先关掉；真要开就配套改代码
      'no-empty': ['error', { allowEmptyCatch: true }],
      // ★ TDZ 白屏：const/let 声明之前就被读（App 里 hook 一多就踩，vite build 查不出来）
      'no-use-before-define': ['error', { functions: false, classes: false, variables: true, allowNamedExports: false }],
    },
  },
  {
    // 服务端与脚本：Node 环境
    files: ['server/**/*.mjs', 'tools/**/*.mjs', 'test/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
