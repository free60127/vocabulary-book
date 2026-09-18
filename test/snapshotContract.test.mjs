/**
 * 云同步 / 备份的**快照契约**测试。
 *
 * ## 为什么要专门守这个契约
 * 出过一次静默数据销毁：`localSnapshot()` 签名支持 `sentences`（错句本），
 * `mergeSnapshot()` 也会合并它，但 `useBooks.js` 里那个**唯一的真实调用点**没传 ——
 * 于是本机快照里 sentences 恒为 `[]`，合并回来还是 `[]`，`applyMerged` 再写回本机，
 * 结果就是「每一次同步成功都把用户的错句本清空」，而且不可恢复。
 *
 * 原来的测试没抓到，是因为它直接给 `localSnapshot({ sentences: ... })` 喂了参数 ——
 * **测的是函数本身，绕过了真实调用点**。所以这里补两层：
 *   ① 行为层：合并结果必须保住本机已有的错句本（远端没有这份数据时尤其要保住）；
 *   ② 契约层：直接扫源码，盯住"localSnapshot 支持的字段 = 调用点传的字段"，
 *      以后任何新增数据集忘了接上，这里立刻红。
 *
 * 跑法：node test/snapshotContract.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localSnapshot, mergeSnapshot } from '../src/storage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('=== 快照契约测试 ===\n');

const mkSentence = (id, head, at) => ({ id, head, sentence: 'I like ' + head, score: 80, at });

/* ---------- 1. 行为：同步不能清空本机错句本 ---------- */
{
  const local = localSnapshot({
    books: [{ id: 'b1', name: '默认', entries: [] }],
    schedule: {}, days: [], history: [], favorites: [],
    deletedBooks: [], deletedEntries: [], deletedFavorites: [],
    killed: {}, revived: {}, wrong: {},
    sentences: [mkSentence('s1', 'object', 1000), mkSentence('s2', 'banana', 2000)],
    deletedSentences: ['dead-1'],
  });
  check('本机快照带上了错句本', local.sentences.length === 2, `sentences=${local.sentences.length}`);
  check('本机快照带上了错句本的墓碑', local.deletedSentences.join() === 'dead-1');

  // 云端快照是白名单重建的：**根本不含** sentences 这个字段
  const remote = { books: [], review: {}, days: [], history: [], favorites: [], deletedBooks: [], deletedEntries: [], deletedFavorites: [] };
  const merged = mergeSnapshot(local, remote);
  check('与"不含错句本的云端快照"合并后，本机错句本仍在（这就是那次数据销毁的现场）',
    Array.isArray(merged.sentences) && merged.sentences.length === 2,
    `merged.sentences=${JSON.stringify(merged.sentences && merged.sentences.length)}`);

  // 云端真带了错句本时要正常并进来
  const remote2 = { ...remote, sentences: [mkSentence('s3', 'cherry', 3000)] };
  const merged2 = mergeSnapshot(local, remote2);
  check('云端的错句本会并进来（不是只保本机）', merged2.sentences.length === 3, `${merged2.sentences.length} 条`);
}

/* ---------- 2. 契约：localSnapshot 支持的字段必须被调用点传全 ---------- */
{
  const storageSrc = fs.readFileSync(path.join(ROOT, 'src', 'storage.js'), 'utf8');
  const hookSrc = fs.readFileSync(path.join(ROOT, 'src', 'hooks', 'useBooks.js'), 'utf8');

  // localSnapshot({ a, b, c }) 的形参表
  const sig = storageSrc.match(/export function localSnapshot\(\{([^}]*)\}/);
  check('能从 storage.js 解析出 localSnapshot 的字段表', Boolean(sig));
  const supported = sig ? sig[1].split(',').map((s) => s.trim()).filter(Boolean) : [];

  // useBooks.js 里的真实调用点：localSnapshot({ ... })
  const call = hookSrc.match(/localSnapshot\(\{([^}]*)\}/);
  check('能从 useBooks.js 找到 localSnapshot 的真实调用点', Boolean(call));
  const passed = new Set(call ? call[1].split(',').map((s) => s.trim()).filter(Boolean) : []);

  // 只有 useBooks 自己持有 state 的字段才要求它传（其余字段属于别的数据源，不归它管）
  const owned = supported.filter((f) => new RegExp(`const \\[${f},`).test(hookSrc));
  const missing = owned.filter((f) => !passed.has(f));
  check('useBooks 持有的每一个本机数据集都传给了 localSnapshot（漏一个 = 每次同步清空它）',
    missing.length === 0, missing.length ? '漏了：' + missing.join(', ') : `共 ${owned.length} 个字段`);

  // 反向：调用点不该传 localSnapshot 不认识的字段（拼错名字时会被静默忽略）
  const unknown = [...passed].filter((f) => !supported.includes(f));
  check('调用点没有拼错的字段名', unknown.length === 0, unknown.length ? '多余：' + unknown.join(', ') : '');
}

/* ---------- 3. 契约：applyMerged 不能把"缺失字段"写成空 ---------- */
{
  const hookSrc = fs.readFileSync(path.join(ROOT, 'src', 'hooks', 'useBooks.js'), 'utf8');
  const body = hookSrc.match(/const applyMerged = useCallback\(\(merged\) => \{([\s\S]*?)\n {2}\},/);
  check('能找到 applyMerged 的实现', Boolean(body));
  const src = body ? body[1] : '';
  // 错句本必须走 Array.isArray 判断（缺失 = 保留本机），不能 `|| []`（缺失 = 清空本机）
  check('applyMerged 对错句本做了"缺失则保留"判断，而不是 `|| []` 清空',
    /Array\.isArray\(merged\.sentences\)/.test(src) && !/persistSentences\(merged\.sentences \|\| \[\]\)/.test(src));
  check('applyMerged 对错句本墓碑做了同样的判断', /Array\.isArray\(merged\.deletedSentences\)/.test(src));
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n❌ ${failed.length}/${results.length} 项失败` : `\n✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
