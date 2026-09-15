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
