/**
 * 复习进度跨设备同步的回归测试。
 *
 * ## 为什么值得单独钉：出过一次"怎么同步都要从头复习"
 * 2026-09-22 用户实测：手机上复习完当天全部到期词，登录并同步后，
 * 电脑端无论如何同步都还要求从头复习。根因在**服务端快照白名单**：
 * `sanitizeSnapshot` 重建 review 记录时只留了 SM-2 五个字段
 * （ease/interval/due/reps/lapses），把 `lastReviewed`/`lastGrade` 削掉了 ——
 * 而客户端 `mergeSchedules` 裁决"两份排期谁新"用的正是 lastReviewed。
 * 云端来的记录时间戳恒为 0，永远判不赢本机旧记录，于是推送次次"成功"，
 * 进度却永远过不去（books/favorites/days 都正常，唯独复习不同步，极具迷惑性）。
 *
 * 这里的三层防护：
 *   ① 服务端白名单必须保留 lastReviewed/lastGrade（本次事故的根）；
 *   ② 端到端：手机记录过 sanitizeSnapshot → 与电脑本地记录合并，手机的必须胜出；
 *   ③ 降级：旧云端记录（无这两个字段）行为不变，畸形 lastGrade 不炸。
 *
 * 跑法：node test/reviewSync.test.mjs
 */

/* mergeSnapshot 会摸 localStorage，Node 里先给一个内存实现 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { sanitizeSnapshot } = await import('../server/sync.mjs');
const { mergeSchedules } = await import('../src/review.js');
const { mergeSnapshot } = await import('../src/storage.js');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('=== 复习进度同步契约测试 ===\n');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

/* ---------- ① 服务端白名单：合并的裁决字段必须活下来 ---------- */
{
  const r = sanitizeSnapshot({
    books: [], days: [], history: [], favorites: [],
    deletedBooks: [], deletedEntries: [], deletedFavorites: [],
    review: {
      'wb-1': { ease: 2.5, interval: 10, due: now + DAY, reps: 3, lapses: 0, lastReviewed: now, lastGrade: 'easy' },
    },
  });
  const rec = r.ok && r.data.review['wb-1'];
  check('sanitizeSnapshot 成功且保留 review 记录', Boolean(rec));
  check('lastReviewed 活下来（本次事故的根）', rec && rec.lastReviewed === now, `lastReviewed=${rec && rec.lastReviewed}`);
  check('lastGrade 活下来', rec && rec.lastGrade === 'easy', `lastGrade=${rec && rec.lastGrade}`);
  check('SM-2 原有字段不受影响', rec && rec.interval === 10 && rec.ease === 2.5 && rec.due === now + DAY && rec.reps === 3);
}

/* ---------- ② 端到端：手机推的进度必须能赢过电脑的旧排期 ---------- */
{
  // 电脑本地：这个词昨天复习过，今天到期（要求用户"从头复习"）
  const desktopLocal = {
    'wb-1': { ease: 2.5, interval: 1, due: now - 3600e3, reps: 2, lapses: 0, lastReviewed: now - DAY, lastGrade: 'normal' },
  };
  // 手机：同一个词今天刚复习（简单），due 推到了明天 —— 这就是要传出去的进度
  const phoneRecord = { ease: 2.7, interval: 4, due: now + 3 * DAY, reps: 3, lapses: 0, lastReviewed: now - 3600e3, lastGrade: 'easy' };
  // 手机推送 → 服务端清洗 → 云端那份
  const pushed = sanitizeSnapshot({
    books: [], days: [], history: [], favorites: [],
    deletedBooks: [], deletedEntries: [], deletedFavorites: [],
    review: { 'wb-1': phoneRecord },
  });
  // 电脑拉取合并：修复前 pushed 里没有 lastReviewed，这条永远采纳不了
  const merged = mergeSchedules(desktopLocal, pushed.ok ? pushed.data.review : {});
  check('电脑采纳了手机的复习进度（due 推到将来 = 不再到期）',
    merged['wb-1'] && merged['wb-1'].lastReviewed === now - 3600e3 && merged['wb-1'].due === now + 3 * DAY,
    `due=${merged['wb-1'] && new Date(merged['wb-1'].due).toISOString()}`);

  // 全链路再走一遍 mergeSnapshot（sync.js 真实用的入口），钉住字段不被中途丢掉
  const full = mergeSnapshot({ review: desktopLocal }, { books: [], days: [], history: [], favorites: [], deletedBooks: [], deletedEntries: [], deletedFavorites: [], review: pushed.ok ? pushed.data.review : {} });
  check('mergeSnapshot 全链路同样采纳手机进度', full.review['wb-1'].lastReviewed === now - 3600e3);
}

/* ---------- ③ 降级：旧云端记录与脏数据行为不变 ---------- */
{
  const r = sanitizeSnapshot({
    books: [], days: [], history: [], favorites: [],
    deletedBooks: [], deletedEntries: [], deletedFavorites: [],
    review: {
      'old': { ease: 2.5, interval: 3, due: now, reps: 1, lapses: 0 },            // 老记录：没有这两个字段
      'bad': { ease: 2.5, interval: 1, due: now, reps: 1, lapses: 0, lastReviewed: '昨天', lastGrade: 'probably' }, // 脏值
    },
  });
  const d = r.ok && r.data.review;
  check('旧云端记录缺字段时补 0/空串（行为与修复前一致）', d.old && d.old.lastReviewed === 0 && d.old.lastGrade === '');
  check('畸形 lastReviewed/lastGrade 被清洗而不炸', d.bad && d.bad.lastReviewed === 0 && d.bad.lastGrade === '');

  // 修复前的行为基线：无时间戳的云端记录不该覆盖本机较新的记录（这个保护必须保留）
  const local = { 'old': { ease: 2.5, interval: 2, due: now + DAY, reps: 2, lapses: 0, lastReviewed: now - DAY, lastGrade: 'normal' } };
  const merged = mergeSchedules(local, d);
  check('无时间戳的云端记录仍不会覆盖本机较新的记录', merged.old.lastReviewed === now - DAY && merged.old.interval === 2);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n❌ ${failed.length}/${results.length} 项失败` : `\n✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
