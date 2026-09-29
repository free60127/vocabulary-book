/**
 * API 响应头的端到端检查（真实起服务，对抗测试 R13）。
 *
 * 背景：json() 是全站 API 的统一出口，但曾经不设任何 Cache-Control ——
 * 同步快照（全部词条+复习进度）、批改结果、账号信息都以可缓存形态出站，
 * 共享代理/企业网关可能把它们缓存下来。现在统一 no-store，这里钉死。
 *
 * 跑法：node test/apiHeaders.test.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 26701 + Math.floor(Math.random() * 200);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    ALLOW_SERVER_KEY: '1',
    DAILY_JOB_LIMIT: '0',
    UPSTASH_REDIS_REST_URL: '',
    UPSTASH_REDIS_REST_TOKEN: '',
    DICT_PROVIDER: 'off',
    DATA_DIR: path.join(ROOT, 'test', 'agent_out', 'api-headers-' + Date.now()),
    RATE_LIMIT_PER_MIN: '1000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', () => { /* 起动日志忽略 */ });

const get = (p) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject);
  req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
});

/* 等服务起来 */
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try { const r = await get('/api/status'); up = r.status > 0; } catch { await new Promise((r) => setTimeout(r, 250)); }
}
check('测试服务已起动', up);

try {
  const s = await get('/api/status');
  check('/api/status 带 Cache-Control: no-store',
    s.headers['cache-control'] === 'no-store', String(s.headers['cache-control']));

  const bad = await get('/api/sync/not-a-valid-code-12345');
  check('404/400 类 JSON 拒绝同样带 no-store（错误响应也可能含上下文）',
    bad.headers['cache-control'] === 'no-store', String(bad.headers['cache-control']));

  const cfg = await get('/api/auth/config');
  check('账号配置接口带 no-store', cfg.headers['cache-control'] === 'no-store', String(cfg.headers['cache-control']));
} finally {
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n❌ ${failed.length}/${results.length} 项失败` : `\n✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
