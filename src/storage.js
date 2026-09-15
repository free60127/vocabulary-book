/**
 * 本机存储（localStorage）统一入口 + 单词本/复习数据的读写。
 *
 * 为什么所有读写都要包一层：裸调 localStorage 在 Safari 无痕、禁用站点数据、
 * 被 iframe 嵌入时会抛 SecurityError，而这些调用出现在首次 render 的惰性初始化里 ——
 * 一抛就是整页白屏，且没有降级路径。（回译本上实测过。）
 */
import { mergeBooks, sanitizeBook, sanitizeEntry } from './wordbook.js';
import { mergeDays, mergeSchedules } from './review.js';

export const BOOKS_KEY = 'vb-books';
export const SCHEDULE_KEY = 'vb-schedule';
export const DAYS_KEY = 'vb-days';
export const HISTORY_KEY = 'vb-history';
export const DELETED_BOOKS_KEY = 'vb-deleted-books';
export const DELETED_ENTRIES_KEY = 'vb-deleted-entries';
export const SETTINGS_KEY = 'vb-settings';
export const LEVEL_KEY = 'vb-level';

export function safeGet(key, fallback = '') {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch { return fallback; }
}
export function safeSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

const parseArray = (raw) => {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
};
const parseObject = (raw) => {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
};

/* ---------- 单词本 ---------- */
export function loadBooks() {
  return parseArray(safeGet(BOOKS_KEY, '[]')).map(sanitizeBook).filter(Boolean);
}
export const saveBooks = (list) => safeSet(BOOKS_KEY, JSON.stringify(list || []));

/* ---------- 复习排期（与词条分开存：词条是内容，排期是"我练到哪了"） ---------- */
export const loadSchedule = () => parseObject(safeGet(SCHEDULE_KEY, '{}'));
export const saveSchedule = (map) => safeSet(SCHEDULE_KEY, JSON.stringify(map || {}));

/* ---------- 连续学习天数 ---------- */
export const loadDays = () => parseArray(safeGet(DAYS_KEY, '[]')).filter((d) => typeof d === 'string');
export const saveDays = (days) => safeSet(DAYS_KEY, JSON.stringify((Array.isArray(days) ? days : []).slice(0, 400)));

/* ---------- 查询历史 ---------- */
/**
 * 读历史。**这里必须清洗**：历史带着词条快照，而快照会从导入的备份文件、
 * 云同步快照回来 —— 两个来源都不可信。卡片渲染会对 meanings/examples 直接 .map，
 * 一份被改过的备份就能让页面白屏（这正是 sanitizeEntry 存在的理由）。
 */
export const loadHistory = () => parseArray(safeGet(HISTORY_KEY, '[]'))
  .filter((h) => h && typeof h === 'object' && h.id)
  .map((h) => {
    const base = {
      id: String(h.id).slice(0, 64),
      head: String(h.head == null ? '' : h.head).slice(0, 200),
      brief: String(h.brief == null ? '' : h.brief).slice(0, 600),
      at: Number(h.at) || 0,
    };
    const entry = h.entry ? sanitizeEntry(h.entry) : null;
    return entry ? { ...base, entry } : base;
  });

/* ---------- 最近查过 ----------
 * 每条历史里存一份**查完的词条快照**，点历史就能直接回到那张卡片。
 *
 * 以前只存 {id, head, brief}：点一下只是把词填回搜索框，要再点"查一下"、再等一次模型 ——
 * 用户的原话是"点这个最近查过的单词不能直接跳转到查完的界面，加入到单词本的才可以"。
 * 存快照之后：秒开、不花钱、断网也能看（词条本来就是要反复回看的东西）。
 *
 * 代价是 localStorage 和云同步快照会变大，所以三道闸都要有：
 *   · 单条超限的**不存快照**（只留 head），降级成"填回搜索框"的老行为；
 *   · 条数上限 50；
 *   · 总量上限 600KB，超了从最旧的开始丢。
 */
export const HISTORY_LIMIT = 50;
export const HISTORY_BYTES = 600 * 1024;
export const HISTORY_ITEM_BYTES = 16 * 1024;

const itemBytes = (h) => {
  try { return JSON.stringify(h).length; } catch { return Infinity; }
};

/** 把一次查词结果做成历史条目（entry 过大时只留摘要） */
export function makeHistoryItem(entry, at = Date.now()) {
  if (!entry || !entry.id) return null;
  const base = { id: entry.id, head: entry.head, brief: entry.brief || '', at };
  const withEntry = { ...base, entry };
  return itemBytes(withEntry) <= HISTORY_ITEM_BYTES ? withEntry : base;
}

/** 排序 + 条数 + 总量三重收口（pushHistory 与 mergeHistory 共用同一套规则） */
function orderHistory(list, limit, bytes) {
  const out = (Array.isArray(list) ? list : []).filter((h) => h && h.id)
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  const kept = [];
  let used = 0;
  for (const h of out) {
    if (kept.length >= limit) break;
    const size = itemBytes(h);
    if (size !== Infinity && used + size > bytes) {
      // 超预算时，先退一步：丢掉快照只留摘要，摘要也放不下才整条丢
      const slim = h.entry ? { id: h.id, head: h.head, brief: h.brief, at: h.at } : null;
      const slimSize = slim ? itemBytes(slim) : Infinity;
      if (slim && used + slimSize <= bytes) { kept.push(slim); used += slimSize; }
      continue;
    }
    kept.push(h); used += size;
  }
  return kept;
}

/** 压入一条历史：同 id 去重（新的顶掉旧的）、按时间倒序、条数与总量双上限 */
export function pushHistory(list, item, { limit = HISTORY_LIMIT, bytes = HISTORY_BYTES } = {}) {
  if (!item || !item.id) return Array.isArray(list) ? list : [];
  return orderHistory([item, ...(Array.isArray(list) ? list : []).filter((h) => h && h.id !== item.id)], limit, bytes);
}

export const saveHistory = (list) => safeSet(HISTORY_KEY, JSON.stringify(pushHistory(list)));

/* ---------- 删除墓碑 ----------
 * 云同步的合并是**并集**：只在本机删除的话，下一次同步会把云端旧副本原样并回来，
 * 用户看到的就是"删了又出现"。所以删除必须留标记，并把它一起同步出去。 */
const loadIds = (key) => parseArray(safeGet(key, '[]')).filter((x) => typeof x === 'string' && x);
const saveIds = (key, arr, max) => safeSet(key, JSON.stringify([...new Set(arr)].slice(-max)));

export const loadDeletedBooks = () => loadIds(DELETED_BOOKS_KEY);
export const saveDeletedBooks = (arr) => saveIds(DELETED_BOOKS_KEY, arr, 200);
export const loadDeletedEntries = () => loadIds(DELETED_ENTRIES_KEY);
export const saveDeletedEntries = (arr) => saveIds(DELETED_ENTRIES_KEY, arr, 5000);

/* ---------- AI 设置 ---------- */
export const loadSettings = () => parseObject(safeGet(SETTINGS_KEY, '{}'));
export const saveSettings = (s) => safeSet(SETTINGS_KEY, JSON.stringify(s || {}));

/* ---------- 快照：云同步与备份共用 ---------- */
export function localSnapshot({ books, schedule, days, history, deletedBooks, deletedEntries }) {
  return {
    books: Array.isArray(books) ? books : [],
    review: schedule && typeof schedule === 'object' ? schedule : {},
    days: Array.isArray(days) ? days : [],
    history: Array.isArray(history) ? history : [],
    deletedBooks: Array.isArray(deletedBooks) ? deletedBooks : [],
    deletedEntries: Array.isArray(deletedEntries) ? deletedEntries : [],
  };
}

/**
 * 墓碑并集。**本机在前**：本机刚删的那条绝不能被远端的长列表挤掉
 * （回译本上就是 `[...local, ...remote].slice(-limit)` 把本机条目挤没了）。
 */
export function unionTombstones(a, b, limit = 5000) {
  const out = [];
  const seen = new Set();
  for (const id of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(-limit);
}

/**
 * 历史合并：按 id 去重、新的在前。
 *
 * 同一个 id 出现两次时**留 at 更大的那条**（而不是"本机优先"）：
 * 历史里现在带着词条快照，两台设备各查过一次同一个词，谁的新就该留谁的 ——
 * 老实现按出现顺序取第一条，会把本机那份旧快照固定下来，另一端的新讲解永远同步不过来。
 * 两边都没有 at 的（早期数据）退化成原来的"本机优先"。
 */
export function mergeHistory(local, remote, limit = HISTORY_LIMIT) {
  const best = new Map();
  for (const h of [...(Array.isArray(local) ? local : []), ...(Array.isArray(remote) ? remote : [])]) {
    if (!h || !h.id) continue;
    const prev = best.get(h.id);
    if (!prev || (Number(h.at) || 0) > (Number(prev.at) || 0)) best.set(h.id, h);
  }
  return orderHistory([...best.values()], limit, Infinity).slice(0, limit);
}

/** 把云端快照合并进本机（纯计算，不落盘；落盘由调用方决定） */
export function mergeSnapshot(local, remote) {
  const deletedBooks = unionTombstones(local.deletedBooks, remote && remote.deletedBooks, 200);
  const deletedEntries = unionTombstones(local.deletedEntries, remote && remote.deletedEntries, 5000);
  const { list: books, booksAdded, entriesAdded } = mergeBooks(local.books, remote && remote.books, deletedBooks, deletedEntries);
  return {
    books,
    review: mergeSchedules(local.review, remote && remote.review),
    days: mergeDays(local.days, remote && remote.days),
    history: mergeHistory(local.history, remote && remote.history),
    deletedBooks,
    deletedEntries,
    added: { booksAdded, entriesAdded },
  };
}
