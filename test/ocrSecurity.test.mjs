/**
 * 服务端接入点安全边界的回归测试。
 *
 * 两条都是**真实被利用过**的洞，用 PoC 打出来之后修掉的 —— 这种洞最容易在后续重构里
 * "顺手改回去"（看起来只是把参数接上、看起来只是挪了一行），所以必须钉住：
 *
 *   ① /api/ocr 曾经接受请求体里的 `visionBaseUrl`，而同一处的 apiKey 是 `ep.apiKey`
 *      （不传 body.apiKey 时就是**服务端自己那份 Key**）。两者一组合，任何人匿名发一个
 *      POST 就能让服务器带着自己的 Key 去访问任意地址，上游响应正文还会经任务错误回显。
 *      其余 6 个路由都走 resolveEndpoint（自定义地址必须自带 Key + 禁私网），只有它漏了。
 *      这里断言：攻击者地址**一个请求都收不到**。
 *
 *   ② `new URL(req.url)` 曾经写在 try 之外。`GET http://[ HTTP/1.1` 这种畸形
 *      request-target 会让它抛 URIError，而这个 async 回调在 try 之前就 reject ——
 *      没有任何一行代码再碰 res，请求永远不结束、连接也不关（Node 的 requestTimeout
 *      只管"把请求收完"，而请求已经收完了）。这里断言：畸形 target 必须**立刻拿到响应**。
 *
 * 跑法：node test/ocrSecurity.test.mjs
 */
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 随机端口：和别的测试/别的会话同时跑时不会撞车 */
const port = () => 33000 + Math.floor(Math.random() * 2000);

console.log('=== 接入点安全边界测试 ===\n');

const ATTACKER_PORT = port();
const UPSTREAM_PORT = port();
const SERVER_PORT = port();
// ⚠️ 金丝雀里必须含 test/fake/example 之类的豁免词（见 test/no-secrets.test.mjs）：
// 这个文件被 git 跟踪后，凭证扫描器会扫它 —— 不含豁免词的 sk- 串会被当成真实 Key 报警（实测）。
const CANARY = 'sk-canary-test-must-never-leave-the-server';

/* 攻击者服务器：只要收到任何请求就说明边界破了 */
const seen = [];
const attacker = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ path: req.url, auth: req.headers.authorization || '', body: body.slice(0, 200) });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'INTERNAL-SECRET-FROM-VICTIM-NET' } }));
  });
});
await new Promise((r) => attacker.listen(ATTACKER_PORT, '127.0.0.1', r));

/* 一个"正常"的上游：让受害服务起得来（它自己会去探这个地址） */
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(SERVER_PORT),
    AI_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
    AI_VISION_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
    DAILY_JOB_LIMIT: '0',
    UPSTASH_REDIS_REST_URL: '',
    UPSTASH_REDIS_REST_TOKEN: '',

    AI_API_KEY: CANARY,                       // ← 服务端自己那份 Key（就是要守住的东西）
    // 刻意**不设** ALLOW_PRIVATE_BASE_URL：贴近生产默认（收紧私网），断言才有意义。
    // 服务端调用自己的 AI_BASE_URL 走的是 fallback 分支，不受这里影响。
    // ⚠️ ALLOW_SERVER_KEY 必须钉死为 1：本测试验证的是"带服务端 Key 的服务端会**受理**
    // 请求并守住 Key"——而开发者本机 .env 若设了 0，会经服务端的 .env 加载漏进被测进程，
    // 路由在受理前就 400，根本走不到要验证的分支（实测踩过）。
    ALLOW_SERVER_KEY: '1',
    DICT_PROVIDER: 'off',
    DATA_DIR: path.join(ROOT, 'test', 'agent_out', 'sec-data-' + Date.now()),
    RATE_LIMIT_PER_MIN: '1000',
  },
  stdio: 'ignore',
});

const BASE = `http://127.0.0.1:${SERVER_PORT}/`;
let up = false;
for (let i = 0; i < 60 && !up; i += 1) {
  try { up = (await fetch(BASE + 'api/health')).ok; } catch { /* 等它起来 */ }
  if (!up) await sleep(300);
}
check('被测服务已启动', up);

/* ---------- ① visionBaseUrl 不得把服务端 Key 送去任意地址 ---------- */
if (up) {
  const r = await fetch(BASE + 'api/ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // 只要能过 /^data:image\/(png|jpe?g|webp);base64,/ 就行，不需要是真图片
      image: 'data:image/png;base64,iVBORw0KGgo=',
      visionBaseUrl: `http://127.0.0.1:${ATTACKER_PORT}/`,   // ← 攻击者地址
      visionModel: 'x',
      // 刻意不传 apiKey / baseUrl：此时服务端会用自己的 Key
    }),
  });
  const body = await r.json().catch(() => ({}));
  check('POST /api/ocr 能受理（前提是请求本身合法）', r.status === 200 && Boolean(body.jobId), `status=${r.status}`);
  await sleep(2500);

  check('攻击者地址收不到任何请求（服务端 Key 不会被送去任意地址）', seen.length === 0,
    seen.length ? `收到 ${seen.length} 个，Authorization=${seen[0].auth}` : '0 个');
  check('服务端 Key 没有出现在任何外发请求里', !seen.some((s) => s.auth.includes(CANARY)));

  if (body.jobId) {
    const j = await (await fetch(BASE + `/api/ocr/${body.jobId}`)).json().catch(() => ({}));
    const err = String((j.job && j.job.error) || '');
    check('上游响应正文不会经任务错误回显给客户端', !err.includes('INTERNAL-SECRET'),
      err ? err.slice(0, 60) : '（无错误）');
  }
}

/* ---------- ② 畸形 request-target 必须立刻有响应，不能挂起 ---------- */
if (up) {
  const probe = (raw) => new Promise((resolve) => {
    const sock = net.connect(SERVER_PORT, '127.0.0.1', () => sock.write(raw));
    let got = '';
    let closed = false;
    sock.on('data', (d) => { got += d; });
    sock.on('close', () => { closed = true; });
    sock.on('error', () => { closed = true; });
    setTimeout(() => { sock.destroy(); resolve({ got, closed }); }, 2000);
  });
  for (const target of ['http://[::1', 'http://[', 'http://%']) {
    const r = await probe(`GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
    check(`畸形 request-target ${JSON.stringify(target)} 有响应、不挂起`,
      r.got.startsWith('HTTP/1.1 4'), r.got ? r.got.split('\r\n')[0] : '无响应（挂起）');
  }
}

server.kill();
attacker.close();
upstream.close();

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n❌ ${failed.length}/${results.length} 项失败` : `\n✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
