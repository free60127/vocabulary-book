/**
 * 收藏夹逻辑测试。
 *
 * 为什么值得测：收藏夹是"待办"性质的数据，最容易出的错是**悄悄丢东西** ——
 *  · 同一个词从两个不同词条里各收藏一次 → 应该还是一条，不是两条；
 *  · 查完词之后要把完整词条补进那条收藏 → 补丢了，「加入词库」就永远只能"查后加入"；
 *  · 删掉的收藏在云同步（并集合并）里被云端旧副本复活 —— 墓碑必须挡住。
 * 这三种都不会报错，只会在用户回头找的时候发现"我明明收藏过"。
 *
 * 跑法：node test/favorites.test.mjs
 */
import {
  addFavorite, attachEntryToFavorite, backfillFavoritesFromEntry, favoriteId, findFavorite, loadFavorites,
  mergeFavorites, removeFavorite, sanitizeFavorite,
} from '../src/favorites.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const SYN = { word: 'consecrate', phonetic: '/ˈkɒnsɪkreɪt/', cn: '使神圣化', register: '正式', tone: '褒义', strength: '强' };

/* ---------- id 与规整 ---------- */
{
  check('id 归一化大小写与空格（同一个词不会存成两条）',
    favoriteId('Consecrate') === favoriteId('consecrate') && favoriteId('give  up') === 'fav-give-up', favoriteId('give  up'));
  check('缺词头的收藏无效', sanitizeFavorite({ brief: 'x' }) === null && sanitizeFavorite(null) === null && sanitizeFavorite('x') === null);
  const f = sanitizeFavorite({ head: 'x', brief: 'y'.repeat(999), at: 'abc' });
  check('超长字段截断、非法时间兜底', f.brief.length === 600 && Number.isFinite(f.at), `brief=${f.brief.length}`);
  check('读入时过滤掉脏数据', loadFavorites([{ head: 'a' }, null, 'x', { brief: 'no-head' }]).length === 1);
}

/* ---------- 增删 ---------- */
{
  // 近义词行上的字段原样带进来（用户点 ⭐ 时拿到的就是这些）
  const list0 = addFavorite([], { ...SYN, from: 'enshrine' });
  check('从近义词行收藏时把一行里的信息都带上（词性/褒贬/强度/音标）',
    list0[0].register === '正式' && list0[0].tone === '褒义' && list0[0].strength === '强' && list0[0].phonetic === SYN.phonetic,
    JSON.stringify(list0[0]));

  let list = addFavorite([], { head: 'consecrate', brief: '使神圣化', from: 'enshrine' });
  check('收藏一条', list.length === 1 && list[0].head === 'consecrate' && list[0].from === 'enshrine');
  check('已收藏能查到', Boolean(findFavorite(list, 'consecrate')));
  check('没收藏的查不到', findFavorite(list, 'enshrine') === null);

  list = addFavorite(list, { head: 'CONSECRATE', brief: '换个说法', from: '别的词条' });
  check('同一个词再次收藏只更新、不新增', list.length === 1, `${list.length} 条`);
  // 第二次的写法不同（大小写）时，显示名要跟着变吗？不变 —— 否则列表里的词名会莫名其妙改样子
  check('重复收藏不改词名的写法，只更新上下文',
    list[0].head === 'consecrate' && list[0].brief === '换个说法', `${list[0].head} / ${list[0].brief}`);

  list = addFavorite(list, { head: 'enshrine', brief: 'x' });
  check('新收藏排在最前（最近收的在上面）', list[0].head === 'enshrine' && list.length === 2);

  const after = removeFavorite(list, favoriteId('enshrine'));
  check('移除只删那一条', after.length === 1 && after[0].head === 'consecrate');
}

/* ---------- 查完词把完整词条补进收藏 ---------- */
{
  const list = addFavorite([], { head: 'consecrate', brief: '使神圣化' });
  const entry = { id: 'wb-1', head: 'consecrate', meanings: [{ cn: '使神圣化' }] };
  const next = attachEntryToFavorite(list, entry);
  check('查完把完整词条挂上去（之后能一步加进词库）', next[0].entry === entry);
  check('没收藏过的词原样返回（不误加）', attachEntryToFavorite(list, { head: 'other' }) === list);
  check('补词条不会把收藏本身弄丢', next[0].head === 'consecrate' && next.length === 1);
}

/* ---------- 合并（云同步是并集） ---------- */
{
  const local = addFavorite([], { head: 'consecrate', brief: '本机', at: 100 });
  const remote = addFavorite([], { head: 'enshrine', brief: '远端', at: 200 });
  const merged = mergeFavorites(local, remote);
  check('两端的收藏并起来', merged.length === 2 && merged.some((f) => f.head === 'enshrine'));
  check('按时间倒序（最近的在前）', merged[0].head === 'enshrine');

  const local2 = addFavorite([], { head: 'consecrate', brief: '旧', at: 100 });
  const remote2 = addFavorite([], { head: 'consecrate', brief: '新', at: 300 });
  check('同一个词两端都有 → 留时间新的那份', mergeFavorites(local2, remote2)[0].brief === '新');
  const withEntry = attachEntryToFavorite(local2, { id: 'wb-9', head: 'consecrate' });
  check('一方查过、另一方没查 → 保留查过的那份 entry',
    Boolean(mergeFavorites(withEntry, remote2)[0].entry), '');
  check('远端为空时不丢本机收藏', mergeFavorites(local, []).length === 1);
  check('上限生效（不会无限增长）', mergeFavorites(
    Array.from({ length: 600 }, (_, i) => ({ head: 'w' + i, at: i })), [], 500).length === 500);
}

console.log('\n' + '='.repeat(62));

/* ---------- 辨析字段：收藏时就要存下来（复习卡要用） ---------- */
{
  const fav = sanitizeFavorite({
    head: 'bespoke', brief: '定制的', from: 'ad hoc',
    diff: '褒贬正好相反', usage: '正式写作', example: 'a bespoke suit', exampleCn: '定做的西装',
  });
  check('收藏保留「差别」与用法', fav.diff === '褒贬正好相反' && fav.usage === '正式写作', JSON.stringify(fav).slice(0, 60));
  check('收藏保留例句与译文', fav.example === 'a bespoke suit' && fav.exampleCn === '定做的西装');
  const merged = mergeFavorites([fav], [{ ...fav, brief: '更新的' }]);
  check('同步合并后辨析字段不丢（合并函数会挑字段，漏了就永久丢）',
    merged[0].diff === '褒贬正好相反' && merged[0].usage === '正式写作', JSON.stringify(merged[0]).slice(0, 60));
  const added = addFavorite([], { head: 'whim', diff: '与 caprice 的差别：whim 更轻', from: 'caprice' });
  check('新收藏走 addFavorite 也带上差别', added[0].diff.length > 0 && added[0].from === 'caprice');
}


/* ---------- 用刚查到的词条回填老收藏（差别 / 用法 / 例句） ---------- */
{
  // 老收藏：只有词头与来源，没有辨析字段（2026-09-17 之前收的就是这样）
  const old = sanitizeFavorite({ head: 'bespoke', brief: '定制的', from: 'ad hoc' });
  const srcEntry = {
    head: 'ad hoc',
    synonyms: [{
      word: 'bespoke', cn: '定制的', phonetic: '/bɪˈspəʊk/',
      diff: '褒贬正好相反', usage: '正式写作', example: 'a bespoke suit', exampleCn: '定做的西装',
    }],
    examples: [{ en: 'ad hoc measures', cn: '临时措施' }],
  };
  const r1 = backfillFavoritesFromEntry([old], srcEntry);
  check('看到源词时自动补上老收藏的差别/用法/例句',
    r1.changed && r1.list[0].diff === '褒贬正好相反' && r1.list[0].usage === '正式写作'
      && r1.list[0].example === 'a bespoke suit' && r1.list[0].phonetic === '/bɪˈspəʊk/',
    JSON.stringify(r1.list[0]).slice(0, 90));

  // 已填好的不该被覆盖（用户可能手改过）
  const filled = sanitizeFavorite({ head: 'bespoke', from: 'ad hoc', diff: '我自己写的' });
  const r2 = backfillFavoritesFromEntry([filled], srcEntry);
  // 注意：**空字段会被补上**（usage/例句），但已有值绝不能被覆盖 —— 用户可能手改过
  check('已有内容不被回填覆盖（空字段可以补，有值的不动）',
    r2.list[0].diff === '我自己写的' && r2.list[0].usage === '正式写作', JSON.stringify(r2.list[0]).slice(0, 80));

  // 看的是收藏词自己 → 至少能补例句
  const self = sanitizeFavorite({ head: 'ad hoc' });
  const r3 = backfillFavoritesFromEntry([self], srcEntry);
  check('看收藏词自己时补上例句', r3.changed && r3.list[0].example === 'ad hoc measures', JSON.stringify(r3.list[0]).slice(0, 70));

  // 无关词条不动任何数据
  const r4 = backfillFavoritesFromEntry([old], { head: 'unrelated', synonyms: [] });
  check('无关卡片不会误改收藏', !r4.changed);
}


/* ---------- 补齐要**如实回报补了什么**（用户踩过："说补好了，界面啥也没变"） ---------- */
{
  // 有 from：来源词的卡片里写着差别
  const withFrom = sanitizeFavorite({ head: 'ensconce', from: 'enshrine' });
  const srcCard = { head: 'enshrine', synonyms: [{ word: 'ensconce', diff: '两者都表安放，ensconce 更舒适' }], examples: [] };
  const r1 = backfillFavoritesFromEntry([withFrom], srcCard);
  check('有来源词时补 diff，并如实回报字段名', r1.fields.includes('diff') && r1.list[0].diff.length > 0, JSON.stringify(r1.fields));

  // 没有 from（老收藏常见）：用**收藏词自己**的近义词对比
  const noFrom = sanitizeFavorite({ head: 'ensconce' });
  const ownCard = { head: 'ensconce', synonyms: [{ word: 'enshrine', diff: 'ensconce 更强调安置在舒适处' }], examples: [{ en: 'She ensconced herself.', cn: '她安坐下来。' }] };
  const r2 = backfillFavoritesFromEntry([noFrom], ownCard);
  check('没有 from 时用"它与近义词的差别"补齐',
    r2.fields.includes('ownDiff') && r2.list[0].ownDiffWord === 'enshrine' && r2.fields.includes('example'),
    JSON.stringify(r2.fields));

  // 卡片里本来就没有可补的 → 不能谎报成功
  const r3 = backfillFavoritesFromEntry([sanitizeFavorite({ head: 'grudge' })], { head: 'grudge', synonyms: [], examples: [] });
  check('没东西可补时 fields 为空、changed=false（不谎报）', r3.changed === false && r3.fields.length === 0, JSON.stringify(r3));
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
