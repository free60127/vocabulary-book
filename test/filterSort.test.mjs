/**
 * 列表筛选 / 排序测试（纯函数层）。
 *
 * 为什么值得测：用户列出的三项需求里有"按到期/新词/掌握度排序、按类型筛选"。
 * 这类逻辑最容易出的不是崩，而是**静默排错**——顺序看着有变化、其实没按该排的排
 * （比如"新词优先"实际按加入时间、复习排期没被读进去）。跑起来不会报错，
 * 只有真去用才发现不对。这里用可预期的夹具把每种排序的确切顺序钉住。
 *
 * 跑法：node test/filterSort.test.mjs
 */
import { FILTERS, SORTS, filterEntries, masteryOf, sortEntries } from '../src/filterSort.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
/** 词条夹具：id / 词头 / 类型 / 加入时间 */
const E = (id, head, kind = 'word', createdAt = NOW - DAY) => ({
  id, head, kind, createdAt, brief: head + ' 的释义', pos: '名词',
  meanings: [{ cn: head + '的意思' }], synonyms: [{ word: head + 'ish' }],
});
/** 排期夹具 */
const S = (dueInDays, reps = 1, interval = 1) => ({ ease: 2.5, interval, reps, lapses: 0, due: NOW + dueInDays * DAY });

/* ---------- 维度本身 ---------- */
{
  check('筛选维度含 全部/单词/短语/句型/今天到期/新词', FILTERS.length === 6 && FILTERS[0].key === 'all', FILTERS.map((f) => f.label).join(' / '));
  check('排序维度含 默认/到期/新词/已掌握/字母', SORTS.length === 5 && SORTS[1].key === 'due', SORTS.map((s) => s.label).join(' / '));
  check('掌握度 = 次数为主 + 间隔为辅', masteryOf({ reps: 2, interval: 5 }) > masteryOf({ reps: 1, interval: 365 }), String(masteryOf({ reps: 2, interval: 5 })));
  check('掌握度对空排期安全', masteryOf(null) === 0 && masteryOf(undefined) === 0);
}

/* ---------- 筛选 ---------- */
{
  const list = [E('a', 'apple', 'word'), E('b', 'give up', 'phrase'), E('c', 'not only', 'pattern')];
  check('全部：不筛掉任何东西', filterEntries(list, { filter: 'all' }, {}, NOW).length === 3);
  check('按类型：只留单词', filterEntries(list, { filter: 'word' }, {}, NOW).map((e) => e.id).join() === 'a');
  check('按类型：只留短语', filterEntries(list, { filter: 'phrase' }, {}, NOW).map((e) => e.id).join() === 'b');
  check('按类型：只留句型', filterEntries(list, { filter: 'pattern' }, {}, NOW).map((e) => e.id).join() === 'c');

  const sch = { a: S(-1), b: S(3), c: S(3, 0) };   // a 已到期；c 是没复习过的新词
  check('今天到期：只留 due <= now', filterEntries(list, { filter: 'due' }, sch, NOW).map((e) => e.id).join() === 'a');
  check('新词：只留没复习过的', filterEntries(list, { filter: 'new' }, sch, NOW).map((e) => e.id).join() === 'c');
  check('没有排期的词条按"新词"算（立刻到期）',
    filterEntries([E('z', 'zero')], { filter: 'new' }, {}, NOW).length === 1
    && filterEntries([E('z', 'zero')], { filter: 'due' }, {}, NOW).length === 1);
}

/* ---------- 搜索：词头之外的字段也要能搜到 ---------- */
{
  const list = [E('a', 'apple'), { ...E('b', 'banana'), meanings: [{ cn: '香蕉' }] }];
  check('搜词头', filterEntries(list, { query: 'app' }, {}, NOW).map((e) => e.id).join() === 'a');
  check('搜中文释义（不只是英文词头）', filterEntries(list, { query: '香蕉' }, {}, NOW).map((e) => e.id).join() === 'b');
  check('搜近义词', filterEntries(list, { query: 'appleish' }, {}, NOW).map((e) => e.id).join() === 'a');
  check('大小写/空格不敏感', filterEntries(list, { query: '  APPLE  ' }, {}, NOW).length === 1);
  check('搜不到就是空（不能兜底成全量）', filterEntries(list, { query: 'zzzz' }, {}, NOW).length === 0);
  check('筛选与搜索叠加生效', filterEntries(list, { query: 'a', filter: 'word' }, {}, NOW).length === 2);
  check('对空输入安全', filterEntries(null, {}) .length === 0 && filterEntries(undefined, { filter: 'all' }).length === 0);
}

/* ---------- 排序：每种都要**确切顺序**，不能只看"变了" ---------- */
{
  const list = [E('a', 'cherry', 'word', NOW - 3 * DAY), E('b', 'apple', 'word', NOW - 2 * DAY), E('c', 'banana', 'word', NOW - DAY)];
  const seq = (arr) => arr.map((e) => e.id).join('');

  check('默认：保持加入顺序（不排序）', seq(sortEntries(list, 'default', {}, NOW)) === 'abc');
  check('字母序：apple → banana → cherry', seq(sortEntries(list, 'alpha', {}, NOW)) === 'bca');

  const sch = { a: S(10, 5, 30), b: S(-2, 1, 1), c: S(0, 0) };
  check('到期优先：已逾期 → 今天 → 以后', seq(sortEntries(list, 'due', sch, NOW)) === 'bca');
  check('新词优先：reps=0 排最前，复习过的按次数升序', seq(sortEntries(list, 'new', sch, NOW)) === 'cba');
  check('已掌握优先：次数多/间隔长的排最前', seq(sortEntries(list, 'known', sch, NOW)) === 'abc');

  // 同样的 reps 时，"新词优先"按加入时间兜底，顺序必须稳定可复现
  const tie = [E('x', 'x', 'word', NOW - 1 * DAY), E('y', 'y', 'word', NOW - 5 * DAY)];
  const tieSch = { x: S(1, 0), y: S(1, 0) };
  check('同为新词时按加入时间（早的在前）', seq(sortEntries(tie, 'new', tieSch, NOW)) === 'yx');

  const before = list.map((e) => e.id).join();
  sortEntries(list, 'known', sch, NOW);
  check('排序不改动入参数组（避免污染 React state）', list.map((e) => e.id).join() === before);
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
