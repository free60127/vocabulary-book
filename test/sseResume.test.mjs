/**
 * SSE 断线续传回归：id 行 + Last-Event-ID 游标。
 *
 * 背景：查词流式链路靠 EventSource 断线自动重连恢复，服务端给段事件带 `id:` 行、
 * 连接回来时按 Last-Event-ID 从断点续传（不重放已收段落）。这条链此前零测试覆盖 ——
 * 一旦有人把 cursor 语义改坏（比如重放从头开始、或游标取错导致漏段），
 * 只有真机弱网才能发现。这里用最小 mock 上游把链路整个跑起来钉死三件事：
 *   ① 段事件带 id 行（id: 0 起、单调递增）；
 *   ② 带 Last-Event-ID: N 重连 → 严格从 N+1 续传，绝不重放 ≤ N 的段；
 *   ③ 任务完成后重连（走"已完成任务一次性推完"分支）同样按游标续传 + done 收尾。
 *
 * 跑法：node test/sseResume.test.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM_PORT = 26001 + Math.floor(Math.random() * 300);
const SERVER_PORT = 26301 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* ---------- mock 上游：OpenAI 流式响应，产出 3 个分段 + done ---------- */
const SEG_LINES = [
  JSON.stringify({ t: 'meta', head: 'object', kind: 'word', phonetic: '/ɒbdʒɪkt/', pos: '名词', brief: '物体', register: '通用', tone: '中性', strength: '中' }),
  JSON.stringify({ t: 'meanings', items: [{ pos: '名词', cn: '物体', en: 'a thing', note: '' }] }),
  JSON.stringify({ t: 'done' }),
];
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const line of SEG_LINES) {
    const chunk = JSON.stringify({ choices: [{ delta: { content: line + '\n' } }] });
    res.write('data: ' + chunk + '\n\n');
  }
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(SERVER_PORT),
    AI_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
    AI_API_KEY: 'sk-test-sse-resume-mock',
    ALLOW_SERVER_KEY: '1',                    // 钉死（本机 .env 策略不得漏进被测进程）
    DAILY_JOB_LIMIT: '0',
    UPSTASH_REDIS_REST_URL: '',
    UPSTASH_REDIS_REST_TOKEN: '',
    DICT_PROVIDER: 'off',
    DATA_DIR: path.join(ROOT, 'test', 'agent_out', 'sse-data-' + Date.now()),
    RATE_LIMIT_PER_MIN: '1000',
  },
  stdio: 'ignore',
});
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
let up = false;
for (let i = 0; i < 60 && !up; i += 1) {
  try { up = (await fetch(BASE + '/api/health')).ok; } catch { await sleep(300); }
}
check('被测服务已启动', up);

/** 原始 SSE 读取：返回 {frames:[{id,event,data}], abort()}；读到 stop(frame) 返回 true 即断开 */
function readSSE(pathname, headers = {}, stop) {
  return new Promise((resolve) => {
    const frames = [];
    const req = http.get(BASE + pathname, { headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const f = {};
          for (const line of raw.split('\n')) {
            if (line.startsWith('id:')) f.id = Number(line.slice(3).trim());
            else if (line.startsWith('event:')) f.event = line.slice(6).trim();
            else if (line.startsWith('data:')) f.data = line.slice(5).trim();
          }
          if (f.event || f.id !== undefined) frames.push(f);
          if (stop && stop(f, frames)) { req.destroy(); resolve({ frames, aborted: true }); return; }
        }
      });
      res.on('end', () => resolve({ frames, aborted: false }));
    });
    req.on('error', () => resolve({ frames, aborted: true }));
  });
}

if (up) {
  // ① 提交流式查词任务
  const sub = await (await fetch(BASE + '/api/lookup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ term: 'object', level: '四六级', stream: true }),
  })).json();
  check('流式任务已受理', Boolean(sub.jobId), JSON.stringify(sub).slice(0, 80));

  // ② 首连：读到第一个带 id 的段就掐断（模拟弱网断线）
  const first = await readSSE(`/api/lookup/${sub.jobId}/stream`, {}, (f, frames) => frames.some((x) => x.event === 'segment' && x.id !== undefined));
  const seg0 = first.frames.filter((f) => f.event === 'segment');
  check('段事件带 id 行且从 0 起', seg0.length >= 1 && seg0[0].id === 0, seg0.map((f) => f.id).join(','));

  // 等 1.5s 让服务端把剩余段收完（mock 上游是瞬时产出）
  await sleep(1500);

  // ③ 带 Last-Event-ID: 0 重连 → 不重放 id:0，按序续传直至 done
  const second = await readSSE(`/api/lookup/${sub.jobId}/stream`, { 'last-event-id': '0' }, (f) => f.event === 'done');
  const ids = second.frames.filter((f) => f.event === 'segment').map((f) => f.id);
  check('重连不重放已收段（无 id:0）', !ids.includes(0), ids.join(','));
  check('续传按序补齐剩余段', ids.length >= 1 && ids.every((v, i) => i === 0 || v === ids[i - 1] + 1), ids.join(','));
  check('done 事件收尾且带最终词条', second.frames.some((f) => f.event === 'done') && String(second.frames.find((f) => f.event === 'done')?.data || '').includes('"head"'));

  // ④ 完成后再连（新连接无游标）→ 全量重放 + done（"切走又回来"语义）
  const third = await readSSE(`/api/lookup/${sub.jobId}/stream`, {}, (f) => f.event === 'done');
  const thirdIds = third.frames.filter((f) => f.event === 'segment').map((f) => f.id);
  check('无游标新连接全量重放（0 起）', thirdIds[0] === 0 && thirdIds.length >= 3, thirdIds.join(','));
}

upstream.close();
server.kill();
const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(62));
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
