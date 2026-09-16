/**
 * 复习排期（SM-2）与连续学习天数测试。
 *
 * 为什么值得测：排期算错的表现很隐蔽 —— 不会报错，只会让用户"明明复习了、第二天还全是到期"，
 * 或者间隔暴涨到几年后（等于再也不复习）。边界（难度因子上下限、间隔上限、时钟回拨）都要钉住。
 *
 * 跑法：node test/review.test.mjs
 */
import {
  EASE_MAX, EASE_MIN, GRADES, INTERVAL_MAX, addStudyDay, addWrong, buildReviewQueue, buildWrongQueue,
  buildTodayQueue, checkSpelling, clearWrong, dayKey, dueEntries, dueLabel, gradeHint, isDueOn, killedSet, mergeDays,
  mergeSchedules, mergeWrong, newSchedule, nextDueAt, normalizeSchedule, scheduleOf, sm2Review,
  spellHint, summarizeStreak, wrongList,
} from '../src/review.js';
import { sanitizeFollowup } from '../server/resultShape.mjs';
import { FOLLOWUP_SYSTEM_PROMPT, buildFollowupMessage } from '../server/prompt.mjs';

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

/* ==========================================================================
   复习队列（本子 + 收藏夹 + 斩掉）：这三条规则直接决定"今天要背什么"，
   错一条用户就会看到"收藏的词永远不出现"或者"斩掉的词又回来了"。
   ========================================================================== */
{
  const now = T0;
  const E = (id, head, createdAt = T0 - 10 * DAY) => ({ id, head, kind: 'word', brief: head + ' 的释义', createdAt });
  const F = (head, at = T0 - 5 * DAY) => ({ id: 'fav-' + head, head, brief: head + ' 的释义', at });
  const sched = (id, due) => ({ [id]: { ease: 2.5, interval: 1, due, reps: 1, lapses: 0, lastReviewed: T0 - DAY, lastGrade: 'normal' } });

  /* —— 收藏夹进复习队列 —— */
  const q1 = buildReviewQueue({
    entries: [E('wb-1', 'object')], favorites: [F('oppose')],
    schedule: { ...sched('wb-1', T0 - 1000), ...sched('fav-oppose', T0 - 500) }, killed: {}, revived: {}, now,
  });
  check('收藏夹里到期的词也进复习队列', q1.length === 2 && q1.some((x) => x.kind === 'favorite' && x.head === 'oppose'),
    JSON.stringify(q1.map((x) => x.head + ':' + x.kind)));
  check('队列按"拖得最久"排序', q1[0].head === 'object', q1.map((x) => x.head).join(','));

  /* —— 同一个词不重复出现 —— */
  const q2 = buildReviewQueue({
    entries: [E('wb-1', 'object')], favorites: [F('Object')],
    schedule: { ...sched('wb-1', T0 - 1000), ...sched('fav-object', T0 - 1000) }, killed: {}, revived: {}, now,
  });
  check('已收进单词本的词不会又从收藏夹进一次（大小写无关）', q2.length === 1, JSON.stringify(q2.map((x) => x.head)));

  /* —— 斩掉 —— */
  const q3 = buildReviewQueue({
    entries: [E('wb-1', 'object'), E('wb-2', 'banana')], favorites: [F('oppose')],
    schedule: { ...sched('wb-1', T0 - 1000), ...sched('wb-2', T0 - 1000), ...sched('fav-oppose', T0 - 1000) },
    killed: { object: T0, oppose: T0 }, revived: {}, now,
  });
  check('斩掉的词条不进队列', !q3.some((x) => x.head === 'object'), JSON.stringify(q3.map((x) => x.head)));
  check('斩掉的收藏同样不进队列', !q3.some((x) => x.head === 'oppose'));
  check('没斩掉的照常进', q3.some((x) => x.head === 'banana'));

  /* —— 斩掉 / 收回按"谁更晚"决胜负 —— */
  check('斩掉之后没收回 → 仍在斩掉集合里', killedSet({ object: 100 }, {}).has('object'));
  check('收回更晚 → 不再是斩掉状态', !killedSet({ object: 100 }, { object: 200 }).has('object'));
  check('又斩一次更晚 → 又进斩掉集合', killedSet({ object: 300 }, { object: 200 }).has('object'));
  const q4 = buildReviewQueue({
    entries: [E('wb-1', 'object')], favorites: [],
    schedule: sched('wb-1', T0 - 1000), killed: { object: 100 }, revived: { object: 200 }, now,
  });
  check('收回之后立刻回到队列（不用等下次同步）', q4.length === 1);

  /* —— 收藏项没有完整词条也要能复习 —— */
  const q5 = buildReviewQueue({
    entries: [], favorites: [{ id: 'fav-x', head: 'incumbent', brief: '在职的', at: T0 - DAY }],
    schedule: {}, killed: {}, revived: {}, now,
  });
  check('没有排期的收藏项当天就能复习（新收藏立刻进队列）', q5.length === 1 && q5[0].kind === 'favorite');
}

/* ==========================================================================
   拼写判定与提示：判错 = 用户明明拼对了却过不去；判太松 = 拼一半也算对
   ========================================================================== */
{
  check('拼写：完全正确', checkSpelling('object', 'object'));
  check('拼写：忽略大小写与首尾空格', checkSpelling('  Object ', 'object'));
  check('拼写：空输入不算对', checkSpelling('', 'object') === false);
  check('拼写：词条带搭配时允许只打主词', checkSpelling('object', 'object to sth'));
  check('拼写：短语必须打全（打一个 no 不算）', checkSpelling('no', 'no sooner ... than') === false);
  check('拼写：短语打全了就算对', checkSpelling('pull off', 'pull off'));
  check('拼写：打错就是错', checkSpelling('objekt', 'object') === false);
  check('提示 1 级只给首字母', spellHint('incumbent', 1).startsWith('i ') && !spellHint('incumbent', 1).includes('ncumbent'));
  check('提示 2 级给一半', spellHint('incumbent', 2).startsWith('incum '));
  check('提示 3 级给整个答案', spellHint('incumbent', 3) === 'incumbent');
  check('提示对空词头安全', spellHint('', 2) === '' && spellHint(null, 1) === '');
}


/* ==========================================================================
   错词本：进本 / 出本 / 合并 / 只练错词
   规则错一条的后果：进不去（"我明明答错了"）或出不来（错词本越攒越多没人看）。
   ========================================================================== */
{
  const now = T0;
  let w = {};
  w = addWrong(w, 'Object', 'forgot', { brief: '物体' }, 1000);
  check('答错进本并记下次数与原因', w.object.count === 1 && w.object.reason === 'forgot', JSON.stringify(w.object));
  w = addWrong(w, 'object', 'spell', {}, 2000);
  check('同一个词再错 → 次数累加、原因取最近一次', w.object.count === 2 && w.object.reason === 'spell', JSON.stringify(w.object));
  check('词头大小写归一（不会出现两条 object）', Object.keys(w).length === 1);
  check('第一次错的时间被保留（用来显示"错了两周"）', w.object.firstAt === 1000 && w.object.at === 2000);

  const listed = wrongList(w, [{ id: 'wb-1', head: 'object', brief: '物体；反对', phonetic: '/ˈɒbdʒɪkt/' }], []);
  check('清单补上本子里的释义与音标', listed[0].brief === '物体；反对' && listed[0].phonetic === '/ˈɒbdʒɪkt/', JSON.stringify(listed[0]));
  check('清单标出"还在不在本子里"', listed[0].inBook === true && listed[0].exists === true);

  const ghost = wrongList({ vanished: { head: 'vanished', count: 3, at: 5 } }, [], []);
  check('词条被删掉也还在清单里（用户得看得见、清得掉）', ghost.length === 1 && ghost[0].exists === false && ghost[0].brief === '');

  check('答对出本', Object.keys(clearWrong(w, 'OBJECT')).length === 0);
  check('出本对不存在的词安全', Object.keys(clearWrong(w, 'nope')).length === 1);
  check('出本对脏输入安全', Object.keys(clearWrong(null, 'x') || {}).length === 0);

  const merged = mergeWrong({ a: { count: 3, at: 10 }, b: { count: 1, at: 99 } }, { a: { count: 5, at: 5 }, c: { count: 2, at: 20 } });
  check('跨设备合并取"次数更多"的那份，不累加', merged.a.count === 5 && merged.c.count === 2, JSON.stringify(merged));
  check('次数相同时取更近的一次', mergeWrong({ a: { count: 2, at: 10 } }, { a: { count: 2, at: 30 } }).a.at === 30);

  const queue = buildWrongQueue({
    wrong: { object: { head: 'object', count: 2, at: 5 }, ghost: { head: 'ghost', count: 1, at: 6 } },
    entries: [{ id: 'wb-1', head: 'object', createdAt: 1 }],
    favorites: [{ id: 'fav-x', head: 'faved', brief: '收藏的' }],
    schedule: {}, killed: {}, revived: {}, now,
  });
  check('只练错词：本子里有的用完整词条', queue.some((x) => x.kind === 'entry' && x.head === 'object'));
  check('只练错词：只剩记录的也能练（用词头那一行）', queue.some((x) => x.kind === 'wrong' && x.head === 'ghost'));
  check('不在错词本里的词不会被带进来', !queue.some((x) => x.head === 'faved'));
  check('斩掉的错词不再出现', buildWrongQueue({
    wrong: { object: { head: 'object', count: 1, at: 5 } },
    entries: [{ id: 'wb-1', head: 'object' }], favorites: [], schedule: {}, killed: { object: 9 }, revived: {}, now,
  }).length === 0);
}

/* ---------- 追问回答的清洗（服务端） ---------- */
{
  check('追问：代码块围栏被剥掉', sanitizeFollowup('```json\n{"answer":"正文"}\n```') === '正文');
  check('追问：开场白被剥掉', sanitizeFollowup('好的，我来回答：object 是名词。') === 'object 是名词。');
  check('追问：对象形态取字段', sanitizeFollowup({ text: '字段回答' }) === '字段回答');
  check('追问：空输入返回空串（前端据此报"没拿到回答"）', sanitizeFollowup(null) === '' && sanitizeFollowup('   ') === '');
  check('追问：超长回答被截断（不让一段话撑爆界面）', sanitizeFollowup('x'.repeat(9000)).length === 4000);
  check('追问提示词：要求直接回答、不许重讲整张卡', /直接回答/.test(FOLLOWUP_SYSTEM_PROMPT) && /不要重新讲一遍/.test(FOLLOWUP_SYSTEM_PROMPT));
  const msg = buildFollowupMessage({ head: 'object', brief: '物体', pos: '名词', question: '怎么选？', context: 'object to sth' });
  check('追问消息带上词、释义、上下文与问题',
    msg.includes('object') && msg.includes('物体') && msg.includes('object to sth') && msg.includes('怎么选？'), msg.slice(0, 40));
}


/* ==========================================================================
   到期判定按"天"：昨晚 21:00 复习、间隔 1 天的词，今天零点就该出现
   （原来是精确时刻：到期时间 = 今晚 21:00，于是用户今天早上看到的是"今天没有要复习的"）
   ========================================================================== */
{
  const night = new Date(2026, 8, 15, 21, 0, 0).getTime();      // 9/15 21:00 复习
  const morning = new Date(2026, 8, 16, 9, 0, 0).getTime();     // 9/16 09:00 打开
  const noon = new Date(2026, 8, 16, 12, 0, 0).getTime();
  const DAYms = 24 * 60 * 60 * 1000;
  const entry = { id: 'wb-1', head: 'object', createdAt: night };
  const map = (due) => ({ 'wb-1': { ease: 2.5, interval: 1, due, reps: 1, lapses: 0, lastReviewed: night, lastGrade: 'normal' } });

  check('间隔 1 天（到期今晚 21:00）→ 今天早上就算到期', isDueOn(night + DAYms, morning) === true,
    new Date(night + DAYms).toLocaleString('zh-CN'));
  check('间隔 2 天（到期明晚）→ 今天不算到期', isDueOn(night + 2 * DAYms, morning) === false);
  check('昨天就该复习的（逾期）当然到期', isDueOn(night - 3 * DAYms, morning) === true);
  check('没有排期（新词）立刻到期', isDueOn(0, morning) === true);
  check('今天 23:59 到期 → 今天零点起就在队列里', isDueOn(new Date(2026, 8, 16, 23, 59, 0).getTime(), morning) === true);

  check('dueEntries 用同一套判定', dueEntries([entry], map(night + DAYms), morning).length === 1);
  check('明天到期的词今天不进队列', dueEntries([entry], map(night + 2 * DAYms), morning).length === 0);
  check('队列按"拖得最久"排：逾期的在前', (() => {
    const two = [{ id: 'a', head: 'a', createdAt: night }, { id: 'b', head: 'b', createdAt: night }];
    const m = { a: { due: night + 2 * DAYms }, b: { due: night - DAYms } };
    return dueEntries(two, m, morning)[0].entry.id === 'b';
  })());

  // 下午再打开：上午已经复习过（间隔 1 天 → 明天到期），今天不该再出现
  const reviewedToday = { 'wb-1': { ease: 2.5, interval: 1, due: morning + DAYms, reps: 2, lastReviewed: morning, lastGrade: 'normal' } };
  check('今天复习过的词，今天不会又冒出来', dueEntries([entry], reviewedToday, noon).length === 0);

  check('nextDueAt 跳过今天已到期的，取下一个日期',
    dayKey(nextDueAt([entry], map(night + 2 * DAYms), morning)) === '2026-09-17',
    new Date(nextDueAt([entry], map(night + 2 * DAYms), morning)).toLocaleString('zh-CN'));
  check('今天已到期的词不算"下一次"', nextDueAt([entry], map(night + DAYms), morning) === 0);
}


/* ==========================================================================
   「今日加练」队列：复习完今天该复习的之后，还能再进去练一遍
   ========================================================================== */
{
  const now = new Date(2026, 8, 16, 10, 0, 0).getTime();     // 9/16 10:00
  const yest = new Date(2026, 8, 15, 21, 0, 0).getTime();
  const tomorrow = new Date(2026, 8, 17, 21, 0, 0).getTime();
  const E = (id, head, createdAt = yest) => ({ id, head, kind: 'word', brief: head, createdAt });
  const S = (due, lastReviewed = 0) => ({ ease: 2.5, interval: 1, due, reps: 1, lapses: 0, lastReviewed, lastGrade: 'normal' });

  const entries = [E('a', 'alpha'), E('b', 'beta', now)];
  const schedule = {
    a: S(tomorrow, now),      // 今天复习过、明天才到期
    b: S(now, 0),             // 今天新加、还没复习
  };
  const q = (map) => buildTodayQueue({ entries, favorites: [], schedule: map, killed: {}, revived: {}, now });
  check('今日加练包含"今天复习过"的词', q(schedule).some((x) => x.head === 'alpha'));
  check('今日加练包含"今天新加"的词', q(schedule).some((x) => x.head === 'beta'));
  check('昨天复习、又不到期的词不进今日加练',
    !q({ ...schedule, a: S(tomorrow, yest) }).some((x) => x.head === 'alpha'));
  check('斩掉的词不进今日加练',
    !buildTodayQueue({ entries, favorites: [], schedule, killed: { alpha: now }, revived: {}, now }).some((x) => x.head === 'alpha'));
  const fav = [{ id: 'fav-x', head: 'gamma', at: now }];     // 今天收藏的
  check('今天收藏的词也算今天碰过',
    buildTodayQueue({ entries: [], favorites: fav, schedule: {}, killed: {}, revived: {}, now }).some((x) => x.head === 'gamma'));
  check('今天什么都没碰 → 今日加练是空的', buildTodayQueue({
    entries: [E('z', 'zeta')], favorites: [], schedule: { z: S(tomorrow, yest) }, killed: {}, revived: {}, now,
  }).length === 0);
  check('到期队列不受影响（仍然是"只看到期的"）',
    buildReviewQueue({ entries, favorites: [], schedule, killed: {}, revived: {}, now }).map((x) => x.head).join(',') === 'beta');
}


/* ---------- 追问回答的"耐造型"：模型换 key / 套 JSON / 给数组都要能抠出来 ---------- */
{
  check('追问：模型换 key 也能抠出来', sanitizeFollowup({ explanation: '这个更正式，用在公文里。' }) === '这个更正式，用在公文里。');
  check('追问：中文键照样认', sanitizeFollowup('{"回答":"接 to 才对。"}') === '接 to 才对。');
  check('追问：嵌套一层也能挖出来', sanitizeFollowup({ data: { content: '嵌套里的答案' } }) === '嵌套里的答案');
  check('追问：数组取第一段', sanitizeFollowup([{ text: '数组里的答案' }]) === '数组里的答案');
  check('追问：围栏 + 开场白一起去掉', sanitizeFollowup('```text\n好的，我来回答：正文在此。\n```') === '正文在此。');
  check('追问：真的空白才返回空（前端据此报错）', sanitizeFollowup('   \n ') === '');
  check('追问：不再要求 JSON 模式（指令冲突会让模型回空壳）', /不要 JSON/.test(FOLLOWUP_SYSTEM_PROMPT));
}

console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
