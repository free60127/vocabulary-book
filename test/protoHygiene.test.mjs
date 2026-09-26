/**
 * 键控写入的原型卫生测试（putKey）。
 *
 * ## 为什么钉这个
 * JSON.parse 会把数据里的 `"__proto__"` 键建成**自有属性**（备份文件、云同步快照、
 * localStorage 都走 JSON.parse）。对这种键做普通赋值 `out[k] = v` 不建键，
 * 而是触发原型 setter 把整个对象的**原型换掉**，记录本身静默消失 ——
 * 2026-09-22 对抗测试第 1 轮实测：一个手改的备份文件就能让合并结果的原型被替换。
 * 修法是 putKey（Object.defineProperty，永远建自有属性）。这里钉住所有键控合并/装载点。
 *
 * 跑法：node test/protoHygiene.test.mjs
 */

/* mergeSnapshot 会摸 localStorage，Node 里先给一个内存实现 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { mergeSchedules, mergeWrong } = await import('../src/review.js');
const { mergeStamps, loadKilled, saveKilled, loadWrong, saveWrong, loadFollowups, saveFollowups } = await import('../src/storage.js');
const { sanitizeSnapshot } = await import('../server/sync.mjs');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const cleanProto = (o) => Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null;

console.log('=== 原型卫生测试 ===\n');

/* ---------- 合并层 ---------- */
{
  const evil = JSON.parse('{"__proto__":{"ease":5,"lastReviewed":99999999999999},"wb-1":{"ease":2.5,"interval":1,"due":1,"reps":1,"lapses":0,"lastReviewed":5}}');
  const out = mergeSchedules({}, evil);
  check('mergeSchedules：__proto__ 键不替换原型', cleanProto(out));
  // 注：自有 __proto__ 属性只能用 getOwnPropertyDescriptor 读（点号/中括号读永远走原型 getter）
  const ownRec = Object.getOwnPropertyDescriptor(out, '__proto__');
  check('mergeSchedules：__proto__ 记录以自有属性幸存（不再静默丢失）',
    Boolean(ownRec) && ownRec.value.lastReviewed === 99999999999999);
  check('mergeSchedules：正常记录照常合并', out['wb-1'] && out['wb-1'].interval === 1);
  check('mergeSchedules：序列化往返后仍是自有键',
    Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(out)), '__proto__'));

  const w = mergeWrong({}, JSON.parse('{"__proto__":{"count":9,"at":1},"grudge":{"count":2,"at":2}}'));
  check('mergeWrong：不替换原型，记录幸存', cleanProto(w) && w.__proto__ && w.__proto__.count === 9 && w.grudge.count === 2);

  const s = mergeStamps({}, JSON.parse('{"__proto__":123,"grudge":5}'));
  check('mergeStamps：数字值也建自有键（以前 setter 吃掉原始值导致静默丢失）',
    cleanProto(s) && Object.prototype.hasOwnProperty.call(s, '__proto__') && s.__proto__ === 123 && s.grudge === 5);
}

/* ---------- 装载层（localStorage 赃数据） ---------- */
{
  saveKilled(JSON.parse('{"__proto__":111,"grudge":222}'));
  const k = loadKilled();
  check('loadKilled：localStorage 赃 __proto__ 键不污染', cleanProto(k) && k.__proto__ === 111 && k.grudge === 222);

  saveWrong(JSON.parse('{"__proto__":{"count":3,"at":1},"w1":{"head":"w1","count":1,"at":2}}'));
  const w = loadWrong();
  check('loadWrong：同样安全且记录幸存', cleanProto(w) && Boolean(w.__proto__) && Boolean(w.w1));

  saveFollowups(JSON.parse('{"__proto__":[{"q":"x"}],"wb-1":[{"q":"怎么用","a":"…","at":1}]}'));
  const f = loadFollowups();
  check('loadFollowups：同样安全且记录幸存', cleanProto(f) && Array.isArray(f.__proto__) && Array.isArray(f['wb-1']));
}

/* ---------- 服务端快照净化 ---------- */
{
  const r = sanitizeSnapshot({
    books: [], days: [], history: [], favorites: [],
    deletedBooks: [], deletedEntries: [], deletedFavorites: [],
    review: JSON.parse('{"__proto__":{"ease":5,"due":1},"wb-1":{"ease":2.5,"interval":1,"due":1,"reps":1,"lapses":0,"lastReviewed":9}}'),
  });
  const ok = r.ok;
  check('sanitizeSnapshot：review 原型不被替换', ok && cleanProto(r.data.review));
  check('sanitizeSnapshot：__proto__ 记录以自有键存进云端（保留语义而非丢弃）',
    ok && Object.prototype.hasOwnProperty.call(r.data.review, '__proto__'));
  check('sanitizeSnapshot：JSON 序列化后原样往返',
    ok && Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(r.data.review)), '__proto__'));
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n❌ ${failed.length}/${results.length} 项失败` : `\n✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
