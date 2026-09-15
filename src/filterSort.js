/**
 * 词条列表的筛选与排序（纯函数，便于测试）。
 *
 * 排序里"掌握度"用的是复习次数与间隔，而不是"感觉"：
 * reps 越多、interval 越长 → 越熟；新词（reps=0）单独一档，方便集中攻克。
 */
import { scheduleOf } from './review.js';

export const SORTS = [
  { key: 'default', label: '默认（加入顺序）' },
  { key: 'due', label: '快到期的优先' },
  { key: 'new', label: '新词优先' },
  { key: 'known', label: '已掌握优先' },
  { key: 'alpha', label: '字母序' },
];

export const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'word', label: '单词' },
  { key: 'phrase', label: '短语' },
  { key: 'pattern', label: '句型' },
  { key: 'due', label: '今天到期' },
  { key: 'new', label: '新词' },
];

/** 一个词条的"掌握度"分数：越大越熟（复习次数为主，间隔为辅） */
export const masteryOf = (schedule) => (Number(schedule?.reps) || 0) * 1000 + (Number(schedule?.interval) || 0);

export function filterEntries(entries, { query = '', filter = 'all' } = {}, schedule = {}, now = Date.now()) {
  const q = String(query || '').trim().toLowerCase();
  return (Array.isArray(entries) ? entries : []).filter((e) => {
    if (!e) return false;
    if (q) {
      const hay = [e.head, e.brief, e.pos, ...(e.meanings || []).map((m) => m.cn), ...(e.synonyms || []).map((s) => s.word)]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filter === 'all') return true;
    if (filter === 'due') return scheduleOf(schedule, e.id, e.createdAt, now).due <= now;
    if (filter === 'new') return (Number(scheduleOf(schedule, e.id, e.createdAt, now).reps) || 0) === 0;
    return e.kind === filter;
  });
}

export function sortEntries(entries, sort = 'default', schedule = {}, now = Date.now()) {
  const list = [...(Array.isArray(entries) ? entries : [])];
  const s = (e) => scheduleOf(schedule, e.id, e.createdAt, now);
  if (sort === 'due') return list.sort((a, b) => s(a).due - s(b).due);
  if (sort === 'new') return list.sort((a, b) => (s(a).reps - s(b).reps) || (a.createdAt - b.createdAt));
  if (sort === 'known') return list.sort((a, b) => masteryOf(s(b)) - masteryOf(s(a)));
  if (sort === 'alpha') return list.sort((a, b) => String(a.head).localeCompare(String(b.head), 'en'));
  return list;
}
