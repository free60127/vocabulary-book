/**
 * 复习排期（SM-2）与连续学习天数测试。
 *
 * 为什么值得测：排期算错的表现很隐蔽 —— 不会报错，只会让用户"明明复习了、第二天还全是到期"，
 * 或者间隔暴涨到几年后（等于再也不复习）。边界（难度因子上下限、间隔上限、时钟回拨）都要钉住。
 *
 * 跑法：node test/review.test.mjs
 */
import {
  EASE_MAX, EASE_MIN, GRADES, INTERVAL_MAX, addStudyDay, dayKey, dueEntries, dueLabel,
  gradeHint, mergeDays, mergeSchedules, newSchedule, nextDueAt, normalizeSchedule,
  scheduleOf, sm2Review, summarizeStreak,
} from '../src/review.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 15, 12, 0, 0);   // 固定时间，避免"跑测试的当天"影响结果

console.log('=== 复习排期测试 ===\n');

/* ---------- 1. 新排期：建完当天就该复习 ---------- */
{
  const s = newSchedule(T0);
  check('新词条当天即到期（否则新词永远不进复习队列）', s.due === T0 && s.interval === 0 && s.reps === 0);
  check('初始难度因子是 2.5', s.ease === 2.5);
  check('三档评分都有中文标签', GRADES.forgot.label === '忘了' && GRADES.normal.label === '一般' && GRADES.easy.label === '简单');
}

/* ---------- 2. 三档评分的间隔推进 ---------- */
{
  let s = newSchedule(T0);
  s = sm2Review(s, 'normal', T0);
  check('第一次「一般」→ 1 天后', s.interval === 1 && s.due === T0 + DAY, `${s.interval} 天`);
  s = sm2Review(s, 'normal', T0 + DAY);
  check('第二次「一般」→ 3 天后', s.interval === 3, `${s.interval} 天`);
  s = sm2Review(s, 'normal', T0 + 4 * DAY);
  check('第三次起按难度因子放大', s.interval === Math.round(3 * 2.5), `${s.interval} 天`);

  let e = newSchedule(T0);
  e = sm2Review(e, 'easy', T0);
  check('第一次「简单」→ 2 天后', e.interval === 2, `${e.interval} 天`);
  e = sm2Review(e, 'easy', T0 + 2 * DAY);
  check('第二次「简单」→ 6 天后，且难度因子上调', e.interval === 6 && e.ease > 2.5, `${e.interval} 天 / ease ${e.ease}`);
}

/* ---------- 3. 「忘了」要真的回到起点 ---------- */
{
  let s = newSchedule(T0);
  for (let i = 0; i < 4; i += 1) s = sm2Review(s, 'normal', T0 + i * DAY);
  const before = s.interval;
  const after = sm2Review(s, 'forgot', T0 + 10 * DAY);
  check('「忘了」把间隔打回 1 天', after.interval === 1, `${before} → ${after.interval}`);
  check('「忘了」重置连续次数并记一次失误', after.reps === 0 && after.lapses === 1);
  check('「忘了」下调难度因子（但不低于下限）', after.ease < 2.5 && after.ease >= EASE_MIN, `ease ${after.ease}`);
}

/* ---------- 4. 边界：不会算出"几年后再见" ---------- */
{
  let s = newSchedule(T0);
  for (let i = 0; i < 60; i += 1) s = sm2Review(s, 'easy', T0 + i * DAY);
  check(`间隔被上限 ${INTERVAL_MAX} 天截住`, s.interval <= INTERVAL_MAX, `${s.interval} 天`);
  check('难度因子不超过上限', s.ease <= EASE_MAX, `ease ${s.ease}`);
  const low = sm2Review({ ease: EASE_MIN, interval: 5, reps: 3 }, 'forgot', T0);
  check('难度因子不低于下限', low.ease >= EASE_MIN, `ease ${low.ease}`);
}

/* ---------- 5. 脏排期与时钟回拨 ---------- */
{
  const dirty = normalizeSchedule({ ease: 99, interval: -5, due: 'x', reps: -1 });
  check('脏排期被夹到合法范围', dirty.ease === EASE_MAX && dirty.interval === 0 && dirty.reps === 0, JSON.stringify(dirty));
  check('非对象排期不崩', normalizeSchedule(null).ease === 2.5 && normalizeSchedule('x').reps === 0);
  const fallback = scheduleOf({}, 'w1', T0, T0 + 5 * DAY);
  check('没有排期的词条按 createdAt 起算到期', fallback.due === T0, String(fallback.due));
}

/* ---------- 6. 到期队列 ---------- */
{
  const entries = [
    { id: 'w1', head: 'a', createdAt: T0 },
    { id: 'w2', head: 'b', createdAt: T0 },
    { id: 'w3', head: 'c', createdAt: T0 },
  ];
  const map = {
    w1: { ease: 2.5, interval: 3, due: T0 + 3 * DAY, reps: 2 },
    w2: { ease: 2.5, interval: 1, due: T0 - DAY, reps: 1 },     // 拖了一天
    w3: { ease: 2.5, interval: 10, due: T0 + 10 * DAY, reps: 3 },
  };
  const due = dueEntries(entries, map, T0);
  check('只挑出到期的', due.map((x) => x.entry.id).join() === 'w2', due.map((x) => x.entry.id).join());
  check('拖得最久的排最前', due[0].entry.id === 'w2');
  check('没排期的词条立刻到期（新词能练）', dueEntries([{ id: 'w9', createdAt: T0 }], {}, T0).length === 1);
  check('下一次复习时间取最小未来值', nextDueAt(entries, map, T0) === T0 + 3 * DAY);
  check('dueLabel 说人话', dueLabel({ due: T0 - DAY }, T0) === '今天' && dueLabel({ due: T0 + DAY }, T0) === '明天' && dueLabel({ due: T0 + 5 * DAY }, T0) === '5 天后');
  check('评分按钮预告下次间隔', gradeHint(newSchedule(T0), 'easy', T0) === '2 天后再见', gradeHint(newSchedule(T0), 'easy', T0));
}

/* ---------- 7. 排期合并（两台设备都练过） ---------- */
{
  const local = { w1: { ease: 2.5, interval: 3, due: T0 + 3 * DAY, reps: 2, lastReviewed: T0 } };
  const incoming = { w1: { ease: 2.6, interval: 6, due: T0 + 6 * DAY, reps: 3, lastReviewed: T0 + DAY } };
  const merged = mergeSchedules(local, incoming);
  check('同一词条取"复习得更新"的那份', merged.w1.reps === 3 && merged.w1.interval === 6, JSON.stringify(merged.w1));
  const rev = mergeSchedules(incoming, local);
  check('反过来合并结果一致（不会互相顶掉）', rev.w1.reps === 3);
  check('本机独有的排期保留', Object.keys(mergeSchedules({ w9: { reps: 1 } }, {})).join() === 'w9');
  check('脏输入不崩', Object.keys(mergeSchedules(null, null)).length === 0);
}

/* ---------- 8. 连续学习天数 ---------- */
{
  const d1 = dayKey(T0);
  const d0 = dayKey(T0 - DAY);
  const d2 = dayKey(T0 - 2 * DAY);
  let days = addStudyDay([], T0);
  check('打卡记下今天的日期', days.length === 1 && days[0] === d1, days.join());
  days = addStudyDay(days, T0);
  check('同一天重复打卡不重复计数', days.length === 1);
  days = addStudyDay(addStudyDay(days, T0 - DAY), T0 - 2 * DAY);
  const s = summarizeStreak(days, T0);
  check('连续 3 天', s.current === 3 && s.todayDone === true, JSON.stringify(s));
  check('最长连续也记录', s.longest === 3);
  // 注意构造：只学了"前天"，昨天和今天都没学 —— 这才叫中断。
  // 第一版写成 [d2, d0]（前天+昨天），那其实是"连续 2 天、今天还没学"，预期本身写错了。
  const broke = summarizeStreak([d2], T0);
  check('中断后当前连续归零', broke.current === 0 && broke.todayDone === false, JSON.stringify(broke));
  const yesterdayOnly = summarizeStreak([d0], T0);
  check('昨天学过、今天还没学 → 仍有 1 天（不算断）', yesterdayOnly.current === 1, String(yesterdayOnly.current));
  check('合并两边的学习日期取并集去重', mergeDays([d1], [d1, d0]).length === 2);
  check('非法日期被丢掉', mergeDays(['2026-09-15', 'x', 123, ''], []).length === 1);
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
