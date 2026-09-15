/**
 * 「最近查过」的测试。
 *
 * 为什么值得单独测：这一块改动的是**用户直接反馈的那个行为** ——
 * "点最近查过的单词不能直接跳转到查完的界面，加入到单词本的才可以"。
 * 修法是给历史存一份词条快照，于是立刻带出三个新风险，每个都得钉住：
 *   1) 快照让 localStorage 与云同步快照变大 → 必须有条数/体积上限，且超限时降级而不是崩；
 *   2) 历史会从**备份文件/云同步**回来，是不可信数据 → 必须过 sanitizeEntry，
 *      否则一份手改的备份就能让卡片白屏；
 *   3) 同一个词在两台设备各查过一次 → 合并要留**更新的那份**（旧实现取先出现的那个）。
 *
 * 跑法：node test/history.test.mjs
 */

/* loadHistory 走 localStorage；Node 里没有，先给它一个内存实现 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const {
  HISTORY_KEY, HISTORY_LIMIT, HISTORY_BYTES, HISTORY_ITEM_BYTES, makeHistoryItem, mergeHistory,
  pushHistory, loadHistory, saveHistory,
} = await import('../src/storage.js');
const { sanitizeSnapshot } = await import('../server/sync.mjs');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const E = (id, head, extra = {}) => ({
  id, head, brief: '释义 ' + head, kind: 'word', phonetic: '/x/', pos: '名词',
  meanings: [{ pos: '名词', cn: '意思' }], examples: [{ en: 'a', cn: 'b' }], createdAt: 1, ...extra,
});
const bytes = (v) => JSON.stringify(v).length;

/* ---------- 制作条目 ---------- */
{
  const item = makeHistoryItem(E('wb-1', 'object'), 1000);
  check('快照装进历史条目（点一下就能回到卡片）', item.entry && item.entry.head === 'object' && item.at === 1000);
  const big = makeHistoryItem(E('wb-2', 'huge', { confusions: 'x'.repeat(30000) }), 1);
  check('词条过大时只留摘要（不把 localStorage 撑爆）', big.entry === undefined && big.head === 'huge', `${bytes(big)} 字节`);
  check('没有 id 的词条不产生历史条目', makeHistoryItem({ head: 'x' }) === null && makeHistoryItem(null) === null);
}

/* ---------- 压入 / 上限 ---------- */
{
  let list = [];
  for (let i = 0; i < 60; i += 1) list = pushHistory(list, makeHistoryItem(E('wb-' + i, 'w' + i), i));
  check(`条数上限 ${HISTORY_LIMIT}：只留最近的那些`, list.length === HISTORY_LIMIT, String(list.length));
  check('最新的排在最前', list[0].head === 'w59' && list[0].at === 59, list[0].head);

  const again = pushHistory(list, makeHistoryItem(E('wb-59', 'w59', { brief: '改过了' }), 99));
  check('同 id 去重（新的顶掉旧的，不会出现两条）',
    again.filter((h) => h.id === 'wb-59').length === 1 && again[0].brief === '改过了' && again[0].at === 99);

  // 体积上限：把预算压到 100KB，塞进去的快照超预算后应降级成摘要（而不是整条消失）
  let bulky = [];
  for (let i = 0; i < 20; i += 1) {
    bulky = pushHistory(bulky, makeHistoryItem(E('big-' + i, 'b' + i, { confusions: 'y'.repeat(8000) }), i), { bytes: 100 * 1024 });
  }
  check('总量超预算：条目一条不丢，只是超出的那些降级成摘要',
    bytes(bulky) <= 100 * 1024 && bulky.length === 20
    && bulky.some((h) => h.entry) && bulky.some((h) => !h.entry),
    `${bulky.length} 条 / ${bytes(bulky)} 字节 · 带快照 ${bulky.filter((h) => h.entry).length} 条`);
  check('默认预算下普通词条不会被削（别误伤正常用量）',
    pushHistory([], makeHistoryItem(E('wb-n', 'normal'), 1)).every((h) => h.entry) && HISTORY_BYTES > HISTORY_ITEM_BYTES * 10);
  check('空输入安全', pushHistory([], null).length === 0 && pushHistory(null, null).length === 0);
}

/* ---------- 落盘 + 读回（含不可信数据清洗） ---------- */
{
  store.clear();
  saveHistory([makeHistoryItem(E('wb-1', 'object'), 5)]);
  check('落盘后能读回，快照还在', loadHistory()[0].entry.head === 'object');
  check('落盘时也过一遍上限', JSON.parse(store.get(HISTORY_KEY)).length === 1);

  // 手改过的备份文件 / 构造出来的同步快照
  store.set(HISTORY_KEY, JSON.stringify([
    { id: 'wb-ok', head: 'ok', at: 3, entry: E('wb-ok', 'ok') },
    { id: 'wb-bad', head: 'bad', at: 2, entry: { id: 'wb-bad', head: 'bad', meanings: 'not-an-array' } },
    { id: '', head: 'no-id', at: 1 },
    'garbage',
    null,
  ]));
  const loaded = loadHistory();
  check('脏历史被丢掉（没有 id 的、非对象的）', loaded.length === 2, JSON.stringify(loaded.map((h) => h.id)));
  // 注意这里**不是**把快照丢掉：meanings 是字符串时 sanitizeEntry 会把它规整成 []，
  // 卡片照样能渲染（这正是"逐字段重建"的意义）。真正丢快照的是"连 id/head 都不合法"那种。
  check('快照里字段类型不对 → 被规整，而不是带病进渲染',
    loaded[1].id === 'wb-bad' && Array.isArray(loaded[1].entry.meanings) && loaded[1].head === 'bad',
    JSON.stringify(loaded[1].entry && loaded[1].entry.meanings));
  check('loadHistory 兜住所有要 .map 的字段',
    loaded.every((h) => !h.entry || (Array.isArray(h.entry.meanings) && Array.isArray(h.entry.examples))));
}

/* ---------- 合并：同 id 留更新的那份 ---------- */
{
  const older = [{ id: 'wb-1', head: 'object', at: 100, entry: E('wb-1', 'object', { brief: '旧的' }) }];
  const newer = [{ id: 'wb-1', head: 'object', at: 200, entry: E('wb-1', 'object', { brief: '新的' }) }];
  check('更新的那份赢，与它在哪一端无关（不再"本机优先"）',
    mergeHistory(older, newer)[0].entry.brief === '新的' && mergeHistory(newer, older)[0].entry.brief === '新的');
  check('都没有 at 时退化成原来的"本机优先"', mergeHistory([{ id: 'a', head: 'L' }], [{ id: 'a', head: 'R' }])[0].head === 'L');
  check('合并结果同样受条数上限约束',
    mergeHistory(Array.from({ length: 80 }, (_, i) => ({ id: 'x' + i, at: i })), []).length === HISTORY_LIMIT);
}

/* ---------- 服务端快照：历史里的快照也要清洗 ---------- */
{
  const snap = sanitizeSnapshot({
    books: [], days: [], review: {}, deletedBooks: [], deletedEntries: [],
    history: [
      { id: 'wb-1', head: 'object', at: 10, entry: { ...E('wb-1', 'object'), dict: { senses: [{ pos: 'n.', cn: '物体' }] } } },
      { id: 'wb-2', head: 'bad', at: 9, entry: { id: 'wb-2', head: 'bad', meanings: 'not-an-array' } },
      { id: 'wb-3', head: 'noid', at: 8, entry: { head: 'no id' } },
      // 造一条"合法但很大"的词条：例句是 8000 字上限的字段，两条 ≈ 32KB ——
      // 过得了 sanitizeEntry（单条上限 40KB），但超过单条历史上限（16KB），必须降级成摘要
      { id: 'wb-4', head: 'huge', at: 7, entry: E('wb-4', 'huge', {
        examples: [
          { en: 'a'.repeat(8000), cn: 'b'.repeat(8000) },
          { en: 'c'.repeat(8000), cn: 'd'.repeat(8000) },
        ] }) },
      'junk', null,
    ],
  });
  check('服务端接受带快照的历史', snap.ok && snap.data.history.length === 4, String(snap.data && snap.data.history.length));
  const h = snap.data.history;
  // ⚠️ 这条同时守着"云同步会不会把词典核对块弄丢"：快照里的 books[].entries[] 也过 sanitizeEntry，
  // 那个函数漏掉 dict 字段的话，本机看得见、同步到另一台就没了（测试抓过一次）
  check('合法快照连词典核对块一起保留', Boolean(h[0].entry && h[0].entry.dict && h[0].entry.dict.senses.length === 1));
  check('快照形状不合法 → 规整成安全形状（不是整条丢）', Array.isArray(h[1].entry.meanings) && h[1].head === 'bad');
  check('缺 id 的快照被丢掉（sanitizeEntry 拒绝它）', h[2].entry === undefined && h[2].head === 'noid');
  check('撑爆单条上限的快照 → 只留摘要，仍在列表里（不会整条消失）', h[3].entry === undefined && h[3].head === 'huge');
  check('只是单个字段超长的，截断后照常保留快照（别误伤）',
    Array.isArray(h[0].entry.meanings) && h[0].entry.exampleNote === undefined);
  check('非对象 / null 被过滤', h.every((x) => x && typeof x === 'object'));

  const noHistory = sanitizeSnapshot({ books: [], days: [], review: {} });
  check('完全没有 history 字段也不报错', noHistory.ok && noHistory.data.history.length === 0);
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
