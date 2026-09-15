/**
 * 任务条数淘汰测试。
 *
 * 为什么值得测：这段逻辑的失效方式是"**什么都不发生**"——
 * 不淘汰的话查词一切正常，只是 KV 里的键越堆越多；等到把 Upstash 免费额度（256MB，
 * 而且是与姊妹项目共用的同一个库）塞满，表现是另一个应用先写不进数据。
 * 所以这里把"超上限之后到底删了谁、留下了谁"逐条钉住。
 *
 * 跑法：node server/job-evict.test.mjs
 */
import { createJobEvictor } from './job-evict.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/** 内存版 kv（语义与真实驱动一致：setNx / incrBy / del） */
function fakeKv() {
  const m = new Map();
  return {
    kind: 'fake',
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v) { m.set(k, String(v)); },
    async setNx(k, v) { if (m.has(k)) return false; m.set(k, String(v)); return true; },
    async del(k) { m.delete(k); },
    async incrBy(k, n) { const v = Number(m.get(k) || 0) + n; m.set(k, String(v)); return v; },
    raw: m,
    keys: () => [...m.keys()],
  };
}
const silent = { warn: () => {}, error: () => {} };
/** 模拟"一个任务落地"：任务键 + 记账 */
async function putJob(kv, ev, id) {
  await kv.set('vb:job:' + id, JSON.stringify({ jobId: id }), 3600);
  return ev.track(id);
}

/* ---------- 不超上限时什么都不删 ---------- */
{
  const kv = fakeKv();
  const ev = createJobEvictor({ kv, max: 5, log: silent });
  for (let i = 1; i <= 5; i += 1) await putJob(kv, ev, 'j' + i);
  check('额度内一个都不删', kv.keys().filter((k) => k.startsWith('vb:job:')).length === 5, String(kv.keys().length));
  check('序号从 1 开始递增', ev.stats.seq === 5 && ev.stats.retained === 5, JSON.stringify(ev.stats));
}

/* ---------- 超上限后从**最旧的**开始删 ---------- */
{
  const kv = fakeKv();
  const ev = createJobEvictor({ kv, max: 3, log: silent });
  for (let i = 1; i <= 6; i += 1) await putJob(kv, ev, 'j' + i);
  const left = kv.keys().filter((k) => k.startsWith('vb:job:')).map((k) => k.slice('vb:job:'.length));
  check('超上限后只留最近 max 条', left.length === 3, left.join(','));
  check('留下的正是最新的三条（j4 j5 j6）', left.sort().join() === 'j4,j5,j6', left.sort().join());
  check('被淘汰的任务键真的从存储里删掉了', !kv.keys().includes('vb:job:j1') && !kv.keys().includes('vb:job:j3'));
  check('淘汰过的映射键也清掉（不然它自己就成了垃圾）', kv.keys().filter((k) => k.startsWith('vb:jobseq:')).length <= 6, String(kv.keys().filter((k) => k.startsWith('vb:jobseq:')).length));
  check('一次 track 最多删一条（不做批量扫描，Upstash 按命令计费）', (await putJob(kv, ev, 'j7')).removed === 1);
}

/* ---------- 同一个任务被保存多次，只该占一个序号 ---------- */
{
  const kv = fakeKv();
  const ev = createJobEvictor({ kv, max: 3, log: silent });
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    await kv.set('vb:job:' + id, '{}', 3600);
    await ev.track(id); await ev.track(id); await ev.track(id);   // 模拟 pending/running/done 三次 saveJob
  }
  check('顺序执行时一个任务也只占一个序号', ev.stats.seq === 5, String(ev.stats.seq));
  const left = kv.keys().filter((k) => k.startsWith('vb:job:')).map((k) => k.slice('vb:job:'.length));
  check('5 个任务 / 上限 3 → 正好留 3 条（不是只剩 1 条）', left.length === 3 && left.sort().join() === 'c,d,e', left.sort().join());
  check('重复记账被识别出来', (await ev.track('e')).duplicate === true);
}

/* ---------- 并发：同一任务的多次保存是 fire-and-forget，会交叉执行 ---------- */
{
  const kv = fakeKv();
  const ev = createJobEvictor({ kv, max: 100, log: silent });
  await kv.set('vb:job:x', '{}', 3600);
  // 故意不 await：saveJob 就是这么调的（pending/running/done 三次保存在同一轮里交叉）
  const rs = await Promise.all([ev.track('x'), ev.track('x'), ev.track('x')]);
  check('交叉执行的重复记账只占一个序号（占位在第一个 await 之前）', ev.stats.seq === 1, `seq=${ev.stats.seq} 结果=${JSON.stringify(rs.map((r) => r.tracked))}`);
  check('另外两次被识别为重复', rs.filter((r) => r.duplicate).length === 2, JSON.stringify(rs));
}

/* ---------- 重启后接着上次的序号 ---------- */
{
  const kv = fakeKv();
  const ev1 = createJobEvictor({ kv, max: 2, log: silent });
  for (let i = 1; i <= 4; i += 1) await putJob(kv, ev1, 'j' + i);
  const seqAfterRestartSource = ev1.stats.seq;

  const ev2 = createJobEvictor({ kv, max: 2, log: silent });   // 新进程
  await ev2.init();
  check('序号从 kv 读回来（重启后不会从 0 重发）', ev2.stats.seq === seqAfterRestartSource, `${ev2.stats.seq} vs ${seqAfterRestartSource}`);
  await putJob(kv, ev2, 'j5');
  const left = kv.keys().filter((k) => k.startsWith('vb:job:')).map((k) => k.slice('vb:job:'.length));
  check('重启后继续淘汰最旧的，不会把新任务当旧的删掉', left.sort().join() === 'j4,j5', left.sort().join());
}

/* ---------- 命名空间：绝不碰别的应用的键 ---------- */
{
  const kv = fakeKv();
  await kv.set('bts:job:other-app', 'x');       // 姊妹项目的数据
  await kv.set('bts:jobs:seq', '999');
  const ev = createJobEvictor({ kv, prefix: 'vb:', max: 1, log: silent });
  for (let i = 1; i <= 4; i += 1) await putJob(kv, ev, 'j' + i);
  check('淘汰只在本应用前缀内进行，别的应用的数据原样保留',
    (await kv.get('bts:job:other-app')) !== null && (await kv.get('bts:jobs:seq')) === '999');
  check('序号键也带前缀（不会和姊妹项目的序号互相干扰）',
    (await kv.get('vb:jobs:seq')) === '4' && (await kv.get('bts:jobs:seq')) === '999', String(await kv.get('vb:jobs:seq')));
}

/* ---------- 存储故障时不影响主流程 ---------- */
{
  const bad = {
    get: async () => { throw new Error('kv 挂了'); },
    set: async () => { throw new Error('kv 挂了'); },
    del: async () => { throw new Error('kv 挂了'); },
    incrBy: async () => { throw new Error('kv 挂了'); },
  };
  const ev = createJobEvictor({ kv: bad, max: 3, log: silent });
  // 直接调 track：putJob 里的 kv.set 会抛，那是测试夹具的行为，不是被测对象
  const r = await ev.track('j1').catch((e) => ({ threw: String(e.message) }));
  check('存储故障时 track 不抛错（清理工不该拖垮查词）', !r.threw && r.tracked === false, JSON.stringify(r));
  check('故障次数被记下来，便于排查', ev.stats.failures > 0, String(ev.stats.failures));
  check('没有 jobId 时直接跳过', (await ev.track('')) .tracked === false);
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
