/**
 * 每日额度闸门测试。
 *
 * 为什么值得测：这是**唯一真正兜住账单的东西**。限流是"每 IP 每分钟"，换个 IP 就绕过；
 * 一个被转到群里的网址如果没这道闸，一天烧掉多少钱没有上限。
 * 而它的三条语义都很容易写错，且错了不会报错、只会在月底的账单上体现：
 *   1) 只算服务端 Key 的请求（访客自带 Key 不能被卡，那是超限时给出的出路）；
 *   2) 先加后判、超了减回去（否则被拒的请求也把计数推高，状态显示变成假数）；
 *   3) 计数故障时放行（保护措施不该让所有人查不了词）。
 *
 * 跑法：node server/budget.test.mjs
 */
import { budgetKey, createBudget, budgetMessage, today } from './budget.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/** 内存版 kv，语义与真实驱动一致（setNx 只在不存在时写、incrBy 原子自增） */
function fakeKv() {
  const m = new Map();
  return {
    kind: 'fake',
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v) { m.set(k, String(v)); },
    async setNx(k, v) { if (m.has(k)) return false; m.set(k, String(v)); return true; },
    async incrBy(k, n) { const v = Number(m.get(k) || 0) + n; m.set(k, String(v)); return v; },
    dump: () => Object.fromEntries(m),
  };
}
const silent = { error: () => {} };

/* ---------- 关闭时不拦 ---------- */
{
  const b = createBudget({ kv: fakeKv(), limit: 0, log: silent });
  const r = await b.spend();
  check('limit=0 表示不限：不计数也不拦', r.ok && b.enabled === false && (await b.used()) === 0);
}

/* ---------- 正常计数与拦截 ---------- */
{
  const kv = fakeKv();
  const b = createBudget({ kv, limit: 3, log: silent });
  const a1 = await b.spend(); const a2 = await b.spend(); const a3 = await b.spend();
  check('额度内放行并计数', a1.ok && a2.ok && a3.ok && a3.used === 3, JSON.stringify([a1.used, a2.used, a3.used]));
  const a4 = await b.spend();
  check('到顶后拒绝', a4.ok === false && a4.used === 3, JSON.stringify(a4));
  check('被拒绝的请求**不会**把计数推高（先加后判、超了减回去）', (await b.used()) === 3, String(await b.used()));
  check('今天用的次数可直接读出来（/api/status 用）', (await b.used()) === 3);
}

/* ---------- 计数键按自然日切分 ---------- */
{
  const kv = fakeKv();
  let clock = new Date('2026-03-01T23:00:00Z').getTime();
  const b = createBudget({ kv, limit: 2, now: () => clock, log: silent });
  await b.spend(); await b.spend();
  check('当天用满即拒绝', (await b.spend()).ok === false);
  clock = new Date('2026-03-02T00:30:00Z').getTime();
  check('跨到第二天自动恢复（不是一次性锁死）', (await b.spend()).ok === true && (await b.used()) === 1);
  check('两天用两个键，互不影响', Object.keys(kv.dump()).sort().join() === [budgetKey('2026-03-01'), budgetKey('2026-03-02')].sort().join(), Object.keys(kv.dump()).join());
  check('today() 取的是 UTC 自然日（与键一致）', today(new Date('2026-03-02T00:30:00Z').getTime()) === '2026-03-02');
}

/* ---------- 故障时放行 ---------- */
{
  const bad = { get: async () => { throw new Error('kv 挂了'); }, setNx: async () => { throw new Error('kv 挂了'); }, incrBy: async () => { throw new Error('kv 挂了'); } };
  const b = createBudget({ kv: bad, limit: 3, log: silent });
  const r = await b.spend();
  check('计数失败时放行（保护措施不该让所有人查不了词）', r.ok === true && r.failed === true, JSON.stringify(r));
  check('计数失败时 used 读出 0 而不是抛错', (await b.used()) === 0);
}

/* ---------- 并发下不超额 ---------- */
{
  const kv = fakeKv();
  const b = createBudget({ kv, limit: 5, log: silent });
  const rs = await Promise.all(Array.from({ length: 20 }, () => b.spend()));
  const passed = rs.filter((r) => r.ok).length;
  check('20 个并发请求里恰好放行 5 个（不会超额放行）', passed === 5, `放行 ${passed} 个`);
  check('并发结束后计数正好等于上限', (await b.used()) === 5, String(await b.used()));
}

/* ---------- 提示语 ---------- */
{
  const msg = budgetMessage(50, 50);
  check('超限提示说清"为什么/何时恢复/现在怎么办"',
    msg.includes('50/50') && msg.includes('明天零点') && msg.includes('自己的 API Key'), msg.slice(0, 40) + '…');
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
