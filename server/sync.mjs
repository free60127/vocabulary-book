/**
 * 云同步的存储层：**CAS（比较并写入）** + 快照形状校验。
 *
 * 从「回译本」原样搬过来的基础设施 —— 这套东西踩过的坑都在注释里，重写一遍只会再踩一次：
 *   · HTTP 层的"先读版本 → 比较 → 再写"不是原子的，两台设备同时提交会互相覆盖（用 Lua EVAL 解决）；
 *   · EVAL 不可用（Upstash 免费档）时退回短锁，并如实上报，不假装原子；
 *   · 快照只保留认识的字段 —— 客户端传什么都不能直接落库。
 *
 * 与回译本的唯一区别是**快照形状**：那边是 课文库/收藏/历史，这里是 单词本/词条/查询历史。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sanitizeEntry } from './resultShape.mjs';
import { kvPrefix } from './kv.mjs';

const CODE_RE = /^[a-f0-9]{32}$/;
/** 单份快照上限（纯文本数据，正常远小于这个数） */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/**
 * 快照的结构限额。
 * 只卡总字节数是不够的：2MB 里可以塞进几万个极小元素，解析、合并和前端渲染都会被拖垮。
 * 所以条数与单条体积都要卡。限额都远高于真实用量，正常用户碰不到。
 */
export const SNAPSHOT_LIMITS = Object.freeze({
  books: 100,               // 单词本数量
  entriesPerBook: 5000,     // 每个本子的词条上限
  history: 60,              // 最近查询记录（每条带一份词条快照，所以条数收紧）
  deletedBooks: 200,        // 已删除的单词本 id（墓碑）
  deletedEntries: 5000,     // 已删除的词条（bookId|entryId）
  days: 400,                // 学习日期（连续天数）：YYYY-MM-DD 去重列表
  review: 5000,             // 复习排期表：entryId → {ease,interval,due,reps,lapses}
  bookIdChars: 64,
  bookNameChars: 80,
  entryIdChars: 64,         // 词条稳定 id（客户端生成，形如 wb-xxxx）
  headChars: 200,           // 词条本身（单词/短语/句型）
  fieldChars: 8000,         // 单个文本字段上限（释义、讲解、助记…）
  examplesPerEntry: 20,
  synonymsPerEntry: 20,
  entryBytes: 40000,        // 单条词条的 JSON 体积
  historyBytes: 16000,      // 单条历史的上限：放不下快照就只存摘要
});

export const newSyncCode = () => randomBytes(16).toString('hex');
export const isValidSyncCode = (code) => CODE_RE.test(String(code || ''));

export const emptySnapshot = () => ({
  books: [], history: [], deletedBooks: [], deletedEntries: [], days: [], review: {},
});

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const jsonBytes = (v) => {
  try { return JSON.stringify(v).length; } catch { return Infinity; }
};
const boundedString = (v, max) => String(v == null ? '' : v).slice(0, max);

/**
 * 校验并重建同步快照：只保留认识的字段、卡条数与单条体积。
 * 超限时**明确拒绝**而不是悄悄截断 —— 静默丢用户数据比报错更糟。
 * @returns {{ok: true, data: object} | {ok: false, error: string}}
 */
export function sanitizeSnapshot(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: '同步数据必须是一个 JSON 对象' };
  const L = SNAPSHOT_LIMITS;

  /* ---------- 数组字段的形状与条数 ---------- */
  for (const [key, max] of [
    ['books', L.books], ['history', L.history],
    ['deletedBooks', L.deletedBooks], ['deletedEntries', L.deletedEntries], ['days', L.days],
  ]) {
    const v = raw[key];
    if (v !== undefined && !Array.isArray(v)) return { ok: false, error: `${key} 必须是数组` };
    if (Array.isArray(v) && v.length > max) {
      return { ok: false, error: `${key} 条目过多（上限 ${max}，收到 ${v.length}）` };
    }
  }

  /* ---------- 词条：形状校验交给 resultShape.mjs（与查词任务共用同一份规则）----------
   * 两边各写一份必然会漂移，所以只在那里定义一次。 */
  const books = [];
  for (const b of Array.isArray(raw.books) ? raw.books : []) {
    if (!isPlainObject(b)) continue;
    const id = boundedString(b.id, L.bookIdChars + 1);
    if (!id || id.length > L.bookIdChars) continue;      // 没有可用 id 的本子没法合并
    const rawEntries = Array.isArray(b.entries) ? b.entries : [];
    if (rawEntries.length > L.entriesPerBook) {
      return { ok: false, error: `单词本「${boundedString(b.name, 20)}」词条过多（上限 ${L.entriesPerBook}）` };
    }
    const entries = [];
    for (const e of rawEntries) {
      const clean = sanitizeEntry(e);
      if (clean) entries.push(clean);
    }
    books.push({
      id,
      name: boundedString(b.name || '未命名单词本', L.bookNameChars),
      note: boundedString(b.note, 500),
      createdAt: Number(b.createdAt) || Date.now(),
      entries,
    });
  }
  const droppedEntries = books.reduce((n, b) => n + b.entries.length, 0);

  /* ---------- 查询历史 ----------
   * 历史里现在带一份**词条快照**（点历史直接回到那张卡片），所以它和 books 一样是
   * "外部进来的结构"：必须逐条过 sanitizeEntry。原样透传的话，一份手工构造的快照
   * 就能把任意形状塞进前端渲染路径（例如 meanings 是字符串 → .map 直接白屏）。
   * 快照不合法就**降级成只有摘要**的历史条目，而不是整条丢掉 —— 至少还能"重新查一次"。 */
  const history = (Array.isArray(raw.history) ? raw.history : [])
    .filter((h) => isPlainObject(h) && typeof h.id === 'string' && h.id)
    .map((h) => {
      const base = {
        id: boundedString(h.id, L.entryIdChars),
        head: boundedString(h.head, L.headChars),
        brief: boundedString(h.brief, 600),
        at: Number(h.at) || 0,
      };
      const entry = isPlainObject(h.entry) ? sanitizeEntry(h.entry) : null;
      const full = entry ? { ...base, entry } : base;
      return jsonBytes(full) <= L.historyBytes ? full : base;
    })
    .slice(0, L.history);

  /* ---------- 墓碑：只留字符串形状合法的去重值 ---------- */
  const collect = (arr, maxLen) => {
    const set = new Set();
    for (const id of Array.isArray(arr) ? arr : []) {
      if (typeof id !== 'string') continue;
      const v = boundedString(id, maxLen + 1);
      if (v && v.length <= maxLen) set.add(v);
    }
    return [...set];
  };
  const deletedBooks = collect(raw.deletedBooks, L.bookIdChars);
  // 词条键 = bookId + '|' + entryId，两个 id 各 ≤64，留点余量
  const deletedEntries = collect(raw.deletedEntries, L.bookIdChars * 2 + 2);

  /* ---------- 学习日期 ---------- */
  const daySet = new Set();
  for (const d of Array.isArray(raw.days) ? raw.days : []) {
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) daySet.add(d);
  }
  const days = [...daySet].sort().reverse().slice(0, L.days);

  /* ---------- 复习排期：entryId → SM-2 字段 ---------- */
  const reviewRaw = isPlainObject(raw.review) ? raw.review : {};
  const reviewEntries = Object.entries(reviewRaw);
  if (reviewEntries.length > L.review) {
    return { ok: false, error: `review 条目过多（上限 ${L.review}，收到 ${reviewEntries.length}）` };
  }
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  const review = {};
  for (const [k, v] of reviewEntries) {
    if (!k || k.length > L.entryIdChars || !isPlainObject(v)) continue;
    review[k] = {
      ease: Number.isFinite(Number(v.ease)) ? Math.min(5, Math.max(1.3, Number(v.ease))) : 2.5,
      interval: num(v.interval),
      due: num(v.due),
      reps: num(v.reps),
      lapses: num(v.lapses),
    };
  }

  const data = { books, history, deletedBooks, deletedEntries, days, review };
  if (jsonBytes(data) > MAX_SNAPSHOT_BYTES) {
    return { ok: false, error: `同步数据过大（上限 ${Math.round(MAX_SNAPSHOT_BYTES / 1024 / 1024)}MB）` };
  }
  return { ok: true, data, dropped: { entries: droppedEntries } };
}

const CAS_LUA = [
  "local raw = redis.call('GET', KEYS[1])",
  'local cur = 0',
  'if raw then',
  "  local ok, doc = pcall(cjson.decode, raw)",
  "  if ok and type(doc) == 'table' and doc['version'] then cur = tonumber(doc['version']) or 0 end",
  'end',
  'local base = tonumber(ARGV[1])',
  'if base >= 0 and cur ~= base then',
  "  return {0, raw or ''}",
  'end',
  "redis.call('SET', KEYS[1], ARGV[2])",
  'return {1, ARGV[2]}',
].join('\n');

/** Upstash Redis REST 驱动（用 JSON 数组形式发命令）。 */
export function createUpstashStore({ url, token, prefix, legacyPrefix }) {
  // 默认取本应用的 KV_PREFIX（原来是写死的 'bts:sync:' —— 和姊妹项目重合，合用同一个库会串数据）
  const NS = String(prefix === undefined ? kvPrefix() : prefix) + 'sync:';
  /**
   * 旧命名空间（改 KV_PREFIX 之前用的那个）。
   *
   * 为什么要有它：这个项目原本写死 `bts:sync:`，改成 `vb:sync:` 时**线上已经有数据了** ——
   * 只改前缀不做兼容，等于把老用户的云端数据扔在旧键上：他自己那串码在新命名空间里"不存在"，
   * 客户端又把 404 当成"空云端"照常往下走，于是**推送一份空数据上去**，
   * 表现就是"电脑有 1 个本子，手机同步过来什么都没有"，而且界面上没有任何报错。
   * 所以这里做一次性认领：新键读不到、旧键有，就把旧的那份搬到新键再返回（幂等）。
   * 只在用默认前缀时启用 —— 显式指定前缀（多应用共库）时不去翻别人的键。
   */
  const LEGACY = legacyPrefix === undefined
    ? (String(prefix === undefined ? kvPrefix() : prefix) === 'vb:' ? 'bts:sync:' : '')
    : String(legacyPrefix || '');
  let adoptedOnce = false;
  const endpoint = String(url).replace(/\/+$/, '');
  const call = async (command) => {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    const text = await r.text();
    if (!r.ok) throw new Error('Upstash 请求失败 ' + r.status + '：' + text.slice(0, 200));
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('Upstash 返回不是 JSON：' + text.slice(0, 200)); }
    if (parsed.error) throw new Error('Upstash 错误：' + parsed.error);
    return parsed.result;
  };
  // EVAL 万一在这个实例上不可用（权限/版本差异），退回带短锁的实现，
  // 并且**只告警一次** —— 静默降级成非原子写入是最糟的结果。
  let casMode = 'lua';
  let warned = false;
  const parse = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

  return {
    kind: 'upstash',
    durable: true,
    get casMode() { return casMode; },
    async read(code) {
      const mine = parse(await call(['GET', NS + code]));
      if (mine || !LEGACY) return mine;
      // 新键没有 → 看看旧键里有没有同一串码的旧数据（改前缀之前写的）
      const older = parse(await call(['GET', LEGACY + code]));
      if (!older) return null;
      if (!adoptedOnce) {
        adoptedOnce = true;
        console.warn('[sync] 在旧命名空间 ' + LEGACY + ' 里发现该同步码的历史数据，已迁移到 ' + NS + '（KV_PREFIX 变更的兼容处理）');
      }
      await call(['SET', NS + code, JSON.stringify(older)]);
      return older;
    },
    async write(code, doc) {
      await call(['SET', NS + code, JSON.stringify(doc)]);
    },
    /**
     * 原子「版本对得上才写」。
     * @returns {{ok:true} | {ok:false, current: object|null}}
     */
    async compareAndSwap(code, baseVersion, doc) {
      const key = NS + code;
      const base = Number.isFinite(Number(baseVersion)) ? Number(baseVersion) : -1;
      if (casMode === 'lua') {
        try {
          const res = await call(['EVAL', CAS_LUA, '1', key, String(base), JSON.stringify(doc)]);
          if (Array.isArray(res) && Number(res[0]) === 1) return { ok: true };
          return { ok: false, current: parse(Array.isArray(res) ? res[1] : '') };
        } catch (e) {
          casMode = 'lock';
          if (!warned) { warned = true; console.warn('⚠️  Upstash 不支持 EVAL，已退回加锁写入（原子性稍弱但仍正确）：', e.message); }
        }
      }
      // 兜底：SET NX 抢短锁 → 读改写 → 释放。锁过期时间给足一次往返，且只有拿不到锁才重试。
      const lockKey = key + ':lock';
      for (let i = 0; i < 20; i += 1) {
        const got = await call(['SET', lockKey, '1', 'NX', 'EX', '5']);
        if (got !== null) {
          try {
            const cur = parse(await call(['GET', key]));
            const curV = cur && Number.isFinite(Number(cur.version)) ? Number(cur.version) : 0;
            if (base >= 0 && curV !== base) return { ok: false, current: cur };
            await call(['SET', key, JSON.stringify(doc)]);
            return { ok: true };
          } finally {
            await call(['DEL', lockKey]).catch(() => {});
          }
        }
        await new Promise((r) => setTimeout(r, 25 + i * 10));
      }
      return { ok: false, current: parse(await call(['GET', key])) };
    },
  };
}

/** 本地文件驱动：仅用于开发/自托管；托管平台上的磁盘通常是临时的。 */
export function createFileStore(dir) {
  const ensure = () => fs.mkdirSync(dir, { recursive: true });
  ensure();
  const fileOf = (code) => path.join(dir, code + '.json');
  /**
   * 原子落盘：先写临时文件再 rename。
   * 直接 writeFileSync 覆盖时进程被杀（部署重启、OOM）会留下**半截 JSON**，
   * 那份数据就永久坏了；rename 在同一文件系统内是原子的，要么旧的要么新的。
   */
  const writeAtomic = (file, text) => {
    const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* 清不掉就算了，别盖住原始错误 */ }
      // 目录可能在运行期被清掉（平台重置磁盘 / 手工清理）——自愈一次，别直接把 500 抛给用户
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
        ensure();
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, file);
        return;
      }
      throw e;
    }
  };
  const readRaw = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

  return {
    kind: 'file',
    durable: false,
    casMode: 'sync',
    async read(code) {
      try { return JSON.parse(readRaw(fileOf(code))); } catch { return null; }
    },
    async write(code, doc) {
      writeAtomic(fileOf(code), JSON.stringify(doc));
    },
    /**
     * 原子「版本对得上才写」。
     * 方法体内**没有任何 await** —— Node 是单线程，同步读改写之间不会让出事件循环，
     * 所以同一个进程里天然原子。
     */
    async compareAndSwap(code, baseVersion, doc) {
      const file = fileOf(code);
      const raw = readRaw(file);
      let cur = null;
      try { cur = raw ? JSON.parse(raw) : null; } catch { cur = null; } // 损坏文件当"不存在"，可被重建
      const curV = cur && Number.isFinite(Number(cur.version)) ? Number(cur.version) : 0;
      const base = Number.isFinite(Number(baseVersion)) ? Number(baseVersion) : -1;
      if (base >= 0 && curV !== base) return { ok: false, current: cur };
      writeAtomic(file, JSON.stringify(doc));
      return { ok: true };
    },
  };
}

/**
 * 按环境变量选择驱动。
 * 配了 UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN 就用 Upstash，否则退回本地文件。
 * @param {string} dataDir 本地文件驱动的数据根目录（调用方传 `data/`，可用 DATA_DIR 环境变量整体搬走）
 */
export function createSyncStore(dataDir, { prefix } = {}) {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (url && token) return createUpstashStore({ url, token, prefix });
  return createFileStore(path.join(dataDir, 'sync'));
}
