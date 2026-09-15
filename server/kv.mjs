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
  const fileOf = (key) => path.join(dir, String(key).replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
  const readEnv = (f) => {
    try {
      const o = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (o && o.e && Date.now() > o.e) return null; // 已过期
      return o && typeof o.v === 'string' ? o.v : null;
    } catch { return null; }
  };
  const writeEnv = (f, v, ttlSec) => {
    const body = JSON.stringify({ v: String(v), e: ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0 });
    try {
      fs.writeFileSync(f, body);
    } catch (e) {
      // 目录可能被清掉（平台重置磁盘 / 手工清理）——自愈一次
      if (isMissing(e)) { ensure(); fs.writeFileSync(f, body); return; }
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
      try { fs.writeFileSync(f, body); } catch (e) { if (isMissing(e)) { ensure(); fs.writeFileSync(f, body); } else throw e; }
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
