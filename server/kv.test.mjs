/**
 * KV 命名空间测试。
 *
 * 为什么值得单独钉：这个项目的账号、云同步、任务、每日额度四块都从姊妹项目「回译本」搬来，
 * 其中**账号与云同步的前缀被写死成了同一个**（`bts:acct:` / `bts:sync:`）。
 * 于是两个应用共用同一个 Upstash 库时会在同一命名空间里读写 ——
 * 表现是"同一个邮箱在一边注册了、另一边就注册不了"，更糟的是账号记录里存着同步码，
 * 串库后两个应用会去读写同一份快照文档，而两边的快照结构完全不同，合并时会把对方的数据清掉。
 * 这种错**不会报任何错**，只在用户数据上体现，所以必须在键名这一层钉死。
 *
 * 跑法：node server/kv.test.mjs
 */
import { kvPrefix } from './kv.mjs';
import { budgetKey, createBudget } from './budget.mjs';
import { createUpstashStore } from './sync.mjs';
import { createAccounts } from './accounts.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/** 拦下 fetch，只记录发了什么 key（不真发请求） */
function spyFetch(sink) {
  return async (url, opts) => {
    const cmd = JSON.parse(opts.body);
    sink.push(String(cmd[1]));
    return { ok: true, text: async () => JSON.stringify({ result: cmd[0] === 'GET' ? null : 1 }) };
  };
}

/* ---------- 默认前缀 ---------- */
{
  check('默认前缀 vb:（与回译本的 bts: 天然分开）', kvPrefix({}) === 'vb:', kvPrefix({}));
  check('留空仍是 vb:（不写就等于用默认，不会变成"无前缀"）',
    kvPrefix({ KV_PREFIX: '' }) === 'vb:' && kvPrefix({ KV_PREFIX: '   ' }) === 'vb:');
  check('可用 KV_PREFIX 覆盖（想和别的应用合用同一个库时靠它错开）',
    kvPrefix({ KV_PREFIX: 'myns:' }) === 'myns:' && kvPrefix({ KV_PREFIX: 'x-' }) === 'x-');
}

/* ---------- 云同步键 ---------- */
{
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = spyFetch(seen);
  const store = createUpstashStore({ url: 'https://example.upstash.io', token: 't' });
  await store.read('abc123');
  check('云同步键是 vb:sync:，不再是 bts:sync:', seen[0] === 'vb:sync:abc123', seen[0]);
  seen.length = 0;
  const custom = createUpstashStore({ url: 'https://example.upstash.io', token: 't', prefix: 'zz:' });
  await custom.read('abc');
  check('前缀可注入', seen[0] === 'zz:sync:abc', seen[0]);
  globalThis.fetch = orig;
}

/* ---------- 账号键 ---------- */
{
  const writes = [];
  const kv = {
    kind: 'fake',
    async get() { return null; },
    async set(k) { writes.push(k); },
    async setNx(k) { writes.push(k); return true; },
    async del() {},
    async incrBy() { return 1; },
  };
  const accounts = createAccounts({ kv, mail: async () => ({ ok: false, reason: 'test' }), env: {} });
  try { await accounts.register({ email: 'a@b.com', password: 'Passw0rd!x', ip: '1.2.3.4' }); } catch { /* 只看键名 */ }
  check('账号键是 vb:acct:，不再是 bts:acct:', writes.some((k) => k.startsWith('vb:acct:')), writes[0] || '(没写入)');
  check('账号键里不再出现 bts:', writes.length > 0 && writes.every((k) => !k.startsWith('bts:')), writes.join(','));
}

/* ---------- 每日额度键 ---------- */
{
  check('额度键带前缀', budgetKey('2026-09-15') === 'vb:spent:2026-09-15', budgetKey('2026-09-15'));
  const seen = [];
  const kv = {
    async get(k) { seen.push(k); return null; },
    async setNx(k) { seen.push(k); return true; },
    async incrBy() { return 1; },
  };
  const b = createBudget({ kv, limit: 5, prefix: 'vb:' });
  await b.spend();
  check('额度计数用的是带前缀的键', seen.every((k) => k.startsWith('vb:spent:')), seen.join(','));
}

/* ---------- 四个命名空间互不重叠，且都与回译本错开 ---------- */
{
  const ns = {
    账号: kvPrefix({}) + 'acct:',
    同步: kvPrefix({}) + 'sync:',
    任务: kvPrefix({}) + 'job:',
    额度: budgetKey('2026-09-15').replace(/2026-09-15$/, ''),
  };
  check('本应用四个命名空间互不重叠', new Set(Object.values(ns)).size === 4, JSON.stringify(ns));
  check('与回译本（bts:acct: / bts:sync: / bts:job:）全部错开',
    Object.values(ns).every((v) => !v.startsWith('bts:')), Object.values(ns).join(' '));
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
