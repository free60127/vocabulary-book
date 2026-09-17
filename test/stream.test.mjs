/**
 * 流式分段协议：解析、折叠、降级。
 *
 * 这一层是"边生成边看"的地基 —— 模型不听话、网络断流、半截行，全在这里兜住。
 * 跑法：node test/stream.test.mjs
 */
import { createSegmentReader, foldSegments, finalizeStreamEntry, SEGMENT_ORDER } from '../server/stream.mjs';
import { foldSegments as foldClient } from '../src/streamFold.js';
import { createLlm } from '../server/llm.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const SEG = {
  meta: '{"t":"meta","head":"object","kind":"word","phonetic":"/ˈɒbdʒɪkt/","pos":"名词","brief":"物体；反对","register":"通用","tone":"中性","strength":"中"}',
  meanings: '{"t":"meanings","items":[{"pos":"名词","cn":"物体","en":"a thing","note":""}]}',
  notes: '{"t":"notes","confusions":"与 oppose 的差别在搭配","usageNotes":"接 to","examTips":"常考 object to doing"}',
  done: '{"t":"done"}',
};

/* ---------- 1. 逐块喂：跨块残行必须拼回来 ---------- */
{
  const r = createSegmentReader();
  const a = r.feed(SEG.meta.slice(0, 20));      // 半行
  const b = r.feed(SEG.meta.slice(20) + '\n' + SEG.meanings.slice(0, 10));
  const c = r.feed(SEG.meanings.slice(10) + '\n');
  const d = r.flush();
  check('跨块残行能拼回完整段', a.length === 0 && b.length === 1 && b[0].t === 'meta', `a=${a.length} b=${b.map((x) => x.t)}`);
  check('第二段也能正确拼出', c.length === 1 && c[0].t === 'meanings', c.map((x) => x.t).join(','));
  check('收尾 flush 不报错', Array.isArray(d));
}

/* ---------- 2. 脏数据：围栏 / 说明文字 / 坏 JSON 一律跳过，不抛错 ---------- */
{
  const r = createSegmentReader();
  const segs = r.feed([
    '好的，下面开始输出：',
    '```json',
    SEG.meta,
    '这是一句解释',
    '{坏 JSON',
    SEG.meanings,
    '```',
    SEG.done,
    '',
  ].join('\n'));
  check('围栏与说明文字被跳过', segs.map((s) => s.t).join(',') === 'meta,meanings,done', segs.map((s) => s.t).join(','));
  check('坏行计数（便于线上排查模型不听话）', r.stats.bad >= 3, `bad=${r.stats.bad}`);
}

/* ---------- 3. 乱序 / 重复：后到的覆盖先到的，认不出的段忽略 ---------- */
{
  const folded = foldSegments([
    { t: 'meanings', items: [{ cn: '旧释义' }] },
    { t: 'notes', confusions: 'A' },
    { t: 'meanings', items: [{ cn: '新释义' }] },
    { t: 'notes', confusions: 'B' },
    { t: 'unknown-future-field', x: 1 },
    null,
    {},
  ]);
  check('重复段以后到的为准', folded.meanings[0].cn === '新释义' && folded.confusions === 'B', JSON.stringify(folded).slice(0, 60));
  check('认不出的段被忽略（后端加字段不会炸老前端）', folded['unknown-future-field'] === undefined);
}

/* ---------- 4. 折叠：字段映射齐全 ---------- */
{
  const folded = foldSegments([
    JSON.parse(SEG.meta), JSON.parse(SEG.meanings),
    { t: 'scenes', items: ['学术'], avoid: '口语别用' },
    { t: 'mnemonic', image: '画面', hook: '钩子', parts: 'ob+ject', family: 'objection' },
    { t: 'synonyms', items: [{ word: 'oppose' }] },
    { t: 'collocations', items: ['object to sth'] },
    { t: 'examples', items: [{ en: 'I object.', cn: '我反对。' }] },
    JSON.parse(SEG.notes),
    { t: 'dict', facts: { ukphone: '/x/' } },
  ]);
  const want = ['head', 'kind', 'phonetic', 'pos', 'brief', 'register', 'tone', 'strength',
    'meanings', 'scenes', 'avoid', 'mnemonic', 'synonyms', 'collocations', 'examples',
    'confusions', 'usageNotes', 'examTips', '__dict'];
  const missing = want.filter((k) => folded[k] === undefined);
  check('折叠把卡片需要的字段都搬齐了', missing.length === 0, missing.join(','));
  check('mnemonic 四个子字段都在', ['image', 'hook', 'parts', 'family'].every((k) => folded.mnemonic[k] !== undefined));
}

/* ---------- 5. 客户端折叠与服务端**必须一致** ---------- */
{
  const segs = [JSON.parse(SEG.meta), JSON.parse(SEG.meanings), { t: 'notes', confusions: 'X' }, { t: 'dict', facts: { a: 1 } }];
  const a = foldSegments(segs);
  const b = foldClient(segs);
  check('服务端与前端折叠结果一致（否则"看到的"和"存下的"会不一样）',
    JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a).slice(0, 70));
}

/* ---------- 6. 收尾：分段成功 → 正常；不按分段 → 整段 JSON 兜底 ---------- */
{
  const full = JSON.parse(SEG.meta);
  const ok = finalizeStreamEntry({
    segments: [full, JSON.parse(SEG.meanings)],
    rawText: '',
    parseLoose: () => null,
    base: { id: 'wb-x', level: '四六级', createdAt: 1 },
  });
  check('分段齐全时走 segments 路径', ok.mode === 'segments' && ok.entry && ok.entry.head === 'object', ok.mode);

  const plainJson = JSON.stringify({ head: 'object', pos: '名词', brief: '物体', meanings: [{ pos: '名词', cn: '物体' }] });
  const fb = finalizeStreamEntry({
    segments: [{ t: 'dict', facts: {} }],          // 只有词典段，没有模型段
    rawText: plainJson,
    parseLoose: (t) => JSON.parse(t),
    base: { id: 'wb-y', level: '四六级', createdAt: 1 },
  });
  check('模型不按分段来 → 整段 JSON 兜底（不会白等一场）', fb.mode === 'fallback' && fb.entry && fb.entry.head === 'object', fb.mode);

  const bad = finalizeStreamEntry({ segments: [], rawText: '这不是 JSON', parseLoose: () => null, base: {} });
  check('彻底解析不出来时给出 failed（调用方报错重试）', bad.mode === 'failed' && bad.entry === null, bad.mode);
}

/* ---------- 7. 段顺序常量与渲染顺序一致（前端靠它"自上而下长"） ---------- */
{
  check('段顺序常量覆盖卡片主要区块',
    SEGMENT_ORDER.join(',') === 'meta,meanings,scenes,mnemonic,synonyms,collocations,examples,notes',
    SEGMENT_ORDER.join(','));
}

/* ---------- 8. 回归：parseJsonLoose 遇到多行 JSON 不能再抛错 ---------- */
{
  const llm = createLlm({});
  let threw = false;
  let val = null;
  try { val = llm.parseJsonLoose('{"t":"meta"}\n{"t":"done"}'); } catch { threw = true; }
  check('parseJsonLoose 遇到 NDJSON 返回 null（原来会抛"Unexpected non-whitespace character"）', !threw && val === null, threw ? 'throws' : String(val));
  check('parseJsonLoose 仍能解析被说明文字包住的 JSON', llm.parseJsonLoose('好的：{"a":1}').a === 1);
  check('parseJsonLoose 仍能解析带围栏的 JSON', llm.parseJsonLoose('```json\n{"a":2}\n```').a === 2);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
