/**
 * 本机存储（localStorage）统一入口 + 单词本/复习数据的读写。
 *
 * 为什么所有读写都要包一层：裸调 localStorage 在 Safari 无痕、禁用站点数据、
 * 被 iframe 嵌入时会抛 SecurityError，而这些调用出现在首次 render 的惰性初始化里 ——
 * 一抛就是整页白屏，且没有降级路径。（回译本上实测过。）
 */
import { mergeBooks, sanitizeBook } from './wordbook.js';
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
export const loadHistory = () => parseArray(safeGet(HISTORY_KEY, '[]')).filter((h) => h && typeof h === 'object');
export const saveHistory = (list) => safeSet(HISTORY_KEY, JSON.stringify((Array.isArray(list) ? list : []).slice(0, 200)));

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

/** 历史合并：按 id 去重、新的在前、只留最近 N 条 */
export function mergeHistory(local, remote, limit = 200) {
  const seen = new Set();
  const out = [];
  for (const h of [...(Array.isArray(local) ? local : []), ...(Array.isArray(remote) ? remote : [])]) {
    if (!h || !h.id || seen.has(h.id)) continue;
    seen.add(h.id);
    out.push(h);
  }
  return out.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).slice(0, limit);
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
