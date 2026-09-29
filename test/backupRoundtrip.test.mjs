/**
 * 备份导出→导入的**往返保真**测试。
 *
 * ## 为什么值得钉
 * 导出用 `{ ...localSnapshot() }`、导入走 `mergeSnapshot(空库, 文件)` ——
 * 中间任何一层字段白名单漏一个，就是"导出的备份导回来缺一块"
 * （用户拿备份做迁移时才发现，通常已经晚了）。2026-09-22 曾修过
 * lastReviewed 被云端白名单削掉的同类问题，这里把**本地往返**全字段钉死。
 *
 * 跑法：node test/backupRoundtrip.test.mjs
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { localSnapshot, mergeSnapshot } = await import('../src/storage.js');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('=== 备份往返保真测试 ===\n');

const now = Date.now();
const local = localSnapshot({
  books: [{ id: 'b1', name: '本', entries: [{ id: 'wb-1', head: 'object', brief: 'x', meanings: [{ cn: '物体' }],
    mnemonic: { parts: 'ob+ject' }, synonyms: [{ word: 'oppose', diff: '更正式', exampleCn: '例句' }],
    examples: [{ en: 'an object', cn: '一个物体' }], avoid: '别骂人', createdAt: 1 }] }],
  schedule: { 'wb-1': { ease: 2.6, interval: 6, due: now + 1, reps: 3, lapses: 1, lastReviewed: now, lastGrade: 'easy' } },
  days: ['2026-09-21', '2026-09-22'],
  history: [{ id: 'wb-1', head: 'object', brief: 'x', at: now }],
  favorites: [{ id: 'fav-grudge', head: 'grudge', brief: '吝惜', diff: 'x', entry: { id: 'wb-2', head: 'grudge', meanings: [{ cn: 'y' }] } }],
  deletedBooks: ['b-old'], deletedEntries: ['b-old|wb-old'], deletedFavorites: ['fav-old'],
  killed: { grudge: now }, revived: { object: now - 5 },
  wrong: { grudge: { head: 'grudge', brief: 'x', count: 3, reason: 'spell', at: now, firstAt: now - 9 } },
  sentences: [{ id: 'st-1', head: 'object', sentence: 'I object.', score: 85, verdict: 'ok', corrected: '', mode: 'free', at: now }],
  deletedSentences: ['st-old'],
});

const imported = mergeSnapshot(localSnapshot({}), local);

const s = imported.review['wb-1'] || {};
check('排期：SM-2 全字段 + lastReviewed/lastGrade 往返无损',
  s.ease === 2.6 && s.interval === 6 && s.reps === 3 && s.lapses === 1 && s.lastReviewed === now && s.lastGrade === 'easy',
  JSON.stringify(s));
const w = imported.wrong.grudge || {};
check('错词本：count/reason/firstAt 往返无损', w.count === 3 && w.reason === 'spell' && w.firstAt === now - 9);
check('斩掉/复活时间戳往返无损', imported.killed.grudge === now && imported.revived.object === now - 5);
check('错句本与墓碑往返无损', (imported.sentences[0] || {}).score === 85 && imported.deletedSentences.includes('st-old'));
check('收藏挂载词条往返无损', Boolean(imported.favorites[0] && imported.favorites[0].entry));
check('三套墓碑往返无损', imported.deletedBooks.includes('b-old') && imported.deletedEntries.includes('b-old|wb-old') && imported.deletedFavorites.includes('fav-old'));
const e = imported.books[0].entries[0];
check('词条嵌套块（mnemonic/synonyms.diff/exampleCn/avoid）往返无损',
  e.mnemonic.parts === 'ob+ject' && e.synonyms[0].diff === '更正式' && e.synonyms[0].exampleCn === '例句' && e.avoid === '别骂人');
check('学习日期往返无损', imported.days.includes('2026-09-22'));

/* 幂等：同一份文件导两次不翻倍 */
const again = mergeSnapshot(imported, local);
check('重复导入幂等（条数不翻倍）', again.books[0].entries.length === 1 && again.sentences.length === 1 && again.favorites.length === 1);

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n❌ ${failed.length}/${results.length} 项失败` : `\n✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
