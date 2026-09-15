/**
 * 本机存储（localStorage）统一入口 + 单词本/复习数据的读写。
 *
 * 为什么所有读写都要包一层：裸调 localStorage 在 Safari 无痕、禁用站点数据、
 * 被 iframe 嵌入时会抛 SecurityError，而这些调用出现在首次 render 的惰性初始化里 ——
 * 一抛就是整页白屏，且没有降级路径。（回译本上实测过。）
 */
import { mergeBooks, sanitizeBook, sanitizeEntry } from './wordbook.js';
import { mergeFavorites } from './favorites.js';
import { mergeDays, mergeSchedules, mergeWrong } from './review.js';

export const BOOKS_KEY = 'vb-books';
export const SCHEDULE_KEY = 'vb-schedule';
export const DAYS_KEY = 'vb-days';
export const HISTORY_KEY = 'vb-history';
export const DELETED_BOOKS_KEY = 'vb-deleted-books';
export const DELETED_ENTRIES_KEY = 'vb-deleted-entries';
export const SETTINGS_KEY = 'vb-settings';
/** 收藏夹（近义词行上点 ⭐ 攒下来的"待细看"的词） */
export const FAVORITES_KEY = 'vb-favorites';
export const DELETED_FAVORITES_KEY = 'vb-deleted-favorites';
/** 已斩掉的词：`{ 词头: 时间戳 }`；配套一份"复活"记录，合并时比时间戳（见 review.js 的 killedSet） */
export const KILLED_KEY = 'vb-killed';
export const REVIVED_KEY = 'vb-revived';
/** 拼写模式开关 */
export const SPELL_KEY = 'vb-spell';
/** 上次导出备份的时间（用来提醒"很久没备份了"） */
export const LAST_EXPORT_KEY = 'vb-last-export';
/** 错词本：`{ 词头: {head, brief, count, reason, at, firstAt} }` */
export const WRONG_KEY = 'vb-wrong';
/** 卡片追问的问答（本机留档，不进云同步：它是"聊过什么"，不是学习数据） */
export const FOLLOWUPS_KEY = 'vb-followups';
/** 侧栏开合（只在桌面端记住；手机端每次进来都收起，见 App.jsx 的说明） */
export const SIDE_STATE_KEY = 'vb-sidebar';
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
export const loadFavorites = () => parseArray(safeGet(FAVORITES_KEY, '[]')).filter((f) => f && typeof f === 'object');
export const saveFavorites = (list) => safeSet(FAVORITES_KEY, JSON.stringify((Array.isArray(list) ? list : []).slice(0, 500)));
export const loadDeletedFavorites = () => parseArray(safeGet(DELETED_FAVORITES_KEY, '[]')).filter((x) => typeof x === 'string' && x);
/** 已斩掉 / 已复活：都是 `{词头: 时间戳}`，只保留数字，脏数据直接丢 */
const loadStampMap = (key) => {
  const raw = parseObject(safeGet(key, '{}'));
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const t = Number(v);
    if (k && Number.isFinite(t) && t > 0) out[String(k).slice(0, 200)] = t;
  }
  return out;
};
const saveStampMap = (key, map) => {
  const entries = Object.entries(map && typeof map === 'object' ? map : {})
    .filter(([k, v]) => k && Number.isFinite(Number(v)))
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 3000);
  safeSet(key, JSON.stringify(Object.fromEntries(entries)));
};
export const loadKilled = () => loadStampMap(KILLED_KEY);
export const saveKilled = (map) => saveStampMap(KILLED_KEY, map);
export const loadRevived = () => loadStampMap(REVIVED_KEY);
export const saveRevived = (map) => saveStampMap(REVIVED_KEY, map);
export const loadLastExportAt = () => Number(safeGet(LAST_EXPORT_KEY, '0')) || 0;
export const saveLastExportAt = (ts) => safeSet(LAST_EXPORT_KEY, String(Number(ts) || Date.now()));
export const loadSpell = () => safeGet(SPELL_KEY, '') === '1';
export const saveSpell = (on) => safeSet(SPELL_KEY, on ? '1' : '0');

/* ---------- 错词本 ---------- */
export const loadWrong = () => {
  const raw = parseObject(safeGet(WRONG_KEY, '{}'));
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k || !v || typeof v !== 'object') continue;
    out[String(k).slice(0, 200)] = {
      head: String(v.head || k).slice(0, 200),
      brief: String(v.brief || '').slice(0, 600),
      phonetic: String(v.phonetic || '').slice(0, 120),
      count: Math.min(999, Math.max(1, Number(v.count) || 1)),
      reason: ['forgot', 'spell', 'reveal'].includes(v.reason) ? v.reason : 'forgot',
      at: Number(v.at) || 0,
      firstAt: Number(v.firstAt) || Number(v.at) || 0,
    };
  }
  return out;
};
export const saveWrong = (map) => {
  const entries = Object.entries(map && typeof map === 'object' ? map : {})
    .sort((a, b) => (Number(b[1] && b[1].at) || 0) - (Number(a[1] && a[1].at) || 0))
    .slice(0, 2000);
  safeSet(WRONG_KEY, JSON.stringify(Object.fromEntries(entries)));
};

/* ---------- 卡片追问的问答留档 ---------- */
/** 结构：`{ [entryId]: [{ q, a, at }] }`；每个词条最多 20 条、总共最多 200 个词条 */
export const loadFollowups = () => {
  const raw = parseObject(safeGet(FOLLOWUPS_KEY, '{}'));
  const out = {};
  for (const [id, list] of Object.entries(raw)) {
    if (!id || !Array.isArray(list)) continue;
    const clean = list
      .filter((x) => x && typeof x === 'object' && (x.q || x.a))
      .slice(-20)
      .map((x) => ({ q: String(x.q || '').slice(0, 500), a: String(x.a || '').slice(0, 4000), at: Number(x.at) || 0 }));
    if (clean.length) out[id] = clean;
  }
  return out;
};
export const saveFollowups = (map) => {
  const entries = Object.entries(map && typeof map === 'object' ? map : {})
    .filter(([id, list]) => id && Array.isArray(list) && list.length)
    .sort((a, b) => {
      const at = (l) => (l[1].length ? Number(l[1][l[1].length - 1].at) || 0 : 0);
      return at(b) - at(a);
    })
    .slice(0, 200);
  safeSet(FOLLOWUPS_KEY, JSON.stringify(Object.fromEntries(entries)));
};
export const saveDeletedFavorites = (list) => safeSet(DELETED_FAVORITES_KEY, JSON.stringify((Array.isArray(list) ? list : []).slice(-2000)));

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
export function localSnapshot({ books, schedule, days, history, favorites, deletedBooks, deletedEntries, deletedFavorites, killed, revived, wrong }) {
  return {
    books: Array.isArray(books) ? books : [],
    review: schedule && typeof schedule === 'object' ? schedule : {},
    days: Array.isArray(days) ? days : [],
    history: Array.isArray(history) ? history : [],
    favorites: Array.isArray(favorites) ? favorites : [],
    deletedBooks: Array.isArray(deletedBooks) ? deletedBooks : [],
    deletedEntries: Array.isArray(deletedEntries) ? deletedEntries : [],
    deletedFavorites: Array.isArray(deletedFavorites) ? deletedFavorites : [],
    killed: killed && typeof killed === 'object' ? killed : {},
    revived: revived && typeof revived === 'object' ? revived : {},
    wrong: wrong && typeof wrong === 'object' ? wrong : {},
  };
}

/**
 * 时间戳表的合并：每个键取**更晚**的那次操作。
 * 斩掉与复活是两个独立的表，所以"先斩后恢复"和"先恢复后斩"都能得到正确结果 ——
 * 并集式的墓碑做不到这一点（恢复永远赢不了，用户会看到斩掉的词自己回来）。
 */
export function mergeStamps(a, b, limit = 3000) {
  const out = { ...(a && typeof a === 'object' ? a : {}) };
  for (const [k, v] of Object.entries(b && typeof b === 'object' ? b : {})) {
    if (!k) continue;
    const t = Number(v) || 0;
    if (t > (Number(out[k]) || 0)) out[k] = t;
  }
  const entries = Object.entries(out).sort((x, y) => Number(y[1]) - Number(x[1])).slice(0, limit);
  return Object.fromEntries(entries);
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
  const deletedFavorites = unionTombstones(local.deletedFavorites, remote && remote.deletedFavorites, 2000);
  const { list: books, booksAdded, entriesAdded } = mergeBooks(local.books, remote && remote.books, deletedBooks, deletedEntries);
  // 收藏夹同样要过墓碑：不然"删掉的收藏"会在下一次同步里被云端旧副本复活
  const dead = new Set(deletedFavorites);
  const favorites = mergeFavorites(local.favorites, remote && remote.favorites).filter((f) => !dead.has(f.id));
  return {
    books,
    review: mergeSchedules(local.review, remote && remote.review),
    days: mergeDays(local.days, remote && remote.days),
    history: mergeHistory(local.history, remote && remote.history),
    favorites,
    deletedBooks,
    deletedEntries,
    deletedFavorites,
    killed: mergeStamps(local.killed, remote && remote.killed),
    revived: mergeStamps(local.revived, remote && remote.revived),
    // 错词本按词头合并：取"次数更多 + 更近"的那份（同一份错不该被数两遍）
    wrong: mergeWrong(local.wrong, remote && remote.wrong),
    added: { booksAdded, entriesAdded, favoritesAdded: favorites.length },
  };
}
