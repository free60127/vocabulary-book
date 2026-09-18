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
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { buildLookupSystemPrompt, normalizeDifficulty, ZH_CANDIDATE_PROMPT, buildZhCandidateMessage, buildLookupMessage, QUIZ_PROMPT, buildQuizMessage, FOLLOWUP_SYSTEM_PROMPT, buildFollowupMessage, SENTENCE_MAKE_PROMPT, buildSentenceMakeMessage, SENTENCE_GRADE_PROMPT, buildSentenceGradeMessage, QUIZ_GRADE_PROMPT, buildQuizGradeMessage, LEVEL_KEYS, DEFAULT_LEVEL, normalizeLevel } from './prompt.mjs';
import { sanitizeQuizGrade, sanitizeEntry, sanitizeQuiz, sanitizeFollowup, sanitizeSentenceTasks, sanitizeSentenceGrade, sanitizeZhCandidates, attachDict } from './resultShape.mjs';
import { lookupDict, dictConflicts, resolveProvider, dictStats, normalizeWord } from './dict.mjs';
import { createUpstashKv, createFileKv, kvPrefix } from './kv.mjs';
import { resolveClientIp, trustProxyHops, trustCloudflareHeader, trustedProxyIps } from './client-ip.mjs';
import { createAccounts } from './accounts.mjs';
import { sendMail } from './mailer.mjs';
import { MAX_SNAPSHOT_BYTES, createSyncStore, isValidSyncCode, newSyncCode, emptySnapshot, sanitizeSnapshot } from './sync.mjs';
import { createBudget, budgetMessage } from './budget.mjs';
import { createJobStore, createJobSlots } from './jobs.mjs';
import { createLlm } from './llm.mjs';
import { createSegmentReader, finalizeStreamEntry, SEGMENT_LABEL } from './stream.mjs';
import { OCR_PROMPT, parseOcrText, ocrQuality } from './ocr.mjs';
import { auditQuizQuestions } from './quizQuality.mjs';

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
/* 本应用在 KV/Redis 里的命名空间。默认 vb: —— 与姊妹项目回译本（写死 bts:）天然分开，
   详见 kv.mjs 里 kvPrefix 的说明（账号与同步共用一个库时会串数据）。 */
const KV_PREFIX = kvPrefix(process.env);
const kv = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? createUpstashKv({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : createFileKv(dataDir);
const kvDurable = kv.kind !== 'file';
const syncStore = createSyncStore(dataDir, { prefix: KV_PREFIX });
const syncDurable = syncStore.kind !== 'file';

/* ---------- 模型调用层 ----------
 * Key 归一化 / 接入点安全边界（防 SSRF）/ 发请求 都在 server/llm.mjs；
 * 这里只持有它的实例，路由与任务照常调用。 */
const ALLOW_SERVER_KEY = process.env.ALLOW_SERVER_KEY !== '0';
const llm = createLlm({ allowServerKey: ALLOW_SERVER_KEY });
const { resolveEndpoint, parseJsonLoose, callLLM, callLLMStream, callVision, envKey } = llm;
/** 模型/地址的取值口：路由里到处在用（原来是同文件的 stat，现在转发给 llm 模块） */
const stat = llm.stat;

/* ---------- 限流（内存滑动窗口，按来源 IP；桶表有界）----------
 * ⚠️ X-Forwarded-For 是客户端可自写的：只信代理**追加在右端**的那部分，
 * 从右往左数自己信任的跳数（取最左值 = 限流形同虚设）。 */
const TRUST_PROXY_HOPS = trustProxyHops(process.env, HOSTED);
const TRUST_CF_IP = trustCloudflareHeader(process.env);
const TRUST_PROXY_IPS = trustedProxyIps(process.env);
const clientIp = (req) => resolveClientIp({
  headers: req.headers || {},
  socketIp: req.socket?.remoteAddress || '',
  hops: TRUST_PROXY_HOPS,
  trustCf: TRUST_CF_IP,
  proxyAllowlist: TRUST_PROXY_IPS,
});

/* 未配置 Key 的报错文案：localhost 上给站长看操作步骤；公网访客看到"复制 .env.example"
   既做不到也吓人（线上实测）—— 按请求来源分流。 */
const isLocalReq = (req) => {
  // 用 clientIp（含可信 XFF 解析）而不是裸 socket：nginx/VPS 同机回源时所有访客的
  // socket 都是 127.0.0.1，裸 socket 判定会把"站长没配 Key"的文案发给全部公网访客。
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};
const missingKeyMsg = (req) => isLocalReq(req)
  ? '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key'
  : '本站暂时无法查询（模型服务还没配置好），请稍后再试';

const RATE_MAX = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map();
/* SSE 并发护栏：一条流最长挂 6 分钟、每 400ms 轮一次内存 —— 无上限的话恶意客户端
   可以用一排连接把它占满（之前这块连限流都没接）。按 IP 最多 3 条 + 全局 64 条。 */
const sseStreamsByIp = new Map();
let sseStreamsTotal = 0;
const SSE_PER_IP = 5;   // 办公室/校园/CGNAT 常是几十人共享一个出口 IP，3 条不够用（超限方静默退回轮询，功能不断但体验降级）
const SSE_GLOBAL_MAX = 64;
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
const budget = createBudget({ kv, limit: DAILY_JOB_LIMIT, prefix: KV_PREFIX });

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

/* ---------- 并发闸门与任务生命周期 ----------
 * 两者都搬进了 server/jobs.mjs：那里能一眼读完"任务什么时候算死、什么时候被淘汰"。
 * 限流（每分钟多少次）管不住"同时有多少个任务在跑"，这是两件事。 */
const MAX_INFLIGHT_JOBS = Math.max(1, posInt(process.env.MAX_INFLIGHT_JOBS, 4));
const MAX_QUEUED_JOBS = posInt(process.env.MAX_QUEUED_JOBS, 50);
const jobSlots = createJobSlots({ max: MAX_INFLIGHT_JOBS, maxQueued: MAX_QUEUED_JOBS });
const store = createJobStore({
  kv,
  prefix: KV_PREFIX,
  ttlSec: Math.max(60, Math.round(Number(process.env.JOB_TTL_DAYS || 30) * 86400)),
  max: Number(process.env.JOB_MAX_COUNT || 2000),
  slots: jobSlots,
});
const { saveJob, findJob, guardStale, safeRun } = store;   // 淘汰/失败落盘仍只在 store 内部用

/* ---------- 调用模型 ---------- */
/* ---------- 自测题批改（只批主观题） ---------- */

/**
 * 批改主观题（翻译 / 改错）。
 *
 * 客观题（选择/填空）在浏览器端本地判 —— 秒出、免费、规则有单测；
 * 这里只处理"没有唯一答案"的那几种，一次请求批完整卷。
 */
async function runQuizGradeJob(jobId, { items, level, baseUrl, model, apiKey }) {
  const job = await findJob(jobId);
  if (!job) return;
  job.status = 'running';
  job.updatedAt = Date.now();
  saveJob(job);

  const raw = await callLLM({
    baseUrl, model, apiKey,
    system: QUIZ_GRADE_PROMPT,
    user: buildQuizGradeMessage({ items, level }),
    maxTokens: 3000,
  });
  const parsed = parseJsonLoose(raw);
  const data = sanitizeQuizGrade(parsed, items.length);
  job.data = data;
  job.status = 'done';
  job.updatedAt = Date.now();
  saveJob(job);
}

/* ---------- 拍照/截图识别单词表 ---------- */

/**
 * 识别一张单词表照片 → 词条列表。
 *
 * 关键点：
 *  · 视觉模型可以是**另一个模型**（`AI_VISION_MODEL`，如 deepseek-flash），
 *    因为日常讲解用的模型未必支持图片；
 *  · 识别完拿**词典**把标了疑问记号的词核一遍：词典里有 → 说明认对了，去掉疑问（少让用户操心）；
 *    词典里没有 → 保留疑问，前端高亮"请核对"；
 *  · 结果缓存按图片内容哈希：同一张图再传一次直接秒回（照片重传很常见）。
 */
/**
 * 识别调用的模型选择。
 *
 * 事实（2026-09-10 实测记录）：**DeepSeek 的 deepseek-flash 后端原生多模态**，
 * 直接发 image_url 就能识图。所以默认**就用配置里的模型**（很可能已经是多模态的那一个），
 * 只有接口明确回"不认图片"时，才回退到 deepseek-flash 再试一次 ——
 * 这样用户不用为了这个功能去改任何配置；真回退了也会在结果里说明用的是哪个模型。
 */
async function callVisionWithFallback({ baseUrl, model, apiKey, image }) {
  /** 回退用的模型：默认 deepseek-flash（原生多模态）；可用 OCR_FALLBACK_MODEL 覆盖（测试也用它注入） */
  const fallbackModel = String(process.env.OCR_FALLBACK_MODEL || 'deepseek-flash');
  try {
    return await callVision({ baseUrl, model, apiKey, prompt: OCR_PROMPT, imageDataUrl: image });
  } catch (e) {
    // 只有"接口明确说不认图片"才回退；网络/额度/超时之类的错照原样抛，
    // 别拿第二次请求把真正的问题掩盖过去
    if (!(e && e.visionUnsupported) || model === fallbackModel) throw e;
    console.warn('[ocr] 模型 ' + model + ' 不认图片，回退到 ' + fallbackModel + ' 重试');
    try {
      const r = await callVision({ baseUrl, model: fallbackModel, apiKey, prompt: OCR_PROMPT, imageDataUrl: image });
      return { ...r, fellBack: true };
    } catch {
      throw e;      // 回退也失败 → 抛**最初那条可操作的提示**（它才说得清该怎么办）
    }
  }
}

async function runOcrJob(jobId, { image, baseUrl, model, apiKey }) {
  const job = await findJob(jobId);
  if (!job) return;
  // ⚠️ 缓存键必须绑定「内容 + 模型 + 提示词版本」：只有内容哈希的话，换了识别模型
  // （AI_VISION_MODEL）或改了 OCR_PROMPT 之后，最长 7 天内还会继续返回旧结果。
  const hash = 'ocr:' + createHash('sha1').update(String(image))
    .update('\u0000' + String(model || ''))
    .update('\u0000ocr-prompt-v2')   // 改 OCR_PROMPT 内容时 bump 这一位，让旧缓存全部失效
    .digest('hex').slice(0, 24);
  const cached = await kv.get(KV_PREFIX + hash).catch(() => null);
  if (cached) {
    try {
      job.data = JSON.parse(cached);
      job.status = 'done';
      job.cached = true;
      job.updatedAt = Date.now();
      saveJob(job);
      return;
    } catch { /* 缓存坏了就当没有 */ }
  }

  job.status = 'running';
  job.updatedAt = Date.now();
  saveJob(job);

  

  const vision = await callVisionWithFallback({ baseUrl, model, apiKey, image });
  const text = vision.text;
  let items = parseOcrText(text);
  if (!items.length) throw new Error('没有从这张图里认出单词 —— 换个角度、让字更大更清晰，或分两张拍');

  // 用词典核对"疑问项"：词典认识 = 认对了（去掉记号）；词典也不认识 = 很可能真的读错，留着让用户核对
  if (DICT_PROVIDER !== 'off') {
    const doubtful = items.filter((x) => x.doubt > 0 && x.word !== '?').slice(0, 12);
    for (const it of doubtful) {
      try {
        const r = await lookupDict(it.word, { provider: DICT_PROVIDER, env: process.env });
        if (r && r.ok) it.doubt = 0;
      } catch { /* 词典不可用就保持原样 */ }
    }
  }

  const data = {
    items,
    quality: ocrQuality(items),
    raw: String(text).slice(0, 4000),
    // 用了哪个模型识别、是否发生过回退 —— 出问题时用户能一眼说清"是哪条路"
    model: vision.model,
    fellBack: Boolean(vision.fellBack),
    finishReason: vision.finishReason || '',
  };
  job.data = data;
  job.status = 'done';
  job.updatedAt = Date.now();
  saveJob(job);
  kv.set(KV_PREFIX + hash, JSON.stringify(data), 7 * 24 * 3600).catch(() => {});
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

/**
 * 中文查词：先给候选词，用户挑一个再走正常的查词讲解。
 * 复用 lookup 的任务与轮询通道（同一个 job 类型），前端按 data.candidates 是否存在来区分。
 */
async function runZhJob(jobId, { term, level, baseUrl, model, apiKey }) {
  const job = await findJob(jobId);
  if (!job) return;
  job.status = 'running';
  job.updatedAt = Date.now();
  saveJob(job);
  const raw = await callLLM({
    baseUrl, model, apiKey,
    system: ZH_CANDIDATE_PROMPT,
    user: buildZhCandidateMessage({ term, level }),
    maxTokens: 2000,
  });
  const parsed = sanitizeZhCandidates(parseJsonLoose(raw));
  if (!parsed.candidates.length) throw new Error('没找出对应的英文词，换个更具体的说法再试');
  job.data = { term: parsed.term || term, candidates: parsed.candidates };
  job.status = 'done';
  job.updatedAt = Date.now();
  saveJob(job);
}

/**
 * 查词结果缓存。
 *
 * 为什么值得做：一次查词要跑几十秒（模型要把整张卡片写完），而"同一个词同一个档位"
 * 的结果是**确定性的** —— 用户重复查、换设备打开历史、把收藏夹的词点回来，都不该再花一次钱和时间。
 *
 * 键里带上 level（不同档位的讲解深度不同）与 model（换模型后结果会变）。
 * 命中就秒回，前端那条"提交 → 轮询"的链路一个字都不用改。
 */
/** 流式连接的兜底时长（前端也会自己收尾；这里防"连接挂着但任务早没了"） */
const TIMEOUT_STREAM_MS = Number(process.env.STREAM_TIMEOUT_MS || 6 * 60 * 1000);

/** 对外的任务视图（不含 segments —— 那些已经按段推过了） */
function publicJob(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    data: job.data || null,
    error: job.error || null,
    streamMode: job.streamMode || '',
    streamIncomplete: Boolean(job.streamIncomplete),
  };
}

const LOOKUP_CACHE_TTL_SEC = Number(process.env.LOOKUP_CACHE_TTL_SEC || 24 * 3600);
/**
 * 查词缓存键。
 *
 * ⚠️ **必须带上解析后的接入点**（baseUrl）。原来只拼 term/level/kindHint/model，
 * 于是"访客自带 Key + 自定义地址"写下的结果会落在服务端自己那条缓存上：
 * 下一个用服务端 Key 的正常用户查同一个词，直接命中 `cached: true` 拿到别人塞的内容，
 * 24 小时内都不会去真调模型（跨用户的内容投毒）。
 * 这里的 model 字段又是可缺省的（缺省 = 服务端默认模型名），所以攻击者连模型名都不用猜。
 * 用哈希是为了不把 URL 里的 `/`、`:` 带进键名（文件型 KV 会把它们映射成 `_`，
 * 不同地址可能撞成同一个文件名）。
 */
const endpointTag = (baseUrl) => createHash('sha256').update(String(baseUrl || '')).digest('hex').slice(0, 16);
const lookupCacheKey = (term, level, kindHint, model, baseUrl) => KV_PREFIX + 'lcache:'
  + [String(term).toLowerCase(), level, kindHint || '', model || '', endpointTag(baseUrl)].join('|');

async function readLookupCache(term, level, kindHint, model, baseUrl) {
  if (!(LOOKUP_CACHE_TTL_SEC > 0)) return null;
  try {
    const raw = await kv.get(lookupCacheKey(term, level, kindHint, model, baseUrl));
    if (!raw) return null;
    const hit = JSON.parse(raw);
    return hit && hit.entry ? hit : null;
  } catch { return null; }
}

async function writeLookupCache(term, level, kindHint, model, baseUrl, data) {
  if (!(LOOKUP_CACHE_TTL_SEC > 0)) return;
  try { await kv.set(lookupCacheKey(term, level, kindHint, model, baseUrl), JSON.stringify(data), LOOKUP_CACHE_TTL_SEC); } catch { /* 缓存写失败不影响出结果 */ }
}

async function runLookupJob(jobId, { term, kindHint, level, context, baseUrl, model, apiKey, stream }) {
  const job = await findJob(jobId);
  if (!job) return;

  // 缓存命中 → 秒回（同一词同一档位 + **同一接入点** 24 小时内重复查不再花时间和费用）
  const cached = await readLookupCache(term, level, kindHint, model, baseUrl);
  if (cached) {
    job.data = cached;
    job.status = 'done';
    job.updatedAt = Date.now();
    job.cached = true;
    saveJob(job);
    return;
  }

  job.status = 'running';
  job.updatedAt = Date.now();
  job.segments = job.segments || [];
  saveJob(job);

  // 词典核对限时：它只提供音标/词性/大纲标注这类"加分事实"，接口抖一下不该拖住整张卡片。
  const DICT_TIMEOUT_MS = Number(process.env.DICT_TIMEOUT_MS || 2500);
  const dictResult = await Promise.race([
    lookupDict(term, { provider: DICT_PROVIDER, env: process.env }),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'timeout' }), DICT_TIMEOUT_MS)),
  ]);
  const facts = dictResult.ok ? dictResult.facts : null;

  // 词典事实先成一段：它在卡片里排第二位，而且**此刻就已经拿到了** ——
  // 用户能最先看到"已用有道词典核对"，不用等模型。
  if (facts) {
    job.segments.push({ t: 'dict', facts });
    job.updatedAt = Date.now();
  }

  const system = buildLookupSystemPrompt({ stream: Boolean(stream) });
  const user = buildLookupMessage({ term, kindHint, level, context, facts });
  // 词条骨架只造一次：重试时保持 id/head 稳定，别让"同一个词两次生成"拿到两个 id
  const baseId = 'wb-' + randomBytes(8).toString('hex');
  let raw = '';
  let final = null;
  /* 模型偶发返回缺释义的残缺结构（实测：reluctant 触发过一次，重查即好）。
     与其把"请重试"甩给用户让他重新排队，这里**自动重试一次**：
     重试前清空上一轮残段（SSE 段带 index，客户端按 index 落位，不会叠出重复内容）。 */
  for (let attempt = 1; attempt <= 2 && !final; attempt += 1) {
    // ⚠️ 重试**不能**清空 job.segments：在场 SSE 连接的 cursor 已越过旧 index，
    //    清空后新段 index < cursor 永远发不出去、词典段还会丢（两轮混拼）。
    //    追加式重发：客户端按类型覆盖折叠，done 事件再带最终词条收敛终态。
    raw = '';
    if (stream) {
      // 流式：边收边按行切段（见 server/stream.mjs 的三条硬规则）
      const reader = createSegmentReader();
      raw = await callLLMStream(
        { baseUrl, model, apiKey, system, user, maxTokens: 8000 },
        {
          onDelta: (delta) => {
            for (const seg of reader.feed(delta)) job.segments.push(seg);
            // 只更新内存里的时间戳（每次写 KV 会把 KV 打爆）；KV 在完成时写一次
            job.updatedAt = Date.now();
          },
        },
      );
      for (const seg of reader.flush()) job.segments.push(seg);
      job.streamStats = reader.stats;
    } else {
      raw = await callLLM({ baseUrl, model, apiKey, system, user, maxTokens: 8000 });
    }

    const parsedIn = parseJsonLoose(raw);
    final = stream
      ? finalizeStreamEntry({
        segments: job.segments,
        rawText: raw,
        parseLoose: parseJsonLoose,
        base: {
          id: (parsedIn && parsedIn.id) || baseId,
          head: (parsedIn && parsedIn.head) || term,
          level,
          createdAt: Date.now(),
        },
      })
      : { entry: (parsedIn ? sanitizeEntry({
        ...parsedIn,
        id: (parsedIn && parsedIn.id) || baseId,
        head: (parsedIn && parsedIn.head) || term,
        level,
        createdAt: Date.now(),
      }) : null), mode: 'oneshot' };
  }

  if (!final || !final.entry) {
    // userFacing：jobs.mjs 对这类错误原样透传，不再包一层"（请重试；若反复出现…）"
    // —— 否则文案变成"请重试（请重试；…）"（线上实测）。
    const err = new Error('模型返回的词条不完整（缺少释义），请重试');
    err.userFacing = true;
    throw err;
  }
  job.data = { entry: applyDict(final.entry, dictResult) };
  job.streamMode = final.mode;          // segments（正常）/ fallback（模型没按分段来）/ oneshot（关流式）
  // 没收到 {"t":"done"} 说明模型中途断了：卡片能用但可能少几块，前端据此提示"可重试补全"
  job.streamIncomplete = Boolean(stream) && !(job.segments || []).some((x) => x && x.t === 'done');
  job.status = 'done';
  job.updatedAt = Date.now();
  writeLookupCache(term, level, kindHint, model, baseUrl, job.data);
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
  const parsedQuiz = sanitizeQuiz(parseJsonLoose(raw));
  /**
   * 出题后的**质量体检**（本地、不花钱）：把"题干里写着答案"这类白送题修掉或剔除。
   * 起因：模型出过「Wearing a mask is ______.（用 mandatory 的适当形式填空）」答案是 mandatory ——
   * 题干把答案告诉了学生、答案又是原词，做了等于没做。
   * 提示词已经收紧，但模型不听话是常态，所以这里再加一道代码兜底，并**如实告诉用户剔了几道**。
   */
  const audit = auditQuizQuestions(parsedQuiz.questions);
  job.data = { ...parsedQuiz, questions: audit.questions, repaired: audit.repaired, dropped: audit.dropped, notes: audit.notes };
  if (audit.dropped) console.warn('[quiz] 剔除了 ' + audit.dropped + ' 道泄题/无效题');
  job.status = 'done';
  job.updatedAt = Date.now();
  saveJob(job);
}

/**
 * 词条追问：学生看完卡片之后再问一句。
 *
 * 为什么复用"异步任务 + 轮询"而不是做成流式：这条链路（提交 → 轮询 → 结果）
 * 已经在弱网和手机端被验证过，追问是同一类耗时操作，多一套流式实现只会多一处会挂的地方。
 * 追问比查词短得多，所以 maxTokens 收小、超时也短（见 TIMEOUT.followup 前端侧）。
 */
async function runFollowupJob(jobId, { head, brief, pos, question, context, level, baseUrl, model, apiKey }) {
  const job = await findJob(jobId);
  if (!job) return;
  job.status = 'running';
  job.updatedAt = Date.now();
  saveJob(job);
  const meta = {};
  const raw = await callLLM({
    baseUrl, model, apiKey,
    system: FOLLOWUP_SYSTEM_PROMPT,
    user: buildFollowupMessage({ head, brief, pos, question, context, level }),
    maxTokens: 1600,
    jsonMode: false,          // 追问要的是人话，不是 JSON（见 callLLM 的注释）
    meta,
  });
  const answer = sanitizeFollowup(raw);
  if (!answer) {
    // 空回答必须留下现场：不然只能对着"模型没有给出回答"干瞪眼（这正是线上发生的事）
    console.error('[followup] 空回答:', JSON.stringify({
      head, q: String(question).slice(0, 60),
      finish: meta.finishReason, len: meta.length, reasoning: meta.reasoning,
      raw: String(raw).slice(0, 200),
    }));
    throw new Error(meta.finishReason === 'length'
      ? '回答被截断了，把问题问短一点再试一次'
      : '模型这次没给出回答，再问一次试试（换个说法也可以）');
  }
  job.data = { head, question, answer };
  job.status = 'done';
  job.updatedAt = Date.now();
  saveJob(job);
}

/**
 * 造句练习：一个入口两种活 —— 出题（翻译模式）与批改（两种模式共用）。
 *
 * 为什么合成一个 kind：两者都是一次短调用、同一个入口、同一套超时；
 * 分成两个 kind 只会让任务表、限流、僵尸阈值三处都要各写一遍。
 */
async function runSentenceJob(jobId, { mode, points, count, head, brief, pos, cn, sentence, level, difficulty, baseUrl, model, apiKey }) {
  const job = await findJob(jobId);
  if (!job) return;
  job.status = 'running';
  job.updatedAt = Date.now();
  saveJob(job);

  if (mode === 'make') {
    const raw = await callLLM({
      baseUrl, model, apiKey,
      system: SENTENCE_MAKE_PROMPT,
      user: buildSentenceMakeMessage({ points: points.slice(0, count), level, difficulty }),
      maxTokens: 3000,
    });
    const parsed = sanitizeSentenceTasks(parseJsonLoose(raw));
    if (!parsed.items.length) throw new Error('模型没有给出题目，请重试');
    job.data = parsed;
  } else {
    const raw = await callLLM({
      baseUrl, model, apiKey,
      system: SENTENCE_GRADE_PROMPT,
      user: buildSentenceGradeMessage({ head, brief, pos, mode: mode === 'translate' ? 'translate' : 'free', cn, sentence, level, difficulty }),
      maxTokens: 2000,
    });
    const grade = sanitizeSentenceGrade(parseJsonLoose(raw));
    if (!grade.verdict && !grade.score) throw new Error('模型没有给出批改结果，请重试');
    job.data = { head, mode, sentence, difficulty, ...grade };
  }
  job.status = 'done';
  job.updatedAt = Date.now();
  saveJob(job);
}

/* ================= HTTP 层 ================= */
const DIST = path.join(ROOT, 'dist');
const MAX_BODY_BYTES = 2 * 1024 * 1024;   // 普通接口只传文本，2MB 足够
/** 拍照识别：图片 base64 会膨胀 4/3，6MB ≈ 4.5MB 原图；前端还会先压到长边 1600 */
const OCR_MAX_BYTES = Number(process.env.OCR_MAX_BYTES || 6 * 1024 * 1024);

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
  // 显式声明了非 JSON 的 Content-Type 就直接拒（415）：省得解析失败后给出误导性的
  // "JSON 格式不正确"—— 调试工具/爬虫发表单或空类型时能立刻看懂被拒的原因。
  // 不带 Content-Type 的放行（自家前端一直带；curl 不带头也常见）。
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct && !ct.includes('json')) throw new HttpError(415, 'Content-Type 必须是 application/json');
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
  let st = null;
  try { st = fs.statSync(file); } catch { /* ENOENT：交给下面的 SPA 回落判定，不能直接 404 */ }
  if (!st || st.isDirectory()) {
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
const accounts = accountsOn ? createAccounts({ kv, mail: sendMail, prefix: KV_PREFIX }) : null;

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  /**
   * ⚠️ new URL() 必须在 try **里面**。
   *
   * 它原来在 try 外面，而 `req.url` 是客户端完全可控的原始 request-target：
   * 一句 `GET http://[ HTTP/1.1` 就能让 new URL 抛 URIError，于是
   *   ① 这个 async 回调在 try 之前就 reject → 落到 unhandledRejection（日志被刷）；
   *   ② 更糟的是**没有任何一行代码再碰 res** —— 请求永远不结束、连接也不关，
   *      一条裸 socket 就能稳定占用一个连接（Node 的 requestTimeout 只管"把请求收完"，
   *      请求已经收完了，所以不会触发）。实测 3 种畸形 target 全部永久挂起。
   * 现在解析失败就直接 400 + 断开，绝不把一个已收完的请求悬在那里。
   */
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
    res.end(JSON.stringify({ error: 'bad request path' }));
    return;
  }
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
        // 识别（拍照导入）用哪个模型：没配 AI_VISION_MODEL 就退回讲解模型（可能不支持图片，前端会提示）
        visionModel: stat.visionModel() || stat.model(),
        visionIsDedicated: Boolean(stat.visionModel()),
        // 服务端有 Key ≠ 访客能用它：ALLOW_SERVER_KEY=0 的站点里，前端据此提示"请填自己的 Key"，
        // 否则会显示"AI 已配置"，用户一点查询却收到一句让他去改服务端 .env 的报错。
        serverKeyAllowed: ALLOW_SERVER_KEY,
        levels: LEVEL_KEYS, defaultLevel: DEFAULT_LEVEL,
        sync: { store: syncStore.kind, durable: syncDurable, hosted: HOSTED },
        accounts: { enabled: accountsOn, durable: kvDurable },
        jobs: {
          store: kv.kind, durable: kvDurable,
          ...store.stats(),
        },
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
      if (!ep.apiKey) {
        return json(res, 400, {
          error: ALLOW_SERVER_KEY
            ? missingKeyMsg(req)
            : '本站不提供公共 Key：请在「AI 设置」里填入你自己的 API Key（只存在你自己的浏览器里，站长看不到）',
        });
      }
      // 只有**用服务端 Key**的请求才占每日额度：访客自带 Key 花的是他自己的钱，不该被卡
            let refund = null;
if (!ep.visitorKey) {
        const b = await budget.spend();
        if (!b.ok) return json(res, 429, { error: budgetMessage(b.used, b.limit) });
        refund = b.refund;
      }

      const jobId = randomUUID();
      // 中文输入 → 先给候选词。中文词与英文词不是一一对应，直接当成词头来讲解必然跑偏
      // （线上真实事故：查"羽毛球"时词头是中文，音标却是 /ˈbædmɪntən/，自相矛盾）
      if (body.zh === true) {
        saveJob({ jobId, kind: 'lookup', title: term + ' · 找对应词', status: 'pending', createdAt: Date.now(), data: null, error: null });
        safeRun('lookup', jobId, refund, () => runZhJob(jobId, {
          term,
          level: normalizeLevel(body.level),
          baseUrl: ep.baseUrl,
          model: String(body.model || '').trim() || stat.model(),
          apiKey: ep.apiKey,
        }));
        return json(res, 200, { ok: true, jobId, status: 'pending' });
      }
      saveJob({ jobId, kind: 'lookup', title: term, status: 'pending', createdAt: Date.now(), data: null, error: null });
      safeRun('lookup', jobId, refund, () => runLookupJob(jobId, {
        term,
        kindHint: String(body.kindHint || '').slice(0, 20),
        context: String(body.context || '').slice(0, 600),
        level: normalizeLevel(body.level),
        baseUrl: ep.baseUrl,
        model: String(body.model || '').trim() || stat.model(),
        apiKey: ep.apiKey,
        // 流式：默认开（设置里可关；关了就回到"一次性 JSON"的老路）
        stream: body.stream !== false,
      }));
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }

    /* ---------- 自测题批改（主观题） ---------- */
    if (p === '/api/quiz/grade' && req.method === 'POST') {
      if (rateLimited(req)) return json(res, 429, { error: '请求过于频繁，请稍后再试' });
      const body = await readBody(req, 256 * 1024);
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 40).map((it) => ({
        stem: String((it && it.stem) || '').slice(0, 2000),
        type: String((it && it.type) || 'translate').slice(0, 20),
        answer: String((it && it.answer) || '').slice(0, 1000),
        userAnswer: String((it && it.userAnswer) || '').slice(0, 2000),
      })).filter((it) => it.stem);
      if (!items.length) return json(res, 400, { error: '没有需要批改的题目' });
      const ep = await resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (ep.error) return json(res, 400, { error: ep.error });
      if (!ep.apiKey) {
        return json(res, 400, {
          error: ALLOW_SERVER_KEY
            ? missingKeyMsg(req)
            : '本站不提供公共 Key：请在「AI 设置」里填入你自己的 API Key（只存在你自己的浏览器里，站长看不到）',
        });
      }
            let refund = null;
if (!ep.visitorKey) {
        const b = await budget.spend();
        if (!b.ok) return json(res, 429, { error: budgetMessage(b.used, b.limit) });
        refund = b.refund;
      }
      const jobId = randomUUID();
      saveJob({ jobId, kind: 'quizgrade', title: '批改自测题', status: 'pending', createdAt: Date.now(), data: null, error: null });
      safeRun('quizgrade', jobId, refund, () => runQuizGradeJob(jobId, {
        items,
        level: normalizeLevel(body.level),
        baseUrl: ep.baseUrl,
        model: String(body.model || '').trim() || stat.model(),
        apiKey: ep.apiKey,
      }));
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }

    /* ---------- 拍照识别单词表 ---------- */
    if (p === '/api/ocr' && req.method === 'POST') {
      if (rateLimited(req, 'ocr')) return json(res, 429, { error: '识别请求过于频繁，请稍后再试' });
      const body = await readBody(req, OCR_MAX_BYTES);
      const image = String(body.image || '');
      if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(image)) {
        return json(res, 400, { error: '请上传 PNG / JPG / WebP 图片' });
      }
      if (image.length > OCR_MAX_BYTES - 1024) {
        return json(res, 413, { error: '图片太大了，请在手机相册里先裁剪或压缩一下再上传' });
      }
      const ep = await resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (ep.error) return json(res, 400, { error: ep.error });
      if (!ep.apiKey) {
        return json(res, 400, {
          error: ALLOW_SERVER_KEY
            ? missingKeyMsg(req)
            : '本站不提供公共 Key：请在「AI 设置」里填入你自己的 API Key（只存在你自己的浏览器里，站长看不到）',
        });
      }
            let refund = null;
if (!ep.visitorKey) {
        const b = await budget.spend();
        if (!b.ok) return json(res, 429, { error: budgetMessage(b.used, b.limit) });
        refund = b.refund;
      }
      const jobId = randomUUID();
      saveJob({ jobId, kind: 'ocr', title: '识别单词表', status: 'pending', createdAt: Date.now(), data: null, error: null });
      safeRun('ocr', jobId, refund, () => runOcrJob(jobId, {
        image,
        /**
         * 识别用**视觉模型**（可与讲解模型不同；日常讲解模型未必支持图片）。
         *
         * ⚠️ 接入点只取服务端配置，**不接受请求体里的 visionBaseUrl**。
         * 这里原来写的是 `String(body.visionBaseUrl || '').trim() || stat.visionBaseUrl()`，
         * 而同一处的 apiKey 是 `ep.apiKey`（不传 body.apiKey 时就是**服务端那份 Key**）——
         * 两者一组合，任何人匿名发一个请求就能让服务器带着自己的 Key 去访问任意地址。
         * 实测 PoC：受害机向攻击者地址发出了 `Authorization: Bearer <服务端 Key>`，
         * 且上游响应正文还会经任务错误回显回来（SSRF 全读）。
         * 其余 6 个路由都走 resolveEndpoint（自定义地址必须自带 Key + 禁私网），只有这里漏了。
         * 前端从来不发这个字段（只发 visionModel），所以直接删掉，不留"看起来能用"的入口。
         * 要换识别接入点，请改服务端 .env 的 AI_VISION_BASE_URL。
         */
        baseUrl: stat.visionBaseUrl(),
        model: String(body.visionModel || '').trim() || stat.visionModel() || stat.model(),
        apiKey: ep.apiKey,
      }));
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }

    /* ---------- 出题 ---------- */
    if (p === '/api/quiz' && req.method === 'POST') {
      if (rateLimited(req)) return json(res, 429, { error: '请求过于频繁，请稍后再试' });
      const body = await readBody(req, 256 * 1024);
      /**
       * ⚠️ 顺序：**先校验参数、再扣额度**。
       * 原来是先 budget.spend() 再校验 points，于是一个 `{"points":[]}` 的空请求
       * （完全不调模型、不花钱）就能把当天的额度扣掉一次 —— 实测 DAILY_JOB_LIMIT=1 时
       * 第一条空请求返回 429，紧接着的**合法**请求也一起被拒。
       * 配了 DAILY_JOB_LIMIT 的部署，别人发 N 个空请求即可让全站当天不可用（零成本 DoS）。
       * 这里也顺手把重复的 resolveEndpoint 合成一次（原来解析两遍，自定义地址要做两次 DNS）。
       */
      const points = (Array.isArray(body.points) ? body.points : [])
        .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 60);
      if (!points.length) return json(res, 400, { error: '请先选择要出题的词条' });
      const count = Math.max(1, Math.min(50, Number(body.count) || 10));
      const ep = await resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (ep.error) return json(res, 400, { error: ep.error });
      if (!ep.apiKey) {
        return json(res, 400, {
          error: ALLOW_SERVER_KEY
            ? missingKeyMsg(req)
            : '本站不提供公共 Key：请在「AI 设置」里填入你自己的 API Key（只存在你自己的浏览器里，站长看不到）',
        });
      }
            let refund = null;
if (!ep.visitorKey) {
        const b = await budget.spend();
        if (!b.ok) return json(res, 429, { error: budgetMessage(b.used, b.limit) });
        refund = b.refund;
      }

      const jobId = randomUUID();
      saveJob({ jobId, kind: 'quiz', title: '自测题 · ' + count + ' 题', status: 'pending', createdAt: Date.now(), data: null, error: null });
      safeRun('quiz', jobId, refund, () => runQuizJob(jobId, {
        points, count, level: normalizeLevel(body.level),
        baseUrl: ep.baseUrl, model: String(body.model || '').trim() || stat.model(), apiKey: ep.apiKey,
      }));
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }

    /* ---------- 词条追问 ---------- */
    if (p === '/api/followup' && req.method === 'POST') {
      if (rateLimited(req)) return json(res, 429, { error: '问得太快了，缓一缓再问' });
      const body = await readBody(req, 64 * 1024);
      const head = String(body.head || body.term || '').trim().slice(0, 200);
      const question = String(body.question || '').trim().slice(0, 500);
      if (!head) return json(res, 400, { error: '缺少要追问的词' });
      if (!question) return json(res, 400, { error: '请先写下你的问题' });
      const ep = await resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (ep.error) return json(res, 400, { error: ep.error });
      if (!ep.apiKey) {
        return json(res, 400, {
          error: ALLOW_SERVER_KEY
            ? missingKeyMsg(req)
            : '本站不提供公共 Key：请在「AI 设置」里填入你自己的 API Key（只存在你自己的浏览器里，站长看不到）',
        });
      }
      // 只有**用服务端 Key**的请求才占每日额度：访客自带 Key 花的是他自己的钱
            let refund = null;
if (!ep.visitorKey) {
        const b = await budget.spend();
        if (!b.ok) return json(res, 429, { error: budgetMessage(b.used, b.limit) });
        refund = b.refund;
      }
      const jobId = randomUUID();
      saveJob({ jobId, kind: 'followup', title: head + ' · 追问', status: 'pending', createdAt: Date.now(), data: null, error: null });
      safeRun('followup', jobId, refund, () => runFollowupJob(jobId, {
        head,
        brief: String(body.brief || '').slice(0, 600),
        pos: String(body.pos || '').slice(0, 60),
        question,
        context: String(body.context || '').slice(0, 600),
        level: normalizeLevel(body.level),
        baseUrl: ep.baseUrl, model: String(body.model || '').trim() || stat.model(), apiKey: ep.apiKey,
      }));
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }

    /* ---------- 造句练习（出题 / 批改） ---------- */
    if (p === '/api/sentence' && req.method === 'POST') {
      const body = await readBody(req, 256 * 1024);
      const mode = body.mode === 'make' ? 'make' : 'grade';
      if (rateLimited(req, mode === 'grade' ? 'grade' : undefined)) {
        return json(res, 429, { error: mode === 'grade' ? '批改得太快了，缓一缓' : '请求过于频繁，请稍后再试' });
      }
      /**
       * ⚠️ 参数校验必须排在 budget.spend() **之前**（与 /api/quiz 同一条坑）：
       * 空请求不调模型、不花钱，却能扣掉一次当日额度 —— 反复发就能零成本耗尽全站配额。
       * 两个分支的参数先在这里收口，下面再解析接入点、扣额度。
       */
      const points = mode === 'make'
        ? (Array.isArray(body.points) ? body.points : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 30)
        : [];
      if (mode === 'make' && !points.length) return json(res, 400, { error: '还没有词条可以出题 —— 先查几个词' });
      const head = mode === 'grade' ? String(body.head || '').trim().slice(0, 200) : '';
      const sentence = mode === 'grade' ? String(body.sentence || '').trim().slice(0, 1000) : '';
      if (mode === 'grade' && !head) return json(res, 400, { error: '缺少要练习的词' });
      if (mode === 'grade' && !sentence) return json(res, 400, { error: '先写下你的句子再提交' });

      const ep = await resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (ep.error) return json(res, 400, { error: ep.error });
      if (!ep.apiKey) {
        return json(res, 400, {
          error: ALLOW_SERVER_KEY
            ? missingKeyMsg(req)
            : '本站不提供公共 Key：请在「AI 设置」里填入你自己的 API Key（只存在你自己的浏览器里，站长看不到）',
        });
      }
            let refund = null;
if (!ep.visitorKey) {
        const b = await budget.spend();
        if (!b.ok) return json(res, 429, { error: budgetMessage(b.used, b.limit) });
        refund = b.refund;
      }

      if (mode === 'make') {
        const count = Math.max(1, Math.min(20, Number(body.count) || 5));
        const jobId = randomUUID();
        saveJob({ jobId, kind: 'sentence', title: '造句练习 · ' + count + ' 题', status: 'pending', createdAt: Date.now(), data: null, error: null });
        safeRun('sentence', jobId, refund, () => runSentenceJob(jobId, {
          mode: 'make', points, count, level: normalizeLevel(body.level), difficulty: normalizeDifficulty(body.difficulty),
          baseUrl: ep.baseUrl, model: String(body.model || '').trim() || stat.model(), apiKey: ep.apiKey,
        }));
        return json(res, 200, { ok: true, jobId, status: 'pending' });
      }

      const jobId = randomUUID();
      saveJob({ jobId, kind: 'sentence', title: head + ' · 批改', status: 'pending', createdAt: Date.now(), data: null, error: null });
      safeRun('sentence', jobId, refund, () => runSentenceJob(jobId, {
        mode: 'grade', head,
        brief: String(body.brief || '').slice(0, 600),
        pos: String(body.pos || '').slice(0, 60),
        cn: String(body.cn || '').slice(0, 600),
        sentence,
        level: normalizeLevel(body.level),
        difficulty: normalizeDifficulty(body.difficulty),
        baseUrl: ep.baseUrl, model: String(body.model || '').trim() || stat.model(), apiKey: ep.apiKey,
      }));
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }

    /* ---------- 流式：GET /api/lookup/:id/stream（SSE） ----------
     * 只推**新增**的段（?from=N / Last-Event-ID），断线重连不重放；
     * 15 秒一次注释心跳，防代理把长连接掐掉；
     * 结束时 event: done 带上**最终完整词条** —— 前端据此覆盖 partial，
     * 保证"看到的"和"存下来的"是同一个东西。 */
    const streamMatch = p.match(/^\/api\/lookup\/([A-Za-z0-9-]{8,64})\/stream$/);
    if (streamMatch && req.method === 'GET') {
      const sseIp = clientIp(req);
      const ipCount = sseStreamsByIp.get(sseIp) || 0;
      if (ipCount >= SSE_PER_IP || sseStreamsTotal >= SSE_GLOBAL_MAX) {
        return json(res, 429, { error: '当前连接数过多，请稍后再试' });
      }
      sseStreamsByIp.set(sseIp, ipCount + 1);
      sseStreamsTotal += 1;
      const jobId = streamMatch[1];
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',        // 让 nginx/代理不要缓冲
      });
      const send = (event, data, id) => {
        // 段带 id 行：断线重连时浏览器自动带 Last-Event-ID，下面的 cursor 才能从断点续传。
        // 不写 id 的话重连永远从 0 重放（白传一遍，客户端还得整段去重）。
        if (id !== undefined && id !== null) res.write('id: ' + id + String.fromCharCode(10));
        res.write('event: ' + event + String.fromCharCode(10));
        res.write('data: ' + JSON.stringify(data) + String.fromCharCode(10) + String.fromCharCode(10));
      };
      res.write(': connected' + String.fromCharCode(10) + String.fromCharCode(10));

      const url0 = new URL(req.url, 'http://x');
      /* 游标语义：from / Last-Event-ID 都表示「客户端**最后见过的段 id**」，续传从 id+1 开始。
         ⚠️ 此前写成 cursor = lastSeen：重连会把 id:0 再发一遍（差一错误，回归测试
         sseResume 抓到）—— 客户端按 index 覆盖去重兜住了正确性，但每次断线重连
         都白收一个重复段。没有游标（首连）才从 0 全量发。
         注意 0 是合法游标，不能靠 || 兜底：必须显式区分"没给"和"给了 0"。 */
      const fromRaw = url0.searchParams.get('from');
      const leiRaw = req.headers['last-event-id'];
      const lastSeen = fromRaw !== null && fromRaw !== '' ? Number(fromRaw)
        : (leiRaw !== undefined && leiRaw !== '' ? Number(leiRaw) : null);
      const cursor = (lastSeen === null || !Number.isFinite(lastSeen) || lastSeen < 0) ? 0 : lastSeen + 1;
      let sendCursor = cursor;   // 轮询中随已发段数推进（保持 const 语义的初值 + 可变游标）
      let closed = false;
      req.on('close', () => { closed = true; });
      const heartbeat = setInterval(() => { if (!closed) res.write(': ping' + String.fromCharCode(10) + String.fromCharCode(10)); }, 15000);

      try {
        // 已经完成的任务（切走又回来）：一次性推完再结束
        const first = await findJob(jobId);
        if (!first) { send('error', { error: '任务不存在或已过期，请重新查询' }); return res.end(); }
        if (first.status === 'done' && Array.isArray(first.segments) && first.segments.length) {
          for (let i = sendCursor; i < first.segments.length; i += 1) send('segment', { index: i, seg: first.segments[i], label: SEGMENT_LABEL[first.segments[i].t] || '' }, i);
          send('done', { job: publicJob(first) });
          return res.end();
        }
        const deadline = Date.now() + Number(TIMEOUT_STREAM_MS || 6 * 60 * 1000);
        while (!closed && Date.now() < deadline) {
          const job = guardStale(await findJob(jobId)) || null;
          if (!job) { send('error', { error: '任务不存在或已过期，请重新查询' }); break; }
          const segs = Array.isArray(job.segments) ? job.segments : [];
          for (let i = sendCursor; i < segs.length; i += 1) {
            send('segment', { index: i, seg: segs[i], label: SEGMENT_LABEL[segs[i].t] || '' }, i);
          }
          sendCursor = Math.max(sendCursor, segs.length);
          if (job.status === 'done') { send('done', { job: publicJob(job) }); break; }
          if (job.status === 'error') { send('error', { error: job.error || '生成失败，请重试' }); break; }
          await new Promise((r) => setTimeout(r, 400));   // 段级轮询：比任务轮询快得多，只读内存
        }
      } catch (e) {
        if (!closed) send('error', { error: String((e && e.message) || e) });
      } finally {

clearInterval(heartbeat);
        const left = (sseStreamsByIp.get(sseIp) || 1) - 1;
        if (left <= 0) sseStreamsByIp.delete(sseIp); else sseStreamsByIp.set(sseIp, left);
        sseStreamsTotal -= 1;
        if (!closed) res.end();
}
      return undefined;
    }

    const jobMatch = p.match(/^\/api\/(lookup|quiz|quizgrade|followup|sentence|ocr)\/([A-Za-z0-9-]{8,64})$/);
    if (jobMatch && req.method === 'GET') {
      const job = await findJob(jobMatch[2]);
      if (!job || job.kind !== jobMatch[1]) return json(res, 404, { error: '任务不存在或已过期，请重新发起' });
      return json(res, 200, { ok: true, job: { jobId: job.jobId, status: job.status, data: job.data || null, error: job.error || null, cached: Boolean(job.cached) } });
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
        // ⚠️ 读也要限流：每一次 GET 都是一次对 Upstash 的真实命令（按命令计费），
        // 原先 POST 限了 GET 没限 —— 匿名脚本可以拿假同步码把读配额刷爆（成本放大器）。
        if (rateLimited(req)) return json(res, 429, { error: '请求过于频繁，请稍后再试' });
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
