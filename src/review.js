/**
 * 复习排期（SM-2 简化版）+ 连续学习天数。
 *
 * 算法本身是从「回译本」的收藏夹复习原样搬过来的 —— 那边已经跑过一阵、也有测试。
 * 与那边的区别：**排期不塞在词条里，而是单独一张表** `{ entryId: {ease,interval,due,reps,lapses} }`。
 * 理由是词条是"内容"（会跨设备同步、会被导出分享），而排期是"我练到哪了"；
 * 分开之后，把词条复制给同学不会连带把你的复习进度也带过去。
 */

const DAY = 24 * 60 * 60 * 1000;

export const EASE_START = 2.5;
export const EASE_MIN = 1.3;
export const EASE_MAX = 3.0;
export const INTERVAL_MAX = 365;

/** 三档评分：忘了 / 一般 / 简单（界面上的按钮文案与"下次几天后见"都取这里） */
export const GRADES = {
  forgot: { key: 'forgot', label: '忘了', tone: 'err' },
  normal: { key: 'normal', label: '一般', tone: 'mid' },
  easy: { key: 'easy', label: '简单', tone: 'ok' },
};
export const GRADE_KEYS = Object.keys(GRADES);
const isGrade = (g) => Object.prototype.hasOwnProperty.call(GRADES, g);

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round2 = (n) => Math.round(n * 100) / 100;

/** 新排期：建完当天就该复习 */
export const newSchedule = (now = Date.now()) => ({
  ease: EASE_START, interval: 0, due: now, reps: 0, lapses: 0, lastReviewed: 0, lastGrade: '',
});

/** 把一条排期规整到合法范围（旧数据/脏数据都过这里） */
export function normalizeSchedule(raw, createdAt = 0, now = Date.now()) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const ease = Math.min(EASE_MAX, Math.max(EASE_MIN, num(s.ease, EASE_START) || EASE_START));
  const interval = Math.max(0, Math.min(INTERVAL_MAX, Math.round(num(s.interval, 0))));
  const due = num(s.due, 0) > 0 ? num(s.due, 0) : (num(createdAt, 0) || now);
  return {
    ease: round2(ease),
    interval,
    due,
    reps: Math.max(0, Math.round(num(s.reps, 0))),
    lapses: Math.max(0, Math.round(num(s.lapses, 0))),
    lastReviewed: Math.max(0, num(s.lastReviewed, 0)),
    lastGrade: isGrade(s.lastGrade) ? s.lastGrade : '',
  };
}

/**
 * 评一次分，返回新的排期。
 * 忘了：回到 1 天、难度因子下调；一般：间隔 ×难度因子；简单：再 ×1.3 并上调因子。
 */
export function sm2Review(schedule, grade, now = Date.now()) {
  const cur = normalizeSchedule(schedule, 0, now);
  const g = isGrade(grade) ? grade : 'normal';
  let { ease, interval, reps, lapses } = cur;
  if (g === 'forgot') {
    reps = 0;
    lapses += 1;
    interval = 1;
    ease = Math.max(EASE_MIN, ease - 0.2);
  } else if (g === 'normal') {
    interval = reps === 0 ? 1 : reps === 1 ? 3 : Math.max(1, Math.round(interval * ease));
    reps += 1;
  } else {
    interval = reps === 0 ? 2 : reps === 1 ? 6 : Math.max(1, Math.round(interval * ease * 1.3));
    reps += 1;
    ease = Math.min(EASE_MAX, ease + 0.15);
  }
  interval = Math.max(1, Math.min(INTERVAL_MAX, interval));
  return {
    ease: round2(ease),
    interval,
    reps,
    lapses,
    due: now + interval * DAY,
    lastReviewed: now,
    lastGrade: g,
  };
}

/** 评分按钮上预告的"下次几天后再见" */
export function gradeHint(schedule, grade, now = Date.now()) {
  const next = sm2Review(schedule, grade, now);
  return next.interval <= 1 ? '明天再见' : next.interval + ' 天后再见';
}

/** 取某个词条的排期（没有就按"现在到期"处理，这样新词会立刻进复习队列） */
export function scheduleOf(map, entryId, createdAt = 0, now = Date.now()) {
  const raw = map && typeof map === 'object' ? map[entryId] : null;
  return normalizeSchedule(raw || newSchedule(createdAt || now), createdAt, now);
}

/** 今天该复习的词条（按"拖得最久"排序，最该先复习的排前面） */
export function dueEntries(entries, map, now = Date.now()) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.id)
    .map((e) => ({ entry: e, schedule: scheduleOf(map, e.id, e.createdAt, now) }))
    .filter((x) => x.schedule.due <= now)
    .sort((a, b) => a.schedule.due - b.schedule.due);
}

/** 下一次复习在什么时候（用来显示"明天还有 N 个"） */
export function nextDueAt(entries, map, now = Date.now()) {
  let min = Infinity;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !e.id) continue;
    const due = scheduleOf(map, e.id, e.createdAt, now).due;
    if (due > now && due < min) min = due;
  }
  return Number.isFinite(min) ? min : 0;
}

/** "2 天后 / 今天 / 已到期"这类人话 */
export function dueLabel(schedule, now = Date.now()) {
  const d = num(schedule && schedule.due, 0);
  if (!d) return '今天';
  const days = Math.ceil((d - now) / DAY);
  if (days <= 0) return '今天';
  if (days === 1) return '明天';
  return days + ' 天后';
}

/** 合并两张排期表：同一条取"已复习过且更新"的那份（否则取到期更晚的那份，避免重复刷） */
export function mergeSchedules(local, incoming) {
  const out = { ...(local && typeof local === 'object' ? local : {}) };
  for (const [id, raw] of Object.entries(incoming && typeof incoming === 'object' ? incoming : {})) {
    if (!id) continue;
    const inc = normalizeSchedule(raw);
    const cur = out[id] ? normalizeSchedule(out[id]) : null;
    if (!cur) { out[id] = inc; continue; }
    const incNewer = num(inc.lastReviewed, 0) > num(cur.lastReviewed, 0);
    const incLater = num(inc.due, 0) > num(cur.due, 0);
    if (incNewer || (!num(cur.lastReviewed, 0) && incLater)) out[id] = inc;
  }
  return out;
}

/* ---------- 连续学习天数 ---------- */

const dayKey = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};
export { dayKey };

/** 记一天（去重、只留最近 400 天） */
export function addStudyDay(days, ts = Date.now()) {
  const key = dayKey(ts);
  const list = [...new Set([...(Array.isArray(days) ? days : []), key])].sort().reverse();
  return list.slice(0, 400);
}

/** 当前连续天数 / 今天是否已学 / 历史最长 */
export function summarizeStreak(days, now = Date.now()) {
  const set = new Set(Array.isArray(days) ? days : []);
  const today = dayKey(now);
  const todayDone = set.has(today);
  let current = 0;
  // 从今天（或昨天，今天还没学时从昨天起算）往前数连续的天数
  let cursor = now;
  if (!todayDone) cursor = now - DAY;
  while (set.has(dayKey(cursor))) {
    current += 1;
    cursor -= DAY;
  }
  const sorted = [...set].sort();
  let longest = 0;
  let run = 0;
  let prev = '';
  for (const d of sorted) {
    const prevDate = prev ? new Date(prev + 'T00:00:00') : null;
    run = prevDate && (new Date(d + 'T00:00:00') - prevDate === DAY) ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { current, todayDone, longest, total: set.size };
}

export const mergeDays = (a, b) => [...new Set([
  ...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : []),
])].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().slice(0, 400);

/* ==========================================================================
   复习队列：单词本词条 + 收藏夹 + 已斩掉的词
   --------------------------------------------------------------------------
   为什么要收口成一个纯函数：这三样东西的"谁进队列、谁不进"是**业务规则**，
   以前写死在组件的 useMemo 里，改一次要靠肉眼确认没把别的东西带进来。
   抽到这里之后可以直接单测（见 test/review.test.mjs）。
   ========================================================================== */

/** 词头归一化：同一个词的不同写法/大小写/空格都算同一个（与 wordbook.js 保持一致） */
export const headKey = (head) => String(head || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * 已斩掉的词集合。
 * 存的是 `{ 词头: 时间戳 }` + 一份"复活"记录，两边都取每个词的最新时间戳再比大小 ——
 * 这样 A 设备斩掉、B 设备恢复之后，合并结果以**更晚的那次操作**为准
 * （单纯做并集的话，恢复永远赢不了，用户会看到"斩掉的词又回来了"）。
 */
export function killedSet(killed, revived) {
  const k = killed && typeof killed === 'object' ? killed : {};
  const r = revived && typeof revived === 'object' ? revived : {};
  const out = new Set();
  for (const key of Object.keys(k)) {
    if (!key) continue;
    const at = Number(k[key]) || 0;
    const back = Number(r[key]) || 0;
    if (at > back) out.add(key);
  }
  return out;
}

/** 单个词头是否被斩掉 */
export const isKilledHead = (killed, revived, head) => killedSet(killed, revived).has(headKey(head));

/**
 * 组一份"今天要复习什么"的清单。
 *
 * 规则（每条都对应一个用户会遇到的场景）：
 *  ① 单词本里的词条：到期的都要；
 *  ② 收藏夹里**还没收进单词本**的词也要 —— 收藏夹就是"回头细看"，
 *     只躺在侧栏里等于永远不看；已经在某个本子里的不再重复出现（同一个词复习两次很烦）；
 *  ③ 被斩掉的词一律不进（用户明确说过"这个我认识，别再问我"）。
 *
 * @returns {Array<{key,kind,head,phonetic,schedule,entry?,favorite?}>} 按"拖得最久"排序
 */
export function buildReviewQueue({ entries, favorites, schedule, killed, revived, now = Date.now() }) {
  const dead = killedSet(killed, revived);
  const bookHeads = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e && e.head) bookHeads.add(headKey(e.head));
  }
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !e.id || dead.has(headKey(e.head))) continue;
    out.push({ key: e.id, kind: 'entry', head: e.head, phonetic: e.phonetic || '', entry: e, schedule: scheduleOf(schedule, e.id, e.createdAt, now) });
  }
  for (const f of Array.isArray(favorites) ? favorites : []) {
    if (!f || !f.id || !f.head) continue;
    const key = headKey(f.head);
    if (dead.has(key) || bookHeads.has(key)) continue;   // 斩掉的 / 已经在单词本里的，都不重复进
    out.push({ key: f.id, kind: 'favorite', head: f.head, phonetic: f.phonetic || '', favorite: f, schedule: scheduleOf(schedule, f.id, f.at || 0, now) });
  }
  return out.filter((x) => x.schedule.due <= now).sort((a, b) => a.schedule.due - b.schedule.due);
}

/**
 * 拼写判定：忽略大小写、首尾空格、连续空格；词条里的 "to " 这类前缀也容忍
 * （用户手打时不会去区分 "object to sth" 和 "object"）。
 */
const TAIL_WORDS = new Set(['to', 'for', 'with', 'on', 'in', 'of', 'at', 'about', 'into', 'from',
  'sth', 'sb', 'someone', 'something', 'doing', 'that', 'whether', 'up', 'off']);
export function checkSpelling(input, head) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const want = norm(head);
  const got = norm(input);
  if (!got) return false;
  if (got === want) return true;
  // "object to sth" / "object to doing" 这类词条：允许用户只打主词
  // （但 "pull off" / "no sooner ... than" 必须打全 —— 否则打一个 "no" 就算对了）
  const parts = want.split(' ');
  const first = parts[0];
  if (parts.length > 1 && got === first && TAIL_WORDS.has(parts[1])) return true;
  const main = want.split(/[(（,，;；/]/)[0].trim();
  return Boolean(main) && got === main && main !== first;
}

/** 提示分三级：首字母 → 一半字母 → 整个答案 */
export function spellHint(head, level) {
  const w = String(head || '');
  if (!w) return '';
  if (level <= 1) return w.slice(0, 1) + ' ' + '_'.repeat(Math.max(0, w.length - 1));
  if (level === 2) {
    const keep = Math.ceil(w.length / 2);
    return w.slice(0, keep) + ' ' + '_'.repeat(Math.max(0, w.length - keep));
  }
  return w;
}

/* ==========================================================================
   错词本：复习里"没答上来"的词单独攒一份
   --------------------------------------------------------------------------
   为什么要有：SM-2 的排期决定"什么时候再问"，但用户还需要一个地方回答
   "我到底哪些词不行" —— 三天后到期的词里混着早就掌握的和一直错的，
   只看"今日待复习"分不出来。错词本也是"考前一小时该看什么"的答案。
   规则：
     · 评「忘了」、拼写出错、拼写提示点满 → 进错词本（次数累加）；
     · 评「简单」或一次拼对 → 出本（说明这个坎过去了）；
     · 跨设备合并时按词头取"次数最多 + 最近一次"，不累加（同一份错不该被数两遍）。
   ========================================================================== */

/** 一条错词记录：`{ head, brief, phonetic, count, reason, at, firstAt }` */
export function addWrong(map, head, reason = 'forgot', extra = {}, now = Date.now()) {
  const key = headKey(head);
  if (!key) return map && typeof map === 'object' ? map : {};
  const base = map && typeof map === 'object' ? map : {};
  const prev = base[key] && typeof base[key] === 'object' ? base[key] : null;
  return {
    ...base,
    [key]: {
      head: String(head || '').slice(0, 200),
      brief: String((extra && extra.brief) || (prev && prev.brief) || '').slice(0, 600),
      phonetic: String((extra && extra.phonetic) || (prev && prev.phonetic) || '').slice(0, 120),
      count: Math.min(999, ((prev && Number(prev.count)) || 0) + 1),
      reason: ['forgot', 'spell', 'reveal'].includes(reason) ? reason : 'forgot',
      at: now,
      firstAt: (prev && Number(prev.firstAt)) || now,
    },
  };
}

/** 答对了就出本（"这个坎过去了"） */
export function clearWrong(map, head) {
  const key = headKey(head);
  if (!key || !map || typeof map !== 'object' || !map[key]) return map || {};
  const next = { ...map };
  delete next[key];
  return next;
}

/** 跨设备合并：每个词取次数更多、时间更近的那份（累加会把同一份错数两遍） */
export function mergeWrong(a, b, limit = 2000) {
  const out = { ...(a && typeof a === 'object' ? a : {}) };
  for (const [key, raw] of Object.entries(b && typeof b === 'object' ? b : {})) {
    if (!key || !raw || typeof raw !== 'object') continue;
    const cur = out[key];
    const incCount = Math.min(999, Math.max(0, Number(raw.count) || 0));
    const curCount = cur ? Math.min(999, Math.max(0, Number(cur.count) || 0)) : -1;
    const incAt = Number(raw.at) || 0;
    const curAt = cur ? Number(cur.at) || 0 : -1;
    if (!cur || incCount > curCount || (incCount === curCount && incAt > curAt)) out[key] = { ...raw, count: incCount };
  }
  const entries = Object.entries(out).sort((x, y) => (Number(y[1] && y[1].at) || 0) - (Number(x[1] && x[1].at) || 0)).slice(0, limit);
  return Object.fromEntries(entries);
}

/**
 * 错词清单（给人看的）：补上释义，按"错得最多 / 最近错"排序。
 * 词条已被删掉也要能显示 —— 用户得看得见、清得掉，否则错词本会一直挂着幽灵条目。
 */
export function wrongList(map, entries, favorites) {
  const byHead = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e && e.head) byHead.set(headKey(e.head), { brief: (e.meanings && e.meanings[0] && e.meanings[0].cn) || e.brief || '', phonetic: e.phonetic || '', inBook: true });
  }
  for (const f of Array.isArray(favorites) ? favorites : []) {
    if (f && f.head && !byHead.has(headKey(f.head))) byHead.set(headKey(f.head), { brief: f.brief || '', phonetic: f.phonetic || '', inBook: false });
  }
  return Object.entries(map && typeof map === 'object' ? map : {})
    .filter(([key, v]) => key && v && typeof v === 'object')
    .map(([key, v]) => {
      const hit = byHead.get(key);
      return {
        key,
        head: v.head || key,
        brief: (hit && hit.brief) || v.brief || '',
        phonetic: (hit && hit.phonetic) || v.phonetic || '',
        count: Math.max(1, Number(v.count) || 1),
        reason: v.reason || 'forgot',
        at: Number(v.at) || 0,
        inBook: Boolean(hit && hit.inBook),
        exists: Boolean(hit),
      };
    })
    .sort((a, b) => (b.count - a.count) || (b.at - a.at));
}

/** 错词本的复习卡：优先用本子里的完整词条，其次收藏项，都没有就用错词记录里的那点信息 */
export function buildWrongQueue({ wrong, entries, favorites, schedule, killed, revived, now = Date.now() }) {
  const dead = killedSet(killed, revived);
  const eByHead = new Map();
  for (const e of Array.isArray(entries) ? entries : []) if (e && e.head) eByHead.set(headKey(e.head), e);
  const fByHead = new Map();
  for (const f of Array.isArray(favorites) ? favorites : []) if (f && f.head && !fByHead.has(headKey(f.head))) fByHead.set(headKey(f.head), f);
  return wrongList(wrong, entries, favorites)
    .filter((w) => !dead.has(w.key))
    .map((w) => {
      const entry = eByHead.get(w.key);
      const favorite = entry ? null : fByHead.get(w.key);
      const key = entry ? entry.id : favorite ? favorite.id : 'wrong:' + w.key;
      return {
        key,
        kind: entry ? 'entry' : favorite ? 'favorite' : 'wrong',
        head: w.head,
        phonetic: w.phonetic,
        brief: w.brief,
        entry, favorite,
        wrong: { count: w.count, reason: w.reason },
        schedule: scheduleOf(schedule, key, 0, now),
      };
    });
}
