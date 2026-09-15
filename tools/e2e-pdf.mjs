/**
 * PDF 导出 e2e：用 Playwright 的 page.pdf() **真正生成 PDF**。
 *
 * 为什么不用"点一下按钮、看有没有报错"这种测法：导出的成败全在**打印样式**上，
 * 而打印样式只在 print 媒体下生效 —— page.pdf() 走的正是同一条路径，
 * 所以它能验证"用户拿到的 PDF 里到底有没有内容、分了几页"。
 * 实测过一次"打印出一张白纸"的经典坑（内容被 display:none 藏掉），只有这种测法能抓住。
 *
 * 跑法：node tools/e2e-pdf.mjs   （需要 tools/shotter 下的 Playwright；先 npm run build）
 */
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'file:///D:/AI/66666-main/tools/shotter/node_modules/playwright/index.mjs';
const PORT = 8817, MOCK = 9817;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entry = (head, extra = {}) => ({
  head, kind: 'word', phonetic: '/ɪnˈʃraɪn/', pos: '动词', brief: '把……奉为神圣',
  register: '正式', tone: '中性', strength: '强',
  meanings: [{ pos: '动词', cn: `${head} 的意思`, en: 'to preserve a right' }],
  scenes: ['法律/宪法语境'], avoid: '别用于日常口语',
  mnemonic: { image: '图像', hook: '钩子', parts: 'en- + shrine', family: 'enshrinement' },
  synonyms: [{ word: 'consecrate', diff: '更宗教', usage: '仪式', example: 'They consecrated it.', exampleCn: '他们把它奉为神圣。' }],
  collocations: ['be enshrined in'], examples: [{ en: `The rule was enshrined.`, cn: '这条规则被载入。', note: '被动更常见' }],
  confusions: '与 conserve 不同', usageNotes: '多用于法律', examTips: 'GRE 常考', createdAt: 1, ...extra,
});
const mock = http.createServer((q, r) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
  const m = /【查询内容】([^\n\\]+)/.exec(b);
  r.writeHead(200, { 'Content-Type': 'application/json' });
  r.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(entry(m ? m[1].trim() : 'enshrine')) } }] }));
}); });
await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r));
const srv = spawn(process.execPath, ['server/index.mjs'], { env: { ...process.env, PORT: String(PORT), AI_BASE_URL: `http://127.0.0.1:${MOCK}/v1`, AI_API_KEY: 'k', ALLOW_PRIVATE_BASE_URL: '1', DICT_PROVIDER: 'off' }, stdio: 'ignore' });
for (let i = 0; i < 40; i += 1) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch { /* wait */ } await sleep(300); }
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
// 把 window.print 打桩：真跑 headless 里它会立刻触发 afterprint，打印页就被收尾清掉了，
// 那样 page.pdf() 只能得到一张白纸。打桩后 printing 状态保留，正好用来验证真实打印管线。
await ctx.addInitScript(() => {
  window.__printed = 0;
  window.print = () => { window.__printed += 1; };
});
// 造一个 3 词条的本子
await ctx.addInitScript((e) => {
  const mk = (h, i) => ({ ...JSON.parse(e), head: h, id: 'wb-' + i, createdAt: i });
  localStorage.setItem('vb-books', JSON.stringify([{ id: 'bk-1', name: '英语文摘2026', note: '', createdAt: 1,
    entries: ['enshrine', 'incumbent', 'resilient'].map((h, i) => mk(h, i)) }]));
}, JSON.stringify(entry('x')));
const p = await ctx.newPage();
p.on('dialog', (d) => d.accept());
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.side-toggle', { timeout: 30000 });
await p.locator('.lesson-item').first().click();          // 进本子
await p.waitForSelector('.entry-row', { timeout: 10000 });

const R = [];
const ok = (n, c, d = '') => { R.push(c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

// ---- 1) 整本导出 ----
await p.locator('button:has-text("导出本子 PDF")').click();
await p.waitForSelector('.print-sheet', { state: 'attached', timeout: 5000 });
const bookSheet = await p.evaluate(() => ({
  cards: document.querySelectorAll('.print-sheet .entry-card').length,
  cover: document.querySelector('.print-cover h1')?.textContent,
  buttons: document.querySelectorAll('.print-sheet button').length,
  saveBars: document.querySelectorAll('.print-sheet .save-bar').length,
  sections: document.querySelectorAll('.print-sheet .entry-card:first-of-type .section-heading h2').length,
  bodyPrinting: document.body.classList.contains('printing'),
}));
ok('整本导出：3 个词条都在打印页里', bookSheet.cards === 3, String(bookSheet.cards));
ok('整本导出：有封面（本子名）', bookSheet.cover === '英语文摘2026', bookSheet.cover || '');
ok('打印页里没有按钮/保存栏（纸上用不到）', bookSheet.buttons === 0 && bookSheet.saveBars === 0, `btn=${bookSheet.buttons} save=${bookSheet.saveBars}`);
ok('讲解板块齐全', bookSheet.sections >= 8, String(bookSheet.sections));
ok('触发打印时 body 带 printing 标记', bookSheet.bodyPrinting);
await p.waitForTimeout(300);   // 等 80ms 的 window.print() 定时器
ok('确实调用了浏览器打印（用户在这里选「另存为 PDF」）', await p.evaluate(() => window.__printed) === 1, String(await p.evaluate(() => window.__printed)));
await p.pdf({ path: 'tmp-book.pdf', format: 'A4', printBackground: true });
const bookPdf = fs.readFileSync('tmp-book.pdf');
ok('整本生成了真实 PDF', bookPdf.length > 5000, `${(bookPdf.length / 1024).toFixed(0)} KB`);

// ---- 2) 单个词条导出 ----
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.side-toggle', { timeout: 30000 });
await p.locator('.lesson-item').first().click();
await p.waitForSelector('.entry-row', { timeout: 10000 });
await p.locator('.entry-open').first().click();            // 打开词条卡片
await p.waitForSelector('.entry-card', { timeout: 10000 });
await p.locator('.save-bar button:has-text("导出 PDF")').click();
await p.waitForSelector('.print-sheet', { state: 'attached', timeout: 5000 });
const oneSheet = await p.evaluate(() => ({
  cards: document.querySelectorAll('.print-sheet .entry-card').length,
  cover: Boolean(document.querySelector('.print-cover')),
}));
ok('单个词条导出：只有 1 张卡片、没有整本封面', oneSheet.cards === 1 && !oneSheet.cover, JSON.stringify(oneSheet));
await p.pdf({ path: 'tmp-one.pdf', format: 'A4', printBackground: true });
const onePdf = fs.readFileSync('tmp-one.pdf');
ok('单个词条生成了真实 PDF', onePdf.length > 3000, `${(onePdf.length / 1024).toFixed(0)} KB`);

const pages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
console.log(`\n整本 PDF 页数 ≈ ${pages(bookPdf)} · 单词条 PDF 页数 ≈ ${pages(onePdf)}`);
ok('整本的页数明显多于单条（说明按词条分页生效）', pages(bookPdf) > pages(onePdf), `${pages(bookPdf)} vs ${pages(onePdf)}`);

await b.close(); srv.kill(); mock.close();
fs.unlinkSync('tmp-book.pdf'); fs.unlinkSync('tmp-one.pdf');
console.log(R.every(Boolean) ? '\n✅ PDF 导出检查全部通过' : '\n❌ 有失败项');
process.exit(R.every(Boolean) ? 0 : 1);
