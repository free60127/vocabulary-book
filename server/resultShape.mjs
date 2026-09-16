/**
 * 模型返回值的形状清洗 —— **单一事实源**。
 *
 * 为什么单独一个文件、而且被两处共用（查词任务落库 + 云同步快照）：
 * 模型输出的形状永远不能信：`sentences: [null]` 这类脏数据在回译本上直接把整页搞白屏过。
 * 两边各写一份校验必然会漂移，所以只在这里定义一次。
 *
 * 原则：**逐字段重建**（白名单），而不是"过滤掉几个坏字段" —— 后者总会漏。
 */

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const boundedString = (v, max) => String(v == null ? '' : v).slice(0, max);
const jsonBytes = (v) => {
  try { return JSON.stringify(v).length; } catch { return Infinity; }
};

export const ENTRY_LIMITS = Object.freeze({
  idChars: 64,
  headChars: 200,
  fieldChars: 8000,
  examples: 20,
  synonyms: 20,
  entryBytes: 40000,
});

const stringList = (v, perItem = 400, maxItems = 30) => (Array.isArray(v) ? v : [])
  .filter((x) => typeof x === 'string' && x.trim())
  .map((x) => x.slice(0, perItem))
  .slice(0, maxItems);

function sanitizeExample(e) {
  if (!isPlainObject(e)) return null;
  const en = boundedString(e.en, ENTRY_LIMITS.fieldChars);
  const cn = boundedString(e.cn, ENTRY_LIMITS.fieldChars);
  if (!en && !cn) return null;
  return { en, cn, note: boundedString(e.note, 600) };
}

function sanitizeSynonym(s) {
  if (!isPlainObject(s)) return null;
  const word = boundedString(s.word, ENTRY_LIMITS.headChars);
  if (!word) return null;
  return {
    word,
    phonetic: boundedString(s.phonetic, 120),
    cn: boundedString(s.cn, 600),
    register: boundedString(s.register, 60),
    tone: boundedString(s.tone, 60),
    strength: boundedString(s.strength, 60),
    diff: boundedString(s.diff, ENTRY_LIMITS.fieldChars),
    usage: boundedString(s.usage, ENTRY_LIMITS.fieldChars),
    example: boundedString(s.example, ENTRY_LIMITS.fieldChars),
    exampleCn: boundedString(s.exampleCn, ENTRY_LIMITS.fieldChars),
  };
}

const KINDS = ['word', 'phrase', 'pattern'];

/**
 * 清洗"词典核对"块。
 *
 * 这块是**外部数据**（有道词典的返回），和模型返回的一样不可信 ——
 * 字段可能被对方改、可能夹 HTML、可能塞进超长字符串。所以照样逐字段重建 + 限长，
 * 而不是整块 JSON.parse 进来就用。整块也参与 entryBytes 上限。
 */
export function sanitizeDict(raw) {
  if (!isPlainObject(raw)) return null;
  const head = boundedString(raw.head, ENTRY_LIMITS.headChars).trim();
  const ph = isPlainObject(raw.phonetics) ? raw.phonetics : {};
  const out = {
    source: boundedString(raw.source, 40),
    head,
    phonetics: { uk: boundedString(ph.uk, 120), us: boundedString(ph.us, 120) },
    perPosPhonetics: (Array.isArray(raw.perPosPhonetics) ? raw.perPosPhonetics : [])
      .filter(isPlainObject).slice(0, 12)
      .map((x) => ({ lang: x.lang === 'us' ? 'us' : 'uk', pos: boundedString(x.pos, 20), phone: boundedString(x.phone, 120) }))
      .filter((x) => x.pos && x.phone),
    senses: (Array.isArray(raw.senses) ? raw.senses : [])
      .filter(isPlainObject).slice(0, 10)
      .map((s) => ({ pos: boundedString(s.pos, 20), cn: boundedString(s.cn, 800) }))
      .filter((s) => s.cn),
    examTypes: stringList(raw.examTypes, 40, 10),
    forms: stringList(raw.forms, 80, 8),
    phrases: (Array.isArray(raw.phrases) ? raw.phrases : [])
      .filter(isPlainObject).slice(0, 12)
      .map((p) => ({ en: boundedString(p.en, 200), cn: boundedString(p.cn, 400) }))
      .filter((p) => p.en && p.cn),
    synonyms: (Array.isArray(raw.synonyms) ? raw.synonyms : [])
      .filter(isPlainObject).slice(0, 4)
      .map((s) => ({ pos: boundedString(s.pos, 20), cn: boundedString(s.cn, 400), words: stringList(s.words, 60, 10) }))
      .filter((s) => s.words.length),
    family: (Array.isArray(raw.family) ? raw.family : [])
      .filter(isPlainObject).slice(0, 4)
      .map((f) => ({
        pos: boundedString(f.pos, 20),
        words: (Array.isArray(f.words) ? f.words : []).filter(isPlainObject).slice(0, 8)
          .map((w) => ({ w: boundedString(w.w, 60), cn: boundedString(w.cn, 200) })).filter((w) => w.w),
      }))
      .filter((f) => f.words.length),
    sentences: (Array.isArray(raw.sentences) ? raw.sentences : [])
      .filter(isPlainObject).slice(0, 5)
      .map((s) => ({ en: boundedString(s.en, 400), cn: boundedString(s.cn, 400) }))
      .filter((s) => s.en),
  };
  const useful = out.senses.length || out.phonetics.uk || out.phonetics.us || out.phrases.length || out.examTypes.length;
  return useful ? out : null;
}

/**
 * 把词典核对结果并回词条（只有真取到东西才挂上去，避免同步里多出一堆空壳）。
 * 走 sanitizeEntry 同一条路：两边各写一份清洗逻辑必然漂移。
 */
export function attachDict(entry, dict, conflicts) {
  if (!entry) return entry;
  if (!sanitizeDict(dict)) return entry;
  const out = sanitizeEntry({ ...entry, dict, dictConflicts: conflicts });
  return out || entry;
}

/**
 * 把一个词条清洗成可落库的形状。缺 id 或 head 的返回 null（这种记录没有意义，
 * 而且没有稳定 id 就没法合并/删除）。id 由调用方补。
 */
export function sanitizeEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const id = boundedString(raw.id, ENTRY_LIMITS.idChars + 1);
  if (!id || id.length > ENTRY_LIMITS.idChars) return null;
  const head = boundedString(raw.head, ENTRY_LIMITS.headChars).trim();
  if (!head) return null;

  const meanings = (Array.isArray(raw.meanings) ? raw.meanings : [])
    .filter(isPlainObject).slice(0, 8)
    .map((m) => ({
      pos: boundedString(m.pos, 60),
      cn: boundedString(m.cn, 600),
      en: boundedString(m.en, 1000),
      note: boundedString(m.note, 600),
    }))
    .filter((m) => m.cn || m.en);

  const mnemonicRaw = isPlainObject(raw.mnemonic) ? raw.mnemonic : {};
  const entry = {
    id,
    head,
    kind: KINDS.includes(raw.kind) ? raw.kind : 'word',
    phonetic: boundedString(raw.phonetic, 120),
    pos: boundedString(raw.pos, 120),
    brief: boundedString(raw.brief, 600),
    meanings,
    register: boundedString(raw.register, 120),
    tone: boundedString(raw.tone, 120),
    strength: boundedString(raw.strength, 120),
    scenes: stringList(raw.scenes, 300, 8),
    avoid: boundedString(raw.avoid, 1000),
    mnemonic: {
      image: boundedString(mnemonicRaw.image, 1000),
      hook: boundedString(mnemonicRaw.hook, 600),
      parts: boundedString(mnemonicRaw.parts, 600),
      family: boundedString(mnemonicRaw.family, 600),
    },
    synonyms: (Array.isArray(raw.synonyms) ? raw.synonyms : [])
      .slice(0, ENTRY_LIMITS.synonyms).map(sanitizeSynonym).filter(Boolean),
    collocations: stringList(raw.collocations, 300, 12),
    examples: (Array.isArray(raw.examples) ? raw.examples : [])
      .slice(0, ENTRY_LIMITS.examples).map(sanitizeExample).filter(Boolean),
    confusions: boundedString(raw.confusions, ENTRY_LIMITS.fieldChars),
    usageNotes: boundedString(raw.usageNotes, ENTRY_LIMITS.fieldChars),
    examTips: boundedString(raw.examTips, ENTRY_LIMITS.fieldChars),
    level: boundedString(raw.level, 40),
    source: boundedString(raw.source, 200),
    createdAt: Number(raw.createdAt) || Date.now(),
  };
  // 词典核对块必须在这里透传，否则它会**在云同步/导入的路上被悄悄抹掉**：
  // 快照里的 books[].entries[] 也要过这个函数，漏一个字段就是"本地有、同步到另一台就没了"。
  const dict = sanitizeDict(raw.dict);
  if (dict) {
    entry.dict = dict;
    const c = isPlainObject(raw.dictConflicts) ? raw.dictConflicts : {};
    const phonetics = stringList(c.phonetics, 120, 3);
    const missingPos = stringList(c.missingPos, 20, 6);
    if (phonetics.length || missingPos.length) entry.dictConflicts = { phonetics, missingPos };
  }
  // 单条过大：丢弃这条而不是拒绝整单（免得一条脏数据卡住整个同步）
  return jsonBytes(entry) > ENTRY_LIMITS.entryBytes ? null : entry;
}

const QUIZ_TYPES = ['choice', 'fill', 'translate', 'correct', 'usage'];

/** 清洗自测题。题目缺题干或答案的直接丢（那种题没法做也没法判）。 */
export function sanitizeQuiz(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const questions = (Array.isArray(src.questions) ? src.questions : [])
    .filter(isPlainObject).slice(0, 80)
    .map((q) => {
      const stem = boundedString(q.stem, 4000).trim();
      const answer = String(q.answer == null ? '' : q.answer).slice(0, 2000).trim();
      if (!stem || !answer) return null;
      return {
        type: QUIZ_TYPES.includes(q.type) ? q.type : 'choice',
        stem,
        options: stringList(q.options, 1000, 8),
        answer,
        explanation: boundedString(q.explanation, 4000),
      };
    })
    .filter(Boolean);
  return {
    title: boundedString(src.title, 200) || ('自测题 · ' + questions.length + ' 题'),
    questions,
  };
}

/**
 * 追问回答的清洗。
 *
 * 刻意做得**比查词宽松**：这里要的是人话，不是结构化数据。
 * 只做三件事：去掉代码块围栏、去掉模型爱加的开场白、限长。
 * （模型偶尔还是会吐 JSON —— 那就把里面的 text/answer 字段抠出来，
 *   总比把一整段 JSON 显示给用户强。）
 */
/**
 * 从任意形状里抠出"最像答案"的那段文本。
 * 顺序：常见字段 → 数组第一项 → **对象里最长的那个字符串值**（模型换个 key 也能救回来，
 * 总比把一整段 JSON 甩给用户或者直接报"没有回答"强）。
 */
function pickAnswerText(obj, depth = 0) {
  if (depth > 2 || !obj || typeof obj !== 'object') return '';
  if (Array.isArray(obj)) {
    for (const it of obj) {
      const t = pickAnswerText(it, depth + 1);
      if (t) return t;
    }
    return '';
  }
  for (const key of ['answer', 'text', 'reply', 'content', 'result', 'message', '回答', '答案']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (v && typeof v === 'object') {
      const t = pickAnswerText(v, depth + 1);
      if (t) return t;
    }
  }
  let best = '';
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim().length > best.length) best = v;
    else if (v && typeof v === 'object') {
      const t = pickAnswerText(v, depth + 1);
      if (t.length > best.length) best = t;
    }
  }
  return best;
}

export function sanitizeFollowup(raw) {
  if (raw && typeof raw === 'object') {
    const pick = pickAnswerText(raw);
    if (pick) return sanitizeFollowup(pick);
  }
  let text = boundedString(raw, 8000);
  // ```json ... ``` / ``` ... ``` 围栏
  text = text.replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  // 模型爱加的开场白（"好的，我来回答："这类），去掉它用户才能一眼看到正题。
  // ⚠️ 这里**不能**用 `[^\n]{0,20}` 去兜"回答如下"这类尾巴 —— 它是贪婪的，
  // 会把冒号后面的正文一起吃掉（实测：整段回答被剥成空串）。
  text = text.replace(/^(好的|当然|没问题|明白)[，,。!！]?\s*(我来|我|帮你|给你)?\s*(回答|说|解释|讲|答)(一下|如下|这个问题)?[:：]?\s*/, '').trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const pick = pickAnswerText(JSON.parse(text));
      if (pick && pick.trim()) text = pick.trim();
    } catch { /* 不是 JSON 就原样留着 */ }
  }
  // 剥掉围栏/开场白之后如果空了，把"只去围栏"的版本还回来 —— 有字总比报错强
  if (!text) {
    text = boundedString(raw, 8000).replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  }
  return text.slice(0, 4000).trim();
}

/* ---------- 中文查词候选 ---------- */

/** 候选词：必须有英文词，且去掉重复（同一个词只留第一条） */
export function sanitizeZhCandidates(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const seen = new Set();
  const candidates = (Array.isArray(src.candidates) ? src.candidates : [])
    .filter(isPlainObject).slice(0, 12)
    .map((it) => {
      const word = boundedString(it.word, 80).trim();
      if (!word || seen.has(word.toLowerCase())) return null;
      seen.add(word.toLowerCase());
      return {
        word,
        pos: boundedString(it.pos, 40).trim(),
        phonetic: boundedString(it.phonetic, 80).trim(),
        cn: boundedString(it.cn, 200).trim(),
        register: boundedString(it.register, 40).trim(),
        variant: boundedString(it.variant, 60).trim(),
        note: boundedString(it.note, 400).trim(),
      };
    })
    .filter(Boolean);
  return { term: boundedString(src.term, 80).trim(), candidates };
}

/* ---------- 造句练习：出题与批改的形状清洗 ---------- */

/** 翻译模式的题目：每题必须有词头与中文句子，缺一不可（缺了没法练） */
export function sanitizeSentenceTasks(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const items = (Array.isArray(src.items) ? src.items : [])
    .filter(isPlainObject).slice(0, 30)
    .map((it) => {
      const head = boundedString(it.head, 200).trim();
      const cn = boundedString(it.cn, 600).trim();
      if (!head || !cn) return null;
      return { head, cn, tip: boundedString(it.tip, 300).trim() };
    })
    .filter(Boolean);
  return { title: boundedString(src.title, 200) || ('造句练习 · ' + items.length + ' 题'), items };
}

const SENTENCE_KINDS = ['word', 'grammar', 'context', 'fidelity'];

/**
 * 批改结果。
 *
 * 分数量纲必须收口：模型偶尔会回 8.5（十分制）或 1（百分制小数），
 * 直接显示会变成"8.5 分" —— 用户以为自己做得很差。统一按 0~100 归一。
 */
export function sanitizeSentenceGrade(raw) {
  const src = isPlainObject(raw) ? raw : {};
  let score = Number(src.score);
  if (!Number.isFinite(score)) score = 0;
  if (score > 0 && score <= 1) score *= 100;
  else if (score > 1 && score <= 10) score *= 10;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const problems = (Array.isArray(src.problems) ? src.problems : [])
    .filter(isPlainObject).slice(0, 8)
    .map((p) => {
      const issue = boundedString(p.issue, 400).trim();
      if (!issue) return null;
      return {
        kind: SENTENCE_KINDS.includes(p.kind) ? p.kind : 'context',
        issue,
        fix: boundedString(p.fix, 400).trim(),
      };
    })
    .filter(Boolean);
  const usesTarget = src.usesTarget === undefined ? score > 0 : Boolean(src.usesTarget);
  const strList = (v, cap) => (Array.isArray(v) ? v : [])
    .map((x) => boundedString(x, 300).trim()).filter(Boolean).slice(0, cap);
  return {
    score: usesTarget ? score : Math.min(score, 40),
    usesTarget,
    points: strList(src.points, 12),
    missing: strList(src.missing, 12),
    verdict: boundedString(src.verdict, 600).trim(),
    problems,
    suggestion: boundedString(src.suggestion, 800).trim(),
    corrected: boundedString(src.corrected, 800).trim(),
  };
}
