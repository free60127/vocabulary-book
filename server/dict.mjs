/**
 * 词典事实层：给 AI 讲解"接地"。
 *
 * 为什么要有这一层：纯 AI 讲解在**客观事实上**会出错，而且是那种"看起来很像"的错 ——
 * 音标重音标错（object 名词 /ˈɒbdʒɪkt/、动词 /əbˈdʒekt/ 是两个音）、词性漏掉、
 * 张口就说"四六级常考"（其实大纲里根本没这个词）。这些都不该让模型猜。
 * 所以：**客观事实来自词典，讲解来自 AI；两者冲突时以词典为准**，并把冲突显式标出来。
 *
 * 两个 provider：
 *  · youdao-open  官方开放平台（https://ai.youdao.com），需要 appKey/appSecret，**付费**、有免费额度。
 *                 这是唯一合规、稳定的路径，公开部署应该用这个。
 *  · youdao-web   有道词典网页版自己用的内部接口，免费、无需 key。
 *                 ⚠️ 它**不是公开 API**：没有文档、没有稳定性承诺、随时可能改字段或被限流，
 *                 且属于抓取第三方站点数据（版权/ToS 上与有道官方条款存在灰色地带）。
 *                 自用没问题，商用/公开部署请换成 youdao-open。
 *
 * 不配置（DICT_PROVIDER=off）或查询失败时：**静默降级成纯 AI**，绝不让查词失败。
 */
import { createHash } from 'node:crypto';

export const DICT_PROVIDERS = ['off', 'youdao-web', 'youdao-open'];

/** 归一化词条查询串：词典接口对大小写/空白敏感，先统一 */
export const normalizeWord = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 80);

/** 音标清洗：去掉包裹的斜杠/方括号与多余空白。
 *  必须先 trim 再剥括号 —— 反过来写的话 `' /x/ '` 两头都带空格，
 *  `^...` 与 `...$` 都匹配不上，斜杠会原样留下（第一版就是这样，测试抓到了）。 */
export const normalizePhonetic = (s) => String(s || '')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/^[/[\]|]+|[/[\]|]+$/g, '')
  .trim();

/** 去掉例句里的 <b> 高亮标签与 HTML 实体（词典返回的是网页片段） */
const stripTags = (s) => String(s || '')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ')
  .trim();

const arr = (x) => (Array.isArray(x) ? x : []);
const str = (x) => (typeof x === 'string' ? x : '');
/** 有道的嵌套结构形如 { l: { i: "文字" } }，逐层剥出来 */
const deep = (o, ...keys) => keys.reduce((cur, k) => (cur && typeof cur === 'object' ? cur[k] : undefined), o);
const text = (o, ...keys) => stripTags(str(deep(o, ...keys)));
/**
 * 取"可能是一行、也可能是一组行"的字段。
 * ⚠️ 有道的 `l.i` 有时是字符串、有时是**数组** —— 早期版本只用 str() 取，
 * 数组一律变成空串，于是所有词条的释义全空（音标/搭配却正常，特别难发现）。
 */
const texts = (o, ...keys) => {
  const v = deep(o, ...keys);
  if (Array.isArray(v)) return v.map((x) => stripTags(str(x))).filter(Boolean);
  const one = stripTags(str(v));
  return one ? [one] : [];
};
/** 把一个可能含多读音的音标串（"ˈɒbdʒɪkt; ˈɒbdʒekt"）拆开 */
const splitPhones = (s) => String(s || '').split(/\s*[;；]\s*/).map(normalizePhonetic).filter(Boolean);

/** 从 "n. 物体，实物；目的" 里拆出词性与中文 */
function splitSense(line) {
  const m = /^\s*([a-z]+\.(?:\s*&\s*[a-z]+\.)*)\s*(.*)$/i.exec(line);
  return m ? { pos: m[1].replace(/\s+/g, ''), cn: m[2].trim() } : { pos: '', cn: String(line || '').trim() };
}

/** 词典原文里同一个词性可能有好几行，合并成一条，避免卡片上出现重复词性 */
function mergeSenses(list) {
  const out = [];
  for (const s of list) {
    if (!s.cn) continue;
    const hit = out.find((x) => x.pos === s.pos);
    if (hit) hit.cn = hit.cn.includes(s.cn) ? hit.cn : hit.cn + '；' + s.cn;
    else out.push({ ...s });
  }
  return out;
}

/* ---------- 有道网页内部接口 → 统一事实形状 ---------- */
export function parseYoudaoJson(json) {
  if (!json || typeof json !== 'object') return null;
  const ecWord = arr(deep(json, 'ec', 'word'))[0] || {};
  const simpleWord = arr(deep(json, 'simple', 'word'))[0] || {};
  const head = text(ecWord, 'return-phrase', 'l', 'i') || str(deep(simpleWord, 'return-phrase')) || normalizeWord(deep(json, 'meta', 'input'));
  if (!head) return null;
  const key = normalizeWord(str(deep(json, 'meta', 'input')) || head);

  const senses = mergeSenses(
    arr(ecWord.trs).flatMap((t) => arr(t.tr).flatMap((x) => texts(x, 'l', 'i').map(splitSense))),
  );

  // 逐词性音标：object 这类"名词/动词重音不同"的词，只给一个音标就是错的
  const perPos = [];
  for (const lang of ['uk', 'us']) {
    for (const p of arr(deep(simpleWord, 'multiPhone', lang))) {
      const phone = normalizePhonetic(p && p.phone);
      if (!phone) continue;
      for (const pos of arr(p && p.pos)) {
        if (!perPos.some((x) => x.pos === pos && x.phone === phone && x.lang === lang)) {
          perPos.push({ lang, pos: String(pos), phone });
        }
      }
    }
  }

  const phrases = arr(deep(json, 'phrs', 'phrs')).map((p) => ({
    en: text(p, 'phr', 'headword', 'l', 'i'),
    cn: text(p, 'phr', 'trs', 0, 'tr', 'l', 'i'),
  })).filter((p) => p.en && p.cn).slice(0, 12);

  const synonyms = arr(deep(json, 'syno', 'synos')).map((s) => ({
    pos: str(deep(s, 'syno', 'pos')),
    cn: stripTags(str(deep(s, 'syno', 'tran'))),
    words: arr(deep(s, 'syno', 'ws')).map((w) => normalizeWord(w && w.w)).filter(Boolean).slice(0, 10),
  })).filter((s) => s.words.length).slice(0, 4);

  const family = arr(deep(json, 'rel_word', 'rels')).map((r) => ({
    pos: str(deep(r, 'rel', 'pos')),
    words: arr(deep(r, 'rel', 'words')).map((w) => ({
      w: normalizeWord(w && w.word),
      cn: stripTags(str(w && w.tran)).trim(),
    })).filter((x) => x.w).slice(0, 8),
  })).filter((r) => r.words.length).slice(0, 4);

  const sentences = arr(deep(json, 'blng_sents_part', 'sentence-pair')).map((s) => ({
    en: text(s, 'sentence-eng') || stripTags(str(s && s.sentence)),
    cn: stripTags(str(s && s['sentence-translation'])),
  })).filter((s) => s.en).slice(0, 5);

  const forms = arr(deep(json, 'collins_primary', 'words', 'indexforms'))
    .map((x) => normalizeWord(x)).filter(Boolean).slice(0, 8);

  // 词典返回的 ukphone/usphone 是"所有读音拼在一起"的串；卡片上只显示第一个（主读音），
  // 其余读音单独进 allPhonetics —— 冲突校验要拿全部读音去比，否则会把正确读音判成错的。
  const ukAll = splitPhones(ecWord.ukphone || simpleWord.ukphone || deep(simpleWord, 'multiPhone', 'uk', 0, 'phone'));
  const usAll = splitPhones(ecWord.usphone || simpleWord.usphone || deep(simpleWord, 'multiPhone', 'us', 0, 'phone'));
  const facts = {
    source: 'youdao',
    head,
    key,
    phonetics: { uk: ukAll[0] || '', us: usAll[0] || '' },
    allPhonetics: [...new Set([...ukAll, ...usAll, ...perPos.map((x) => x.phone)])],
    perPosPhonetics: perPos,
    senses,
    examTypes: arr(deep(json, 'ec', 'exam_type')).map((x) => str(x)).filter(Boolean).slice(0, 10),
    phrases,
    synonyms,
    family,
    sentences,
    forms,
  };
  // 一个字段都没取到等于没查到：宁可当成未命中（走纯 AI），也不要往卡片上贴一个空壳
  const useful = facts.senses.length || facts.phonetics.uk || facts.phonetics.us || facts.phrases.length;
  return useful ? facts : null;
}

/* ---------- 官方开放平台（付费，需签名） ---------- */
/** 官方文档规定的截断规则：长度 > 20 时取「首10 + 长度 + 末10」 */
export const truncate = (q) => {
  const s = String(q || '');
  return s.length <= 20 ? s : s.slice(0, 10) + s.length + s.slice(-10);
};
export const youdaoSign = (appKey, appSecret, q, salt, curtime) =>
  createHash('sha256').update(appKey + truncate(q) + salt + curtime + appSecret).digest('hex');

export function parseYoudaoOpen(json) {
  if (!json || json.errorCode !== '0') return null;
  const head = normalizeWord(json.query);
  const senses = mergeSenses(arr(json.basic && json.basic.explains).map((line) => splitSense(stripTags(line))));
  const ukOpen = splitPhones(json.basic && json.basic['uk-phonetic']);
  const usOpen = splitPhones(json.basic && json.basic['us-phonetic']);
  const facts = {
    source: 'youdao',
    head,
    key: head,
    phonetics: { uk: ukOpen[0] || '', us: usOpen[0] || '' },
    allPhonetics: [...new Set([...ukOpen, ...usOpen])],
    perPosPhonetics: [],
    senses,
    examTypes: arr(json.basic && json.basic.exam_type).map((x) => str(x)).filter(Boolean).slice(0, 10),
    phrases: arr(json.web).map((w) => ({
      en: stripTags(w && w.key),
      cn: arr(w && w.value).map((v) => stripTags(v && v.value)).filter(Boolean).join('；'),
    })).filter((p) => p.en && p.cn).slice(0, 12),
    synonyms: [],
    family: [],
    sentences: [],
    forms: arr(json.basic && json.basic.wfs).map((w) => {
      const name = { le: '', p: '过去式', d: '过去分词', i: '现在分词', s: '第三人称单数', r: '比较级', t: '最高级' }[w && w.wf && w.wf.name] || '';
      return name ? `${name} ${stripTags(w.wf.value)}`.trim() : '';
    }).filter(Boolean).slice(0, 8),
  };
  return facts.senses.length || facts.phonetics.uk || facts.phonetics.us ? facts : null;
}

/* ---------- 缓存 + 熔断 + 并发去重 ---------- */
const CACHE_MAX = 500;
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const cache = new Map();               // key -> { facts, at }（facts 为 null 表示"词典里没有"）
const inflight = new Map();            // key -> Promise，防止同一个词被并发打多次
let fails = 0;
let openUntil = 0;                     // > now 表示熔断中

export function dictStats() {
  return { cached: cache.size, inflight: inflight.size, fails, open: openUntil > Date.now() };
}
/** 测试用：清掉缓存与熔断状态 */
export function resetDictState() {
  cache.clear(); inflight.clear(); fails = 0; openUntil = 0;
}

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return undefined; }
  return hit.facts;
}
function writeCache(key, facts) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);   // 有界，别把内存吃光
  cache.set(key, { facts, at: Date.now() });
}

/** 从 .env 读出要用哪个 provider；没配就是 off */
export function resolveProvider(env = {}) {
  const want = String(env.DICT_PROVIDER || '').trim().toLowerCase();
  const hasOpenKey = Boolean(env.YOUDAO_APP_KEY && env.YOUDAO_APP_SECRET);
  if (want === 'off' || want === 'none' || want === '0') return 'off';
  if (want === 'youdao-open') return hasOpenKey ? 'youdao-open' : 'off';
  if (want === 'youdao-web') return 'youdao-web';
  // 没显式配：有官方 key 就优先走官方（合规），否则默认用免费的网页接口
  return hasOpenKey ? 'youdao-open' : 'youdao-web';
}

const TIMEOUT_MS = 3500;
const BREAK_AFTER = 5;                 // 连续失败这么多次就熔断
const BREAK_MS = 60_000;

/** 词典接口地址。可用 DICT_BASE_URL 指向镜像/代理（自建缓存、公司网关），也便于本地联调。 */
export const dictBaseUrl = (env = {}) => String(env.DICT_BASE_URL || 'https://dict.youdao.com').replace(/\/+$/, '');

async function fetchYoudaoWeb(word, env, fetchImpl) {
  const url = dictBaseUrl(env) + '/jsonapi?q=' + encodeURIComponent(word);
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; vocabulary-book/0.1)', Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('词典接口 HTTP ' + res.status);
  return parseYoudaoJson(await res.json());
}

async function fetchYoudaoOpen(word, env, fetchImpl) {
  const salt = String(Date.now()) + Math.floor(Math.random() * 1000);
  const curtime = String(Math.floor(Date.now() / 1000));
  const body = new URLSearchParams({
    q: word, from: 'en', to: 'zh-CHS', appKey: env.YOUDAO_APP_KEY,
    salt, sign: youdaoSign(env.YOUDAO_APP_KEY, env.YOUDAO_APP_SECRET, word, salt, curtime),
    signType: 'v3', curtime,
  });
  const res = await fetchImpl('https://openapi.youdao.com/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('有道开放平台 HTTP ' + res.status);
  return parseYoudaoOpen(await res.json());
}

/**
 * 查词典。**永不抛错**：查不到、超时、熔断、字段变了都返回 { ok:false, reason }，
 * 调用方据此静默降级 —— 词典是加分项，不该因为它挂了就让用户查不了词。
 */
export async function lookupDict(word, { provider, env = {}, fetchImpl = fetch } = {}) {
  const p = provider || resolveProvider(env);
  const key = normalizeWord(word);
  if (p === 'off' || !key) return { ok: false, reason: 'disabled' };

  const cached = readCache(p + '|' + key);
  if (cached !== undefined) return cached ? { ok: true, facts: cached, cached: true } : { ok: false, reason: 'not-found' };

  if (openUntil > Date.now()) return { ok: false, reason: 'circuit-open' };
  if (inflight.has(p + '|' + key)) return inflight.get(p + '|' + key);

  const task = (async () => {
    try {
      const facts = p === 'youdao-open'
        ? await fetchYoudaoOpen(key, env, fetchImpl)
        : await fetchYoudaoWeb(key, env, fetchImpl);
      fails = 0;
      writeCache(p + '|' + key, facts);
      return facts ? { ok: true, facts } : { ok: false, reason: 'not-found' };
    } catch (e) {
      fails += 1;
      if (fails >= BREAK_AFTER) openUntil = Date.now() + BREAK_MS;
      console.warn('[dict] 查询失败，本次降级为纯 AI：', key, e && e.message);
      return { ok: false, reason: 'error' };
    } finally {
      inflight.delete(p + '|' + key);
    }
  })();
  inflight.set(p + '|' + key, task);
  return task;
}

/* ---------- 冲突校验：AI 说的和词典说的对不上时，以词典为准 ---------- */
/**
 * 词性中文 → 归类。
 * ⚠️ 模型的 schema 里 pos 写的是中文（"名词/动词/形容词"），词典给的是 "n."/"vt."，
 * 不先把两边归到同一档，"词性漏没漏"永远判不出结果（第一版就是这样：恒等为空，看着像"从不冲突"）。
 */
const POS_FAMILY = {
  名词: 'n', 动词: 'v', 形容词: 'adj', 副词: 'adv', 介词: 'prep', 连词: 'conj',
  代词: 'pron', 数词: 'num', 冠词: 'art', 感叹词: 'int', 限定词: 'det', 助动词: 'v',
};
const posFamily = (raw) => {
  const p = String(raw || '').replace(/\./g, '').trim().toLowerCase();
  if (!p) return '';
  if (POS_FAMILY[p]) return POS_FAMILY[p];
  if (/^[a-z]+$/.test(p)) return p.startsWith('v') ? 'v' : p.startsWith('adj') ? 'adj' : p.startsWith('adv') ? 'adv' : p;
  return POS_FAMILY[p.slice(0, 3)] || POS_FAMILY[p.slice(0, 2)] || '';
};
/**
 * 只查两类"客观、可判定"的冲突 —— 其余的（讲解深浅、场景是否贴切）是主观的，
 * 硬判只会制造噪音：
 *  · 音标：词典里所有音标（含逐词性音标）都没有 AI 给的那一个 → 冲突，用词典的覆盖。
 *  · 词性：词典标了某个词性而 AI 完全没提 → 记为"漏"，列出来提醒。
 */
export function dictConflicts(entry, facts) {
  const out = { phonetics: [], missingPos: [] };
  if (!entry || !facts) return out;

  const known = [
    facts.phonetics?.uk, facts.phonetics?.us,
    ...(facts.allPhonetics || []),
    ...(facts.perPosPhonetics || []).map((x) => x.phone),
  ].map(normalizePhonetic).filter(Boolean);

  const ai = normalizePhonetic(entry.phonetic);
  if (ai && known.length && !known.includes(ai)) out.phonetics.push(ai);

  const dictPos = [...new Set((facts.senses || []).map((s) => posFamily(s.pos)).filter(Boolean))];
  const aiFam = new Set([
    ...String(entry.pos || '').split(/[、,，\s/]+/),
    ...(entry.meanings || []).map((m) => m.pos || ''),
  ].map(posFamily).filter(Boolean));
  for (const p of dictPos) if (!aiFam.has(p)) out.missingPos.push(p);
  return out;
}

/** 把事实压成一段给模型看的提示词；没事实时返回空串（调用方直接不加这一段） */
export function buildFactsBlock(facts) {
  if (!facts) return '';
  const L = [];
  // 音标要按"词性 → 英/美"归并着写：逐条列出来既啰嗦又容易让模型抓错重点
  const byPos = new Map();
  for (const x of facts.perPosPhonetics || []) {
    if (!byPos.has(x.pos)) byPos.set(x.pos, {});
    const slot = byPos.get(x.pos);
    if (!slot[x.lang]) slot[x.lang] = x.phone;
  }
  if (byPos.size) {
    const parts = [...byPos].map(([pos, v]) =>
      [v.uk ? '英 ' + v.uk : '', v.us ? '美 ' + v.us : ''].filter(Boolean).join('，') + `（${pos}.）`);
    L.push('音标（按词性，同一个词不同词性读音可能不同）：' + parts.join('；'));
  } else {
    const parts = [facts.phonetics?.uk ? '英 ' + facts.phonetics.uk : '', facts.phonetics?.us ? '美 ' + facts.phonetics.us : ''].filter(Boolean);
    if (parts.length) L.push('音标：' + parts.join('，'));
  }
  if (facts.senses?.length) L.push('词性+释义：' + facts.senses.map((s) => `${s.pos} ${s.cn}`.trim()).join(' | '));
  if (facts.examTypes?.length) L.push('考试大纲标注：' + facts.examTypes.join('、'));
  if (facts.forms?.length) L.push('词形变化：' + facts.forms.join('、'));
  if (facts.phrases?.length) L.push('常见搭配：' + facts.phrases.map((p) => `${p.en}（${p.cn}）`).join('；'));
  if (facts.synonyms?.length) {
    L.push('词典近义：' + facts.synonyms.map((s) => `${s.pos}${s.words.join(' / ')}${s.cn ? '→' + s.cn : ''}`).join('；'));
  }
  if (facts.family?.length) {
    L.push('同根词族：' + facts.family.map((f) => `${f.pos}${f.words.map((w) => w.w).join(' / ')}`).join('；'));
  }
  if (L.length < 2) return '';         // 只有个光杆音标就不值得占提示词篇幅
  // 这段每查一次词就进一次提示词，长度必须有上限：
  // 一张卡片十来个搭配、每个搭配再带一长串中文，很容易把这块顶到两三千字（烧的是 token）。
  // 超限时先砍尾巴（搭配/近义/词族），音标与释义这两个"最该核对"的必须留下。
  const kept = [];
  let used = 0;
  for (const line of L) {
    if (kept.length >= 2 && used + line.length > 1400) continue;
    kept.push(line.length > 700 ? line.slice(0, 700) + '…' : line);
    used += line.length;
  }
  return '\n【权威词典事实（来自有道词典，客观事实一律以词典为准）】\n'
    + kept.map((x) => '- ' + x).join('\n') + '\n'
    + '硬要求：\n'
    + '1. phonetic 必须与上面的音标**逐字符一致**（含重音符号）；一个词有多个读音时，用「名词读音; 动词读音」这种写法把它们都给出来。\n'
    + '2. pos 与 meanings 必须覆盖上面列出的**全部词性**，一个都不能漏。\n'
    + '3. 只有在上面「考试大纲标注」里出现过的考试，才可以说它属于该考试范围；没标注就不许提。\n'
    + '4. 词根词缀、同根词族若与上面的释义矛盾，以上面的释义为准（宁可不说，也不要说反）。\n'
    + '5. 词典没给的部分（语域、褒贬、情感强度、使用场景、助记、近义词差别、例句）由你补全，'
    + '但不能与上面任何一条冲突。\n';
}

export const __internals = { stripTags, splitSense, mergeSenses, readCache, writeCache, TIMEOUT_MS, BREAK_AFTER };
