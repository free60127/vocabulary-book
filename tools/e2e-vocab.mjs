/**
 * 单词本主链路 e2e（真实浏览器 + 自带 mock 模型）。
 *
 * 覆盖三块功能：
 *   ① 查词 → 卡片 → 加入单词本（含筛选/排序/朗读按钮）
 *   ② 今日待复习 → 显示答案 → 三档评分
 *   ③ 自测题 → 显示答案；备份导出；同步码生成；账号弹窗
 *
 * 跑法：node tools/e2e-vocab.mjs   （需要 tools 里能拿到 playwright；先 npm run build）
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let chromium;
try {
  ({ chromium } = await import('file:///D:/AI/66666-main/tools/shotter/node_modules/playwright/index.mjs'));
} catch {
  console.error('缺少 playwright：本机跑 `cd D:/AI/66666-main/tools/shotter && npm i` 后再执行（CI 不跑这条链路）。');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.E2E_PORT || 8811);
const MOCK = Number(process.env.E2E_MOCK || 9811);
const DICT_MOCK = Number(process.env.E2E_DICT_MOCK || 9812);
const BASE = `http://127.0.0.1:${PORT}/`;

/* ---------- mock 模型：查词返回词条，出题返回题目 ---------- */
const entryFor = (head) => ({
  head, kind: head.includes(' ') ? 'phrase' : 'word',
  // 故意给一个**错的**音标（重音位置错）和一个漏掉动词词性的 pos：
  // 词典核对必须把它纠正过来，这正是"怕 AI 编"要防的那类错
  phonetic: '/ɒbˈdʒekt/', pos: '名词', brief: '物体；反对',
  register: '通用', tone: '中性', strength: '中',
  meanings: [
    // 只给名词：模型"漏掉动词词性"是很典型的一种不全，词典核对要能指出来
    { pos: '名词', cn: '物体、目标', en: 'a thing you can see and touch' },
  ],
  scenes: ['学术写作中表达不同意见', '日常描述实物'],
  avoid: '不要用它表示"拒绝"（那是 refuse）',
  mnemonic: { image: '把反对意见"扔"到对方面前', hook: 'ob（反）+ ject（扔）= 对着扔', parts: 'ob-（反对）+ ject（扔）', family: 'objection / objective' },
  synonyms: [{
    word: 'oppose', phonetic: '/əˈpəʊz/', cn: '反对', register: '正式', tone: '中性', strength: '强',
    diff: 'oppose 更强调公开、正式的反对', usage: '正式场合用 oppose，日常用 be against',
    example: 'They opposed the plan.', exampleCn: '他们反对这个计划。',
  }],
  collocations: ['object to sth', 'a solid object'],
  examples: [{ en: 'She objected to the new rules.', cn: '她反对新规定。', note: '演示 object to 这个搭配' }],
  confusions: 'object 作动词必须接 to；oppose 直接接宾语。',
  usageNotes: '作动词时重音在第二节。',
  examTips: '四六级常考 object to doing 这个结构。',
});
const QUIZ = {
  title: '单词本自测 · 3 题',
  questions: [
    { type: 'choice', stem: '选出最合适的一项：She ___ to the new rules.', options: ['objected', 'opposed', 'against', 'object'], answer: 'objected', explanation: 'object 作动词要接 to。' },
    { type: 'fill', stem: '填空：They ___ the plan openly.（公开反对）', options: [], answer: 'opposed', explanation: 'oppose 直接接宾语，更正式。' },
    { type: 'choice', stem: '哪句更得体？', options: ['I object to this.', 'I oppose to this.'], answer: 'I object to this.', explanation: 'oppose 不与 to 连用。' },
  ],
};
const mock = http.createServer((q, r) => {
  let b = ''; q.on('data', (c) => { b += c; });
  q.on('end', () => {
    const isQuiz = /自测题|出题/.test(b);
    const m = /【查询内容】([^\n\\]+)/.exec(b);
    const payload = isQuiz ? QUIZ : entryFor(m ? m[1].trim() : 'object');
    r.writeHead(200, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
  });
});
await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r));

/* ---------- mock 词典：故意和模型"说的不一样"，用来验证以词典为准 ---------- */
const DICT_SAMPLE = {
  ec: {
    exam_type: ['初中', '高中', 'CET4', 'CET6', '考研'],
    word: [{
      ukphone: 'ˈɒbdʒɪkt; əbˈdʒekt', usphone: 'ˈɑːbdʒekt; əbˈdʒekt',
      trs: [{ tr: [{ l: { i: ['n. 物体，实物；目的，目标'] } }] }, { tr: [{ l: { i: ['v. 反对'] } }] }],
      'return-phrase': { l: { i: 'object' } },
    }],
  },
  simple: {
    query: 'object',
    word: [{ 'return-phrase': 'object', multiPhone: { uk: [{ phone: 'ˈɒbdʒɪkt', pos: ['n'] }], us: [{ phone: 'ˈɑːbdʒekt', pos: ['n'] }] } }],
  },
  meta: { input: 'object' },
};
const dictMock = http.createServer((q, r) => {
  r.writeHead(200, { 'Content-Type': 'application/json' });
  r.end(JSON.stringify(DICT_SAMPLE));
});
await new Promise((r) => dictMock.listen(DICT_MOCK, '127.0.0.1', r));

const server = spawn(process.execPath, ['server/index.mjs'], {
  env: {
    ...process.env, PORT: String(PORT), AI_BASE_URL: `http://127.0.0.1:${MOCK}/v1`, AI_API_KEY: 'mock-e2e', ALLOW_PRIVATE_BASE_URL: '1',
    // 词典也指向本地 mock：e2e 不该依赖外网 —— 对方一抖动就红一片，还平白给人家刷请求
    DICT_PROVIDER: 'youdao-web', DICT_BASE_URL: `http://127.0.0.1:${DICT_MOCK}`,
  },
  stdio: 'ignore',
});
let up = false;
for (let i = 0; i < 40 && !up; i += 1) {
  try { up = (await fetch(`${BASE}api/health`)).ok; } catch { /* 等 */ }
  if (!up) await sleep(400);
}
if (!up) { console.error('后端启动超时'); process.exit(1); }

const R = [];
const ok = (n, c, d = '') => { R.push({ n, c }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
// ⚠️ prompt 上 `d.accept()` 传的是**空串**而不是 prompt 的默认值（本项目 Chromium 实测），
// 所以"新建单词本"会被当成空名字取消。必须显式把 defaultValue 递回去。
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? d.defaultValue() : undefined));

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.status-chip', { timeout: 30000 });
  await page.waitForFunction(() => /AI 已配置/.test(document.querySelector('.status-chip')?.textContent || ''), null, { timeout: 30000 });
  ok('页面加载且后端已配置模型', true);

  /* ---------- ① 查词 → 卡片 ---------- */
  await page.fill('.search-input', 'object');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.entry-card', { timeout: 60000 });
  const card = await page.evaluate(() => ({
    head: document.querySelector('.entry-card h1')?.textContent.trim(),
    chips: [...document.querySelectorAll('.entry-card .chips-meta .chip')].map((c) => c.textContent.trim()),
    sections: [...document.querySelectorAll('.entry-card .section-heading h2')].map((h) => h.textContent.trim()),
    synDiff: document.querySelector('.syn-usage')?.textContent.trim(),
    morph: [...document.querySelectorAll('.morph-line')].map((x) => x.textContent.trim()).slice(0, 2),
    exampleNote: document.querySelector('.entry-card .summary-card .muted')?.textContent.trim(),
    speakBtns: document.querySelectorAll('.entry-card .icon-btn[aria-label="朗读"]').length,
  }));
  ok('查词生成详细讲解卡片', /object/i.test(card.head || ''), card.head || '');
  ok('词性/语域/褒贬/强度 以徽章呈现', card.chips.length >= 4, card.chips.join(' · '));
  ok('讲解板块齐全（释义/近义词/例句/易混点）',
    ['释义', '近义词对比', '例句', '易混点'].every((s) => card.sections.includes(s)), card.sections.join(' / '));
  ok('词根词缀 + 助记画面', card.morph.some((m) => /词根词缀/.test(m)) && card.morph.some((m) => /助记画面/.test(m)), card.morph.join(' | '));
  ok('近义词带"差别"', /差别/.test(card.synDiff || ''), card.synDiff || '');
  ok('例句带语境说明', Boolean(card.exampleNote), card.exampleNote || '');
  ok('卡片上有朗读按钮', card.speakBtns >= 1, String(card.speakBtns));

  /* ---------- ①b 词典核对：模型给错音标/漏词性时，以词典为准 ---------- */
  const dn = await page.evaluate(() => ({
    badge: document.querySelector('.dict-badge')?.textContent.trim() || '',
    warn: Boolean(document.querySelector('.dict-badge.warn')),
    section: Boolean(document.querySelector('.dict-section')),
    rows: [...document.querySelectorAll('.dict-facts > div')].map((d) => d.textContent.trim()),
    phonetic: document.querySelector('.entry-card .phonetic')?.textContent.trim() || '',
  }));
  ok('卡片上有「词典核对」区块（用户最怕 AI 编，这个结论要第一眼看到）', dn.section && /已用有道词典核对/.test(dn.badge), dn.badge.slice(0, 60));
  ok('模型音标错了 → 用词典的覆盖，并标出"已校正"',
    dn.phonetic.includes('ˈɒbdʒɪkt') && !dn.phonetic.includes('ɒbˈdʒekt') && /音标已按词典校正/.test(dn.badge),
    `${dn.phonetic} | ${dn.badge.slice(0, 50)}`);
  ok('模型漏掉动词词性 → 提示词典还标了 v.', /词典还标了/.test(dn.badge) && /v/.test(dn.badge), dn.badge.slice(0, 80));
  ok('词典原文照登（音标/释义/大纲标注）',
    dn.rows.some((r) => /^英/.test(r)) && dn.rows.some((r) => /n\./.test(r) && /物体/.test(r)) && dn.rows.some((r) => /大纲/.test(r) && /CET6/.test(r)),
    dn.rows.slice(0, 3).join(' | '));

  /* ---------- 加入单词本 ---------- */
  await page.locator('.save-bar button').click();
  await page.waitForSelector('.saved-flag', { timeout: 10000 });
  const afterSave = await page.evaluate(() => ({
    flag: document.querySelector('.saved-flag')?.textContent.trim(),
    books: JSON.parse(localStorage.getItem('vb-books') || '[]'),
    schedule: JSON.parse(localStorage.getItem('vb-schedule') || '{}'),
  }));
  ok('加入单词本成功（本机落盘）', afterSave.books.length === 1 && afterSave.books[0].entries.length === 1, afterSave.flag || '');
  ok('新词条立刻有复习排期（当天到期）', Object.keys(afterSave.schedule).length === 1, JSON.stringify(afterSave.schedule).slice(0, 60));

  /* ---------- ①c 最近查过：点一下要能**直接回到查完的界面** ---------- */
  // 用户原话："点这个最近查过的单词不能直接跳转到查完的界面，加入到单词本的才可以"
  {
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('vb-history') || '[]'));
    ok('查完就进历史，且带了词条快照', before.length === 1 && Boolean(before[0].entry), JSON.stringify(before.map((h) => Object.keys(h))));

    // 先离开卡片（进单词本再回来），确认点历史是真的重新渲染出卡片
    await page.locator('.lesson-item').first().click();
    await page.waitForSelector('.entry-row', { timeout: 8000 });
    ok('离开卡片后不在词条界面', (await page.locator('.entry-card').count()) === 0);

    await page.locator('.lesson-list').last().locator('.lesson-item').first().click();
    await page.waitForSelector('.entry-card', { timeout: 8000 });
    const back = await page.evaluate(() => ({
      head: document.querySelector('.entry-card h1')?.textContent.trim(),
      sections: document.querySelectorAll('.entry-card .section-heading h2').length,
      dict: Boolean(document.querySelector('.dict-section')),
    }));
    ok('点「最近查过」直接回到查完的界面（含词典核对）',
      /object/i.test(back.head) && back.sections >= 8 && back.dict, `${back.head} · ${back.sections} 个板块`);
    ok('回到卡片不触发新查询（快照直出）',
      (await page.locator('.progress-box').count()) === 0 && (await page.locator('.entry-card').count()) === 1);

    // 老数据（只有 head、没有快照）要走"自动重查"而不是干等
    await page.evaluate(() => localStorage.setItem('vb-history', JSON.stringify([{ id: 'legacy-1', head: 'object', brief: '', at: 1 }])));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lesson-list .lesson-item', { timeout: 20000 });
    const legacyTag = await page.locator('.lesson-list').last().locator('.lesson-item').first().innerText();
    ok('没有快照的老历史标出「需重查」', /需重查/.test(legacyTag), legacyTag.split('\n').join(' '));
    await page.locator('.lesson-list').last().locator('.lesson-item').first().click();
    await page.waitForSelector('.entry-card', { timeout: 60000 });
    ok('点老历史自动补查，仍然落到查完的界面', (await page.locator('.entry-card').count()) === 1);
  }

  /* ---------- ② 单词本：列表 / 筛选 / 排序 ---------- */
  await page.locator('.lesson-item').first().click();
  await page.waitForSelector('.entry-row', { timeout: 8000 });
  ok('单词本里能看到词条', (await page.locator('.entry-row').count()) === 1);
  const toolbar = await page.evaluate(() => ({
    filters: [...document.querySelectorAll('.book-toolbar select')][0]?.options.length || 0,
    sorts: [...document.querySelectorAll('.book-toolbar select')][1]?.options.length || 0,
    hasSpeak: Boolean(document.querySelector('.entry-row .icon-btn[aria-label="朗读"]')),
  }));
  ok('筛选下拉有多个维度（全部/单词/短语/句型/到期/新词）', toolbar.filters >= 6, String(toolbar.filters));
  ok('排序下拉有多个维度（默认/到期/新词/掌握度/字母）', toolbar.sorts >= 5, String(toolbar.sorts));
  ok('列表行上有朗读按钮', toolbar.hasSpeak);
  // 搜一个不存在的词，应该筛空
  await page.fill('.book-toolbar .fav-search', 'zzzz-不存在');
  await sleep(300);
  ok('本子里搜索能筛出空结果', (await page.locator('.entry-row').count()) === 0);
  await page.fill('.book-toolbar .fav-search', '');

  /* ---------- ③ 复习 ---------- */
  await page.locator('.due-btn').click();
  await page.waitForSelector('.review-word', { timeout: 8000 });
  ok('今日待复习 能进入复习', (await page.locator('.review-word strong').innerText()).length > 0, await page.locator('.review-word strong').innerText());
  ok('翻面前不显示答案', (await page.locator('.review-answer').count()) === 0);
  await page.locator('.primary-btn.big').click();
  await page.waitForSelector('.grade-bar', { timeout: 8000 });
  const hints = await page.evaluate(() => [...document.querySelectorAll('.grade-bar .ghost-btn')].map((b) => b.textContent.trim()));
  ok('三档评分按钮带"下次几天后"预告', hints.length === 3 && hints.every((h) => /再见/.test(h)), hints.join(' / '));
  await page.locator('.grade-bar .ghost-btn').nth(2).click();   // 简单
  await page.waitForSelector('.entry-card, .start-guide, .search-bar', { timeout: 8000 });
  const afterReview = await page.evaluate(() => ({
    schedule: JSON.parse(localStorage.getItem('vb-schedule') || '{}'),
    days: JSON.parse(localStorage.getItem('vb-days') || '[]'),
  }));
  const st = Object.values(afterReview.schedule)[0] || {};
  ok('评分写入排期（间隔/次数/难度因子）', st.reps === 1 && st.interval >= 1, JSON.stringify(st));
  ok('复习记了一次打卡（连续天数）', afterReview.days.length === 1, afterReview.days.join());

  /* ---------- ④ 自测题 ---------- */
  await page.locator('button:has-text("自测题")').first().click();
  await page.waitForSelector('.modal button:has-text("开始出题")', { timeout: 8000 });
  await page.locator('.modal button:has-text("开始出题")').click();
  await page.waitForSelector('.quiz-item', { timeout: 60000 });
  const quiz = await page.evaluate(() => ({
    title: document.querySelector('.sheet-title h1')?.textContent.trim(),
    count: document.querySelectorAll('.quiz-list .quiz-item').length,
    options: document.querySelectorAll('.quiz-option').length,
    answersShown: Boolean(document.querySelector('.quiz-answers')),
  }));
  ok('自测题生成（题型/选项渲染）', quiz.count >= 3 && quiz.options >= 4, `${quiz.title} · ${quiz.count} 题 · ${quiz.options} 个选项`);
  ok('默认不显示答案（先做题）', !quiz.answersShown);
  await page.locator('button:has-text("显示答案")').click();
  await page.waitForSelector('.quiz-answers', { timeout: 8000 });
  const ans = await page.evaluate(() => [...document.querySelectorAll('.quiz-answers .quiz-item')].map((x) => x.textContent.trim().slice(0, 30)));
  ok('显示答案后给出答案与解析', ans.length === quiz.count && ans.every((a) => a.length > 3), ans[0] || '');

  /* ---------- ⑤ 备份与同步 ---------- */
  await page.locator('button:has-text("备份/同步")').click();
  await page.waitForSelector('.backup-modal', { timeout: 8000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    page.locator('button:has-text("导出备份文件")').click(),
  ]);
  let backupOk = false;
  if (download) {
    const p = path.join(process.env.TEMP || '/tmp', 'vb-backup-test.json');
    await download.saveAs(p);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    backupOk = Array.isArray(j.books) && j.books.length === 1 && j.books[0].entries.length === 1;
    fs.unlinkSync(p);
  }
  ok('导出备份文件（内容含刚存的词条）', backupOk);

  await page.locator('button:has-text("生成同步码")').click();
  await page.waitForSelector('.sync-code', { timeout: 20000 });
  const code = (await page.locator('.sync-code').innerText()).trim();
  ok('生成同步码（32 位十六进制）', /^[a-f0-9]{32}$/.test(code), code);

  await page.locator('button:has-text("登录 / 注册")').click();
  await page.waitForSelector('.auth-modal', { timeout: 8000 });
  const auth = await page.evaluate(() => ({
    title: document.querySelector('.auth-modal h2')?.textContent.trim(),
    disabled: document.querySelector('.auth-modal .primary-btn')?.disabled,
    note: document.querySelector('.auth-modal .sync-lost')?.textContent.trim().slice(0, 40) || '',
  }));
  ok('账号弹窗可打开', auth.title === '账号', auth.title || '');
  ok('未启用账号时给出解释而不是死按钮', auth.disabled === true && /没有启用账号功能/.test(auth.note), `disabled=${auth.disabled} ${auth.note}`);

  ok('全程无控制台报错', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  ok('e2e 执行未抛错', false, String(e.message || e).slice(0, 160));
} finally {
  await browser.close();
  server.kill();
  mock.close();
  dictMock.close();
}

console.log('\n' + '='.repeat(62));
const failed = R.filter((x) => !x.c);
console.log(failed.length ? `❌ ${failed.length}/${R.length} 项失败` : `✅ 全部 ${R.length} 项通过`);
process.exit(failed.length ? 1 : 0);
