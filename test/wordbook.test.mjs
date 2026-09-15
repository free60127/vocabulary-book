/**
 * 单词本领域逻辑测试（纯函数层）。
 *
 * 为什么值得测：增删改和**合并**直接决定跨设备同步会不会丢数据 ——
 * 回译本上就因为"按标题判重 + 删除没墓碑"出现过"改名变成两条""删了又出现"。
 * 这里把那些坑提前钉住。
 *
 * 跑法：node test/wordbook.test.mjs
 */
import {
  allEntries, createBook, entryLabel, entryTombstoneKey, findEntryBook, mergeBooks,
  newBookId, newEntryId, removeBook, removeEntry, renameBook, sanitizeBook, sanitizeDictBlock,
  sanitizeEntry, summarizeBooks, upsertEntry,
} from '../src/wordbook.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('=== 单词本领域逻辑测试 ===\n');

const E = (id, head, extra = {}) => ({ id, head, kind: 'word', brief: head + ' 的释义', createdAt: 1, ...extra });
const B = (id, name, entries = []) => ({ id, name, note: '', createdAt: 1, entries });
const ids = (list) => allEntries(list).map((e) => e.id);

/* ---------- 1. 规整：脏数据不能进库 ---------- */
{
  check('缺 id 的词条被拒（没有稳定 id 无法合并/删除）', sanitizeEntry({ head: 'object' }) === null);
  check('缺 head 的词条被拒（没法展示）', sanitizeEntry({ id: 'w1' }) === null);
  check('非对象被拒', sanitizeEntry(null) === null && sanitizeEntry('x') === null && sanitizeEntry([1]) === null);
  const e = sanitizeEntry({ id: 'w1', head: 'object', meanings: 'not-array', scenes: [1, 'ok'], kind: '乱写' });
  check('脏字段被规整（数组字段强制成数组、kind 回落 word）',
    Array.isArray(e.meanings) && e.scenes.length === 1 && e.kind === 'word', JSON.stringify({ meanings: e.meanings, scenes: e.scenes, kind: e.kind }));
  check('缺 id 的本子被拒', sanitizeBook({ name: 'x' }) === null);
  check('本子里的坏词条被丢掉、好的留下',
    sanitizeBook({ id: 'b1', entries: [{ head: '无 id' }, E('w1', 'ok')] }).entries.length === 1);
}

/* ---------- 2. 增删改 ---------- */
{
  let list = createBook([], '四级核心词');
  check('新建本子带上 id 与名字', list.length === 1 && list[0].name === '四级核心词' && /^bk-/.test(list[0].id));

  const bid = list[0].id;
  const eid = newEntryId();
  let r = upsertEntry(list, bid, E(eid, 'object'));
  list = r.list;
  check('加入词条', allEntries(list).length === 1 && r.replaced === false);

  r = upsertEntry(list, bid, E(eid, 'object', { brief: '改过的释义' }));
  list = r.list;
  check('同 id 再存是覆盖而不是新增', allEntries(list).length === 1 && r.replaced === true);
  check('覆盖时保留原 createdAt（复习排期不因此重置）', allEntries(list)[0].createdAt === 1);

  check('findEntryBook 能找到词条所在本子', findEntryBook(list, eid)?.id === bid);
  check('找不到时返回 null', findEntryBook(list, '不存在') === null);

  list = renameBook(list, bid, { name: '改过名' });
  check('改名只动名字', list[0].name === '改过名' && allEntries(list).length === 1);

  list = removeEntry(list, bid, eid);
  check('删词条', allEntries(list).length === 0);
  check('删完了本子还在', list.length === 1);

  list = removeBook(list, bid);
  check('删本子', list.length === 0);
  check('newBookId 前缀正确', newBookId().startsWith('bk-') && newEntryId().startsWith('wb-'));
}

/* ---------- 3. 合并（跨设备同步的核心） ---------- */
{
  const local = [B('b1', '我的本', [E('w1', 'object')])];
  const remote = [B('b1', '我的本', [E('w1', 'object'), E('w2', 'oppose')])];
  const r = mergeBooks(local, remote);
  check('同 id 的本子合并不是新增一个', r.list.length === 1 && r.booksAdded === 0);
  check('远端新增的词条被并进来', ids(r.list).sort().join() === 'w1,w2');
  check('统计到新增数量', r.entriesAdded === 1, String(r.entriesAdded));

  // 改名后的同一个本子（这是回译本踩过的坑：按名字判重会变成两个本子）
  const renamed = mergeBooks(local, [B('b1', '换了个名字', [E('w3', 'x')])]);
  check('本子改过名也只合并成一个（按 id 不按名字）', renamed.list.length === 1, `本子数 ${renamed.list.length}`);
  check('合并时沿用本机已有的名字（不把用户改的名字冲掉）', renamed.list[0].name === '我的本', renamed.list[0].name);

  // 墓碑：删掉的东西不能被并回来
  const withTomb = mergeBooks([], [B('b1', 'x', [E('w1', 'a'), E('w2', 'b')])], [], [entryTombstoneKey('b1', 'w1')]);
  check('词条墓碑命中时不再并回来', ids(withTomb.list).join() === 'w2', ids(withTomb.list).join());
  const deadBook = mergeBooks([], [B('b1', 'x', [E('w1', 'a')])], ['b1'], []);
  check('本子墓碑命中时整个本子都不并回来', deadBook.list.length === 0);
  check('墓碑键格式是 bookId|entryId', entryTombstoneKey('b1', 'w1') === 'b1|w1');

  // 老数据没有这些字段也不能崩
  const legacy = mergeBooks(null, null, null, null);
  check('全是 null 时不崩、返回空列表', Array.isArray(legacy.list) && legacy.list.length === 0);
}

/* ---------- 4. 其它小工具 ---------- */
{
  check('entryLabel 优先用词条本身', entryLabel({ head: 'object', brief: 'x' }) === 'object');
  check('entryLabel 兜底用释义', entryLabel({ brief: 'x' }) === 'x');
  check('entryLabel 对空值安全', entryLabel(null) === '');
  const s = summarizeBooks([B('b1', 'a', [E('w1', 'x'), E('w2', 'y', { kind: 'phrase' })]), B('b2', 'b', [E('w3', 'z', { kind: 'pattern' })])]);
  check('统计本子数/词条数/按类型分布', s.books === 2 && s.entries === 3 && s.byKind.phrase === 1 && s.byKind.pattern === 1, JSON.stringify(s));
  check('allEntries 带上所属本子信息', allEntries([B('b1', '我的本', [E('w1', 'x')])])[0].bookName === '我的本');

  /* ---------- 词典核对块：备份文件/同步快照回来的是**不可信数据** ---------- */
  check('词典块：正常数据保留', sanitizeDictBlock({ senses: [{ pos: 'n.', cn: '物体' }], examTypes: ['CET4'] }).senses.length === 1);
  check('词典块：空壳丢掉', sanitizeDictBlock({}) === null && sanitizeDictBlock(null) === null && sanitizeDictBlock('x') === null);
  const dirty = sanitizeDictBlock({
    senses: 'not-an-array', examTypes: ['CET4', 5, null], phonetics: 'x',
    perPosPhonetics: [{ lang: 'us', pos: 'n', phone: 'p' }, 'junk'],
  });
  check('词典块：字段类型不对也不会把渲染搞崩（.map/.join 的前置条件）',
    Array.isArray(dirty.senses) && dirty.senses.length === 0 && dirty.examTypes.join() === 'CET4'
    && dirty.phonetics.uk === '' && dirty.perPosPhonetics.length === 1, JSON.stringify(dirty.examTypes));
  check('词典块：逐字段限长截断',
    sanitizeDictBlock({ senses: [{ pos: 'n.', cn: 'x'.repeat(5000) }] }).senses[0].cn.length === 800);
  const withDict = sanitizeEntry({ id: 'w1', head: 'object', dict: { senses: [{ pos: 'n.', cn: '物体' }] }, dictConflicts: { missingPos: ['v', 7] } });
  check('词条带词典块时保留（含冲突）', withDict.dict.senses.length === 1 && withDict.dictConflicts.missingPos.join() === 'v');
  const junkDict = sanitizeEntry({ id: 'w2', head: 'x', dict: 'garbage', dictConflicts: 'garbage' });
  check('词条带着脏 dict 时整块丢掉（不能留半截给卡片去 .map）', junkDict.dict === undefined && junkDict.dictConflicts === undefined);
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
