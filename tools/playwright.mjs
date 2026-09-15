/**
 * Playwright 的解析入口（本地开发与 CI 共用）。
 *
 * 为什么单独一个文件：三个工具（e2e / PDF / 用户模拟）以前各自把
 * `file:///D:/AI/66666-main/tools/shotter/node_modules/playwright/index.mjs`
 * 写死在代码里 —— 那是我本机的路径，别人 clone 下来跑不了，CI 更跑不了。
 * 现在按优先级找：
 *   ① 环境变量 PLAYWRIGHT_PATH（要 file:// URL 或包名）
 *   ② 项目里装的 playwright（CI：`npm i --no-save playwright`）
 *   ③ 本机那个共享安装目录（开发机上是它，省得每个项目装一份浏览器）
 *
 * 用法：
 *   import { chromium, devices } from './playwright.mjs';       // 拿不到会抛错
 *   const pw = await loadPlaywright();                          // 拿不到返回 null
 */

const CANDIDATES = [
  process.env.PLAYWRIGHT_PATH,
  'playwright',
  'file:///D:/AI/66666-main/tools/shotter/node_modules/playwright/index.mjs',
].filter(Boolean);

let cached = null;

/** @returns {Promise<{chromium:any, devices:any}|null>} */
export async function loadPlaywright() {
  if (cached) return cached;
  const tried = [];
  for (const spec of CANDIDATES) {
    try {
      const mod = await import(spec);
      if (mod && mod.chromium) { cached = mod; return mod; }
    } catch (e) {
      tried.push(`${spec}（${String(e.message || e).slice(0, 60)}）`);
    }
  }
  console.error([
    '缺少 playwright，浏览器相关的测试跑不了。三种装法选一种：',
    '  ① 项目里装：npm i --no-save playwright && npx playwright install chromium',
    '  ② 用已有的安装：PLAYWRIGHT_PATH=file:///路径/node_modules/playwright/index.mjs node tools/sim-user.mjs',
    '  ③ 本机共享安装目录（开发机上通常已经有）：D:/AI/66666-main/tools/shotter',
    '尝试过的路径：',
    ...tried.map((t) => '  · ' + t),
  ].join('\n'));
  return null;
}

/** 拿不到就退出（脚本开头用） */
export async function requirePlaywright() {
  const pw = await loadPlaywright();
  if (!pw) process.exit(2);
  return pw;
}
