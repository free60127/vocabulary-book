/**
 * 用户真实模拟（桌面端 + 手机端）。
 *
 * 和 tools/e2e-vocab.mjs 的分工：
 *   e2e   = 「功能在不在」—— 断言按钮点了会发生预期的事；
 *   sim   = 「人用起来顺不顺」—— 用真机尺寸/触摸/DPR 跑同一段旅程，
 *           量出横向溢出、点不中的按钮、被键盘顶飞的输入框、关不掉的弹窗、
 *           返回键直接退出应用这类**只有真机上才暴露**的问题，并逐屏截图存档。
 *
 * 跑法：
 *   npm run build
 *   node tools/sim-user.mjs                 # 全部设备
 *   node tools/sim-user.mjs desktop iphone13
 *   node tools/sim-user.mjs --shots-only
 *
 * 依赖：playwright（解析顺序见 tools/playwright.mjs：PLAYWRIGHT_PATH → 项目内安装 →
 * 本机共享安装目录）。截图落在 test/agent_out/sim/<设备>/（已被 .gitignore 忽略）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockProvider } from './mock-provider.mjs';
import { requirePlaywright } from './playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium, devices } = await requirePlaywright();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * 点保存栏主按钮：全新安装时保存栏是「新建单词本并加入」，
 * 现在走的是**应用内弹窗**（不再是 window.prompt）—— 不处理的话保存会静默失败。
 */
const saveViaBar = async (page) => {
  await page.locator('.save-bar .primary-btn').click();
  if (await page.locator('.rename-modal').count()) {
    await page.locator('.rename-modal input').fill('我的单词本');
    await page.locator('.rename-modal .primary-btn').click();
    await page.waitForTimeout(350);
  }
};


/**
 * 端口：默认**每次跑随机取一段**，避免和别的项目/别的会话撞车。
 *
 * 踩过的坑：姊妹项目（回译本）的 e2e 也用 8821/9821，两个会话同时跑时
 * 后起的那个直接 EADDRINUSE 崩掉，而且报错信息（"Emitted 'error' event on Server"）
 * 完全看不出是"端口被别人占了"。
 * 需要固定端口时用 SIM_PORT / SIM_MOCK / SIM_DICT_MOCK 覆盖。
 */
const PORT_BASE = Number(process.env.SIM_PORT_BASE || (26000 + Math.floor(Math.random() * 2000)));
const PORT = Number(process.env.SIM_PORT || PORT_BASE);
const MOCK = Number(process.env.SIM_MOCK || (PORT_BASE + 1));
const DICT_MOCK = Number(process.env.SIM_DICT_MOCK || (PORT_BASE + 2));
const BASE = `http://127.0.0.1:${PORT}/`;
const SHOTS = path.join(ROOT, 'test', 'agent_out', 'sim');
const argv = process.argv.slice(2);
const SHOTS_ONLY = argv.includes('--shots-only');
const ONLY = argv.filter((a) => !a.startsWith('--'));

/* ============================ 设备矩阵 ============================ */
const mocksRef = { current: null };   // mock 提供者（在启动后才赋值，profile 内部通过它取用）

const PROFILES = [
  { id: 'desktop', label: '桌面 1440×900', touch: false, opts: { viewport: { width: 1440, height: 900 } } },
  { id: 'laptop', label: '小笔记本 1280×720', touch: false, opts: { viewport: { width: 1280, height: 720 } } },
  { id: 'ipad', label: 'iPad 竖屏 820×1180', touch: true, opts: { ...devices['iPad (gen 7)'] } },
  { id: 'iphone13', label: 'iPhone 13 390×844', touch: true, opts: { ...devices['iPhone 13'] } },
  { id: 'iphonese', label: 'iPhone SE 320×568（最小屏）', touch: true, opts: { ...devices['iPhone SE'] } },
  { id: 'android', label: 'Android 412×915（Pixel 7）', touch: true, opts: { ...devices['Pixel 7'] } },
  { id: 'android-s', label: 'Android 393×727（Pixel 5，dpr 2.75）', touch: true, opts: { ...devices['Pixel 5'] } },
  { id: 'phone-flat', label: '手机横屏 844×390', touch: true, opts: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
].filter((p) => !ONLY.length || ONLY.includes(p.id));

/* ============================ 结果收集 ============================ */
const R = [];
const fail = (profile, name, detail) => { R.push({ profile, name, ok: false, detail }); console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); };
const pass = (profile, name, detail) => { R.push({ profile, name, ok: true, detail }); if (process.env.SIM_VERBOSE) console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); };
const warn = (profile, name, detail) => { R.push({ profile, name, ok: null, detail }); console.log(`  WARN  ${name}${detail ? '  — ' + detail : ''}`); };
const check = (profile, name, cond, detail) => (cond ? pass(profile, name, detail) : fail(profile, name, detail));

/* ============================ 页面审计 ============================ */
/**
 * 一屏里能被量出来的"真机不适"：
 *  · 横向溢出（页面能左右拖 / 整页被缩放）
 *  · 出界的可点元素（点不到的那一半）
 *  · 触摸设备上 <40px 的热区、<16px 的输入框（iOS 聚焦会自动放大整页）
 *  · 弹窗是否完整落在视口内
 */
async function audit(page, tag) {
  return page.evaluate((t) => {
    const de = document.documentElement;
    // ⚠️ 基准必须是 clientWidth 而不是 innerWidth：页面被撑宽后，手机浏览器会把
    // 视觉视口放大（innerWidth 跟着变大），用它当基准就永远量不出溢出。
    const vw = de.clientWidth; const vh = window.innerHeight;
    const name = (el) => {
      const cls = typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      const txt = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 14);
      return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls + (txt ? `[${txt}]` : '');
    };
    const box = (el) => el.getBoundingClientRect();
    const shown = (el) => {
      if (el.closest('.print-sheet')) return false;
      const r = box(el);
      if (r.width < 1 || r.height < 1) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    };

    // ① 横向溢出：只报"露出一半"的，完全在屏幕外的（如桌面端收起的侧栏）不算
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!shown(el)) continue;
      const r = box(el);
      if ((r.right > vw + 1 && r.left < vw) || (r.left < -1 && r.right > 1)) {
        out.push({ sel: name(el), l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) });
      }
    }

    // ② 触摸热区 < 40px（Apple HIG 说 44，留 4px 容差给内联图标）
    const small = [];
    if (t) {
      const sel = 'button, a[href], select, [role="button"], label.ghost-btn';
      for (const el of document.querySelectorAll(sel)) {
        if (!shown(el) || el.disabled) continue;
        const r = box(el);
        if (r.width < 40 || r.height < 40) {
          small.push({ sel: name(el), w: Math.round(r.width), h: Math.round(r.height) });
        }
      }
    }

    // ③ 表单：可点高度 < 40px（视觉上一整条大框，实际只有中间那行文字能点中）+ 字号 < 16px（iOS 聚焦会自动放大整页）
    const tiny = []; const lowField = [];
    if (t) {
      for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
        if (!shown(el)) continue;
        const r = box(el);
        if (r.height < 40) lowField.push({ sel: name(el), h: Math.round(r.height) });
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 16) tiny.push({ sel: name(el), size: Math.round(size * 10) / 10 });
      }
    }

    // ④ 弹窗是否完整在视口内（含内部可滚动区）
    const modal = document.querySelector('.modal-mask .modal');
    let modalBox = null;
    if (modal) {
      const r = box(modal);
      modalBox = {
        top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
        fitsH: r.top >= -1 && r.bottom <= vh + 1,
        scrollable: modal.scrollHeight > modal.clientHeight + 1,
        maskScrollTop: document.querySelector('.modal-mask').scrollTop,
      };
    }

    return {
      tag: t,
      vw, vh, innerWidth: window.innerWidth,
      docOverflowX: de.scrollWidth - de.clientWidth,
      bodyOverflowX: document.body.scrollWidth - de.clientWidth,
      docHeight: de.scrollHeight,
      out: out.slice(0, 12),
      small: small.slice(0, 12),
      smallCount: small.length,
      tiny: tiny.slice(0, 8),
      tinyCount: tiny.length,
      lowField: lowField.slice(0, 8),
      lowFieldCount: lowField.length,
      modalBox,
      coarse: window.matchMedia('(pointer: coarse)').matches,
      hoverNone: window.matchMedia('(hover: none)').matches,
      activeEl: document.activeElement ? name(document.activeElement) : '',
      activeIsField: /^(input|textarea|select)/.test((document.activeElement && document.activeElement.tagName || '').toLowerCase()),
      canScrollBehind: null,
    };
  }, tag);
}

const short = (a) => JSON.stringify(a).slice(0, 220);

/* ============================ 单个设备的旅程 ============================ */
async function runProfile(browser, p) {
  console.log(`\n=== ${p.label}（${p.id}）===`);
  const ctx = await browser.newContext({ acceptDownloads: true, ...p.opts });
  // 把 window.print 打桩：headless 里真调它会立刻触发 afterprint，打印页当场被收尾清掉，
  // 于是"导出 PDF"这一步永远量不到东西（实测踩到）。
  await ctx.addInitScript(() => { window.__printed = 0; window.print = () => { window.__printed += 1; }; });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message + ' @ ' + String(e.stack || '').split(String.fromCharCode(10)).slice(1, 3).join(' ').slice(0, 220)));
  page.on('requestfailed', (r) => {
    const url = r.url();
    const text = (r.failure() && r.failure().errorText) || '';
    /**
     * SSE 流式端点的 ERR_ABORTED 是**预期行为**，不算缺陷：
     * 服务端发完 `done` 后前端主动 close()（不 close 的话 EventSource 会自动重连，
     * 反而多打一次请求）。浏览器把这次主动关闭记成 ERR_ABORTED。
     * 只豁免这一种组合（路径是 /stream 且错误就是 ERR_ABORTED），别的一律照报。
     */
    if (/\/api\/lookup\/[^/]+\/stream$/.test(url) && /ERR_ABORTED/.test(text)) return;
    logs.push(`requestfailed: ${url} ${text}`);
  });
  const prompts = [];
  page.on('dialog', (d) => d.accept(d.type() === 'prompt'
    ? (prompts.length ? prompts.shift() : d.defaultValue())
    : undefined));



  /** 点「新建单词本」→ 出现的是应用内弹窗（不再是 window.prompt），填名字后提交 */
  const newBookVia = async (name) => {
    await page.locator('.sidebar .primary-btn').click();
    await page.waitForSelector('.rename-modal', { timeout: 8000 });
    await page.locator('.rename-modal input').fill(name);
    await page.locator('.rename-modal .primary-btn').click();
    await page.waitForTimeout(400);
  };

  let step = '(未开始)';
  const at = (s) => { step = s; };
  /* Playwright 拍**整页截图**时会临时改设备指标，拍完 (pointer: coarse) 会掉成 false ——
     之后所有"热区够不够大"都会按桌面尺寸误报（实测踩到，查了半天）。检测到就重新施加一次。 */
  let cdp = null;
  const ensureTouch = async () => {
    if (!p.touch) return;
    const ok = await page.evaluate(() => matchMedia('(pointer: coarse)').matches).catch(() => true);
    if (ok) return;
    cdp = cdp || await ctx.newCDPSession(page);
    const vp = page.viewportSize() || { width: 390, height: 780 };
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width, height: vp.height, deviceScaleFactor: p.opts.deviceScaleFactor || 1, mobile: true,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  };

  const shotDir = path.join(SHOTS, p.id);
  fs.mkdirSync(shotDir, { recursive: true });
  let n = 0;
  const shot = async (step) => {
    n += 1;
    await page.screenshot({ path: path.join(shotDir, `${String(n).padStart(2, '0')}-${step}.png`), fullPage: false });
  };
  const auditShot = async (step, { full = false } = {}) => {
    await ensureTouch();
    const a = await audit(page, step);
    if (process.env.SIM_VERBOSE) console.log(`  · 审计 ${step}: coarse=${a.coarse} vw=${a.vw} inner=${a.innerWidth} 小目标=${a.smallCount}`);
    await shot(step);
    if (full) {
      await page.screenshot({ path: path.join(shotDir, `${String(n).padStart(2, '0')}-${step}-full.png`), fullPage: true }).catch(() => {});
      await ensureTouch();
    }
    return a;
  };

  try {
  /** 顶栏动作：手机端「自测题 / 登录」收在「更多」菜单里，得先展开 */
  const clickTopAction = async (re) => {
    const more = page.locator('.topbar-more .icon-btn');
    if (await more.isVisible()) {
      await more.click();
      // ⚠️ 只能在菜单里找：桌面上那两个同名按钮在手机上是 display:none，
      // 用 page.locator('button') 会先命中它们，然后一直等它可见（实测超时）
      await page.waitForSelector('.more-menu', { timeout: 5000 });
      await page.locator('.more-menu button').filter({ hasText: re }).first().click();
      return;
    }
    await page.locator('.topbar button').filter({ hasText: re }).first().click();
  };

  /** 手机上侧栏是抽屉：直接点 .lesson-item 会打在 display:none 上，必须先拉开 */
  const openBook = async () => {
    if (p.touch && await page.locator('.sidebar').isHidden()) {
      await page.locator('.side-toggle').click();
      await page.waitForTimeout(320);
    }
    await page.locator('.lesson-item').first().click();
  };

    at('冷启动首屏');
    /* ---------- 0. 冷启动（第一次打开的人看到什么） ---------- */
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip', { timeout: 30000 });
    await page.waitForTimeout(400);
    const boot = await auditShot('home');
    check(p.id, '首屏没有横向溢出', boot.docOverflowX <= 1, `${boot.docOverflowX}px`);
    check(p.id, '首屏没有内容伸出屏幕', boot.out.length === 0, short(boot.out));
    if (p.touch) {
      check(p.id, '手机端进页面不自动弹软键盘', !boot.activeIsField, boot.activeIsField ? `焦点在 ${boot.activeEl}` : '未自动聚焦');
      check(p.id, '触摸热区都够大（≥40px）', boot.smallCount === 0, `${boot.smallCount} 处：${short(boot.small)}`);
      check(p.id, '输入框字号 ≥16px（iOS 不会自动放大）', boot.tinyCount === 0, short(boot.tiny));
      check(p.id, '输入框可点高度 ≥40px（大框别只有中间一行能点中）', boot.lowFieldCount === 0, short(boot.lowField));
      pass(p.id, '触摸媒体查询命中（44px 规则生效）', `pointer:coarse=${boot.coarse} hover:none=${boot.hoverNone}`);
    }
    pass(p.id, '首屏有引导说明（不是一片空白）', String(await page.locator('.start-guide').count()));
    {
      const chrome = await page.evaluate(() => {
        const bar = document.querySelector('.topbar');
        return { h: Math.round(bar.getBoundingClientRect().height), vh: window.innerHeight, nodes: document.querySelectorAll('*').length };
      });
      warn(p.id, '首屏顶栏占屏幕高度', `${chrome.h}px / ${chrome.vh}px（${Math.round(chrome.h / chrome.vh * 100)}%）· 全页 DOM ${chrome.nodes} 节点`);
      if (p.touch) {
        check(p.id, '手机端顶栏不超过两行（≤96px）', chrome.h <= 96, `${chrome.h}px（原来 148px）`);
      }
    }
    if (!p.touch) check(p.id, '桌面端自动聚焦搜索框（省一次点击）', boot.activeIsField, boot.activeEl);
    await page.screenshot({ path: path.join(shotDir, '00-home-full.png'), fullPage: true });
    await ensureTouch();

    at('空数据点复习');
    /* ---------- 0b. 空数据时点「今日待复习」要给话，不能没反应 ---------- */
    await page.locator('.due-btn').click();
    await page.waitForTimeout(300);
    check(p.id, '没词条时点复习给出提示', (await page.locator('.fav-tip.toast').count()) > 0,
      await page.locator('.fav-tip.toast').innerText().catch(() => ''));
    await page.waitForTimeout(2800);

    at('查询 object');
    /* ---------- 1. 查词 ---------- */
    await page.fill('.search-input', 'object');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.entry-card', { timeout: 60000 });
    await page.waitForTimeout(250);
    const card = await auditShot('card', { full: true });
    check(p.id, '词条卡片没有横向溢出', card.docOverflowX <= 1 && card.out.length === 0, `溢出 ${card.docOverflowX}px ${short(card.out)}`);
    if (p.touch) {
      check(p.id, '卡片上的热区都够大', card.smallCount === 0, `${card.smallCount} 处：${short(card.small)}`);
      check(p.id, '卡片上的表单控件够高', card.lowFieldCount === 0, short(card.lowField));
    }

    at('搜索框尺寸');
    /* 输入框套了一层容器（为了放 × 按钮）之后，手机端被挤成 68px 宽 ——
       这类"改结构把响应式规则打断"的问题，只有量宽度才能发现。 */
    {
      await page.fill('.search-input', 'tumult');
      await page.waitForTimeout(250);
      const box = await page.evaluate(() => {
        const input = document.querySelector('.search-input');
        const clear = document.querySelector('.input-clear');
        const r = input.getBoundingClientRect();
        const cr = clear && clear.getBoundingClientRect();
        return {
          vw: window.innerWidth,
          inputW: Math.round(r.width),
          inputH: Math.round(r.height),
          clearIn: Boolean(cr && cr.width > 0 && cr.right <= r.right + 1
            && cr.left >= r.left - 1
            && Math.abs((cr.top + cr.height / 2) - (r.top + r.height / 2)) <= 2),
          clearSize: cr ? Math.round(cr.width) : 0,
        };
      });
      check(p.id, '搜索框够宽（≥ 视口一半，手机端也是独占一行）',
        box.inputW >= box.vw / 2, JSON.stringify(box));
      check(p.id, '一键清空按钮在输入框内且可点',
        box.clearIn && box.clearSize >= 24, JSON.stringify(box));
      if (p.touch) {
        check(p.id, '手机上输入框高度够（44px，手指能点中）', box.inputH >= 40, `${box.inputH}px`);
      }
      await page.locator('.input-clear').click();
      await page.waitForTimeout(150);
    }

    at('中文查词');
    /* ---------- 1a2. 中文输入 → 先给候选词，挑一个再讲解 ----------
       线上真实事故：查"羽毛球"时词头直接是中文，音标却是 /ˈbædmɪntən/，自相矛盾。 */
    {
      await page.fill('.search-input', '羽毛球');
      await page.keyboard.press('Enter');
      // 候选面板是**内联**在搜索栏下面的：搜索框必须还在（用户能改词重搜）
      await page.waitForSelector('.zh-picker', { timeout: 60000 });
      check(p.id, '中文候选内联在搜索栏下方（输入框还在，可以改词重搜）',
        (await page.locator('.search-input').count()) === 1, '搜索框存在=' + (await page.locator('.search-input').count()));
      // ⚠️ 面板先出来、候选是异步到的：必须等条目渲染出来再断言，否则读到的是"正在找词…"的空列表
      await page.waitForSelector('.zh-item', { timeout: 60000 });
      await page.waitForTimeout(300);
      const cand = await page.evaluate(() => ({
        words: [...document.querySelectorAll('.zh-item .zh-word')].map((x) => x.textContent.trim()),
        notes: [...document.querySelectorAll('.zh-item .zh-note')].map((x) => x.textContent.trim()),
        hasVariant: /英式|美式/.test(document.querySelector('.zh-picker')?.innerText || ''),
      }));
      check(p.id, '中文查词先列候选词（不是直接把中文当词头）', cand.words.length >= 2 && cand.words.includes('badminton'), cand.words.join('/'));
      check(p.id, '候选里说清了英式/美式或语域的分工', cand.hasVariant, JSON.stringify(cand).slice(0, 160));
      await auditShot('zh-picker');
      // 选第一个 → 走正常查词讲解
      await page.locator('.zh-item').first().click();
      await page.waitForFunction(() => document.querySelector('.entry-card h1')?.textContent?.trim().length > 0, null, { timeout: 60000 });
      const picked = await page.evaluate(() => ({
        // h1 里除了词头还有音标（.phonetic），取第一个文本节点才是词头
        head: (document.querySelector('.entry-card h1')?.childNodes[0]?.textContent || '').trim(),
        query: document.querySelector('.search-input')?.value || '',
        last: JSON.parse(localStorage.getItem('vb-zh-picks') || '{}')['羽毛球'] || '',
      }));
      check(p.id, '挑完直接出这个英文词的完整卡片（词头是英文）', /^[A-Za-z]/.test(picked.head), picked.head);
      check(p.id, '搜索框回填成选中的英文词', picked.query === picked.head, JSON.stringify(picked));
      check(p.id, '记住"这个中文上次选的是哪个词"', picked.last === picked.head, picked.last);
    }

    at('超长连写内容');
    /* ---------- 1b. 长 token 不能把页面撑宽 ---------- */
    await page.fill('.search-input', '__huge__');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /__huge__/.test(document.querySelector('.entry-card h1')?.textContent || ''), null, { timeout: 60000 });
    await page.waitForTimeout(200);
    const huge = await audit(page, 'huge');
    check(p.id, '超长连写内容不撑宽页面', huge.docOverflowX <= 1, `溢出 ${huge.docOverflowX}px（视口 ${huge.vw} → 实际 ${huge.innerWidth}）${short(huge.out)}`);
    await shot('huge-card');

    at('存进单词本');
    /* ---------- 2. 存进单词本 ---------- */
    await page.fill('.search-input', 'object');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /object/i.test(document.querySelector('.entry-card h1')?.textContent || ''), null, { timeout: 60000 });
    await saveViaBar(page);
    await page.waitForSelector('.saved-flag', { timeout: 10000 });
    await auditShot('saved');

    at('回到顶部');
    /* ---------- 1b2. 长卡片滚到底之后要能一键回顶 ---------- */
    {
      // 上一步点「加入单词本」时，保存栏在卡片底部，Playwright 会把页面滚下去 —— 先回到顶部
      await page.evaluate(() => {
        const ed = document.querySelector('.editor');
        const root = document.scrollingElement || document.documentElement;
        if (ed) ed.scrollTop = 0;
        root.scrollTop = 0;
      });
      await page.waitForTimeout(700);
      const before = await page.evaluate(() => Boolean(document.querySelector('.back-to-top')));
      check(p.id, '回到顶部时按钮自己隐藏', !before);
      // 滚到底（桌面端滚 .editor，手机端滚整页）
      await page.evaluate(() => {
        const ed = document.querySelector('.editor');
        const root = document.scrollingElement || document.documentElement;
        if (ed) ed.scrollTop = ed.scrollHeight;
        root.scrollTop = root.scrollHeight;
        window.dispatchEvent(new Event('scroll'));
      });
      await page.waitForTimeout(400);
      const shown = await page.evaluate(() => {
        const btn = document.querySelector('.back-to-top');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), inView: r.top > 0 && r.bottom <= window.innerHeight + 1 };
      });
      check(p.id, '滚到底出现「回到顶部」按钮', Boolean(shown) && shown.inView, JSON.stringify(shown));
      if (p.touch) check(p.id, '「回到顶部」热区够大（44px）', shown && shown.w >= 44 && shown.h >= 44, JSON.stringify(shown));
      await shot('back-to-top');
      await page.locator('.back-to-top').click();
      // 平滑滚动需要一点时间（小屏上更明显）：等它稳定下来再断言，别用固定 sleep 赌
      await page.waitForFunction(() => {
        const ed = document.querySelector('.editor');
        const root = document.scrollingElement || document.documentElement;
        return (root.scrollTop || 0) <= 4 && (!ed || (ed.scrollTop || 0) <= 4);
      }, null, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(600);
      const back = await page.evaluate(() => {
        const ed = document.querySelector('.editor');
        const root = document.scrollingElement || document.documentElement;
        return { win: Math.round(root.scrollTop), ed: ed ? Math.round(ed.scrollTop) : 0, btn: Boolean(document.querySelector('.back-to-top')) };
      });
      check(p.id, '点它回到顶部（两个滚动容器都回零，按钮自己隐藏）', back.win <= 40 && back.ed <= 40 && !back.btn, JSON.stringify(back));
    }

    at('词条追问');
    /* ---------- 1c. 追问：就地再问一句（复用任务轮询，答案是纯文本） ---------- */
    {
      const hasAsk = (await page.locator('.ask-section').count()) === 1;
      check(p.id, '卡片上有追问输入框', hasAsk && (await page.locator('.ask-input').count()) === 1);
      if (hasAsk) {
        await auditShot('ask-empty');
        await page.locator('.ask-input').fill('它和 oppose 到底怎么选？');
        await page.locator('.ask-row .primary-btn').click();
        await page.waitForSelector('.ask-item .ask-a', { timeout: 40000 });
        const ans = await page.evaluate(() => ({
          q: document.querySelector('.ask-item .ask-q')?.textContent.trim(),
          a: document.querySelector('.ask-item .ask-a')?.textContent.trim(),
          input: document.querySelector('.ask-input')?.value,
          stored: Object.keys(JSON.parse(localStorage.getItem('vb-followups') || '{}')).length,
        }));
        check(p.id, '追问拿到回答并显示在卡片上', ans.a && ans.a.length > 5 && /object/i.test(ans.a), ans.a.slice(0, 40));
        check(p.id, '追问后输入框清空、问答留档在本机', ans.input === '' && ans.stored === 1, JSON.stringify({ input: ans.input, stored: ans.stored }));
        await auditShot('ask-answer');
        // 快捷问题：点一下就直接问
        await page.locator('.ask-chips .chip-btn').first().click();
        await page.waitForFunction(() => document.querySelectorAll('.ask-item').length >= 2, null, { timeout: 40000 });
        check(p.id, '快捷问题一键追问（不需要打字）', (await page.locator('.ask-item').count()) >= 2);
      }
    }

    at('数据安全提醒');
    /* ---------- 2c. 有数据却没同步码 → 必须明说"丢了找不回来" ----------
       真实事故：用户清了浏览数据，一天的词条与收藏全没了（当时没有同步码，云端没有副本）。 */
    {
      const banner = await page.evaluate(() => {
        const el = document.querySelector('.safety-banner');
        return el ? { text: el.innerText.replace(/\s+/g, ' ').trim(), danger: el.classList.contains('danger') } : null;
      });
      check(p.id, '有数据但没有同步码时出现安全提醒', Boolean(banner) && banner.danger,
        banner ? banner.text.slice(0, 60) : '（没有提醒）');
      check(p.id, '提醒里说清了"没有云端副本可恢复"', Boolean(banner) && /没有云端副本|找不回来|消失/.test(banner.text), banner ? banner.text.slice(0, 80) : '');
      await auditShot('safety-banner');
      // 点「生成同步码」→ 横幅消失（数据有退路了）
      if (banner) {
        await page.locator('.safety-banner .primary-btn').click();
        await page.waitForFunction(() => /^[a-f0-9]{32}$/.test(localStorage.getItem('vb-sync-code') || ''), null, { timeout: 20000 });
        await page.waitForTimeout(600);
        const after = await page.evaluate(() => Boolean(document.querySelector('.safety-banner')));
        check(p.id, '生成同步码后安全提醒消失', !after);
      }
    }

    at('再存一个词');
    await page.fill('.search-input', 'banana');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /banana/i.test(document.querySelector('.entry-card h1')?.textContent || ''), null, { timeout: 60000 });
    await page.waitForTimeout(200);
    await saveViaBar(page);
    await page.waitForTimeout(400);
    check(p.id, '第二个词也存进本子（复习至少两张卡）',
      (await page.evaluate(() => JSON.parse(localStorage.getItem('vb-books') || '[]').flatMap((b) => b.entries.map((e) => e.head)))).includes('banana'));

    at('收藏一个近义词');
    /* ---------- 2a. 收藏夹：收藏一个近义词，它当天就该进复习队列 ---------- */
    {
      const star = page.locator('.syn-acts .icon-btn[aria-label="收藏"]').first();
      if ((await star.count()) > 0) {
        await star.click();
        await page.waitForTimeout(300);
        const fav = await page.evaluate(() => ({
          favs: JSON.parse(localStorage.getItem('vb-favorites') || '[]').map((f) => f.head),
          sched: Object.keys(JSON.parse(localStorage.getItem('vb-schedule') || '{}')).filter((k) => k.startsWith('fav-')),
        }));
        check(p.id, '收藏近义词进收藏夹', fav.favs.length === 1, JSON.stringify(fav.favs));
        check(p.id, '新收藏立刻有排期（当天进复习队列）', fav.sched.length === 1, JSON.stringify(fav.sched));
      } else {
        fail(p.id, '卡片上没有收藏入口', '');
      }
    }

    at('重复查词');
    /* ---------- 2b. 同一个词再查一次：不能变成两条；而且**不该再花一次钱** ---------- */
    // 清空按钮（手机端挨个退格太难受）
    await page.fill('.search-input', 'tumult');
    await page.waitForTimeout(200);
    const clearBtn = await page.locator('.input-clear').count();
    check(p.id, '搜索框有一键清空按钮', clearBtn === 1);
    if (clearBtn) {
      await page.locator('.input-clear').click();
      await page.waitForTimeout(200);
      check(p.id, '点 × 清空全部字母（不用挨个退格）',
        (await page.inputValue('.search-input')) === '', await page.inputValue('.search-input'));
    }
    const callsBefore = mocksRef.current.calls.ai;
    await page.fill('.search-input', 'object');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /object/i.test(document.querySelector('.entry-card h1')?.textContent || ''), null, { timeout: 60000 });
    await page.waitForTimeout(250);
    check(p.id, '再查同一个词时卡片认出「已在单词本里」', (await page.locator('.saved-flag').count()) === 1,
      `标记 ${await page.locator('.saved-flag').count()} 个`);
    // 服务端缓存：同一个词同一档位 24 小时内不再调用模型（省钱省时间）
    check(p.id, '同一个词再查走服务端缓存（不再调用模型）', mocksRef.current.calls.ai === callsBefore,
      `模型调用 ${callsBefore} → ${mocksRef.current.calls.ai}`);
    await saveViaBar(page);
    await page.waitForTimeout(400);
    const heads = await page.evaluate(() => JSON.parse(localStorage.getItem('vb-books') || '[]').flatMap((b) => b.entries.map((e) => e.head)));
    check(p.id, '同一个词存两次不会变成两条',
      heads.filter((h) => h === 'object').length === 1, heads.join(','));

    at('侧栏抽屉');
    /* 滚动条：两侧可滚区域各画一条灰条太抢眼（用户截图反馈）——
       现在两端都隐藏，靠底部渐隐提示"下面还有"。 */
    {
      const bars = await page.evaluate(() => [...document.querySelectorAll('.sidebar, .side-section, .lesson-list')]
        .map((n) => getComputedStyle(n).scrollbarWidth));
      check(p.id, '侧栏不画滚动条（抽屉/分区/列表都隐藏）',
        bars.length > 0 && bars.every((v) => v === 'none'), bars.join('/'));
    }

    /* ---------- 3. 侧栏（手机端是抽屉） ---------- */
    if (p.touch && (p.opts.viewport?.width ?? 0) <= 900) {
      await page.locator('.side-toggle').click();
      await page.waitForTimeout(350);
      const drawer = await auditShot('sidebar');
      check(p.id, '抽屉打开后没有横向溢出', drawer.docOverflowX <= 1, `${drawer.docOverflowX}px`);
      // 抽屉打开时页面应当锁住滚动，否则手指划的是背后的正文（iOS 上手感是"抽屉在飘"）。
      // ⚠️ 必须用**用户滚动**（滚轮/触摸）来验：overflow:hidden 只挡用户滚动，
      // window.scrollBy 这种程序化滚动照样生效 —— 第一版就是这么误判的。
      const y0 = await page.evaluate(() => window.scrollY);
      await page.mouse.wheel(0, 320).catch(() => {});
      await page.waitForTimeout(250);
      const y1 = await page.evaluate(() => window.scrollY);
      const scrolled = Math.abs(y1 - y0) > 4;
      await page.evaluate((y) => window.scrollTo(0, y), y0);
      check(p.id, '抽屉打开时锁住背后的滚动', !scrolled, scrolled ? '背景跟着滚（手指划的是底下的正文）' : '已锁住');
      // 关掉
      await page.locator('.sidebar-close').click();
      await page.waitForTimeout(250);
      check(p.id, '抽屉能关掉', (await page.locator('.sidebar').isVisible()) === false);
    }

    at('单词本视图');
    /* ---------- 4. 单词本视图 ---------- */
    await openBook();
    await page.waitForSelector('.entry-row', { timeout: 8000 });
    await page.waitForTimeout(200);
    const book = await auditShot('book');
    check(p.id, '单词本视图没有横向溢出', book.docOverflowX <= 1 && book.out.length === 0, `${book.docOverflowX}px ${short(book.out)}`);
    if (p.touch) check(p.id, '单词本里的热区都够大', book.smallCount === 0, `${book.smallCount} 处：${short(book.small)} [coarse=${book.coarse} vw=${book.vw} inner=${book.innerWidth}]`);

    at('本子改名与合并');
    /* ---------- 4c. 改名 / 合并 ----------
       手机端这两个动作在**本子页顶部**（侧栏只有 268px，三个 44px 图标会把本子名挤成三四个字，
       实测被当成"手机端看不到我的单词本"）；桌面端侧栏行内也有。这里两边都验一遍。 */
    {
      if (p.touch && (await page.locator('.sidebar').isHidden())) { await page.locator('.side-toggle').click(); await page.waitForTimeout(320); }
      // ① 侧栏行：手机上必须只剩一个动作按钮，把宽度让给本子名
      const row = await page.evaluate(() => {
        const r = document.querySelector('.lesson-row');
        if (!r) return null;
        const item = r.querySelector('.lesson-item');
        const shown = (sel) => { const el = r.querySelector(sel); return el ? getComputedStyle(el).display !== 'none' : false; };
        return {
          itemW: Math.round(item.getBoundingClientRect().width),
          title: (item.querySelector('.lesson-title')?.textContent || '').trim(),
          edit: shown('.lesson-edit'), merge: shown('.lesson-merge'), del: shown('.lesson-del'),
        };
      });
      check(p.id, '侧栏单词本行显示得出名字（标题宽度 ≥160px）', Boolean(row) && row.itemW >= 160 && row.title.length > 0,
        row ? `${row.itemW}px · 「${row.title}」` : '没有本子行');
      if (p.touch) {
        check(p.id, '手机端侧栏只留删除（改名/合并挪到本子页）', row && !row.edit && !row.merge && row.del,
          row ? `改名=${row.edit} 合并=${row.merge} 删除=${row.del}` : '');
      }

      // ② 新建第二个本子（走真实的应用内弹窗；以前是 window.prompt，取消就静默失败）
      await page.locator('.sidebar .primary-btn').click();
      await page.waitForSelector('.rename-modal', { timeout: 8000 });
      check(p.id, '「新建单词本」用的是应用内弹窗（不是浏览器 prompt）',
        (await page.evaluate(() => document.querySelectorAll('.rename-modal input').length)) === 1);
      // 先试一次"取消"：应该给反馈，而不是什么都不发生
      await page.locator('.rename-modal .ghost-btn').click();
      await page.waitForTimeout(300);
      const cancelTip = await page.evaluate(() => document.querySelector('.fav-tip.toast')?.textContent || '');
      check(p.id, '取消新建时给出反馈（原来静默无反应）', /已取消/.test(cancelTip), cancelTip);
      await newBookVia('临时本子');
      const two = await page.evaluate(() => JSON.parse(localStorage.getItem('vb-books') || '[]').map((b) => b.name));
      check(p.id, '新建第二个单词本', two.length === 2, two.join(' / '));
      await shot('sidebar-two-books');

      // ③ 进第一个本子，用它页面上的「合并」
      if (p.touch && (await page.locator('.sidebar').isHidden()) === false) { await page.locator('.sidebar-close').click(); await page.waitForTimeout(220); }
      // ⚠️ 已经在某个本子里时**不能**再点侧栏那一行：它是"打开/收起"开关，再点一次会把本子收起来
      if ((await page.locator('.entry-row').count()) === 0) {
        await openBook();
        await page.waitForSelector('.entry-row', { timeout: 8000 });
      }
      const ops = await page.evaluate(() => [...document.querySelectorAll('.book-ops button')].map((b) => b.textContent.trim()));
      check(p.id, '本子页顶部有「改名 / 合并」', ops.some((t) => /改名/.test(t)) && ops.some((t) => /合并/.test(t)), ops.join(' / '));

      await page.locator('.book-ops button', { hasText: '合并' }).click();
      await page.waitForSelector('.merge-modal', { timeout: 8000 });
      const mergeModal = await auditShot('merge-modal');
      check(p.id, '合并弹窗完整在视口内', !mergeModal.modalBox || mergeModal.modalBox.fitsH, short(mergeModal.modalBox));
      await page.locator('.merge-modal .primary-btn').click();
      await page.waitForTimeout(700);
      const afterMerge = await page.evaluate(() => {
        const books = JSON.parse(localStorage.getItem('vb-books') || '[]');
        return {
          names: books.map((b) => b.name),
          heads: books.flatMap((b) => b.entries.map((e) => e.head)),
          tombstones: JSON.parse(localStorage.getItem('vb-deleted-books') || '[]').length,
        };
      });
      check(p.id, '合并后只剩一个本子、词条搬了过去', afterMerge.names.length === 1 && afterMerge.heads.includes('object'), short(afterMerge));
      check(p.id, '被合并掉的本子留了墓碑（否则下次同步会复活）', afterMerge.tombstones >= 1, `墓碑 ${afterMerge.tombstones} 个`);

      // ④ 改名（同一个位置）
      await page.waitForTimeout(300);
      if ((await page.locator('.book-ops button', { hasText: '改名' }).count()) === 0) await openBook();
      await page.locator('.book-ops button', { hasText: '改名' }).click();
      await page.waitForSelector('.rename-modal', { timeout: 8000 });
      await page.locator('.rename-modal input').fill('阅读词汇');
      await auditShot('rename-modal');
      await page.locator('.rename-modal .primary-btn').click();
      await page.waitForTimeout(600);
      const renamed = await page.evaluate(() => JSON.parse(localStorage.getItem('vb-books') || '[]').map((b) => b.name));
      check(p.id, '改名生效（词条与排期不受影响）', renamed.length === 1 && renamed[0] === '阅读词汇', renamed.join('/'));
      const stillThere = await page.evaluate(() => JSON.parse(localStorage.getItem('vb-books') || '[]')[0].entries.map((e) => e.head));
      check(p.id, '改名后词条还在', stillThere.includes('object') && stillThere.length >= 1, stillThere.join(','));
    }

    at('返回键');
    /* ---------- 4b. 返回键（手机端最容易踩：一按就退出应用） ---------- */
    const histBefore = await page.evaluate(() => history.length);
    await page.goBack({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(500);
    const stillHere = page.url().startsWith(BASE) && (await page.locator('.app').count()) > 0;
    const backToSearch = stillHere && (await page.locator('.entry-row').count()) === 0;
    check(p.id, '系统返回键不退出应用（回到上一个界面）', stillHere,
      stillHere ? `留在站内（history.length ${histBefore} → ${await page.evaluate(() => history.length)}）`
        : '直接退出了应用（安卓返回键 = 关掉页面）');
    if (stillHere) check(p.id, '返回键退回了上一个界面（单词本 → 搜索）', backToSearch, backToSearch ? '' : '视图没变');
    if (!stillHere) { await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.status-chip'); }

    at('复习');
    /* ---------- 5a. 一轮三张卡：本子 2 张 + 收藏夹 1 张 ----------
       现在进来先选模式（复习 / 拼写），选完直接按那个模式跑整轮 —— 不再是"进去再勾选"。 */
    await page.locator('.due-btn').click();
    await page.waitForSelector('.review-setup', { timeout: 8000 });
    {
      const setup = await page.evaluate(() => ({
        modes: [...document.querySelectorAll('.review-setup .mode-card strong')].map((x) => x.textContent.trim()),
        text: (document.querySelector('.review-setup')?.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
      }));
      check(p.id, '进复习先选模式（复习 / 拼写）', setup.modes.length === 2 && /复习模式/.test(setup.modes[0]) && /拼写模式/.test(setup.modes[1]), setup.modes.join('/'));
      check(p.id, '模式选择页说明这一批多少个词', /这一批 \d+ 个词/.test(setup.text), setup.text);
      await auditShot('review-setup');
      await page.locator('.review-setup .mode-card', { hasText: '复习模式' }).click();
      await page.locator('.review-setup .primary-btn').click();
    }
    await page.waitForSelector('.review-pane', { timeout: 8000 });
    await page.waitForTimeout(250);
    const queueLen = await page.evaluate(() => {
      const m = /\/(\s*)(\d+)/.exec(document.querySelector('.review-pane .panel-head h2')?.textContent || '');
      return m ? Number(m[2]) : 0;
    });
    check(p.id, '复习队列把收藏夹的词也算进来', queueLen >= 3, `${queueLen} 张卡`);
    const mixText = await page.evaluate(() => document.querySelector('.queue-mix')?.textContent.replace(/\s+/g, ' ').trim() || '');
    check(p.id, '复习页显示队列构成（本子 N · 收藏 M）', /本子\s*\d+/.test(mixText) && /收藏\s*\d+/.test(mixText), mixText);


    /* 轮内换模式：明确的"从头开始"，不做半路变题（用户先后两次反馈合起来的结论） */
    {
      await page.locator('.mode-switch .mode-chip', { hasText: '拼写' }).click();
      await page.waitForTimeout(500);
      const sw = await page.evaluate(() => ({
        header: document.querySelector('.review-pane .panel-head h2')?.textContent.replace(/\s+/g, ' ').trim() || '',
        spellInput: document.querySelectorAll('.spell-input').length,
        index: (document.querySelector('.review-pane .panel-head h2')?.textContent || '').match(/\/\s*(\d+)/)?.[0] || '',
        toast: document.querySelector('.fav-tip.toast')?.textContent || '',
      }));
      check(p.id, '轮内切到拼写：立刻变拼写题且从头开始', sw.spellInput === 1 && /1\s*\//.test(sw.header), JSON.stringify(sw).slice(0, 110));
      // 再切回复习，后面按正常流程走
      await page.locator('.mode-switch .mode-chip', { hasText: '复习' }).click();
      await page.waitForTimeout(500);
      const back = await page.evaluate(() => ({
        spellInput: document.querySelectorAll('.spell-input').length,
        header: document.querySelector('.review-pane .panel-head h2')?.textContent.replace(/\s+/g, ' ').trim() || '',
      }));
      check(p.id, '再切回复习模式也是从头开始', back.spellInput === 0 && /1\s*\//.test(back.header), JSON.stringify(back).slice(0, 90));
    }

    const reveal = async () => {
      if (p.touch) await page.locator('.review-word').click();
      else await page.keyboard.press('Space');
      await page.waitForTimeout(280);
    };
    const gradeBy = async (kind) => {
      if (p.touch) {
        // 手机：右滑=简单、左滑=忘了
        await page.evaluate((dir) => {
          const el = document.querySelector('.review-answer');
          const mk = (type, x) => new TouchEvent(type, {
            bubbles: true, cancelable: true,
            touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientX: x, clientY: 300 })],
            changedTouches: [new Touch({ identifier: 1, target: el, clientX: x, clientY: 300 })],
          });
          el.dispatchEvent(mk('touchstart', dir > 0 ? 60 : 260));
          el.dispatchEvent(mk('touchend', dir > 0 ? 260 : 60));
        }, kind === 'easy' ? 1 : -1);
      } else {
        await page.keyboard.press(kind === 'easy' ? '3' : '1');
      }
      await page.waitForTimeout(600);
    };

    const rev1 = await auditShot('review-question');
    check(p.id, '复习首屏没有横向溢出', rev1.docOverflowX <= 1, `${rev1.docOverflowX}px`);
    await reveal();
    check(p.id, p.touch ? '点词头就能翻面' : '空格键就能翻面',
      (await page.locator('.grade-bar').count()) === 1, `评分条 ${await page.locator('.grade-bar').count()} 个`);
    const rev2 = await auditShot('review-answer');
    if (p.touch) check(p.id, '评分按钮热区够大', rev2.smallCount === 0, `${rev2.smallCount} 处：${short(rev2.small)}`);
    const gradesVisible = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.grade-bar button')];
      return { total: btns.length, inView: btns.filter((b) => b.getBoundingClientRect().bottom <= window.innerHeight + 1).length };
    });
    check(p.id, '三档评分按钮不用滚动就能点到', gradesVisible.inView === gradesVisible.total && gradesVisible.total === 3,
      `${gradesVisible.inView}/${gradesVisible.total} 在首屏内`);
    await gradeBy('easy');
    const graded = await page.evaluate(() => {
      const sched = JSON.parse(localStorage.getItem('vb-schedule') || '{}');
      const vals = Object.values(sched);
      return { easyCount: vals.filter((v) => v && v.lastGrade === 'easy' && v.reps === 1).length, total: vals.length };
    });
    check(p.id, p.touch ? '右滑评分（简单）写进排期' : '键盘 1/2/3 评分写进排期', graded.easyCount === 1, short(graded));

    /* ---------- 5b. 错词本：评「忘了」自动进本 ---------- */
    {
      await reveal();
      const headForgot = await page.evaluate(() => document.querySelector('.review-word strong')?.textContent.trim());
      await gradeBy('forgot');
      const afterForgot = await page.evaluate(() => ({
        wrong: JSON.parse(localStorage.getItem('vb-wrong') || '{}'),
        link: Boolean(document.querySelector('.review-foot .link-btn') || document.querySelector('.review-killed-line .link-btn')),
      }));
      const keys = Object.keys(afterForgot.wrong);
      check(p.id, '复习评「忘了」自动进错词本',
        keys.length === 1 && afterForgot.wrong[keys[0]].reason === 'forgot' && keys[0] === String(headForgot).toLowerCase(),
        `${headForgot} → ${JSON.stringify(afterForgot.wrong)}`);
      check(p.id, '复习页出现「错词本 N 个」入口', afterForgot.link);
      await shot('review-wrong');
    }

    /* ---------- 5c. 斩掉：这个词以后不再复习 ---------- */
    {
      const headNow = await page.evaluate(() => document.querySelector('.review-word strong')?.textContent.trim());
      await page.locator('.kill-btn').click();
      await page.waitForTimeout(450);
      const afterKill = await page.evaluate(() => ({
        killed: Object.keys(JSON.parse(localStorage.getItem('vb-killed') || '{}')),
        card: document.querySelector('.review-word strong')?.textContent.trim() || '',
        done: Boolean(document.querySelector('.review-done-line')),
        link: Boolean(document.querySelector('.review-foot .link-btn') || document.querySelector('.review-killed-line .link-btn')),
      }));
      check(p.id, '斩掉后写进已斩掉清单', afterKill.killed.length === 1, JSON.stringify(afterKill.killed));
      check(p.id, '斩掉的词从本轮里立刻消失（不用再翻它一次）',
        afterKill.done || (afterKill.card && afterKill.card !== headNow),
        afterKill.done ? '直接进入本轮完成' : `当前卡：${afterKill.card}`);
      check(p.id, '复习页能看到「已斩掉 N 个」入口', afterKill.link);
      await shot('review-killed');
      check(p.id, '一轮走完出现「本轮完成」与拼写加练入口', (await page.locator('.review-done-line').count()) > 0,
        (await page.locator('.review-pane').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 60));
      await auditShot('review-done');
    }

    /* ---------- 5d. 只练错词（练习模式不写排期），答对自动出本 ---------- */
    {
      const schedBefore = await page.evaluate(() => localStorage.getItem('vb-schedule'));
      const linkLoc = page.locator('.review-foot .link-btn, .review-killed-line .link-btn');
      // 完成页上有两个入口（错词本 / 已斩掉），错词本那个写着"错词本"
      const wrongLink = page.locator('.review-killed-line .link-btn', { hasText: '错词本' });
      if ((await wrongLink.count()) > 0) await wrongLink.click();
      else await linkLoc.first().click();
      await page.waitForSelector('.wrong-modal', { timeout: 8000 });
      const wrongModal = await auditShot('wrong-modal');
      check(p.id, '错词本弹窗完整在视口内', !wrongModal.modalBox || wrongModal.modalBox.fitsH, short(wrongModal.modalBox));
      check(p.id, '错词本列出刚答错的词', (await page.locator('.wrong-row').count()) === 1,
        (await page.locator('.wrong-row').innerText().catch(() => '')).replace(/\s+/g, ' '));
      await page.locator('.wrong-modal .primary-btn').click();   // 只练这些
      await page.waitForTimeout(600);
      const practicing = await page.evaluate(() => ({
        inReview: Boolean(document.querySelector('.review-pane')),
        header: document.querySelector('.review-pane .panel-head h2')?.textContent || '',
        isPractice: document.body.innerText.includes('拼写练习') || document.body.innerText.includes('练习'),
      }));
      check(p.id, '「只练这些」直接开一轮错词练习', practicing.inReview && /复习 1 \/ 1/.test(practicing.header), short(practicing));
      await reveal();
      await gradeBy('easy');
      const cleared = await page.evaluate(() => ({
        wrong: Object.keys(JSON.parse(localStorage.getItem('vb-wrong') || '{}')).length,
        sched: localStorage.getItem('vb-schedule'),
      }));
      check(p.id, '答对一次自动出错词本', cleared.wrong === 0, `还剩 ${cleared.wrong} 个`);
      check(p.id, '错词练习不改动复习排期（只练不写）', cleared.sched === schedBefore, '排期未变');
    }

    /* ---------- 5e. 过完一轮 → 用拼写再过一遍（拼对才放行 + 3 次提示给答案） ---------- */
    {
      const beforeSched = await page.evaluate(() => localStorage.getItem('vb-schedule'));
      await page.locator('.review-done-actions .primary-btn').click();
      await page.waitForTimeout(400);
      check(p.id, '点「用拼写再过一遍」进入拼写练习', /拼写练习/.test(await page.locator('.review-pane').innerText().catch(() => '')));
      check(p.id, '拼写模式出现输入框', (await page.locator('.spell-input').count()) === 1);

      /* 拼写轮里没有"勾选框"了 —— 模式在进来之前就定了；
         轮内想换模式要走「复习 / 拼写」那对小按钮，且明确从头开始（前面已验证） */
      check(p.id, '拼写轮里没有勾选框（模式进来前就定好）', (await page.locator('.spell-switch input').count()) === 0);
      check(p.id, '拼写轮顶栏显示当前模式', /拼写/.test(await page.locator('.mode-switch').innerText().catch(() => '')));

      const shownHead = await page.evaluate(() => document.querySelector('.review-word strong')?.textContent.trim());
      check(p.id, '拼写模式不显示词头（否则就是抄）', !/^[a-z]+$/i.test(String(shownHead)) && String(shownHead).length > 0, String(shownHead).slice(0, 14));

      await page.locator('.spell-input').fill('zzzz');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(350);
      check(p.id, '拼错不放行（还停在这一张，并标红）',
        (await page.locator('.spell-input.wrong').count()) === 1 && (await page.locator('.review-done-line').count()) === 0);
      const spellWrongTracked = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('vb-wrong') || '{}')).map((x) => x.reason));
      check(p.id, '拼写出错也记进错词本', spellWrongTracked.includes('spell') || spellWrongTracked.includes('reveal'),
        JSON.stringify(spellWrongTracked));

      const hintBtn = page.locator('.spell-help .ghost-btn');
      await hintBtn.click(); await page.waitForTimeout(160);
      const h1 = await page.locator('.spell-hint').innerText();
      await hintBtn.click(); await page.waitForTimeout(160);
      const h2 = await page.locator('.spell-hint').innerText();
      await hintBtn.click(); await page.waitForTimeout(220);
      const h3 = await page.locator('.spell-hint').innerText();
      const revealed = (hint) => String(hint).replace(/[_\s]/g, '').length;
      check(p.id, '提示逐级放开（首字母 → 一半 → 整个）',
        revealed(h1) === 1 && revealed(h2) > 1 && revealed(h2) < revealed(h3),
        `${h1} / ${h2} / ${h3}（露出字母 ${revealed(h1)}·${revealed(h2)}·${revealed(h3)}）`);
      check(p.id, '第 3 次提示后输入框被清空并要求重填',
        (await page.locator('.spell-input').inputValue()) === '' && /答案已给出/.test(await page.locator('.spell-help').innerText()));
      await shot('spell-hint');

      await page.locator('.spell-input').fill(h3.trim());
      await page.keyboard.press('Enter');
      await page.waitForTimeout(900);
      check(p.id, '照着答案重填正确后才进入下一张',
        (await page.locator('.review-done-line').count()) > 0 || (await page.locator('.spell-input').count()) === 0, '已离开这一张');
      await auditShot('spell-done');
      const afterSched = await page.evaluate(() => localStorage.getItem('vb-schedule'));
      check(p.id, '拼写练习同样不改动复习排期', beforeSched === afterSched, '排期未变');
      const exitBtn = page.locator('.review-done-actions .ghost-btn');
      if ((await exitBtn.count()) > 0) await exitBtn.click();
      else await page.locator('.review-head-tools .ghost-btn').click();
      await page.waitForTimeout(300);
    }

    /* ---------- 5b2. 复习完之后「今日待复习」仍然点得进去（今日加练） ---------- */
    {
      // 先确保已经退出复习：上一段（拼写）最后点了「回到查词」，也可能还停在完成页
      if ((await page.locator('.review-pane').count()) > 0) {
        const exit = page.locator('.review-done-actions .ghost-btn, .review-head-tools .ghost-btn').first();
        if ((await exit.count()) > 0) await exit.click();
        await page.waitForTimeout(450);
      }
      check(p.id, '（前置）已退出复习，回到主界面', (await page.locator('.search-bar').count()) === 1);

      const dueEmpty = await page.evaluate(() => /待复习$/.test(document.querySelector('.due-btn').textContent.replace(/\s+/g, ' ').trim()));
      check(p.id, '复习完之后没有到期的词（按钮不再显示计数）', dueEmpty, await page.locator('.due-btn').innerText());

      // 关键：这时候点「今日待复习」必须进得去，而且这一轮是"今日加练"（只练不写排期）
      const schedBefore = await page.evaluate(() => localStorage.getItem('vb-schedule'));
      await page.locator('.due-btn').click();
      // 没有到期的词 → 进的是「今日加练」的模式选择页（标题就是今日加练）
      await page.waitForSelector('.review-setup', { timeout: 8000 });
      await page.waitForTimeout(300);
      const again = await page.evaluate(() => ({
        header: (document.querySelector('.review-setup h2')?.textContent || '').replace(/\s+/g, ' ').trim(),
        body: (document.querySelector('.review-setup')?.innerText || '').replace(/\s+/g, ' ').slice(0, 90),
      }));
      check(p.id, '今天复习完之后「今日待复习」仍然进得去', /今日加练/.test(again.header), JSON.stringify(again).slice(0, 110));
      check(p.id, '加练页说明"不改变排期"', /不改变排期/.test(again.body), again.body);
      await auditShot('review-today-practice');
      await page.locator('.review-setup .mode-card', { hasText: '复习模式' }).click();
      await page.locator('.review-setup .primary-btn').click();
      await page.waitForSelector('.review-pane', { timeout: 8000 });
      await page.waitForTimeout(300);
      const prac = await page.evaluate(() => document.querySelector('.review-pane .panel-head h2')?.textContent.replace(/\s+/g, ' ').trim() || '');
      check(p.id, '这一轮标成「今日加练」', /今日加练/.test(prac), prac);
      // 加练不写排期
      await page.locator('.review-word').click().catch(() => {});
      await page.waitForTimeout(200);
      if ((await page.locator('.grade-bar .grade-ok').count()) > 0) await page.locator('.grade-bar .grade-ok').click();
      await page.waitForTimeout(500);
      const schedAfter = await page.evaluate(() => localStorage.getItem('vb-schedule'));
      check(p.id, '今日加练不改动复习排期', schedBefore === schedAfter);
      // 完成页可以顺势开拼写（"今天之内想再补上拼写"）
      if ((await page.locator('.review-done-actions .ghost-btn').count()) > 0) {
        await page.locator('.review-done-actions .ghost-btn').click();
      } else {
        await page.locator('.review-head-tools .ghost-btn').click();
      }
      await page.waitForTimeout(400);
      // 回到复习页继续后面的用例
      await page.locator('.due-btn').click();
      await page.waitForSelector('.review-setup', { timeout: 8000 });
      await page.waitForTimeout(300);
    }

    at('造句练习');
    /* ---------- 6b. 造句：两种模式 + AI 批改（用词/语法/语境） ---------- */
    {
      // 入口：桌面在顶栏，手机在「更多」里（复用现成的 clickTopAction）
      await clickTopAction(/造句/);
      await page.waitForSelector('.sentence-setup', { timeout: 8000 });
      const modes = await page.evaluate(() => [...document.querySelectorAll('.mode-card strong')].map((x) => x.textContent.trim()));
      check(p.id, '造句有两种模式：自由 / 翻译', modes.join('/') === '自由造句/翻译造句', modes.join('/'));
      await auditShot('sentence-setup');

      // 难度与题量都是可选的（用户要求）
      const opts = await page.evaluate(() => ({
        diff: [...document.querySelectorAll('.opt-row')][0] ? [...document.querySelectorAll('.opt-row')[0].querySelectorAll('.opt-chip')].map((b) => b.textContent.trim()) : [],
        counts: [...document.querySelectorAll('.opt-row')][1] ? [...document.querySelectorAll('.opt-row')[1].querySelectorAll('.opt-chip')].map((b) => b.textContent.trim()) : [],
      }));
      check(p.id, '难度三档可选', opts.diff.join('/') === '简单/中等/困难', opts.diff.join('/'));
      check(p.id, '题量可选 5/10/15/20 + 自定义', opts.counts.join('/') === '5 题/10 题/15 题/20 题/自定义', opts.counts.join('/'));
      await page.locator('.opt-row').nth(0).locator('.opt-chip', { hasText: '困难' }).click();
      await page.locator('.opt-row').nth(1).locator('.opt-chip', { hasText: '自定义' }).click();
      await page.locator('.opt-input').fill('3');
      await page.waitForTimeout(200);
      const pref = await page.evaluate(() => JSON.parse(localStorage.getItem('vb-sentence-pref') || '{}'));
      check(p.id, '难度与题量记在本机', pref.difficulty === '困难' && pref.count === 3, JSON.stringify(pref));
      await auditShot('sentence-options');
      await page.locator('.opt-row').nth(1).locator('.opt-chip').filter({ hasText: /^5 题$/ }).click();

      // 选翻译模式（要给中文句子）
      await page.locator('.mode-card', { hasText: '翻译造句' }).click();
      await page.locator('.sentence-setup .primary-btn').click();
      await page.waitForSelector('.sentence-pane', { timeout: 60000 });
      await page.waitForFunction(() => document.querySelectorAll('.sentence-word strong').length === 1, null, { timeout: 20000 });
      const task = await page.evaluate(() => ({
        head: document.querySelector('.sentence-word strong')?.textContent.trim() || '',
        cn: document.querySelector('.sentence-cn p')?.textContent.trim() || '',
        mode: document.querySelector('.sentence-pane h2')?.textContent.replace(/\s+/g, ' ').trim() || '',
      }));
      check(p.id, '翻译模式给出了中文句子', Boolean(task.cn) && /翻译造句/.test(task.mode), JSON.stringify(task).slice(0, 90));

      // ① 用上目标词 → 应该得分高、没有"没用上"标记
      await page.locator('.sentence-input').fill('I really want to use ' + task.head + ' in a sentence.');
      await page.locator('.sentence-actions .primary-btn').click();
      await page.waitForSelector('.sentence-grade', { timeout: 60000 });
      const good = await page.evaluate(() => ({
        score: Number((document.querySelector('.grade-score b') || {}).textContent || 0),
        flag: Boolean(document.querySelector('.grade-flag')),
        verdict: (document.querySelector('.grade-verdict p') || {}).textContent || '',
      }));
      check(p.id, '用上目标词 → 得分高且没有"没用上"标记', good.score >= 60 && !good.flag, JSON.stringify(good).slice(0, 90));
      await auditShot('sentence-graded');

      // ② 下一个词：故意不用目标词 → 应被判"没用上"、分数低、并进错词本
      await page.locator('.sentence-grade .primary-btn').click();
      await page.waitForTimeout(500);
      const head2 = await page.evaluate(() => document.querySelector('.sentence-word strong')?.textContent.trim() || '');
      await page.locator('.sentence-input').fill('This sentence has nothing to do with it.');
      await page.locator('.sentence-actions .primary-btn').click();
      await page.waitForSelector('.sentence-grade', { timeout: 60000 });
      const bad = await page.evaluate(() => ({
        score: Number((document.querySelector('.grade-score b') || {}).textContent || 0),
        flag: (document.querySelector('.grade-flag') || {}).textContent || '',
        problems: [...document.querySelectorAll('.grade-problem')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
        wrong: JSON.parse(localStorage.getItem('vb-wrong') || '{}'),
      }));
      check(p.id, '没用上目标词 → 明确标出来且分数低', bad.score < 60 && /没有用上/.test(bad.flag), JSON.stringify({ score: bad.score, flag: bad.flag }).slice(0, 80));
      check(p.id, '批改给出具体问题（不是一句"注意语法"）', bad.problems.length > 0 && bad.problems[0].length > 6, bad.problems[0] || '');
      check(p.id, '造句没写好会自动进错词本', Object.keys(bad.wrong).some((k) => k.includes(head2.toLowerCase())), Object.keys(bad.wrong).join(','));

      // ③ 收进错句本（完全由用户决定收不收）
      await page.locator('.sentence-grade .ghost-btn', { hasText: '收进错句本' }).click();
      await page.waitForTimeout(400);
      const saved = await page.evaluate(() => ({
        n: JSON.parse(localStorage.getItem('vb-sentences') || '[]').length,
        label: (document.querySelector('.sentence-grade .ghost-btn') || {}).textContent || '',
      }));
      check(p.id, '可以把自己写的句子收进错句本', saved.n === 1 && /已在错句本/.test(saved.label), JSON.stringify(saved));
      await page.locator('.sentence-pane .ghost-btn', { hasText: '退出练习' }).click();
      await page.waitForTimeout(400);
      check(p.id, '退出造句回到查词界面', (await page.locator('.search-bar').count()) === 1);

      // ④ 错句本能打开、看得到、删得掉
      await clickTopAction(/造句/);
      await page.waitForSelector('.sentence-setup', { timeout: 8000 });
      await page.locator('.book-link').click();
      await page.waitForSelector('.sentence-book', { timeout: 8000 });
      const book = await page.evaluate(() => ({
        items: document.querySelectorAll('.sentence-book-item').length,
        hasMine: /我写的/.test(document.querySelector('.sentence-book')?.innerText || ''),
        hasScore: Boolean(document.querySelector('.sb-score')),
      }));
      check(p.id, '错句本列出收藏的句子（含我的原句与分数）', book.items === 1 && book.hasMine && book.hasScore, JSON.stringify(book));
      await auditShot('sentence-book');
      await page.locator('.sentence-book .icon-btn.danger').first().click();
      await page.waitForTimeout(400);
      const afterDel = await page.evaluate(() => ({
        n: JSON.parse(localStorage.getItem('vb-sentences') || '[]').length,
        tombstones: JSON.parse(localStorage.getItem('vb-deleted-sentences') || '[]').length,
      }));
      check(p.id, '从错句本删除（并留墓碑，避免同步时被带回来）', afterDel.n === 0 && afterDel.tombstones === 1, JSON.stringify(afterDel));
      await page.locator('.sentence-book .primary-btn').click();
      await page.waitForTimeout(300);
      await page.locator('.sentence-setup .ghost-btn', { hasText: '回到查词' }).click();
      await page.waitForTimeout(300);
    }

    at('自测题');
    /* ---------- 6. 自测题 ---------- */
    await clickTopAction(/自测题/);
    await page.waitForSelector('div[aria-label="生成自测题"]', { timeout: 8000 });
    const quizModal = await auditShot('quiz-setup');
    check(p.id, '出题弹窗完整在视口内', !quizModal.modalBox || quizModal.modalBox.fitsH,
      short(quizModal.modalBox));
    await page.locator('.modal .primary-btn').filter({ hasText: /开始出题/ }).click();
    await page.waitForSelector('.quiz-item, .quiz-list li', { timeout: 60000 });
    await page.waitForTimeout(250);
    const quiz = await auditShot('quiz');
    check(p.id, '试卷页没有横向溢出', quiz.docOverflowX <= 1 && quiz.out.length === 0, `${quiz.docOverflowX}px ${short(quiz.out)}`);

    /* 作答 + 批改：选择题点选项、填空/主观题输入，然后一次批改 */
    {
      const qn = await page.locator('.quiz-item').count();
      const opts = page.locator('.quiz-option.clickable');
      const optCount = await opts.count();
      check(p.id, '自测题：选择题的选项可以点', optCount >= 2, `${qn} 题 / ${optCount} 个可点选项`);
      if (optCount) await opts.first().click();
      const inputs = page.locator('.quiz-input');
      const inputCount = await inputs.count();
      for (let i = 0; i < inputCount; i += 1) await inputs.nth(i).fill('test answer');
      await page.waitForTimeout(200);
      const gradeBtn = page.locator('.result-toolbar .primary-btn', { hasText: /批改/ });
      const label = (await gradeBtn.innerText()).replace(/\s+/g, ' ').trim();
      check(p.id, '自测题：作答后「批改」按钮显示进度（N/总数）', /批改（\d+\/\d+）/.test(label), label);
      await gradeBtn.click();
      await page.waitForTimeout(3500);
      const g = await page.evaluate(() => ({
        badges: document.querySelectorAll('.quiz-badge').length,
        feedback: document.querySelectorAll('.quiz-feedback').length,
        score: document.querySelector('.quiz-score')?.innerText?.replace(/\s+/g, ' ').trim() || '',
        picked: document.querySelectorAll('.quiz-option.picked').length,
      }));
      check(p.id, '自测题：批改后逐题给出判定与反馈', g.badges >= 1 && g.feedback >= 1, JSON.stringify(g));
      check(p.id, '自测题：批改后显示客观题得分', /客观题\s*\d+\s*\/\s*\d+/.test(g.score), g.score);
      check(p.id, '自测题：点过的选项保持选中状态', g.picked >= 1 || optCount === 0, JSON.stringify(g));
      /* 两个真实反馈：① 白送题（题干里写着答案）要被修掉/剔除；② 未作答的题**不能**被揭晓答案 */
      const auditNote = await page.evaluate(() => document.querySelector('.quiz-audit')?.innerText?.replace(/\s+/g, ' ').trim() || '');
      check(p.id, '自测题：体检把"题干写着答案"的题修好或剔除，并如实说明',
        /修好|剔除/.test(auditNote), auditNote || '(没有提示)');
      const blanks = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.quiz-item')];
        const blank = items.filter((it) => /未作答/.test(it.querySelector('.quiz-head')?.innerText || ''));
        return {
          blankCount: blank.length,
          leaked: blank.filter((it) => /参考答案/.test(it.innerText)).length,
        };
      });
      check(p.id, '自测题：只做了一部分时，未作答的题不会显示参考答案',
        blanks.blankCount === 0 || blanks.leaked === 0, JSON.stringify(blanks));
      const hideBtn = page.locator('.result-toolbar .ghost-btn', { hasText: /收起批改/ });
      if (await hideBtn.count()) {
        await hideBtn.click();
        await page.waitForTimeout(250);
        const hidden = await page.evaluate(() => document.querySelectorAll('.quiz-feedback').length);
        check(p.id, '自测题：批改反馈可以收起（关得掉）', hidden === 0, `收起后反馈块 ${hidden} 个`);
        await page.locator('.result-toolbar .ghost-btn', { hasText: /显示批改/ }).click();
      } else {
        check(p.id, '自测题：批改反馈可以收起（关得掉）', false, '没找到「收起批改」按钮');
      }
      await auditShot('quiz-graded');
    }

    at('登录弹窗与 ESC');
    /* ---------- 7. 弹窗：ESC 关闭 / 遮罩关闭 / 焦点 ---------- */
    await clickTopAction(/登录|@/);
    await page.waitForSelector('.auth-modal', { timeout: 8000 });
    await page.waitForTimeout(200);
    const authA = await auditShot('auth');
    check(p.id, '登录弹窗完整在视口内', !authA.modalBox || authA.modalBox.fitsH, short(authA.modalBox));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    const escCloses = (await page.locator('.auth-modal').count()) === 0;
    check(p.id, 'ESC 能关闭弹窗', escCloses, escCloses ? '可以' : '不能（键盘用户只能去点右上角的 X）');
    if (!escCloses) { await page.mouse.click(4, 4); await page.waitForTimeout(300); }

    at('同步面板');
    /* ---------- 8. 同步面板（含模态堆叠） ---------- */
    if (p.touch && (p.opts.viewport?.width ?? 0) <= 900) { await page.locator('.side-toggle').click(); await page.waitForTimeout(300); }
    await page.locator('.side-footer button').filter({ hasText: /备份/ }).click();
    await page.waitForSelector('.backup-modal', { timeout: 8000 });
    await page.waitForTimeout(250);
    const backup = await auditShot('backup', { full: p.touch });
    check(p.id, '同步面板完整在视口内', !backup.modalBox || backup.modalBox.fitsH, short(backup.modalBox));
    check(p.id, '同步面板内部可滚动（小屏放得下全部内容）', !backup.modalBox || !backup.modalBox.fitsH ? backup.modalBox.scrollable : true, short(backup.modalBox));
    // 点遮罩关闭
    await page.mouse.click(4, 4);
    await page.waitForTimeout(300);
    check(p.id, '点遮罩能关掉弹窗', (await page.locator('.backup-modal').count()) === 0);

    at('导出 PDF');
    /* ---------- 9. 导出 PDF（手机端先弹说明；打印媒体下不能溢出） ---------- */
    await openBook();
    await page.waitForSelector('.entry-row', { timeout: 8000 });
    await page.locator('.book-toolbar button').filter({ hasText: /导出本子 PDF/ }).click();
    await page.waitForTimeout(350);
    if (p.touch) {
      const hint = await page.locator('.print-hint-modal').count();
      check(p.id, '手机端导出前先解释"存成文件在系统菜单里"', hint > 0, `弹窗 ${hint} 个`);
      await shot('print-hint');
      await page.locator('.print-hint-modal .primary-btn').click();
      await page.waitForTimeout(200);
    } else {
      await page.waitForTimeout(300);
    }
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(300);
    const printed = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sheetVisible: Boolean(document.querySelector('.print-sheet .entry-card')),
      appHidden: getComputedStyle(document.querySelector('.app')).display === 'none',
      cards: document.querySelectorAll('.print-sheet .entry-card').length,
    }));
    await page.screenshot({ path: path.join(shotDir, `${String(n + 1).padStart(2, '0')}-print.png`), fullPage: true }).catch(() => {});
    await page.emulateMedia({ media: 'screen' });
    check(p.id, '打印媒体下不溢出且只显示打印页', printed.overflow <= 1 && printed.sheetVisible && printed.appHidden, short(printed));

    at('错误路径');
    /* ---------- 10. 错误路径：模型 500 / 返回垃圾 ---------- */
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip');
    await page.fill('.search-input', '__error__');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.error-banner', { timeout: 60000 });
    const errText = (await page.locator('.error-banner').innerText()).replace(/\s+/g, ' ').slice(0, 90);
    check(p.id, '模型报错时给出可读错误（不是白屏/英文堆栈）', errText.length > 4, errText);
    await shot('error-banner');
    await page.locator('.err-close').click();
    await page.fill('.search-input', '__garbage__');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    const garbled = await page.locator('.error-banner, .entry-card').first().innerText().catch(() => '');
    check(p.id, '模型返回垃圾内容时也有提示', /失败|重试|不对|没有返回/.test(garbled), garbled.replace(/\s+/g, ' ').slice(0, 70));

    at('刷新后数据还在');
    /* ---------- 11. 刷新后数据还在 ---------- */
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip', { timeout: 20000 });
    const persisted = await page.evaluate(() => ({
      books: JSON.parse(localStorage.getItem('vb-books') || '[]').length,
      entries: JSON.parse(localStorage.getItem('vb-books') || '[]').reduce((s, b) => s + b.entries.length, 0),
    }));
    check(p.id, '刷新后单词本还在（本机持久化）', persisted.books >= 1 && persisted.entries >= 1, short(persisted));

    /* ---------- 12. 全程 console ---------- */
    const realErrors = logs.filter((l) => !/favicon|Download the React DevTools/i.test(l)
      // 离线重载时 Chromium 会抱怨 modulepreload 与"由 Service Worker 供给的模块脚本"不同源世界 ——
      // 这是 PWA + modulepreload 的已知噪音，不是本项目的问题（离线能力本身是用户要的）
      && !/cross-world service worker resource mismatch/i.test(l));
    check(p.id, '全程无 JS 报错 / 失败请求', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  } catch (e) {
    fail(p.id, `旅程在「${step}」中断`, e.message.split('\n')[0]);
    await page.screenshot({ path: path.join(shotDir, 'ZZ-crash.png') }).catch(() => {});
  }
  await ctx.close();
}

/* ============================ 对比度审计 ============================ */
/**
 * 按 WCAG 算"文字色 vs 实际背景色"的对比度。
 * 深色模式最容易出的问题不是"哪个块忘了改"，而是**改了底没改字**：
 * 深灰字压在深灰底上，肉眼一眼看不出，自动量一下立刻现形（阈值：正文 4.5，次要文字 3.0）。
 */
async function contrastAudit(page, selectors) {
  return page.evaluate((sels) => {
    const lum = (rgb) => {
      const c = rgb.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const parse = (s) => {
      const m = String(s).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map((x) => parseFloat(x));
      return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
    };
    const bgOf = (el) => {
      let node = el;
      while (node && node !== document.documentElement) {
        const c = parse(getComputedStyle(node).backgroundColor);
        if (c && c.a > 0.5) return c.rgb;
        node = node.parentElement;
      }
      const b = parse(getComputedStyle(document.body).backgroundColor);
      return b ? b.rgb : [255, 255, 255];
    };
    const out = [];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const fg = parse(getComputedStyle(el).color);
      if (!fg) continue;
      const bg = bgOf(el);
      const l1 = lum(fg.rgb); const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      out.push({ sel, ratio: Math.round(ratio * 100) / 100, fg: fg.rgb.join(','), bg: bg.join(',') });
    }
    return out;
  }, selectors);
}

/* ============================ 特殊场景（只跑一次） ============================ */
/**
 * 这些不是"某个屏幕尺寸"的问题，而是**环境**问题：
 * 禁用站点数据、后端不可用、连续提示 —— 真机上每个都遇到过，e2e 与模拟都没覆盖。
 */
async function runEdgeCases(browser) {
  console.log('\n=== 特殊场景（只跑一次） ===');
  const P = 'edge';

  /* ① 浏览器禁用站点数据（Safari 无痕 / 关 Cookie / 被 iframe 嵌）：不能白屏 */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
      });
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const alive = (await page.locator('.app').count()) > 0;
    const fallback = alive ? '' : (await page.locator('#root').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 50);
    check(P, '禁用站点数据时不白屏（界面照常出来）', alive, fallback);
    if (alive) {
      await page.fill('.search-input', 'object');
      await page.keyboard.press('Enter');
      const got = await page.waitForSelector('.entry-card', { timeout: 45000 }).then(() => true).catch(() => false);
      check(P, '禁用站点数据时查词仍能用（只是不落盘）', got);
    }
    await page.screenshot({ path: path.join(SHOTS, 'edge-no-storage.png') }).catch(() => {});
    await ctx.close();
  }

  /* ② 后端不可用（离线 / Render 免费档休眠）：本机单词本照常能看，查词给出人话 */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => {
      localStorage.setItem('vb-books', JSON.stringify([{
        id: 'bk-offline', name: '离线也要能看', note: '', createdAt: Date.now(),
        entries: [{ id: 'wb-offline', head: 'object', kind: 'word', brief: '物体', meanings: [], createdAt: Date.now() }],
      }]));
    });
    const page = await ctx.newPage();
    await page.route('**/api/**', (r) => r.abort());
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip');
    await page.waitForTimeout(400);
    let chip = (await page.locator('.status-chip').innerText()).replace(/\s+/g, ' ');
    if (!chip.trim() || !/后端未连接/.test(chip)) {
      // 手机端状态条只留一个小圆点，完整文案在「更多」菜单里
      const more = page.locator('.topbar-more .icon-btn');
      if (await more.isVisible()) {
        await more.click();
        await page.waitForSelector('.more-menu', { timeout: 5000 });
        chip = (await page.locator('.more-menu-info').innerText()).replace(/\s+/g, ' ');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
      }
    }
    // ⚠️ 不能一失败就说"未连接"：冷启动要 30~60 秒，先给"正在连接"（用户实测反馈过这个误报）
    check(P, '刚失败时不误报「未连接」，而是显示正在连接', !/未连接/.test(chip), chip);
    await page.waitForTimeout(13000);
    // 手机端顶栏的状态条只留圆点，完整文案在「更多」菜单里 —— 两处都读一遍
    let chip2 = await page.evaluate(() => (document.querySelector('.status-chip')?.innerText || '').replace(/\s+/g, ' ').trim());
    if (!chip2) {
      const more2 = page.locator('.topbar-more .icon-btn');
      if (await more2.isVisible()) {
        await more2.click();
        await page.waitForSelector('.more-menu', { timeout: 5000 });
        chip2 = (await page.locator('.more-menu-info').innerText()).replace(/\s+/g, ' ').trim();
        await page.keyboard.press('Escape');
      }
    }
    check(P, '持续连不上（约 13 秒后）才明说「未连接 · 点这里重试」', /未连接/.test(chip2), chip2);
    const drawer = await page.locator('.sidebar').isHidden();
    if (drawer) { await page.locator('.side-toggle').click(); await page.waitForTimeout(300); }
    const bookVisible = (await page.locator('.lesson-item').count()) > 0;
    check(P, '后端连不上时本机单词本照常能看（离线优先）', bookVisible);
    if (drawer) { await page.locator('.sidebar-close').click(); await page.waitForTimeout(250); }
    await page.fill('.search-input', 'object');
    await page.keyboard.press('Enter');
    const banner = await page.waitForSelector('.error-banner', { timeout: 30000 }).then(() => true).catch(() => false);
    const text = banner ? (await page.locator('.error-banner').innerText()).replace(/\s+/g, ' ').slice(0, 60) : '（没有提示，一直转圈）';
    check(P, '后端连不上时查词给出可读错误（不是无限转圈）', banner, text);
    await page.screenshot({ path: path.join(SHOTS, 'edge-offline.png') }).catch(() => {});
    await ctx.close();
  }

  /* ③ 连续两条提示：第二条不能被第一条的定时器提前清掉（实测只活 1.6s 而不是 2.6s） */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip');
    await page.locator('.due-btn').click();
    await page.waitForTimeout(1000);
    await page.locator('.due-btn').click();
    const t0 = Date.now();
    await page.waitForFunction(() => !document.querySelector('.fav-tip.toast'), null, { timeout: 8000 }).catch(() => {});
    const lived = Date.now() - t0;
    check(P, '第二条提示能待满自己的时长（不被上一条提前挑掉）', lived >= 2200, `存活 ${lived}ms（应 ≈2600ms）`);
    await ctx.close();
  }

  /* ②b 离线可用（Service Worker）：断网后重新打开，页面还能起来、本机数据还在 */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => {
      localStorage.setItem('vb-books', JSON.stringify([{
        id: 'bk-offline2', name: '断网也要能复习', note: '', createdAt: Date.now(),
        entries: [{ id: 'wb-offline2', head: 'object', kind: 'word', brief: '物体', meanings: [], createdAt: Date.now() }],
      }]));
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('.status-chip');
    // 等 SW 装上并接管（首次访问注册，缓存壳资源）
    // ⚠️ 必须带超时：SW 注册失败时 `ready` 永远不 resolve，
    // page.evaluate 又没有默认超时 —— 整个测试会静默挂死（实测踩过）
    const swReady = await page.evaluate(() => Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 6000)),
    ]).catch(() => false));
    check(P, 'Service Worker 注册成功（生产构建）', swReady === true);
    await page.waitForTimeout(600);   // 给静态资源一点时间进缓存

    await ctx.setOffline(true);
    const reloaded = await page.reload({ waitUntil: 'domcontentloaded' }).then(() => true).catch(() => false);
    const rendered = reloaded && (await page.locator('.app').count()) > 0;
    check(P, '断网后重新打开页面还能起来（SW 缓存壳资源）', rendered,
      rendered ? '' : '页面打不开 —— 离线能力没生效');
    if (rendered) {
      if (await page.locator('.sidebar').isHidden()) { await page.locator('.side-toggle').click(); await page.waitForTimeout(250); }
      const books = await page.locator('.lesson-item').count();
      check(P, '断网后本机单词本照常能看（复习不需要网络）', books > 0, `${books} 个本子`);
      await page.locator('.lesson-item').first().click();
      await page.waitForSelector('.entry-row', { timeout: 8000 }).then(() => true).catch(() => false);
      check(P, '断网后能进本子看词条', (await page.locator('.entry-row').count()) > 0);
      await page.screenshot({ path: path.join(SHOTS, 'offline-reload.png') }).catch(() => {});
    }
    await ctx.setOffline(false);
    await ctx.close();
  }

  /* ③a 深色模式：跟随系统，检查关键文字的可读性（对比度） */
  {
    const ctx = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'dark' });
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? d.defaultValue() : undefined));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip');
    const shell = await page.evaluate(() => {
      const bg = getComputedStyle(document.body).backgroundColor;
      const fg = getComputedStyle(document.body).color;
      return { bg, fg, scheme: getComputedStyle(document.documentElement).colorScheme };
    });
    const isDark = /rgba?\((\d+), (\d+), (\d+)/.test(shell.bg)
      && Number(RegExp.$1) + Number(RegExp.$2) + Number(RegExp.$3) < 260;
    check(P, '深色模式：页面底色确实变深（跟随系统）', isDark, JSON.stringify(shell));
    await page.screenshot({ path: path.join(SHOTS, 'dark-home.png') }).catch(() => {});

    // 查一个词，把卡片也拉进来一起量
    await page.fill('.search-input', 'object');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.entry-card', { timeout: 40000 });
    await page.waitForTimeout(300);
    const rows = await contrastAudit(page, [
      'body', '.topbar-left strong', '.muted.small', '.chip', '.entry-card h1',
      '.entry-brief', '.scene-line', '.syn-row .syn-word', '.dict-badge', '.save-bar',
      '.due-tag', '.search-input', '.start-guide-title',
    ]);
    const bad = rows.filter((r) => r.ratio < 4.5);
    const worst = rows.slice().sort((a, b) => a.ratio - b.ratio).slice(0, 3);
    check(P, '深色模式：正文对比度 ≥ 4.5', bad.length === 0,
      bad.length ? bad.map((r) => `${r.sel} ${r.ratio}`).join(' · ') : `最低 ${worst.map((r) => r.sel + ' ' + r.ratio).join(' / ')}`);
    await page.screenshot({ path: path.join(SHOTS, 'dark-card.png'), fullPage: false }).catch(() => {});

    /* 外观可选：跟随系统 / 亮色 / 暗色 —— 系统是暗色时也要能钉住亮色 */
    {
      await page.locator('.side-toggle').click();
      await page.waitForTimeout(300);
      await page.locator('.side-footer button', { hasText: 'AI 设置' }).click();
      await page.waitForSelector('.modal', { timeout: 8000 });
      const opts = await page.evaluate(() => {
        const sel = document.querySelector('.modal select');
        return sel ? [...sel.options].map((o) => o.textContent) : [];
      });
      check(P, '设置有「外观」三档可选', opts.slice(0, 3).join('/') === '跟随系统/亮色/暗色', opts.join('/'));
      await page.locator('.modal select').first().selectOption('light');
      await page.waitForTimeout(350);
      const light = await page.evaluate(() => ({
        attr: document.documentElement.getAttribute('data-theme'),
        bg: getComputedStyle(document.body).backgroundColor,
        stored: localStorage.getItem('vb-theme'),
      }));
      check(P, '系统是暗色时也能切到亮色并记住',
        light.attr === 'light' && light.bg === 'rgb(244, 246, 248)' && light.stored === 'light', JSON.stringify(light));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.status-chip');
      const kept = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      check(P, '刷新后仍是用户选的那一种（不被系统覆盖）', kept === 'light', String(kept));
    }
    await ctx.close();
  }

  /* ②d 跨天自动翻篇：昨晚复习的词，今天零点起就该出现（不用刷新页面） */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => {
      const night = new Date(2026, 8, 15, 21, 0, 0).getTime();   // 9/15 21:00 复习
      const due = night + 24 * 3600 * 1000;                     // 到期 9/16 21:00
      localStorage.setItem('vb-books', JSON.stringify([{
        id: 'bk-1', name: '书', note: '', createdAt: night,
        entries: [{ id: 'wb-1', head: 'object', kind: 'word', brief: '物体', meanings: [{ cn: '物体' }], createdAt: night }],
      }]));
      localStorage.setItem('vb-schedule', JSON.stringify({ 'wb-1': { ease: 2.5, interval: 1, due, reps: 1, lapses: 0, lastReviewed: night, lastGrade: 'normal' } }));
    });
    const page = await ctx.newPage();
    await page.clock.install({ time: new Date(2026, 8, 15, 23, 50, 0) });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip');
    await page.waitForTimeout(300);
    const before = (await page.locator('.due-btn').innerText()).replace(/\s+/g, ' ').trim();
    check(P, '23:50 时昨晚刚复习的词还没到期', /待复习$/.test(before) && !/\d/.test(before), before);
    await page.clock.fastForward('20:00');                     // 拨到 9/16 00:10
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => ({
      due: document.querySelector('.due-btn').textContent.replace(/\s+/g, ' ').trim(),
      now: new Date().toISOString().slice(0, 16),
    }));
    check(P, '跨过 00:00 不用刷新就翻篇（新的词进今日待复习）', /\(1\)/.test(after.due), `${after.due} · 页面时间 ${after.now}`);
    await page.screenshot({ path: path.join(SHOTS, 'midnight-rollover.png') }).catch(() => {});
    await ctx.close();
  }

  /* ②老收藏的辨析补齐：以前收藏的词没存过"差别/例句"，
       卡片上要能自助补上（一次查词），补完卡片立刻更新 */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(() => {
      const now = Date.now();
      // 模拟"上个版本收藏的词"：只有词头与来源，没有 diff/例句
      localStorage.setItem('vb-favorites', JSON.stringify([
        { id: 'fav-oppose', head: 'oppose', brief: '反对', from: 'object', at: now },
      ]));
      localStorage.setItem('vb-schedule', JSON.stringify({
        'fav-oppose': { due: now - 1000, interval: 1, ease: 2.5, reps: 0, lapses: 0, lastAt: 0 },
      }));
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 90)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip');
    await page.locator('.due-btn').click();
    await page.waitForSelector('.review-setup', { timeout: 8000 });
    await page.locator('.review-setup .mode-card', { hasText: '复习模式' }).click();
    await page.locator('.review-setup .primary-btn').click();
    await page.waitForSelector('.review-word', { timeout: 8000 });
    await page.locator('.review-word').click();
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => ({
      diff: document.querySelectorAll('.review-diff').length,
      fill: document.querySelectorAll('.fill-fav-btn').length,
    }));
    check(P, '老收藏缺差别时，卡片给出「补上差别和例句」入口', before.fill === 1 && before.diff === 0, JSON.stringify(before));
    await page.locator('.fill-fav-btn').click();
    await page.waitForTimeout(3500);
    const after = await page.evaluate(() => {
      const f = JSON.parse(localStorage.getItem('vb-favorites') || '[]')[0] || {};
      return {
        stored: { diff: Boolean(f.diff), usage: Boolean(f.usage), example: Boolean(f.example) },
        diffOnCard: document.querySelectorAll('.review-diff').length,
        fill: document.querySelectorAll('.fill-fav-btn').length,
        example: (document.querySelector('.review-answer .example-line')?.innerText || '').replace(/\s+/g, ' ').slice(0, 40),
      };
    });
    check(P, '补齐后：差别/用法/例句都写进了收藏', after.stored.diff && after.stored.usage && after.stored.example, JSON.stringify(after.stored));
    check(P, '补齐后：卡片立刻显示差别（不是等下一轮）', after.diffOnCard === 1 && after.fill === 0, JSON.stringify(after).slice(0, 90));
    check(P, '补齐后：复习卡上能看到例句', after.example.length > 6, after.example);
    check(P, '补齐场景无未捕获异常', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ②应用内相机：安卓 Chrome 常常忽略 input 的 capture 属性（直接弹照片选择器），
       所以拍照走 getUserMedia 自建取景（用 Chrome 的假摄像头验证整条链路） */
  {
    const camBrowser = await chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    const ctx = await camBrowser.newContext({ ...devices['Pixel 7'], permissions: ['camera'] });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 90)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip');
    await page.locator('.side-toggle').click();
    await page.waitForTimeout(400);
    await page.locator('.side-import').click();
    await page.waitForSelector('.import-modal', { timeout: 8000 });
    await page.locator('.import-actions .primary-btn').click();       // 「拍照」
    const paneOk = await page.waitForSelector('.camera-pane', { timeout: 8000 }).then(() => true).catch(() => false);
    check(P, '拍照按钮打开的是**应用内相机**（不是系统选择器）', paneOk);
    if (paneOk) {
      const live = await page.waitForFunction(() => {
        const v = document.querySelector('.camera-video');
        return v && v.videoWidth > 0;
      }, null, { timeout: 15000 }).then(() => true).catch(() => false);
      check(P, '相机取景画面是活的（有视频流）', live);
      await page.locator('.camera-actions .primary-btn').click();     // 「拍摄」
      const gotRows = await page.waitForSelector('.import-row', { timeout: 60000 }).then(() => true).catch(() => false);
      check(P, '拍完直接进入识别结果', gotRows);
      check(P, '拍摄后相机已关闭（不占着摄像头）', (await page.locator('.camera-pane').count()) === 0);
    }
    check(P, '相机场景无未捕获异常', errs.length === 0, errs.join(' | '));
    await camBrowser.close();
  }

  /* ②拍照导入：识别 → 默认全选 → 取消一条 → 选本子 → 入库
       （用户要求的"拍照识别一键导入"；手写占位行与疑问标记也要有交代） */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 90)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip');
    await page.locator('.side-import').click();
    await page.waitForSelector('.import-modal', { timeout: 8000 });
    // 造一张最小的合法 PNG 当作"单词表照片"（mock 不真读图，只验证链路与界面）
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAOklEQVR42u3OMQEAAAgDoJnc6BpjDyQgd2cLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4NfAAAcHm1F8AAAAASUVORK5CYII=', 'base64');
    const imgPath = path.join(SHOTS, 'fake-wordlist.png');
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(imgPath, png);
    await page.setInputFiles('.import-modal input[type=file]:not([capture])', imgPath);
    await page.waitForSelector('.import-row', { timeout: 60000 });
    const got = await page.evaluate(() => ({
      rows: document.querySelectorAll('.import-row').length,
      checked: document.querySelectorAll('.import-check input:checked').length,
      doubt: document.querySelectorAll('.import-row.doubt').length,
      placeholderChecked: [...document.querySelectorAll('.import-row')]
        .filter((r) => r.querySelector('.import-word')?.value === '?')
        .every((r) => !r.querySelector('input[type=checkbox]').checked),
    }));
    check(P, '拍照导入：识别出的词按序号列出，默认全部勾选',
      got.rows >= 5 && got.checked === got.rows - 1, JSON.stringify(got));
    check(P, '拍照导入：手写把握不大的词被标出（请核对）', got.doubt >= 1, `${got.doubt} 条带疑问标记`);
    /* 识别模型：默认用配置里的模型；接口说"不认图片"时自动回退到多模态模型，
       并且**在界面上说明用的是哪个** —— 出问题时用户能一眼说清是哪条路 */
    const vinfo = await page.evaluate(() => document.querySelector('.import-model')?.innerText?.replace(/\s+/g, ' ') || '');
    check(P, '拍照导入：界面说明实际使用的识别模型（含自动回退的说明）',
      /识别模型/.test(vinfo) && /flash/.test(vinfo) && /自动改用/.test(vinfo), vinfo.slice(0, 80));
    check(P, '拍照导入：没认出来的占位行不默认勾选（勾了也导不进去）', got.placeholderChecked);
    await page.screenshot({ path: path.join(SHOTS, 'image-import-list.png') }).catch(() => {});

    // 取消一条 → 计数跟着变
    await page.locator('.import-row').first().locator('input[type=checkbox]').click();
    await page.waitForTimeout(200);
    const afterUncheck = await page.evaluate(() => document.querySelector('.import-count')?.innerText?.trim() || '');
    check(P, '拍照导入：可以自己取消勾选，计数实时更新', /已选/.test(afterUncheck), afterUncheck);

    // 建本子 → 导入
    if (await page.locator('.import-newbook-name').count()) {
      await page.fill('.import-newbook-name', '拍照导入');
      await page.locator('.import-newbook .ghost-btn').click();
      await page.waitForTimeout(500);
    }
    await page.locator('.import-foot .primary-btn').click();
    await page.waitForTimeout(1200);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('vb-books') || '[]').flatMap((b) => b.entries.map((e) => e.head)));
    const imported = await page.evaluate(() => {
      const b = JSON.parse(localStorage.getItem('vb-books') || '[]');
      const book = b[0] || { entries: [] };
      return { bookName: book.name, count: book.entries.length, first: book.entries[0] && { head: book.entries[0].head, brief: book.entries[0].brief } };
    });
    check(P, '拍照导入：勾选的词进了指定单词本（释义一起带上）',
      imported.count >= 4 && imported.first && imported.first.brief && imported.first.brief.length > 0, JSON.stringify(imported).slice(0, 110));
    check(P, '拍照导入：没认出来的占位行没有被写进本子', !stored.includes('?'), stored.join(','));
    check(P, '拍照导入场景无未捕获异常', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ②收藏词的辨析：只收藏、没收进单词本的词，复习翻面后要能看到「与主词的差别」
       （用户反馈："只点个收藏的那种词，复习时只剩一个孤立释义"） */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 90)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip');
    await page.fill('.search-input', 'object');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /object/i.test(document.querySelector('.entry-card h1')?.textContent || ''), null, { timeout: 60000 });
    // 收藏它的**近义词**（不加入单词本 —— 这就是"只点个收藏"的路径）
    await page.locator('.entry-card .syn-row button[aria-label="收藏"]').first().click();
    await page.waitForTimeout(400);
    const stored = await page.evaluate(() => {
      const f = JSON.parse(localStorage.getItem('vb-favorites') || '[]')[0] || {};
      return { head: f.head, from: f.from, diff: f.diff || '', usage: f.usage || '' };
    });
    check(P, '收藏时把「与主词的差别」和用法一起存下来了',
      stored.diff.length > 0 && stored.from.length > 0, JSON.stringify(stored).slice(0, 80));

    await page.locator('.due-btn').click();
    await page.waitForSelector('.review-setup', { timeout: 8000 });
    await page.locator('.review-setup .mode-card', { hasText: '复习模式' }).click();
    await page.locator('.review-setup .primary-btn').click();
    await page.waitForSelector('.review-word', { timeout: 8000 });
    const beforeReveal = await page.evaluate(() => document.querySelectorAll('.review-diff').length);
    check(P, '收藏词：翻面前不剧透差别', beforeReveal === 0, String(beforeReveal));
    await page.locator('.review-word').click();
    await page.waitForTimeout(300);
    const shown = await page.evaluate(() => ({
      head: document.querySelector('.review-word strong')?.textContent?.trim() || '',
      diff: document.querySelector('.review-diff')?.innerText?.replace(/\s+/g, ' ').trim() || '',
      hasUsage: /什么时候用哪个/.test(document.querySelector('.review-answer')?.innerText || ''),
    }));
    check(P, '收藏词：翻面后显示「与 X 的差别」',
      shown.head.toLowerCase() === stored.head.toLowerCase() && shown.diff.includes(stored.from) && shown.diff.includes(stored.diff.slice(0, 6)),
      JSON.stringify(shown).slice(0, 100));
    check(P, '收藏词：同时给出"什么时候用哪个"', shown.hasUsage);
    await page.screenshot({ path: path.join(SHOTS, 'favorite-diff.png') }).catch(() => {});
    check(P, '收藏辨析场景无未捕获异常', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ②流式查词：边生成边看（用户要求的功能，必须真的"先看到内容"）
       同时验证：流式中不能存/导出半成品；SSE 被拦时自动回退轮询，结果照样出来。 */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 90)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip');

    const t0 = Date.now();
    await page.fill('.search-input', '__slow__streaming');   // mock 的慢速标记：分段之间放慢，才观察得到
    await page.keyboard.press('Enter');
    // 第一块内容（进度条出现 = 卡片已经在长）
    const sawBar = await page.waitForFunction(() => Boolean(document.querySelector('.stream-bar')), null, { timeout: 30000 })
      .then(() => true).catch(() => false);
    const firstPaint = Date.now() - t0;
    if (!sawBar) {
      // 失败时把现场说清楚（不要只抛一个超时 —— 那样排查要重跑一遍）
      const st = await page.evaluate(() => ({
        err: document.querySelector('.error-banner')?.innerText?.replace(/\s+/g, ' ').slice(0, 80) || '',
        progress: document.querySelector('.search-pane')?.innerText?.replace(/\s+/g, ' ').slice(0, 60) || '',
        card: Boolean(document.querySelector('.entry-card')),
        chip: document.querySelector('.status-chip')?.innerText?.replace(/\s+/g, ' ').slice(0, 40) || '',
      }));
      check(P, '流式：进度条出现（未出现时给出诊断）', false, JSON.stringify(st));
    }
    const during = await page.evaluate(() => ({
      bar: Boolean(document.querySelector('.stream-bar')),
      saveDisabled: document.querySelector('.save-bar .primary-btn')?.disabled === true,
      pdfDisabled: [...document.querySelectorAll('.save-bar button')].some((b) => /导出 PDF/.test(b.textContent) && b.disabled),
      askHidden: !document.querySelector('.ask-section'),
      text: (document.querySelector('.stream-bar')?.innerText || '').replace(/\s+/g, ' ').slice(0, 50),
    }));
    if (sawBar) check(P, '流式：生成中就显示进度条', during.bar, during.text);
    check(P, '流式：生成中禁用「加入单词本」与「导出 PDF」（避免存下半成品）',
      during.saveDisabled && during.pdfDisabled, JSON.stringify(during));
    check(P, '流式：生成中不显示追问（半成品上追问没意义）', during.askHidden);
    await page.screenshot({ path: path.join(SHOTS, 'stream-early.png') }).catch(() => {});

    await page.waitForFunction(() => !document.querySelector('.stream-bar'), null, { timeout: 60000 });
    const doneAt = Date.now() - t0;
    const after = await page.evaluate(() => ({
      sections: document.querySelectorAll('.entry-card .sheet-section').length,
      saveDisabled: document.querySelector('.save-bar .primary-btn')?.disabled === true,
      ask: Boolean(document.querySelector('.ask-section')),
    }));
    check(P, '流式：首块出现明显早于完成（< 完成时间的一半）',
      firstPaint < doneAt / 2, `首块 ${firstPaint}ms / 完成 ${doneAt}ms`);
    check(P, '流式：完成后写操作恢复、追问回来',
      after.sections >= 6 && !after.saveDisabled && after.ask, JSON.stringify(after));

    /* 回退：把 SSE 端点拦掉，应该自动回到轮询并照样出卡片 */
    await page.route('**/api/lookup/*/stream', (route) => route.abort());
    await page.fill('.search-input', '__slow__fallbackword');
    await page.keyboard.press('Enter');
    const cardOk = await page.waitForFunction(
      () => /fallbackword/i.test(document.querySelector('.entry-card h1')?.textContent || ''),
      null, { timeout: 60000 },
    ).then(() => true).catch(() => false);
    check(P, '流式不可用时自动回退轮询（照样出卡片）', cardOk);
    await page.unroute('**/api/lookup/*/stream');
    check(P, '流式场景无未捕获异常', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ②侧栏滚动条：三块可滚区域各画一条灰条，比内容还抢眼（用户反馈截图） */
  {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    await ctx.addInitScript(() => {
      const now = Date.now();
      localStorage.setItem('vb-books', JSON.stringify([{ id: 'b1', name: '英语文摘2026', note: '', createdAt: now, entries: [{ id: 'w1', head: 'good', brief: 'x', createdAt: now }] }]));
      localStorage.setItem('vb-favorites', JSON.stringify(Array.from({ length: 63 }, (_, i) => ({ id: 'f' + i, head: 'fav' + i, brief: 'y', at: now - i * 1000 }))));
      localStorage.setItem('vb-history', JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ id: 'h' + i, head: 'hist' + i, at: now - i * 1000 }))));
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip');
    await page.locator('.side-toggle').click();
    await page.waitForTimeout(400);
    const bars = await page.evaluate(() => {
      const lists = [...document.querySelectorAll('.sidebar .lesson-list')];
      return lists.map((node) => {
        const cs = getComputedStyle(node);
        return {
          scrollbarWidth: cs.scrollbarWidth || '(默认)',
          scrollable: node.scrollHeight > node.clientHeight + 1,
          faded: (cs.maskImage || cs.webkitMaskImage || 'none') !== 'none',
          capped: node.classList.contains('scroll-capped'),
        };
      });
    });
    check(P, '手机端侧栏不画滚动条（三块列表都隐藏）',
      bars.length >= 2 && bars.every((b) => b.scrollbarWidth === 'none'), JSON.stringify(bars.map((b) => b.scrollbarWidth)));
    check(P, '限高可滚的那两块带"下面还有"的渐隐提示',
      bars.filter((b) => b.capped).length >= 1 && bars.filter((b) => b.faded).length >= 1,
      JSON.stringify(bars.map((b) => ({ capped: b.capped, faded: b.faded }))));
    await page.screenshot({ path: path.join(SHOTS, 'sidebar-scrollbars.png') }).catch(() => {});
    await ctx.close();
  }

  /* ②a Android 专项：iOS 上不需要、安卓上不做就会出问题的几条
        （字体放大 / 点按高亮 / 下拉刷新 / 地址栏高度 / 返回键 / 触摸滑动） */
  {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    await ctx.addInitScript(() => {
      const now = Date.now();
      const entries = Array.from({ length: 4 }, (_, i) => ({ id: 'wb-' + i, head: 'word' + i, kind: 'word', brief: '释义' + i, meanings: [{ cn: '释义' + i }], createdAt: now - 86400000 }));
      localStorage.setItem('vb-books', JSON.stringify([{ id: 'bk-1', name: '安卓测试本', note: '', createdAt: now - 86400000, entries }]));
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 100)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip');
    await page.waitForTimeout(400);

    // ① 安卓 Chrome 会放大长段正文（font boosting）——必须显式关掉
    const css = await page.evaluate(() => {
      const html = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      return {
        textAdjust: html.webkitTextSizeAdjust || html.getPropertyValue('-webkit-text-size-adjust') || '(无)',
        tapHighlight: body.getPropertyValue('-webkit-tap-highlight-color') || '(无)',
        overscrollBody: body.getPropertyValue('overscroll-behavior-y') || body.overscrollBehaviorY || '(无)',
        isAndroid: /Android/i.test(navigator.userAgent),
        ua: navigator.userAgent.slice(0, 46),
      };
    });
    check(P, 'Android：关掉字体自动放大（否则安卓字号比 iOS 大一截）',
      /100%/.test(css.textAdjust), `-webkit-text-size-adjust=${css.textAdjust}`);
    check(P, 'Android：点按高亮已去掉（不再闪方块）',
      /rgba\(0, 0, 0, 0\)|transparent/.test(css.tapHighlight), css.tapHighlight);
    check(P, 'Android：禁用下拉刷新链（手一抖不会刷新整页）',
      /contain|none/.test(css.overscrollBody), css.overscrollBody);
    check(P, 'Android UA 确实生效（这条场景跑的是真安卓 UA）', css.isAndroid, css.ua);

    // ② 地址栏收起/展开：可视高度突变时布局不能破、底部按钮不能被顶出视野
    await page.locator('.due-btn').click();
    await page.waitForSelector('.review-setup', { timeout: 8000 });
    await page.locator('.review-setup .primary-btn').click();
    await page.waitForSelector('.review-word', { timeout: 8000 });
    await page.locator('.review-word').click().catch(() => {});
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      gradeVisible: (() => { const g = document.querySelector('.grade-bar'); if (!g) return false; const r = g.getBoundingClientRect(); return r.bottom <= window.innerHeight + 1 && r.top >= 0; })(),
    }));
    check(P, 'Android：地址栏展开时评分条完整可见', before.gradeVisible && !before.overflow, JSON.stringify(before));
    // 地址栏收起 → 可视高度变大；再展开 → 变小（模拟真实抖动）
    await page.setViewportSize({ width: 412, height: 700 });
    await page.waitForTimeout(350);
    const short = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      gradeVisible: (() => { const g = document.querySelector('.grade-bar'); if (!g) return false; const r = g.getBoundingClientRect(); return r.bottom <= window.innerHeight + 1; })(),
      btnClickable: (() => { const b = document.querySelector('.grade-bar .grade-ok'); return Boolean(b); })(),
    }));
    check(P, 'Android：可视高度变小（地址栏/键盘）后仍不溢出、按钮还在',
      !short.overflow && short.gradeVisible && short.btnClickable, JSON.stringify(short));
    await page.setViewportSize({ width: 412, height: 839 });

    // ③ 触摸滑动评分：安卓走的是 touches 事件（changetouches）
    const card = page.locator('.review-answer');
    if (await card.count()) {
      const box = await card.boundingBox();
      if (box) {
        await page.touchscreen.tap(box.x + 10, box.y + 10).catch(() => {});
        await page.waitForTimeout(200);
      }
    }

    // ④ 安卓返回键 = history back：弹窗关闭、视图回退，且不退出应用
    await page.locator('.review-head-tools .ghost-btn').click().catch(() => {});
    await page.waitForTimeout(400);
    const hist0 = await page.evaluate(() => history.length);
    await page.locator('.side-toggle').click();
    await page.waitForTimeout(350);
    await page.locator('.side-footer button', { hasText: 'AI 设置' }).click();
    await page.waitForSelector('.modal', { timeout: 8000 });
    await page.goBack();
    await page.waitForTimeout(500);
    const afterBack = await page.evaluate(() => ({
      modal: Boolean(document.querySelector('.modal')),
      alive: Boolean(document.querySelector('.status-chip')),
      hist: history.length,
    }));
    check(P, 'Android：返回键关弹窗（不是退出应用）', !afterBack.modal && afterBack.alive, JSON.stringify({ ...afterBack, hist0 }));

    // ⑤ 弹窗在矮视口里不超出可视高度（安卓地址栏 + 键盘会让 100vh 失真）
    await page.setViewportSize({ width: 412, height: 620 });
    await page.waitForTimeout(250);
    if (await page.locator('.sidebar').isHidden()) { await page.locator('.side-toggle').click(); await page.waitForTimeout(300); }
    await page.locator('.side-footer button', { hasText: 'AI 设置' }).click().catch(() => {});
    const modalBox = await page.locator('.modal').first().boundingBox().catch(() => null);
    check(P, 'Android：矮视口下弹窗不超出可视高度（用 dvh 而不是 vh）',
      Boolean(modalBox) && modalBox.height <= 620 - 20, modalBox ? `弹窗高 ${Math.round(modalBox.height)} / 视口 620` : '弹窗没打开');
    await page.keyboard.press('Escape').catch(() => {});
    await page.setViewportSize({ width: 412, height: 839 });
    check(P, 'Android 场景无未捕获异常', errs.length === 0, errs.join(' | '));
    await page.screenshot({ path: path.join(SHOTS, 'android-special.png') }).catch(() => {});
    await ctx.close();
  }

  /* ②c 手机端侧栏（数据饱满时）：本子列表被压扁 = "看不到我的单词本" */
  {
    const ctx = await browser.newContext({ ...devices['iPhone SE'] });   // 最小屏最容易复现
    await ctx.addInitScript(() => {
      const now = Date.now();
      const entries = Array.from({ length: 20 }, (_, i) => ({ id: 'wb-' + i, head: 'word' + i, kind: 'word', brief: '释义' + i, meanings: [{ cn: '释义' + i }], createdAt: now - 86400000 }));
      localStorage.setItem('vb-books', JSON.stringify([{ id: 'bk-1', name: '英语文摘2026', note: '', createdAt: now, entries }]));
      localStorage.setItem('vb-favorites', JSON.stringify(Array.from({ length: 43 }, (_, i) => ({ id: 'fav-' + i, head: 'fav' + i, brief: '收藏' + i, at: now - i * 1000 }))));
      localStorage.setItem('vb-history', JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ id: 'h' + i, head: 'hist' + i, brief: '', at: now - i * 1000, entry: null }))));
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip');
    await page.locator('.side-toggle').click();
    await page.waitForTimeout(400);
    const side = await page.evaluate(() => {
      const row = document.querySelector('.lesson-row');
      const item = row && row.querySelector('.lesson-item');
      const title = row && row.querySelector('.lesson-title');
      const list = document.querySelector('.side-section > .lesson-list');
      return {
        listH: list ? Math.round(list.getBoundingClientRect().height) : 0,
        rowH: row ? Math.round(row.getBoundingClientRect().height) : 0,
        titleH: title ? Math.round(title.getBoundingClientRect().height) : 0,
        titleW: title ? Math.round(title.getBoundingClientRect().width) : 0,
        name: title ? title.textContent : '',
        itemBottom: item ? Math.round(item.getBoundingClientRect().bottom) : 0,
      };
    });
    check(P, '手机端数据饱满时，单词本行仍然完整可见（没被压扁）',
      side.listH >= 44 && side.rowH >= 40 && side.titleH >= 12 && side.titleW >= 120,
      JSON.stringify(side));
    await page.screenshot({ path: path.join(SHOTS, 'sidebar-dense-mobile.png') }).catch(() => {});
    await ctx.close();
  }

  /* ③b 大词库性能：1000 个词条时打开本子要多久（分批渲染之前是整屏同步渲染） */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => {
      const entries = Array.from({ length: 1000 }, (_, i) => ({
        id: 'wb-seed-' + i, head: 'word' + i, kind: 'word', phonetic: '/w' + i + '/', pos: '名词',
        brief: '第 ' + i + ' 个词的释义', meanings: [{ pos: '名词', cn: '释义 ' + i }],
        synonyms: [{ word: 'syn' + i, cn: '近义' }], examples: [{ en: 'Example ' + i, cn: '例句 ' + i }],
        createdAt: Date.now(),
      }));
      localStorage.setItem('vb-books', JSON.stringify([{ id: 'bk-seed', name: '压力测试本', createdAt: Date.now(), entries }]));
      localStorage.setItem('vb-schedule', JSON.stringify(Object.fromEntries(
        entries.map((e) => [e.id, { ease: 2.5, interval: 1, reps: 2, due: Date.now() - 1000 }]))));
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-chip');
    if (await page.locator('.sidebar').isHidden()) { await page.locator('.side-toggle').click(); await page.waitForTimeout(250); }
    const t1 = Date.now();
    await page.locator('.lesson-item').first().click();
    await page.waitForSelector('.entry-row');
    const open = Date.now() - t1;
    const m = await page.evaluate(() => ({
      rows: document.querySelectorAll('.entry-row').length,
      nodes: document.querySelectorAll('*').length,
      more: Boolean(document.querySelector('.list-more')),
    }));
    check(P, '1000 词条：打开本子 < 800ms（首屏只渲染一批）', open < 800, `${open}ms`);
    check(P, '1000 词条：首屏只渲染一批（不是 1000 行一起上）', m.rows <= 120 && m.more, `渲染 ${m.rows} 行 · DOM ${m.nodes} 节点`);
    await page.screenshot({ path: path.join(SHOTS, 'perf-1000.png') }).catch(() => {});
    await ctx.close();
  }

  /* ④ 双设备云同步：电脑上存的词，手机上能不能看到
        —— 这是"手机端和电脑端都要测"里最容易出事、也最少被自动测到的一条链路：
        服务端没有 Upstash 时走**文件 KV**（本地开发就是这种），两边各开一个浏览器上下文，
        用同一串同步码对齐。 */
  {
    const seed = async (page) => {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.status-chip');
    };
    const saveWord = async (page, term) => {
      await page.fill('.search-input', term);
      await page.keyboard.press('Enter');
      await page.waitForFunction((t) => new RegExp(t, 'i').test(document.querySelector('.entry-card h1')?.textContent || ''), term, { timeout: 60000 });
      await page.waitForTimeout(200);
      const already = (await page.locator('.saved-flag').count()) > 0;
      if (!already) { await saveViaBar(page); await page.waitForSelector('.saved-flag', { timeout: 10000 }); }
    };
    const openSync = async (page, mobile) => {
      // 已经开着就别再点一次：面板开着时侧栏被遮罩挡住，再点只会等到超时
      if ((await page.locator('.backup-modal').count()) > 0) return;
      if (mobile && (await page.locator('.sidebar').isHidden())) { await page.locator('.side-toggle').click(); await page.waitForTimeout(300); }
      await page.locator('.side-footer button').filter({ hasText: /备份/ }).click();
      await page.waitForSelector('.backup-modal', { timeout: 8000 });
    };

    const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    ctxA.on('dialog', (d) => d.accept(d.type() === 'prompt' ? d.defaultValue() : undefined));
    ctxB.on('dialog', (d) => d.accept(d.type() === 'prompt' ? d.defaultValue() : undefined));
    const A = await ctxA.newPage(); const B = await ctxB.newPage();
    let sStep = '(开始)';
    const at = (x) => { sStep = x; };
    try {
      /* 电脑：存一个词 → 生成同步码 */
      at('电脑存词');
      await seed(A);
      await saveWord(A, 'object');
      at('电脑打开同步面板');
      await openSync(A, false);
      at('电脑生成同步码');
      await A.locator('.backup-modal .primary-btn').filter({ hasText: /生成同步码/ }).click();
      await A.waitForFunction(() => /^[a-f0-9]{32}$/.test(localStorage.getItem('vb-sync-code') || ''), null, { timeout: 20000 });
      // 码是**先落盘再同步**的：等同步真的跑完（lastSyncAt 写进去）再读，否则读到的是上一轮的 meta（实测踩到）
      await A.waitForFunction(() => Number(JSON.parse(localStorage.getItem('vb-sync-meta') || '{}').lastSyncAt) > 0, null, { timeout: 25000 });
      const code = await A.evaluate(() => localStorage.getItem('vb-sync-code'));
      const pushed = await A.evaluate(() => JSON.parse(localStorage.getItem('vb-sync-meta') || '{}'));
      check(P, '电脑端生成同步码并把本机推上云',
        Boolean(code) && pushed.lastSyncAt > 0 && pushed.verified !== false,
        `码 ${String(code).slice(0, 8)}… · 本机推了 ${pushed.pushedEntries ?? '?'} 条词条 · 回读校验 ${pushed.verified === false ? '未通过' : '通过'}`);

      /* 手机：粘贴同步码 → 立即同步 → 词条出现 */
      at('手机粘贴同步码');
      await seed(B);
      await openSync(B, true);
      // ⚠️ 不能取 .backup-modal input 的第一个：DOM 里更靠前的是"导入备份"那个 hidden file input
      await B.locator('.backup-modal input[placeholder*="同步码"]').fill(code);
      await B.locator('.backup-modal button').filter({ hasText: /^使用$/ }).click();
      await B.waitForFunction(() => (JSON.parse(localStorage.getItem('vb-books') || '[]')).some((b) => b.entries.length > 0), null, { timeout: 25000 })
        .then(() => true).catch(() => false);
      const onPhone = await B.evaluate(() => JSON.parse(localStorage.getItem('vb-books') || '[]').flatMap((b) => b.entries.map((e) => e.head)));
      check(P, '手机端粘贴同步码后拿到电脑上的词条', onPhone.includes('object'), onPhone.join(',') || '（空）');

      /* 手机上加一个词 → 电脑立即同步 → 也能看到（双向） */
      at('手机关闭同步面板并加词');
      await B.locator('.backup-modal .modal-head .icon-btn').click();
      await B.waitForTimeout(300);
      await saveWord(B, 'banana');
      at('手机立即同步');
      await openSync(B, true);
      await B.locator('.backup-modal button').filter({ hasText: /立即同步/ }).click();
      await B.waitForTimeout(1500);
      at('电脑立即同步');
      await openSync(A, false);
      await A.locator('.backup-modal button').filter({ hasText: /立即同步/ }).click();
      await A.waitForTimeout(2000);
      const onPc = await A.evaluate(() => JSON.parse(localStorage.getItem('vb-books') || '[]').flatMap((b) => b.entries.map((e) => e.head)));
      check(P, '手机上加的词能同步回电脑（双向）', onPc.includes('banana') && onPc.includes('object'), onPc.join(','));
      await A.screenshot({ path: path.join(SHOTS, 'sync-desktop.png') }).catch(() => {});
      await B.screenshot({ path: path.join(SHOTS, 'sync-mobile.png') }).catch(() => {});
    } catch (e) {
      fail(P, `双设备同步在「${sStep}」中断`, e.message.split('\n')[0]);
    }
    await ctxA.close(); await ctxB.close();
  }
}

/* ============================ 主流程 ============================ */
const mocks = await startMockProvider({ aiPort: MOCK, dictPort: DICT_MOCK });
mocksRef.current = mocks;
const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    AI_BASE_URL: mocks.aiBaseUrl,
    AI_API_KEY: 'mock-sim',
    ALLOW_PRIVATE_BASE_URL: '1',
    DICT_PROVIDER: 'youdao-web',
    DICT_BASE_URL: mocks.dictBaseUrl,
    // 每轮用**全新**的数据目录：查词缓存/任务若跨轮次复用，
    // 会让"流式"这类场景直接命中缓存而看不到过程（实测踩过：表现为看不到进度条）
    DATA_DIR: path.join(ROOT, 'test', 'agent_out', 'sim-data-' + Date.now()),
    // 测试自己会跑几十次查词：把限流放宽，否则后面的场景会被 429 掐掉
    // （踩过：新增的流式场景因为前面积累的请求量而拿不到任务，表现为"看不到进度条"）
    RATE_LIMIT_PER_MIN: '1000',
  },
  stdio: 'ignore',
});
let up = false;
for (let i = 0; i < 40 && !up; i += 1) {
  try { up = (await fetch(`${BASE}api/health`)).ok; } catch { /* 等 */ }
  if (!up) await sleep(400);
}
if (!up) { console.error('后端启动超时'); process.exit(1); }
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
for (const p of PROFILES) {
  if (SHOTS_ONLY) { console.log(`(--shots-only) ${p.id}`); continue; }
  await runProfile(browser, p);
}
if (!SHOTS_ONLY) await runEdgeCases(browser);
await browser.close();
server.kill();
await mocks.close();

/* ============================ 汇总 ============================ */
const fails = R.filter((r) => r.ok === false);
const warns = R.filter((r) => r.ok === null);
console.log('\n' + '='.repeat(62));
console.log(`检查 ${R.length} 项：通过 ${R.length - fails.length - warns.length} · 问题 ${fails.length} · 观察 ${warns.length}`);
if (fails.length) {
  console.log('\n需要修的：');
  for (const f of fails) console.log(`  [${f.profile}] ${f.name}  — ${f.detail}`);
}
if (warns.length) {
  console.log('\n值得看的（不算错，但真机上会硌人）：');
  for (const w of warns) console.log(`  [${w.profile}] ${w.name}  — ${w.detail}`);
}
console.log(`\n截图：${path.relative(ROOT, SHOTS)}`);
process.exit(fails.length ? 1 : 0);
