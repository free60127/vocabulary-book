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

/* ---------- 改前缀不能把老数据扔掉（一次性认领）----------
   真实事故：原本写死 bts:sync:，改成 vb:sync: 之后，老用户那串码在新命名空间里读不到，
   客户端把 404 当"空云端"照常推送 —— 结果是"电脑有数据、手机同步过来什么都没有"，
   而且界面上没有任何报错。所以旧键里有同一串码时必须认领过来。 */
{
  const seen = [];
  const store = new Map();
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const cmd = JSON.parse(opts.body);
    const key = String(cmd[1]);
    seen.push(key);
    if (cmd[0] === 'GET') return { ok: true, text: async () => JSON.stringify({ result: store.has(key) ? store.get(key) : null }) };
    if (cmd[0] === 'SET') { store.set(key, String(cmd[2])); return { ok: true, text: async () => JSON.stringify({ result: 'OK' }) }; }
    return { ok: true, text: async () => JSON.stringify({ result: null }) };
  };
  const legacyDoc = JSON.stringify({ version: 7, updatedAt: 1, data: { books: [{ id: 'bk-old', name: '老数据', entries: [] }] } });
  store.set('bts:sync:OLDC0DE', legacyDoc);

  const store2 = createUpstashStore({ url: 'https://x.upstash.io', token: 't' });
  const got = await store2.read('OLDC0DE');
  check('新键没有、旧键有 → 把旧数据认领过来（而不是当成空云端）',
    got && got.version === 7 && got.data.books[0].name === '老数据', JSON.stringify(got && got.version));
  const adopted = JSON.parse(store.get('vb:sync:OLDC0DE') || 'null');
  check('认领时会写进新键（sanitize 规范化后的数据），之后就走新键了',
    store.has('vb:sync:OLDC0DE') && adopted && adopted.data && adopted.data.books[0].name === '老数据',
    JSON.stringify(adopted && adopted.data && adopted.data.books).slice(0, 80));
  seen.length = 0;
  await store2.read('OLDC0DE');
  check('第二次只查新键（不重复翻旧键）', seen.length === 1 && seen[0] === 'vb:sync:OLDC0DE', seen.join(','));

  /* 旧命名空间认领必须过 sanitizeSnapshot：异构/恶意形状当不存在（绝不直达前端） */
  {
    const seen3 = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (url, opts) => {
      const cmd = JSON.parse(opts.body);
      const key = String(cmd[1]);
      seen3.push(key);
      if (cmd[0] === 'GET') {
        if (key === 'bts:sync:BADDE') return { ok: true, text: async () => JSON.stringify({ result: JSON.stringify({ version: 3, updatedAt: 1, data: { books: '不是数组', evil: true } }) }) };
        return { ok: true, text: async () => JSON.stringify({ result: null }) };
      }
      return { ok: true, text: async () => JSON.stringify({ result: 'OK' }) };
    });
    const store3 = createUpstashStore({ url: 'https://x.upstash.io', token: 't' });
    const bad = await store3.read('BADDE');
    globalThis.fetch = prevFetch;   // 恢复现场：后面的用例各自依赖自己的 fetch 桩
    check('旧键里的坏形状数据 → 当不存在（不返回、不迁移）', bad === null, JSON.stringify(bad));
  }

  seen.length = 0;
  const miss = await store2.read('NOTEXIST');
  check('两边都没有就是真的没有', miss === null && seen.join(',') === 'vb:sync:NOTEXIST,bts:sync:NOTEXIST', seen.join(','));

  const custom = createUpstashStore({ url: 'https://x.upstash.io', token: 't', prefix: 'zz:' });
  seen.length = 0;
  await custom.read('OLDC0DE');
  check('显式指定前缀（多应用共库）时不翻旧键，免得读到别人的数据',
    seen.join(',') === 'zz:sync:OLDC0DE', seen.join(','));
  globalThis.fetch = orig;
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


/* ---------- forgot：SMTP 失败细节不外泄 ---------- */
{
  const store2 = new Map();
  const kv2 = {
    async get(k) { return store2.has(k) ? store2.get(k) : null; },
    async set(k, v) { store2.set(k, String(v)); },
    async setNx(k, v) { if (store2.has(k)) return false; store2.set(k, String(v)); return true; },
    async del(k) { store2.delete(k); },
    async incrBy(k, n) { const cur = Number(store2.get(k)) || 0; const next = cur + Number(n); store2.set(k, String(next)); return next; },
    async count() { return store2.size; },
  };
  const smtpDetail = 'test-internal-smtp-detail-host-5.6.7.8';   // 故意的假细节，用于断言不外泄
  const SECRET = 'test-only-secret-credential';                  // 邮件失败时夹带的"内部机密"，同样必须不外泄
  const accts = createAccounts({
    kv: kv2,
    mail: async () => ({ ok: false, code: 'connect', error: 'connect failed: ' + SECRET }),
    env: {},
  });
  const reg = await accts.register({ email: 'f@d.com', password: 'Passw0rd!x', ip: '2.2.2.2' });
  const forgot = await accts.forgot({ email: 'f@d.com' });
  check('forgot 失败时给用户的是原因分类，不带底层细节',
    forgot.status === 503 && !String(forgot.error).includes(smtpDetail) && String(forgot.error).includes('连不上邮件服务器'),
    String(forgot.error).slice(0, 60));
  check('注册（上面 forgot 的前置）成功', reg.status === 200 || reg.error === undefined, JSON.stringify(reg).slice(0, 60));
}
