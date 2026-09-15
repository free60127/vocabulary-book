/**
 * 词典事实层测试。
 *
 * 为什么值得测：这一层的价值全在"**客观事实不能错**"上 —— 音标、词性、大纲标注。
 * 而它同时又是个外部依赖（别人的接口、字段可能随时变），出问题的典型表现是
 * **静默出错**：接口返回了数据但解析出空数组，卡片上看着正常，实际上一个字都没核对。
 * 第一版就踩过这个坑（`l.i` 有时是数组，用 str() 取一律变空串，所有词条释义全空），
 * 所以这里连"解析结果非空"都单独钉一条。
 *
 * 跑法：node server/dict.test.mjs
 */
import {
  buildFactsBlock, dictConflicts, lookupDict, normalizePhonetic, normalizeWord,
  parseYoudaoJson, parseYoudaoOpen, resetDictState, resolveProvider, truncate, youdaoSign,
} from './dict.mjs';
import { sanitizeDict, attachDict } from './resultShape.mjs';
import { buildLookupMessage } from './prompt.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* ---------- 真实返回的样本（从 dict.youdao.com 抓下来的原样结构） ---------- */
const SAMPLE = {
  ec: {
    exam_type: ['初中', '高中', 'CET4', 'CET6', '考研', 'IELTS', 'SAT', '商务英语'],
    word: [{
      usphone: 'ˈɑːbdʒekt; əbˈdʒekt',
      ukphone: 'ˈɒbdʒɪkt; əbˈdʒekt',
      // ⚠️ 真实接口里 trs[].tr[].l.i 是**数组**，这是那次"释义全空"的根因
      trs: [
        { tr: [{ l: { i: ['n. 物体，实物；目的，目标'] } }] },
        { tr: [{ l: { i: ['v. 反对；反对说'] } }] },
      ],
      'return-phrase': { l: { i: 'object' } },
    }],
  },
  simple: {
    query: 'object',
    word: [{
      'return-phrase': 'object',
      multiPhone: {
        uk: [{ phone: 'ˈɒbdʒɪkt', pos: ['n'] }, { phone: 'əbˈdʒekt', pos: ['v'] }],
        us: [{ phone: 'ˈɑːbdʒekt', pos: ['n'] }, { phone: 'əbˈdʒekt', pos: ['v'] }],
      },
    }],
  },
  phrs: { phrs: [{ phr: { headword: { l: { i: 'object oriented' } }, trs: [{ tr: { l: { i: '面向对象的' } } }] } }] },
  syno: { synos: [{ syno: { pos: 'n.', ws: [{ w: 'target' }, { w: 'goal' }], tran: '目标；物体' } }] },
  rel_word: { rels: [{ rel: { pos: 'n.', words: [{ word: 'objection', tran: '异议' }] } }] },
  blng_sents_part: { 'sentence-pair': [{ 'sentence-eng': 'A rock is an <b>object</b>.', 'sentence-translation': '岩石是物体。' }] },
  collins_primary: { words: { indexforms: ['object', 'objects', 'objected'] } },
  meta: { input: 'object' },
};

/* ---------- 解析 ---------- */
{
  const f = parseYoudaoJson(SAMPLE);
  check('解析出词头', f && f.head === 'object', f && f.head);
  check('解析出**非空**释义（数组型 l.i 的回归）', f.senses.length === 2, JSON.stringify(f.senses));
  check('同词性多行合并成一条', f.senses.every((s) => !s.cn.includes('；；')), f.senses.map((s) => s.pos).join('/'));
  check('音标拆多读音，主读音只留第一个', f.phonetics.uk === 'ˈɒbdʒɪkt' && f.phonetics.us === 'ˈɑːbdʒekt', JSON.stringify(f.phonetics));
  check('逐词性音标（object 名/动重音不同，这是最该纠的错）',
    f.perPosPhonetics.some((x) => x.pos === 'v' && x.phone === 'əbˈdʒekt')
    && f.perPosPhonetics.some((x) => x.pos === 'n' && x.phone === 'ˈɒbdʒɪkt'),
    f.perPosPhonetics.map((x) => `${x.lang}/${x.pos}/${x.phone}`).join(' '));
  check('全部读音进 allPhonetics（冲突校验要拿全部比，否则正确读音会被判错）',
    f.allPhonetics.includes('əbˈdʒekt') && f.allPhonetics.includes('ˈɑːbdʒekt'), f.allPhonetics.join(' '));
  check('考试大纲标注整组取回', f.examTypes.length === 8 && f.examTypes.includes('CET6'), f.examTypes.join('/'));
  check('搭配 / 近义 / 同根词族 / 例句 / 词形', f.phrases.length === 1 && f.synonyms.length === 1
    && f.family.length === 1 && f.sentences.length === 1 && f.forms.length === 3, '');
  check('例句里的 <b> 标签被清掉', f.sentences[0].en === 'A rock is an object.', f.sentences[0].en);
  check('空壳返回 null（宁可当没查到，也不贴一张空卡片）', parseYoudaoJson({ meta: { input: 'x' } }) === null);
  check('畸形输入不抛错', parseYoudaoJson(null) === null && parseYoudaoJson('x') === null && parseYoudaoJson({}) === null);
}

/* ---------- 归一化 ---------- */
{
  check('音标去斜杠/方括号/空白', normalizePhonetic(' /ˈɒbdʒɪkt/ ') === 'ˈɒbdʒɪkt' && normalizePhonetic('[əbˈdʒekt]') === 'əbˈdʒekt');
  check('查询串压缩空白', normalizeWord('  give   up ') === 'give up');
  check('超长查询串截断（防止拿它去拼 URL）', normalizeWord('a'.repeat(500)).length === 80);
}

/* ---------- provider 选择 ---------- */
{
  check('没配任何东西 → 默认走免费网页接口', resolveProvider({}) === 'youdao-web');
  check('显式关掉 → off', resolveProvider({ DICT_PROVIDER: 'off' }) === 'off');
  check('有官方 key → 优先官方（合规路径）', resolveProvider({ YOUDAO_APP_KEY: 'a', YOUDAO_APP_SECRET: 'b' }) === 'youdao-open');
  check('声明走官方但没给 key → 退回 off（不能假装能用）',
    resolveProvider({ DICT_PROVIDER: 'youdao-open' }) === 'off');
}

/* ---------- 官方接口签名 ---------- */
{
  check('官方截断规则：>20 取「首10+长度+末10」',
    truncate('abcdefghijklmnopqrstuvwxyz') === 'abcdefghij' + 26 + 'qrstuvwxyz' && truncate('short') === 'short');
  const sign = youdaoSign('key', 'secret', 'object', 'salt', '1700000000');
  check('签名是 64 位十六进制', /^[0-9a-f]{64}$/.test(sign), sign.slice(0, 16) + '…');
  check('签名对输入敏感（改一个字符结果就变）', youdaoSign('key', 'secret', 'object2', 'salt', '1700000000') !== sign);
  const open = parseYoudaoOpen({
    errorCode: '0', query: 'object',
    basic: { explains: ['n. 物体', 'v. 反对'], 'uk-phonetic': 'ˈɒbdʒɪkt', 'us-phonetic': 'ˈɑːbdʒekt', exam_type: ['CET4'] },
    web: [{ key: 'object', value: ['对象'] }],
  });
  check('官方返回也能解析成同一套事实形状', open.senses.length === 2 && open.phonetics.uk === 'ˈɒbdʒɪkt' && open.examTypes[0] === 'CET4', '');
  check('官方接口报错码 → null（不把错误当数据）', parseYoudaoOpen({ errorCode: '108', query: 'x' }) === null);
}

/* ---------- 冲突校验 ---------- */
{
  const facts = parseYoudaoJson(SAMPLE);
  const ok = dictConflicts({ phonetic: '/ˈɒbdʒɪkt/', pos: '名词/动词', meanings: [{ pos: '名词' }, { pos: '动词' }] }, facts);
  check('音标与词典一致 + 词性齐全 → 无冲突', ok.phonetics.length === 0 && ok.missingPos.length === 0, JSON.stringify(ok));

  const badPhone = dictConflicts({ phonetic: '/ˈɒbdʒekt/', pos: '名词' }, facts);
  check('音标对不上 → 记为冲突', badPhone.phonetics.length === 1, JSON.stringify(badPhone.phonetics));

  const notInDict = dictConflicts({ phonetic: '/ˈɒbdʒekt/', pos: '名词' }, { phonetics: {}, allPhonetics: [], perPosPhonetics: [], senses: [] });
  check('词典没有音标时不判冲突（不能拿空数据冤枉模型）', notInDict.phonetics.length === 0);

  const missV = dictConflicts({ pos: '名词', phonetic: 'ˈɒbdʒɪkt' }, facts);
  check('模型漏掉动词词性 → 记下来', missV.missingPos.join() === 'v', JSON.stringify(missV));

  const cn = dictConflicts({ pos: '名词 形容词', phonetic: 'x' }, { senses: [{ pos: 'n.' }, { pos: 'adj.' }] });
  check('中文词性名（名词/形容词）能与词典的 n./adj. 对上', cn.missingPos.length === 0, JSON.stringify(cn));

  const vt = dictConflicts({ pos: '动词' }, { senses: [{ pos: 'vt.' }, { pos: 'vi.' }] });
  check('vt./vi. 不重复报成两个缺失', vt.missingPos.length === 0, JSON.stringify(vt));
}

/* ---------- 提示词接地 ---------- */
{
  const facts = parseYoudaoJson(SAMPLE);
  const block = buildFactsBlock(facts);
  check('事实块含音标/释义/大纲标注', /音标/.test(block) && /词性\+释义/.test(block) && /考试大纲标注/.test(block));
  check('事实块写明"以词典为准"并给出硬要求', /以词典为准/.test(block) && /逐字符一致/.test(block) && /不许提/.test(block));
  check('没有事实时不产生空块', buildFactsBlock(null) === '' && buildFactsBlock({ phonetics: {} }) === '');

  const msg = buildLookupMessage({ term: 'object', facts });
  check('查词消息里真的带上了事实块（接了线，不只是写了个函数）', msg.includes('考试大纲标注'), '');
  check('没查到词典时消息与以前一致', !buildLookupMessage({ term: 'object' }).includes('权威词典事实'));

  const big = buildFactsBlock({
    ...facts,
    phrases: Array.from({ length: 12 }, (_, i) => ({ en: 'p' + i, cn: 'x'.repeat(200) })),
    family: Array.from({ length: 4 }, () => ({ pos: 'n.', words: Array.from({ length: 8 }, (_, i) => ({ w: 'w' + i, cn: 'y'.repeat(50) })) })),
  });
  check('事实块有长度上限（每次都进提示词，不能无限膨胀）', big.length < 2600, String(big.length));
}

/* ---------- 落库形状 ---------- */
{
  const facts = parseYoudaoJson(SAMPLE);
  check('sanitizeDict 逐字段重建并去掉空块', sanitizeDict(facts).senses.length === 2 && sanitizeDict({}) === null);
  const dirty = sanitizeDict({ ...facts, head: 'x'.repeat(999), senses: Array.from({ length: 50 }, () => ({ pos: 'n.', cn: 'a' })) });
  check('词典数据同样是外部数据：照样限长截断', dirty.head.length <= 200 && dirty.senses.length <= 10, String(dirty.senses.length));

  const entry = attachDict({ id: 'wb-1', head: 'object' }, facts, { phonetics: ['x'], missingPos: ['v'] });
  check('核对结果并回词条（含冲突）', entry.dict.senses.length === 2 && entry.dictConflicts.missingPos[0] === 'v');
  check('没查到时词条保持原样，不挂空壳', attachDict({ id: 'wb-1', head: 'x' }, null, null).dict === undefined);
}

/* ---------- 网络层：缓存 / 降级 / 熔断（全部用假 fetch，不碰真接口） ---------- */
{
  resetDictState();
  let calls = 0;
  const okFetch = async () => { calls += 1; return { ok: true, json: async () => SAMPLE }; };
  const r1 = await lookupDict('object', { provider: 'youdao-web', fetchImpl: okFetch });
  const r2 = await lookupDict('object', { provider: 'youdao-web', fetchImpl: okFetch });
  check('查到事实并归一化', r1.ok && r1.facts.senses.length === 2);
  check('第二次走缓存（不打第二次接口）', calls === 1 && r2.cached === true, `calls=${calls}`);

  resetDictState();
  const boom = async () => { throw new Error('网络炸了'); };
  const bad = await lookupDict('object', { provider: 'youdao-web', fetchImpl: boom });
  check('接口出错 → 返回 ok:false 而不是抛错（词典挂了不能拖垮查词）', bad.ok === false && bad.reason === 'error', JSON.stringify(bad));

  resetDictState();
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  for (let i = 0; i < 5; i += 1) await lookupDict('w' + i, { provider: 'youdao-web', fetchImpl: http500 });
  let after = 0;
  const tripped = await lookupDict('w9', { provider: 'youdao-web', fetchImpl: async () => { after += 1; return { ok: true, json: async () => SAMPLE }; } });
  check('连续失败后熔断：不再继续打接口', tripped.ok === false && tripped.reason === 'circuit-open' && after === 0, JSON.stringify(tripped));

  resetDictState();
  const empty = async () => ({ ok: true, json: async () => ({ meta: { input: 'zzz' } }) });
  const none = await lookupDict('zzz', { provider: 'youdao-web', fetchImpl: empty });
  check('词典里没有这个词 → not-found（且不缓存成"有数据"）', none.ok === false && none.reason === 'not-found', JSON.stringify(none));

  const off = await lookupDict('object', { provider: 'off' });
  check('provider=off 时完全不发请求', off.ok === false && off.reason === 'disabled');
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
