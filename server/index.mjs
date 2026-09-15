/**
 * 单词本 · 后端（零依赖 Node http）。
 *
 * 从「回译本」搬过来的**基础设施**（都是那边踩过坑、修好、跑过测试的）：
 *   · 接入点安全边界：服务端 Key 只发往自己配置的地址；自定义地址禁私网 + 不跟随重定向（防 SSRF）
 *   · 限流：按来源 IP 的滑动窗口（XFF 从右往左数可信跳数），桶表有界
 *   · 并发闸门：同时在跑的模型任务数上限，挡 OOM
 *   · 任务生命周期：内存 + KV 双层，重启后仍能取回结果，僵尸任务按 kind 判死
 *   · 账号与云同步：见 server/accounts.mjs、server/sync.mjs（原样复用）
 *
 * 与回译本的区别：只有两个模型能力 —— **查词**（核心）和**出题**。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as dnsLookup } from 'node:dns';

import { LOOKUP_SYSTEM_PROMPT, buildLookupMessage, QUIZ_PROMPT, buildQuizMessage, LEVEL_KEYS, DEFAULT_LEVEL, normalizeLevel } from './prompt.mjs';
import { sanitizeEntry, sanitizeQuiz, attachDict } from './resultShape.mjs';
import { lookupDict, dictConflicts, resolveProvider, dictStats, normalizeWord } from './dict.mjs';
import { createUpstashKv, createFileKv } from './kv.mjs';
import { resolveClientIp, trustProxyHops, trustCloudflareHeader } from './client-ip.mjs';
import { createAccounts } from './accounts.mjs';
import { sendMail } from './mailer.mjs';
import { MAX_SNAPSHOT_BYTES, createSyncStore, isValidSyncCode, newSyncCode, emptySnapshot, sanitizeSnapshot } from './sync.mjs';
import { staleMsFor } from './job-stale.mjs';
import { createBudget, budgetMessage } from './budget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ---------- .env ---------- */
function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 8790);
const HOSTED = Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
const dataDir = process.env.DATA_DIR || path.join(ROOT, 'data');
const kv = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? createUpstashKv({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : createFileKv(dataDir);
const kvDurable = kv.kind !== 'file';
const syncStore = createSyncStore(dataDir);
const syncDurable = syncStore.kind !== 'file';

/* ---------- API Key 归一化 ----------
 * 实测踩过：在部署平台粘贴 Key 时把界面上的"必填"标记一起带了进去（值成了 `sk-… 必`），
 * 表现不是"认证失败"，而是 fetch 直接抛 ByteString 错误，且 hasKey 仍显示 true。
 * Key 只可能是可打印 ASCII —— 非 ASCII 与空白一律去掉，改动过就告警一次（不静默）。 */
function normalizeApiKey(raw) {
  const s = String(raw == null ? '' : raw);
  const cleaned = s.replace(/[^\x21-\x7E]/g, '');
  return { key: cleaned, dirty: Boolean(s) && cleaned !== s };
}
const warnedKeys = new Set();
const warnDirty = (name) => {
  if (warnedKeys.has(name)) return;
  warnedKeys.add(name);
  console.warn('⚠️  ' + name + ' 里混进了非 ASCII 字符或空白（常见于粘贴时带上了平台界面的提示文字），已自动清理后使用，请到部署平台核对该项。');
};
const envKey = () => { const { key, dirty } = normalizeApiKey(process.env.AI_API_KEY); if (dirty) warnDirty('AI_API_KEY'); return key; };

const stat = {
  baseUrl: () => String(process.env.AI_BASE_URL || 'https://api.deepseek.com/v1').trim(),
  model: () => process.env.AI_MODEL || 'deepseek-chat',
  visionBaseUrl: () => String(process.env.AI_VISION_BASE_URL || process.env.AI_BASE_URL || 'https://api.deepseek.com/v1').trim(),
  visionModel: () => process.env.AI_VISION_MODEL || '',
  hasKey: () => Boolean(envKey()),
};

/* ---------- 接入点安全边界（照搬回译本：那里被 PoC 打过）----------
 * 1) 服务端 Key 只允许发往服务端自己配置的 baseUrl；
 * 2) 客户端要用自定义接口必须自带 Key；
 * 3) 自定义地址禁私网/环回/链路本地（含 IPv4 映射的 IPv6），并**解析域名**后再判一次。 */
const ALLOW_SERVER_KEY = process.env.ALLOW_SERVER_KEY !== '0';
const ALLOW_PRIVATE_BASE = process.env.ALLOW_PRIVATE_BASE_URL === '1';
const sameEndpoint = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
const looksLikeIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

function isPrivateIp4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}
function isPrivateIp6(ip) {
  if (ip === '::' || ip === '::1') return true;
  if (/^f[cd]/.test(ip)) return true;
  if (/^fe[89ab]/.test(ip)) return true;
  if (ip.startsWith('ff')) return true;
  return false;
}
function isPrivateIp(raw) {
  const ip = String(raw || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!ip) return true;
  const mapped = ip.match(/^::(?:ffff:)?(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    if (mapped[1]) return isPrivateIp4(mapped[1]);
    const hi = parseInt(mapped[2], 16);
    const lo = parseInt(mapped[3], 16);
    return isPrivateIp4([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.'));
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return isPrivateIp4(ip);
  if (ip.includes(':')) return isPrivateIp6(ip);
  return true;
}
const isPrivateName = (host) => {
  const h = String(host || '').toLowerCase();
  return !h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
};
async function isSafeBaseUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (ALLOW_PRIVATE_BASE) return true;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isPrivateName(host)) return false;
  if (looksLikeIp(host)) return !isPrivateIp(host);
  try {
    const addrs = await dnsLookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch { return false; }
}
async function resolveEndpoint({ bodyBase, bodyKey, fallbackBase, fallbackKey }) {
  const base = String(bodyBase || '').trim();
  const key = normalizeApiKey(bodyKey).key;
  // visitorKey = 这次用的是**访客自己带来的 Key**（而不是服务端那份）。
  // 每日额度只算服务端 Key 的请求：别人花自己的钱，没理由被我们的预算卡住。
  if (!base || sameEndpoint(base, fallbackBase)) {
    const visitorKey = Boolean(key);
    return { baseUrl: fallbackBase, apiKey: key || (ALLOW_SERVER_KEY ? fallbackKey : ''), visitorKey };
  }
  if (!(await isSafeBaseUrl(base))) {
    return { error: '该 Base URL 不被允许（只接受公网可解析的 http/https 地址）。如需指向内网地址，请改在服务端 .env 里配置 AI_BASE_URL，或设 ALLOW_PRIVATE_BASE_URL=1' };
  }
  if (!key) return { error: '使用自定义 Base URL 时，必须同时填写该接口的 API Key（服务端密钥不会发往自定义地址）' };
  return { baseUrl: base.replace(/\/+$/, ''), apiKey: key, visitorKey: true };
}

/* ---------- 限流（内存滑动窗口，按来源 IP；桶表有界）----------
 * ⚠️ X-Forwarded-For 是客户端可自写的：只信代理**追加在右端**的那部分，
 * 从右往左数自己信任的跳数（取最左值 = 限流形同虚设）。 */
const TRUST_PROXY_HOPS = trustProxyHops(process.env, HOSTED);
const TRUST_CF_IP = trustCloudflareHeader(process.env);
const clientIp = (req) => resolveClientIp({
  headers: req.headers || {},
  socketIp: req.socket?.remoteAddress || '',
  hops: TRUST_PROXY_HOPS,
  trustCf: TRUST_CF_IP,
});
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map();
const posInt = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && String(raw ?? '').trim() !== '' ? Math.floor(n) : fallback;
};
const RATE_BUCKET_MAX = Math.max(1, posInt(process.env.RATE_BUCKET_MAX, 20000));

/* 词典事实层：配了就用（有官方 key 优先官方），显式 off 就纯 AI。见 server/dict.mjs 顶部说明。 */
const DICT_PROVIDER = resolveProvider(process.env);

/* 每日任务总量上限（0 = 不限）。见下方 dailyBudgetExceeded 的说明。 */
const DAILY_JOB_LIMIT = Math.max(0, posInt(process.env.DAILY_JOB_LIMIT, 0));

function sweepRateBuckets(now) {
  for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
  if (rateBuckets.size > RATE_BUCKET_MAX) {
    let over = rateBuckets.size - RATE_BUCKET_MAX;
    for (const k of rateBuckets.keys()) { if (over-- <= 0) break; rateBuckets.delete(k); }
  }
}
setInterval(() => sweepRateBuckets(Date.now()), 60_000).unref();

/* 每日预算闸门（实现在 server/budget.mjs，那里有完整的设计说明与测试） */
const budget = createBudget({ kv, limit: DAILY_JOB_LIMIT });

function rateLimited(req, bucketKey = '', max = RATE_MAX) {
  const now = Date.now();
  const ip = clientIp(req) + (bucketKey ? '|' + bucketKey : '');
  const bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    if (rateBuckets.size >= RATE_BUCKET_MAX) sweepRateBuckets(now);
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  if (rateBuckets.size >= RATE_BUCKET_MAX) sweepRateBuckets(now);
  return bucket.count > max;
}

/* ---------- 并发闸门 ----------
 * 限流（每分钟多少次）不是资源保护：它管不住"同时有多少个任务在跑"。 */
const MAX_INFLIGHT_JOBS = Math.max(1, posInt(process.env.MAX_INFLIGHT_JOBS, 4));
const MAX_QUEUED_JOBS = posInt(process.env.MAX_QUEUED_JOBS, 50);
let inflightJobs = 0;
const jobQueue = [];
async function acquireJobSlot() {
  if (inflightJobs < MAX_INFLIGHT_JOBS) { inflightJobs += 1; return true; }
  if (jobQueue.length >= MAX_QUEUED_JOBS) return false;
  await new Promise((resolve) => jobQueue.push(resolve));
  return true;
}
function releaseJobSlot() {
  const next = jobQueue.shift();
  if (next) next();
  else inflightJobs -= 1;
}

/* ---------- 任务生命周期 ---------- */
const JOB_PREFIX = 'vb:job:';
const JOB_TTL_DAYS = Number(process.env.JOB_TTL_DAYS || 30);
const JOB_TTL_SEC = Math.max(60, Math.round(JOB_TTL_DAYS * 86400));
const JOB_MAX_COUNT = Number(process.env.JOB_MAX_COUNT || 2000);
const jobs = new Map();
const jobRenewedAt = new Map();
const JOB_RENEW_MS = 24 * 60 * 60 * 1000;
function scheduleForget(jobId) {
  const t = setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
  if (t.unref) t.unref();
}
function saveJob(job) {
  jobs.set(job.jobId, job);
  scheduleForget(job.jobId);
  return Promise.resolve(kv.set(JOB_PREFIX + job.jobId, JSON.stringify(job), JOB_TTL_SEC)).catch(() => {});
}
function renewJobTtl(job) {
  if (!job || !job.jobId) return;
  if (jobRenewedAt.size > 5000) jobRenewedAt.clear();
  const last = jobRenewedAt.get(job.jobId) || 0;
  if (Date.now() - last < JOB_RENEW_MS) return;
  jobRenewedAt.set(job.jobId, Date.now());
  Promise.resolve(kv.set(JOB_PREFIX + job.jobId, JSON.stringify(job), JOB_TTL_SEC)).catch(() => {});
}
async function findJob(jobId) {
  const mem = jobs.get(jobId);
  if (mem) return mem;
  try {
    const raw = await kv.get(JOB_PREFIX + jobId);
    if (!raw) return null;
    const job = JSON.parse(raw);
    if (job && job.jobId) {
      jobs.set(jobId, job);
      scheduleForget(jobId);
      renewJobTtl(job);
      return guardStale(job);
    }
  } catch (e) { console.error('读取任务失败:', e.message); }
  return null;
}
function guardStale(job) {
  if (!job || (job.status !== 'running' && job.status !== 'pending')) return job;
  const ts = Number(job.updatedAt || job.createdAt || 0);
  if (ts && Date.now() - ts > staleMsFor(job.kind)) {
    job.status = 'error';
    job.error = '这次任务超时没完成（常见原因：服务端重启，或模型接口长时间无响应）。请重新提交一次。';
    job.updatedAt = Date.now();
    saveJob(job);
  }
  return job;
}
function markJobFailed(jobId, e) {
  const message = (e && e.message) || '未知错误';
  const text = e && e.userFacing ? message : '服务端任务异常：' + message + '（请重试；若反复出现请把这句话发给开发者）';
  const apply = (job) => {
    if (!job) return;
    job.status = 'error';
    job.error = text;
    job.updatedAt = Date.now();
    saveJob(job);
  };
  const mem = jobs.get(jobId);
  if (mem) { apply(mem); return undefined; }
  return Promise.resolve().then(() => findJob(jobId)).then(apply).catch(() => {});
}
function safeRun(name, jobId, fn) {
  return acquireJobSlot().then((got) => {
    if (!got) {
      const busy = new Error('服务器正忙（同时在跑的任务已达上限），请过一会儿再试 —— 这次没有调用模型，不产生费用。');
      busy.userFacing = true;
      return markJobFailed(jobId, busy);
    }
    return Promise.resolve().then(fn)
      .catch((e) => {
        console.error('[job] ' + name + ' 异常:', jobId, (e && e.stack) || e);
        return markJobFailed(jobId, e);
      })
      .finally(releaseJobSlot);
  });
}

/* ---------- 调用模型 ---------- */
async function postChat({ url, headers, body, withFormat, timeoutMs = 120000 }) {
  let r;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    r = await fetch(url, {
      method: 'POST', headers,
      signal: controller.signal,
      // 不跟随重定向：跟随等于把"已验证是公网"的目标换成响应头里指定的任意地址
      redirect: 'manual',
      body: JSON.stringify(withFormat ? Object.assign({}, body, { response_format: { type: 'json_object' } }) : body),
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('模型接口请求超时（' + Math.round(timeoutMs / 1000) + '秒），请稍后重试');
    throw new Error('无法连接模型接口: ' + e.message);
  } finally {
    clearTimeout(timer);
  }
  if (r.status >= 300 && r.status < 400) {
    const loc = r.headers.get('location') || '(响应里没有 Location)';
    throw new Error('模型接口返回了重定向（' + r.status + ' → ' + loc + '）。出于安全考虑不自动跟随，请把 Base URL 直接写成最终地址。');
  }
  return r;
}
function parseJsonLoose(text) {
  const t = String(text || '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : t;
  try { return JSON.parse(body); } catch { /* 继续 */ }
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
  throw new Error('模型返回不是有效 JSON，请重试或换模型');
}
async function callLLM({ baseUrl, model, apiKey, system, user, maxTokens }) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const r = await postChat({
    url, headers, withFormat: true,
    body: {
      model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.4, max_tokens: Number(maxTokens || process.env.AI_MAX_TOKENS || 8000),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error('模型接口错误 ' + r.status + ': ' + text.slice(0, 500));
  const data = JSON.parse(text);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('模型没有返回内容，请重试');
  return content;
}

/* ---------- 查词任务（本产品的核心） ---------- */
/**
 * 把词典事实并进 AI 词条，并在**客观事实上以词典为准**。
 *
 * 只动两处，其余讲解内容保持模型输出：
 *  · 音标：模型给的和词典里任何一个读音都对不上（或压根没给）→ 直接换成词典的。
 *    这是最值得自动纠正的一项：object 这种"名词/动词重音不同"的词，模型错得很有代表性。
 *  · 词性：模型漏掉的词性只**记下来**（不擅自往 meanings 里塞），卡片上提示用户"词典还标了 v."，
 *    因为凭空补一条释义比不补更糟。
 */
function applyDict(entry, dictResult) {
  if (!entry || !dictResult || !dictResult.ok) return entry;
  const facts = dictResult.facts;
  const conflicts = dictConflicts(entry, facts);
  const corrected = { ...entry };
  const dictPhone = facts.perPosPhonetics?.length
    ? [...new Set(facts.perPosPhonetics.map((x) => x.phone))].join('; ')
    : (facts.phonetics?.uk || facts.phonetics?.us || '');
  if (dictPhone && (conflicts.phonetics.length || !entry.phonetic)) {
    corrected.phonetic = dictPhone;
    if (conflicts.phonetics.length) corrected.phoneticFixed = true;
  }
  return attachDict(corrected, facts, conflicts);
}

async function runLookupJob(jobId, { term, kindHint, level, context, baseUrl, model, apiKey }) {
  const job = await findJob(jobId);
  if (!job) return;
  job.status = 'running';
  job.updatedAt = Date.now();
  saveJob(job);
  // 先取词典事实：它是**客观事实的来源**（音标/词性/考试大纲标注），
  // 也是这次讲解"接地"的依据。取不到就静默降级为纯 AI —— 词典是加分项，不该拖垮查词。
  const dictResult = await lookupDict(term, { provider: DICT_PROVIDER, env: process.env });
  const raw = await callLLM({
    baseUrl, model, apiKey,
    system: LOOKUP_SYSTEM_PROMPT,
    user: buildLookupMessage({ term, kindHint, level, context, facts: dictResult.ok ? dictResult.facts : null }),
    maxTokens: 8000,
  });
  const parsed = parseJsonLoose(raw);
  // 词条必须有**稳定 id**：客户端靠它合并/去重/记删除墓碑，云同步也认它。
  // 模型不会给（也不该让它给），所以服务端补一个。
  const entry = sanitizeEntry({
    ...parsed,
    id: parsed.id || 'wb-' + randomBytes(8).toString('hex'),
    head: parsed.head || term,
    level,
    createdAt: Date.now(),
  });
  if (!entry) throw new Error('模型返回的词条不完整（缺少释义），请重试');
  job.data = { entry: applyDict(entry, dictResult) };
  job.status = 'done';
  job.updatedAt = Date.now();
  saveJob(job);
}

async function runQuizJob(jobId, { points, count, level, baseUrl, model, apiKey }) {
  const job = await findJob(jobId);
  if (!job) return;
  job.status = 'running';
  job.updatedAt = Date.now();
  saveJob(job);
  const raw = await callLLM({
    baseUrl, model, apiKey,
    system: QUIZ_PROMPT,
    user: buildQuizMessage({ points, count, level }),
    maxTokens: 8000,
  });
  job.data = sanitizeQuiz(parseJsonLoose(raw));
  job.status = 'done';
  job.updatedAt = Date.now();
  saveJob(job);
}

/* ================= HTTP 层 ================= */
const DIST = path.join(ROOT, 'dist');
const MAX_BODY_BYTES = 2 * 1024 * 1024;   // 这个产品只传文本，2MB 足够

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}
function json(res, code, obj) {
  const body = JSON.stringify(obj ?? {});
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
/** 读请求体；超限时先把剩余数据排空再回 413，避免连接状态错乱 */
async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const c of req) {
    if (tooLarge) continue;
    size += c.length;
    if (size > maxBytes) { tooLarge = true; chunks.length = 0; continue; }
    chunks.push(c);
  }
  if (tooLarge) throw new HttpError(413, '请求体过大（上限 ' + Math.round(maxBytes / 1024) + 'KB）');
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 格式不正确');
  }
}

/* 跨域白名单：默认不发任何 CORS 头（只服务同源页面）。前后端分开部署时用 ALLOW_ORIGIN 显式放行。
   漏配的后果很隐蔽：浏览器会拦掉响应读取但**不报错**，页面看着正常、数据却全是空的。 */
const ALLOWED_ORIGINS = String(process.env.ALLOW_ORIGIN || '')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

/** 静态文件：先找真实文件，找不到就回 index.html（SPA） */
function insideDist(file) {
  const rel = path.relative(DIST, file);
  // ⚠️ rel === '' 表示"就是 dist 目录本身"（请求 `/` 时）—— 那是合法的，必须放行。
  // 第一版把它当成越界，结果**首页直接 403**（浏览器只看到一句 JSON 错误），
  // 用户看到的就是"index.html 打不开"。越界只可能是 `..` 开头或绝对路径。
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function serveStatic(res, pathname) {
  // 畸形转义（`/a%zz`、裸 `%`）会让 decodeURIComponent 抛 URIError —— 那是客户端写错了 URL，
  // 不该记成服务器 500（会把日志刷满并掩盖真实故障）。
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { return json(res, 400, { error: 'bad request path' }); }
  let file = path.normalize(path.join(DIST, decoded));
  if (!insideDist(file)) return json(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA 回落只对"看起来像页面路径"的请求生效。带扩展名的路径（`/.env`、`/x.json`）
    // 是**静态资源**请求，回落成 index.html 会给出一个 200 —— 扫描器看到 200 会以为命中，
    // 排查问题时也容易被这个假 200 带偏。本项目没有前端路由，不会因此丢链接。
    // ⚠️ `path.extname('/.env')` 是**空串** —— dotfile 在 Node 眼里"没有扩展名"，
    // 只看 extname 会漏掉 `.env` 这类最该拦住的探测请求。所以基名以点开头也算资源请求。
    const base = path.basename(decoded);
    if (path.extname(decoded) || base.startsWith('.')) return json(res, 404, { error: 'not found' });
    file = path.join(DIST, 'index.html');
    if (!fs.existsSync(file)) return json(res, 404, { error: '前端未构建：请先 npm run build' });
  }
  const ext = path.extname(file).toLowerCase();
  const type = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
  }[ext] || 'application/octet-stream';
  // 带哈希的产物可以长缓存；index.html 一律不缓存（否则发版后用户拿不到新的）
  const immutable = /-[A-Za-z0-9_]{8,}\.(js|css)$/.test(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  const stream = fs.createReadStream(file);
  // 读流出错（部署中途文件被替换 / fd 耗尽）必须结束响应，否则客户端会一直挂到超时
  stream.on('error', () => { if (!res.headersSent) json(res, 404, { error: 'not found' }); else res.destroy(); });
  stream.pipe(res);
}

/* ---------- 音标兜底查询（模型没给音标时用；带缓存 + 熔断） ---------- */
const phoneticCache = new Map();
let phoneticDown = false;
async function lookupPhonetic(word) {
  const key = String(word || '').trim().toLowerCase();
  if (!key || phoneticDown) return '';
  if (phoneticCache.has(key)) return phoneticCache.get(key);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const r = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(key), { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error('not found');
    const data = await r.json();
    const phonetic = data?.[0]?.phonetic || data?.[0]?.phonetics?.find((x) => x.text)?.text || '';
    if (phoneticCache.size > 5000) phoneticCache.clear();
    phoneticCache.set(key, phonetic);
    return phonetic;
  } catch {
    phoneticDown = true;   // 词典接口不可达（如国内网络）：直接放弃，别让每个请求都等超时
    const t = setTimeout(() => { phoneticDown = false; }, 10 * 60 * 1000);
    if (t.unref) t.unref();
    return '';
  }
}

/* ---------- 前端错误上报（隐私：只收错误本身，不收用户内容） ---------- */
const CLIENT_ERRORS_MAX = 200;
const clientErrors = [];
function recordClientError(entry) {
  clientErrors.push(entry);
  if (clientErrors.length > CLIENT_ERRORS_MAX) clientErrors.splice(0, clientErrors.length - CLIENT_ERRORS_MAX);
  console.error('[client-error]', entry.kind, '|', entry.path, '|', entry.message.slice(0, 200));
}

const accountsOn = kvDurable;
const accounts = accountsOn ? createAccounts({ kv, mail: sendMail }) : null;

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    /* ---------- 前端错误上报（独立限流桶，别和查词抢配额） ---------- */
    if (p === '/api/report' && req.method === 'POST') {
      if (rateLimited(req, 'report', 60)) return json(res, 429, { error: 'too many reports' });
      const body = await readBody(req, 16 * 1024);
      const message = String(body.message || '').slice(0, 2000).trim();
      if (!message) return json(res, 400, { error: 'missing message' });
      recordClientError({
        kind: String(body.kind || 'unknown').slice(0, 20),
        message,
        stack: String(body.stack || '').slice(0, 4000),
        path: String(body.path || '').slice(0, 200),
        at: Date.now(),
      });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/health') return json(res, 200, { ok: true });

    if (p === '/api/status') {
      return json(res, 200, {
        app: 'vocabulary-book',
        baseUrl: stat.baseUrl(), model: stat.model(), hasKey: stat.hasKey(),
        levels: LEVEL_KEYS, defaultLevel: DEFAULT_LEVEL,
        sync: { store: syncStore.kind, durable: syncDurable, hosted: HOSTED },
        accounts: { enabled: accountsOn, durable: kvDurable },
        jobs: { store: kv.kind, durable: kvDurable, ttlDays: JOB_TTL_DAYS, max: JOB_MAX_COUNT, retained: jobs.size },
        rateLimit: { perMin: RATE_MAX, trustProxyHops: TRUST_PROXY_HOPS, trustCfIp: TRUST_CF_IP, buckets: rateBuckets.size, bucketMax: RATE_BUCKET_MAX },
        budget: { dailyLimit: DAILY_JOB_LIMIT, usedToday: await budget.used() },
        concurrency: { maxInflight: MAX_INFLIGHT_JOBS, maxQueued: MAX_QUEUED_JOBS },
        mail: { configured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) },
        dict: { provider: DICT_PROVIDER, ...dictStats() },
      });
    }

    /* ---------- 词典核对（单独可查：排查"讲解对不对"时不用整条重跑） ---------- */
    if (p === '/api/dict') {
      const word = normalizeWord(url.searchParams.get('word') || '');
      if (!word) return json(res, 400, { error: '缺少 word 参数' });
      if (DICT_PROVIDER === 'off') {
        return json(res, 200, { ok: true, enabled: false, reason: '词典核对未启用（DICT_PROVIDER=off）' });
      }
      if (rateLimited(req)) return json(res, 429, { error: '请求过于频繁，请稍后再试' });
      const r = await lookupDict(word, { provider: DICT_PROVIDER, env: process.env });
      return json(res, 200, r.ok
        ? { ok: true, enabled: true, provider: DICT_PROVIDER, facts: r.facts }
        : { ok: true, enabled: true, provider: DICT_PROVIDER, found: false, reason: r.reason });
    }

    /* ---------- 音标兜底 ---------- */
    if (p === '/api/phonetic') {
      if (rateLimited(req, 'phonetic', 120)) return json(res, 429, { error: 'too many requests' });
      const word = String(url.searchParams.get('word') || '').trim().slice(0, 60);
      if (!/^[a-z][a-z'’-]*$/i.test(word)) return json(res, 400, { error: 'invalid word' });
      return json(res, 200, { ok: true, word, phonetic: await lookupPhonetic(word) });
    }

    /* ---------- 查词（核心）：提交 → 轮询 ---------- */
    if (p === '/api/lookup' && req.method === 'POST') {
      if (rateLimited(req)) return json(res, 429, { error: '查询过于频繁，请稍后再试' });
      const body = await readBody(req, 64 * 1024);
      const term = String(body.term || '').trim().slice(0, 200);
      if (!term) return json(res, 400, { error: '请先输入要查的单词或短语' });
      const ep = await resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (ep.error) return json(res, 400, { error: ep.error });
      if (!ep.apiKey) return json(res, 400, { error: '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key' });
      // 只有**用服务端 Key**的请求才占每日额度：访客自带 Key 花的是他自己的钱，不该被卡
      // 只有**用服务端 Key** 的请求才占每日额度：访客自带 Key 花的是他自己的钱，不该被卡
      if (!ep.visitorKey) {
        const b = await budget.spend();
        if (!b.ok) return json(res, 429, { error: budgetMessage(b.used, b.limit) });
      }

      const jobId = randomUUID();
      saveJob({ jobId, kind: 'lookup', title: term, status: 'pending', createdAt: Date.now(), data: null, error: null });
      safeRun('lookup', jobId, () => runLookupJob(jobId, {
        term,
        kindHint: String(body.kindHint || '').slice(0, 20),
        context: String(body.context || '').slice(0, 600),
        level: normalizeLevel(body.level),
        baseUrl: ep.baseUrl,
        model: String(body.model || '').trim() || stat.model(),
        apiKey: ep.apiKey,
      }));
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }

    /* ---------- 出题 ---------- */
    if (p === '/api/quiz' && req.method === 'POST') {
      if (rateLimited(req)) return json(res, 429, { error: '请求过于频繁，请稍后再试' });
      const body = await readBody(req, 256 * 1024);
      const epQuiz = await resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (!epQuiz.error && !epQuiz.visitorKey) {
        const b = await budget.spend();
        if (!b.ok) return json(res, 429, { error: budgetMessage(b.used, b.limit) });
      }
      const points = (Array.isArray(body.points) ? body.points : [])
        .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 60);
      if (!points.length) return json(res, 400, { error: '请先选择要出题的词条' });
      const count = Math.max(1, Math.min(50, Number(body.count) || 10));
      const ep = await resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (ep.error) return json(res, 400, { error: ep.error });
      if (!ep.apiKey) return json(res, 400, { error: '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key' });

      const jobId = randomUUID();
      saveJob({ jobId, kind: 'quiz', title: '自测题 · ' + count + ' 题', status: 'pending', createdAt: Date.now(), data: null, error: null });
      safeRun('quiz', jobId, () => runQuizJob(jobId, {
        points, count, level: normalizeLevel(body.level),
        baseUrl: ep.baseUrl, model: String(body.model || '').trim() || stat.model(), apiKey: ep.apiKey,
      }));
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }

    const jobMatch = p.match(/^\/api\/(lookup|quiz)\/([A-Za-z0-9-]{8,64})$/);
    if (jobMatch && req.method === 'GET') {
      const job = await findJob(jobMatch[2]);
      if (!job || job.kind !== jobMatch[1]) return json(res, 404, { error: '任务不存在或已过期，请重新发起' });
      return json(res, 200, { ok: true, job: { jobId: job.jobId, status: job.status, data: job.data || null, error: job.error || null } });
    }

    /* ---------- 云同步 ---------- */
    if (p === '/api/sync/info') {
      return json(res, 200, { ok: true, store: syncStore.kind, durable: syncDurable, hosted: HOSTED });
    }
    if (p === '/api/sync/new' && req.method === 'POST') {
      if (rateLimited(req)) return json(res, 429, { error: '请求过于频繁，请稍后再试' });
      const code = newSyncCode();
      await syncStore.write(code, { version: 1, updatedAt: Date.now(), device: '', data: emptySnapshot() });
      return json(res, 200, { ok: true, code, version: 1 });
    }
    const syncMatch = p.match(/^\/api\/sync\/(.+)$/);
    if (syncMatch) {
      const code = String(syncMatch[1] || '').toLowerCase();
      if (!isValidSyncCode(code)) return json(res, 400, { error: '同步码格式不正确（应为 32 位十六进制）' });
      if (req.method === 'GET') {
        const doc = await syncStore.read(code);
        if (!doc) return json(res, 404, { error: '同步码不存在，请检查是否输错' });
        return json(res, 200, { ok: true, version: doc.version, updatedAt: doc.updatedAt, data: doc.data });
      }
      if (req.method === 'POST') {
        if (rateLimited(req)) return json(res, 429, { error: '同步过于频繁，请稍后再试' });
        const body = await readBody(req, MAX_SNAPSHOT_BYTES + 256 * 1024);
        const check = sanitizeSnapshot(body.data);
        if (!check.ok) return json(res, 413, { error: check.error });
        // baseVersion 必须是 ≥0 的整数：负数会让 CAS 的版本校验被跳过（回译本上发现过这个洞）
        const baseVersion = Number(body.baseVersion);
        if (!Number.isInteger(baseVersion) || baseVersion < 0) {
          return json(res, 400, { error: 'baseVersion 必须是 ≥0 的整数' });
        }
        const next = {
          version: baseVersion + 1,
          updatedAt: Date.now(),
          device: String(body.device || '').slice(0, 40),
          data: check.data,
        };
        const r = await syncStore.compareAndSwap(code, baseVersion, next);
        if (r.ok) return json(res, 200, { ok: true, version: next.version });
        // 版本对不上：把云端最新那份一起回给客户端，它才好重新合并再推
        const cur = await syncStore.read(code);
        return json(res, 409, { error: '云端数据已被其它设备更新', version: cur?.version ?? 0, data: cur?.data ?? emptySnapshot() });
      }
    }

    /* ---------- 账号（与回译本同一套实现） ---------- */
    if (p === '/api/auth/config') {
      return json(res, 200, { ok: true, enabled: accountsOn, store: kv.kind, durable: kvDurable });
    }
    if (p.startsWith('/api/auth/')) {
      if (!accounts) {
        return json(res, 503, {
          error: '账号功能未启用：服务端没有配置持久存储。托管平台的磁盘是临时的，在那里开账号会导致重新部署后账号全丢，'
            + '所以默认关闭。配置 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 后自动开启。',
        });
      }
      const action = p.slice('/api/auth/'.length);
      if (req.method !== 'POST' && req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const ip = clientIp(req);
      const body = req.method === 'POST' ? await readBody(req, 64 * 1024) : {};
      const handlers = {
        register: () => accounts.register({ ...body, ip }),
        login: () => accounts.login({ ...body, ip, device: body.device }),
        logout: () => accounts.logout(token),
        'logout-all': () => accounts.logoutAll(token),
        me: () => accounts.me(token),
        sync: () => accounts.setSync(token, body.sync),
        'change-password': () => accounts.changePassword(token, body),
        'delete-account': () => accounts.deleteAccount(token, body),
        forgot: () => accounts.forgot({ email: body.email, ip }),
        'reset-password': () => accounts.resetPassword({ ...body, ip }),
      }[action];
      if (!handlers) return json(res, 404, { error: 'unknown auth api' });
      const r = await handlers();
      if (!r.ok) return json(res, r.status || 400, { error: r.error });
      const { status, ...rest } = r;
      return json(res, status || 200, { ok: true, ...rest });
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'unknown api' });
    return serveStatic(res, p);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error('[500]', req.method, p, (e && e.stack) || e);
    return json(res, status, { error: status >= 500 ? '服务器内部错误' : (e.message || '请求有误') });
  }
});

/* 端口被占用这类错误必须让进程退出：否则会留一个"既不服务也不退出"的僵尸进程，
   平台健康检查失败后表现为"莫名重启"，排查时完全看不出原因。 */
server.on('error', (e) => {
  console.error('服务启动失败:', e.message);
  process.exit(1);
});
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', (e && e.stack) || e);
  if (e && ['EADDRINUSE', 'ENOMEM'].includes(e.code)) process.exit(1);
});
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', (e && e.stack) || e));

server.listen(PORT, () => {
  console.log('单词本后端已启动: http://localhost:' + PORT);
  console.log('模型: ' + stat.model() + ' @ ' + stat.baseUrl() + '  key: ' + (stat.hasKey() ? '已配置' : '未配置'));
  console.log('云同步存储: ' + syncStore.kind + (syncDurable ? '（持久）' : '（容器本地磁盘，重新部署会丢）'));
  console.log('账号功能: ' + (accountsOn ? '已启用' : '未启用（需配置 UPSTASH）') + '（存储 ' + kv.kind + '）');
  console.log('限流: ' + RATE_MAX + ' 次/分钟 · 可信代理 ' + TRUST_PROXY_HOPS + ' 跳'
    + (TRUST_CF_IP ? ' · 信任 CF-Connecting-IP' : ''));
  console.log('并发闸门: 同时 ' + MAX_INFLIGHT_JOBS + ' 个任务 · 排队上限 ' + MAX_QUEUED_JOBS);
  console.log('每日额度: ' + (DAILY_JOB_LIMIT ? DAILY_JOB_LIMIT + ' 次（仅算用服务端 Key 的请求）' : '不限（DAILY_JOB_LIMIT=0）'));
  console.log('词典核对: ' + (DICT_PROVIDER === 'off'
    ? '未启用（DICT_PROVIDER=off，讲解完全由模型生成）'
    : DICT_PROVIDER + (DICT_PROVIDER === 'youdao-web' ? '（免费网页接口，非官方，可能失效）' : '（官方开放平台）')));
});
