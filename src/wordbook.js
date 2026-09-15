/**
 * 单词本领域逻辑（纯函数，不碰网络与 localStorage）。
 *
 * 为什么单独一个文件：增删改与**合并**是最容易出错、也最该被测试的部分。
 * 合并规则直接决定跨设备同步会不会丢数据 —— 这一块在回译本上踩过"删了又出现"、
 * "改名变成两条"这类坑，所以这里一开始就把墓碑（tombstone）和稳定 id 设计进去。
 *
 * 数据形状：
 *   books: [{ id, name, note, createdAt, entries: [entry] }]
 *   entry: { id, head, kind, phonetic, pos, brief, meanings[], register, tone, strength,
 *            scenes[], avoid, mnemonic{}, synonyms[], collocations[], examples[],
 *            confusions, usageNotes, examTips, level, source, createdAt }
 */

export const KIND_LABEL = { word: '单词', phrase: '短语', pattern: '句型' };

/** 词条的稳定 id（客户端在"手动新增"时用；AI 查词的结果由服务端补） */
export function newEntryId() {
  return 'wb-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
export function newBookId() {
  return 'bk-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 词条的墓碑键：bookId|entryId */
export const entryTombstoneKey = (bookId, entryId) => String(bookId || '') + '|' + String(entryId || '');

/** 单条词条的可读标题（列表用） */
export function entryLabel(entry) {
  if (!entry) return '';
  return entry.head || entry.brief || '(无词条)';
}

/**
 * 规整"词典核对"块。
 *
 * 服务端已经清洗过一遍，这里为什么还要再来一次：这份数据还会从**导入的备份文件**和
 * **云同步快照**回来 —— 那两个来源完全不可信（用户可以手改 JSON，别人可以构造快照）。
 * 卡片渲染时会对 dict.senses 直接 .map、对 examTypes 直接 .join，
 * 少一个校验就是一次白屏。所以照样逐字段重建。
 */
export function sanitizeDictBlock(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const S = (v, max) => String(v == null ? '' : v).slice(0, max);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const ph = raw.phonetics && typeof raw.phonetics === 'object' ? raw.phonetics : {};
  const out = {
    source: S(raw.source, 40),
    head: S(raw.head, 200),
    phonetics: { uk: S(ph.uk, 120), us: S(ph.us, 120) },
    perPosPhonetics: arr(raw.perPosPhonetics).filter((x) => x && typeof x === 'object').slice(0, 12)
      .map((x) => ({ lang: x.lang === 'us' ? 'us' : 'uk', pos: S(x.pos, 20), phone: S(x.phone, 120) })),
    senses: arr(raw.senses).filter((s) => s && typeof s === 'object').slice(0, 10)
      .map((s) => ({ pos: S(s.pos, 20), cn: S(s.cn, 800) })),
    examTypes: arr(raw.examTypes).filter((x) => typeof x === 'string').slice(0, 10),
    forms: arr(raw.forms).filter((x) => typeof x === 'string').slice(0, 8),
    phrases: arr(raw.phrases).filter((p) => p && typeof p === 'object').slice(0, 12)
      .map((p) => ({ en: S(p.en, 200), cn: S(p.cn, 400) })),
  };
  return out.senses.length || out.examTypes.length || out.phonetics.uk || out.phonetics.us ? out : null;
}

/**
 * 规整一个词条（导入/同步来的也要过这一关）。
 * 没有 id 或 head 的返回 null —— 这种记录既没法合并也没法展示。
 */
export function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id || '').trim();
  const head = String(raw.head || '').trim();
  if (!id || !head) return null;
  const S = (v, max = 8000) => String(v == null ? '' : v).slice(0, max);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const dict = sanitizeDictBlock(raw.dict);
  const conflictsRaw = raw.dictConflicts && typeof raw.dictConflicts === 'object' ? raw.dictConflicts : null;
  const conflicts = conflictsRaw ? {
    phonetics: arr(conflictsRaw.phonetics).filter((x) => typeof x === 'string').slice(0, 3),
    missingPos: arr(conflictsRaw.missingPos).filter((x) => typeof x === 'string').slice(0, 6),
  } : null;
  const out = {
    ...raw,
    id,
    head,
    kind: ['word', 'phrase', 'pattern'].includes(raw.kind) ? raw.kind : 'word',
    phonetic: S(raw.phonetic, 120),
    pos: S(raw.pos, 120),
    brief: S(raw.brief, 600),
    meanings: arr(raw.meanings).filter((m) => m && typeof m === 'object'),
    register: S(raw.register, 120),
    tone: S(raw.tone, 120),
    strength: S(raw.strength, 120),
    scenes: arr(raw.scenes).filter((x) => typeof x === 'string'),
    mnemonic: raw.mnemonic && typeof raw.mnemonic === 'object' ? raw.mnemonic : {},
    synonyms: arr(raw.synonyms).filter((x) => x && typeof x === 'object'),
    collocations: arr(raw.collocations).filter((x) => typeof x === 'string'),
    examples: arr(raw.examples).filter((x) => x && typeof x === 'object'),
    createdAt: Number(raw.createdAt) || Date.now(),
  };
  // 注意是用 delete 而不是置 undefined：`...raw` 可能已经带进来一份脏的 dict
  // （手改过的备份文件、构造出来的同步快照），必须显式删掉而不是覆盖成 undefined。
  if (dict) { out.dict = dict; out.dictConflicts = conflicts; }
  else { delete out.dict; delete out.dictConflicts; }
  return out;
}

/** 规整一个单词本 */
export function sanitizeBook(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(raw.name || '未命名单词本').slice(0, 80),
    note: String(raw.note || '').slice(0, 500),
    createdAt: Number(raw.createdAt) || Date.now(),
    entries: (Array.isArray(raw.entries) ? raw.entries : []).map(sanitizeEntry).filter(Boolean),
  };
}

export function createBook(list, name) {
  const book = { id: newBookId(), name: String(name || '新的单词本').slice(0, 80), note: '', createdAt: Date.now(), entries: [] };
  return [...(Array.isArray(list) ? list : []), book];
}

export function renameBook(list, bookId, patch) {
  return (list || []).map((b) => (b.id === bookId
    ? { ...b, name: String(patch.name ?? b.name).slice(0, 80), note: String(patch.note ?? b.note).slice(0, 500) }
    : b));
}

export function removeBook(list, bookId) {
  return (list || []).filter((b) => b.id !== bookId);
}

/** 找出词条所在的第一个本子（用于"这个词在不在我的本子里"） */
export function findEntryBook(list, entryId) {
  for (const b of list || []) {
    if ((b.entries || []).some((e) => e.id === entryId)) return b;
  }
  return null;
}

/**
 * 把一个词条放进指定本子。
 * 同 id 覆盖（不新增），并按 head 判重：同一个词查两次不该变成两条
 * （但 id 不同、head 相同的两条也不该合并 —— 用户可能故意分开存不同语境）。
 * @returns {{list: Array, replaced: boolean}}
 */
export function upsertEntry(list, bookId, rawEntry) {
  const entry = sanitizeEntry(rawEntry);
  if (!entry) return { list, replaced: false };
  let replaced = false;
  const next = (list || []).map((b) => {
    if (b.id !== bookId) return b;
    const idx = (b.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      replaced = true;
      const entries = [...b.entries];
      entries[idx] = { ...entry, createdAt: b.entries[idx].createdAt || entry.createdAt };
      return { ...b, entries };
    }
    return { ...b, entries: [...(b.entries || []), entry] };
  });
  return { list: next, replaced };
}

export function removeEntry(list, bookId, entryId) {
  return (list || []).map((b) => (b.id === bookId
    ? { ...b, entries: (b.entries || []).filter((e) => e.id !== entryId) }
    : b));
}

/** 所有词条摊平（复习队列、出题、统计都要用） */
export function allEntries(list) {
  return (list || []).flatMap((b) => (b.entries || []).map((e) => ({ ...e, bookId: b.id, bookName: b.name })));
}

/**
 * 墓碑过滤：把已删除的本子/词条从合并结果里剔除。
 *
 * ⚠️ 必须做成**合并之后的统一收口**，不能只在"本子已存在"那条分支里判断 ——
 * 第一版就是那么写的：新本子走的是"整体加进来"那条路，墓碑完全没生效，
 * 于是"删掉的词条跟着新本子一起复活"（正是回译本踩过的坑的翻版）。
 * 收口成一步之后，两条分支自动都被覆盖。
 */
export function applyTombstones(list, deletedBooks = [], deletedEntries = []) {
  const deadBooks = new Set(Array.isArray(deletedBooks) ? deletedBooks : []);
  const deadEntries = new Set(Array.isArray(deletedEntries) ? deletedEntries : []);
  return (Array.isArray(list) ? list : [])
    .filter((b) => b && !deadBooks.has(b.id))
    .map((b) => {
      const entries = Array.isArray(b.entries) ? b.entries : [];
      const kept = entries.filter((e) => !(e && e.id && deadEntries.has(entryTombstoneKey(b.id, e.id))));
      return kept.length === entries.length ? b : { ...b, entries: kept };
    });
}

/**
 * 合并两个单词本列表（跨设备同步 / 导入备份都走这里）。
 *
 * 规则（每一条都对应一个踩过的坑）：
 *   · 按 **id** 合并，不按名字 —— 改过名的同一个本子不能变成两个；
 *   · 合并完统一过一遍**墓碑** —— 否则"删了又出现"；
 *   · 词条按 id 合并（同 id 覆盖，不重复）；
 *   · 纯并集，不删除任何一边独有的数据。
 */
export function mergeBooks(current, incoming, deletedBooks = [], deletedEntries = []) {
  let list = (Array.isArray(current) ? current : []).map(sanitizeBook).filter(Boolean);
  let booksAdded = 0;
  let entriesAdded = 0;

  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const clean = sanitizeBook(raw);
    if (!clean) continue;
    const exists = list.find((b) => b.id === clean.id);
    if (!exists) {
      list = [...list, clean];
      booksAdded += 1;
      entriesAdded += clean.entries.length;
      continue;
    }
    for (const entry of clean.entries) {
      const r = upsertEntry(list, clean.id, entry);
      list = r.list;
      if (!r.replaced) entriesAdded += 1;
    }
  }
  // 统一收口：无论走哪条分支，墓碑命中的都不留
  const filtered = applyTombstones(list, deletedBooks, deletedEntries);
  return { list: filtered, booksAdded, entriesAdded };
}

/** 学习统计（界面上的"共 N 个词条 / 今天该复习 M 个"） */
export function summarizeBooks(list) {
  const entries = allEntries(list);
  return {
    books: (list || []).length,
    entries: entries.length,
    byKind: entries.reduce((acc, e) => { acc[e.kind] = (acc[e.kind] || 0) + 1; return acc; }, {}),
  };
}
