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
