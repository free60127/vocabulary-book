/**
 * 通用键值存储（账号体系用）。
 *
 * 两种驱动，API 完全一致：
 *   - Upstash Redis（REST API，纯 fetch，**零 npm 依赖**）→ 生产用，数据持久
 *   - 本地文件 data/kv/<key>.txt → 开发 / 自托管用
 *
 * 为什么不用 Postgres：那需要引入 `pg` 依赖。这个后端能"零依赖直接跑起来"
 * 是它最大的优点（换任何机器、任何平台都不用装东西），不该为了账号破掉。
 * 而且同步层已经在用 Upstash 了，同一个服务顺带把「同步数据重启就丢」也修掉。
 *
 * 值一律是字符串（和 Redis 语义一致），两个驱动的行为不会分叉。
 *
 * TTL：
 *   - Upstash 用原生 EX（过期自动清理）
 *   - 文件驱动内部包一层 {v,e} 信封自己判过期
 *   对调用方是同一套接口。
 */
import fs from 'node:fs';
import path from 'node:path';

const isMissing = (e) => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

/* ---------- Upstash ---------- */
export function createUpstashKv({ url, token }) {
  const endpoint = String(url).replace(/\/+$/, '');
  const cmd = async (command) => {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    const text = await r.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('Upstash 返回不是 JSON：' + text.slice(0, 200)); }
    if (parsed && parsed.error) throw new Error('Upstash 错误：' + parsed.error);
    if (!r.ok) throw new Error('Upstash 请求失败 ' + r.status);
    return parsed.result;
  };
  return {
    kind: 'upstash',
    durable: true,
    async get(key) {
      const v = await cmd(['GET', key]);
      return v === null || v === undefined ? null : String(v);
    },
    async set(key, val, ttlSec) {
      const c = ['SET', key, String(val)];
      if (ttlSec > 0) c.push('EX', String(Math.ceil(ttlSec)));
      await cmd(c);
    },
    /** 只在键不存在时写入。返回 true 表示"本次创建成功"（并发下只有一个赢）。 */
    async setNx(key, val, ttlSec) {
      const c = ['SET', key, String(val), 'NX'];
      if (ttlSec > 0) c.push('EX', String(Math.ceil(ttlSec)));
      return (await cmd(c)) !== null;
    },
    async del(key) { await cmd(['DEL', key]); },
    async incrBy(key, n) { return Number(await cmd(['INCRBY', key, String(n)])); },
    /** 键总数：用来在启动日志里给出"离存储上限还有多远"的量级（免费额度按 256MB 计） */
    async dbSize() { return Number(await cmd(['DBSIZE'])) || 0; },
  };
}

/* ---------- 本地文件 ---------- */
export function createFileKv(dir) {
  const ensure = () => fs.mkdirSync(dir, { recursive: true });
  ensure();
  // 启动时清掉上次崩溃留下的 .tmp 孤儿（原子写中断的残留；单实例部署，启动期清理安全）
  try {
    for (const n of fs.readdirSync(dir)) if (n.includes('.tmp-')) fs.unlinkSync(path.join(dir, n));
  } catch { /* 清理失败不影响使用 */ }
  const fileOf = (key) => path.join(dir, String(key).replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
  const readEnv = (f) => {
    try {
      const o = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (o && o.e && Date.now() > o.e) return null; // 已过期
      return o && typeof o.v === 'string' ? o.v : null;
    } catch { return null; }
  };
  // 原子写：先写同目录临时文件再 rename 覆盖。裸 writeFileSync 被进程中途打断（崩溃/被杀/
  // 平台重启）会留下半截 JSON —— 读侧 parse 失败静默当 null，等于任务/预算/会话数据悄悄丢；
  // sync.mjs 的 writeAtomic 一直是 tmp+rename，这里把文件驱动补齐成同一做法。
  // Windows 上 renameSync 覆盖已存在目标没有问题（Node 用 MOVEFILE_REPLACE_EXISTING）。
  const writeFileAtomic = (f, body) => {
    const tmp = f + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, f);
  };
  const writeEnv = (f, v, ttlSec) => {
    const body = JSON.stringify({ v: String(v), e: ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0 });
    try {
      writeFileAtomic(f, body);
    } catch (e) {
      // 目录可能被清掉（平台重置磁盘 / 手工清理）——自愈一次
      if (isMissing(e)) { ensure(); writeFileAtomic(f, body); return; }
      throw e;
    }
  };
  return {
    kind: 'file',
    durable: false, // 是否真持久由调用方结合"是不是托管平台"判断
    async get(key) { return readEnv(fileOf(key)); },
    async set(key, val, ttlSec) { writeEnv(fileOf(key), val, ttlSec); },
    async setNx(key, val, ttlSec) {
      const f = fileOf(key);
      if (readEnv(f) !== null) return false; // 已存在（且未过期）
      writeEnv(f, val, ttlSec);
      return true;
    },
    async del(key) { try { fs.unlinkSync(fileOf(key)); } catch { /* 不存在即成功 */ } },
    async incrBy(key, n) {
      const f = fileOf(key);
      const cur = Number(readEnv(f));
      const next = (Number.isFinite(cur) ? cur : 0) + Number(n);
      // 注意：这里不传 ttl，保留原有信封的过期时间需要单独读一次
      let exp = 0;
      try { exp = JSON.parse(fs.readFileSync(f, 'utf8')).e || 0; } catch { /* 新键 */ }
      const body = JSON.stringify({ v: String(next), e: exp });
      try { writeFileAtomic(f, body); } catch (e) { if (isMissing(e)) { ensure(); writeFileAtomic(f, body); } else throw e; }
      return next;
    },
    /** 键总数（本地就是文件个数）；顺带能给出占用字节，用于日志里的量级提示 */
    async dbSize() {
      try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length; } catch { return 0; }
    },
  };
}

/**
 * 固定的滑动窗口限流。
 * 先 SET NX 建窗口（并发下只建一次，TTL 只在这里设置），再 INCR —— 两个驱动都原子。
 * @returns {Promise<{count:number, over:boolean, failed:boolean}>}
 */
export async function rateLimit(kv, key, windowSec, max) {
  try {
    await kv.setNx(key, '0', windowSec);
    const count = await kv.incrBy(key, 1);
    return { count, over: count > max, failed: false };
  } catch (e) {
    console.error('rateLimit error:', e && e.message);
    // 限流器故障时保守拒绝（调用方据此返回 503），不能"故障即放行"
    return { count: 0, over: false, failed: true };
  }
}

/**
 * 本应用的 Redis 键前缀 —— **单一事实源**。
 *
 * 为什么必须有：这个项目的账号与云同步模块是从姊妹项目「回译本」搬过来的，
 * 两份代码里的前缀一模一样（都是 `bts:acct:` / `bts:sync:`）。也就是说，
 * 两个应用**共用同一个 Upstash 库时会在同一个命名空间里读写**：
 *   · 同一个邮箱在 A 注册过，B 就注册不了（或直接登录进了 A 的账号）；
 *   · 账号记录里存着同步码 —— 串库之后两个应用会去读写同一份快照文档，
 *     而两边的快照结构完全不同，合并时会把对方的数据清掉。
 * 实测过键名：任务键原本就是分开的（vb:job: / bts:job:），只有账号和同步是重合的。
 *
 * 所以把命名空间收到一处、由 KV_PREFIX 决定，默认 `vb:`。
 * 想和别的应用合用同一个库，只要两边的 KV_PREFIX 不同即可（也可以留空表示不分前缀）。
 */
export function kvPrefix(env = process.env) {
  const raw = env && env.KV_PREFIX;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'vb:';
  return String(raw).trim();
}
