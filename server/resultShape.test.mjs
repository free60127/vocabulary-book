/**
 * 模型返回值的形状清洗测试。
 *
 * 为什么值得测：这一层是**唯一**挡住脏数据的地方 —— 模型偶尔会返回
 * `meanings: [null]`、超长字符串、或者把数组写成字符串。不清洗的直接后果是
 * 前端渲染时抛异常、整页白屏（回译本上就是这样白屏过）。
 *
 * 跑法：node server/resultShape.test.mjs
 */
import { ENTRY_LIMITS, sanitizeEntry, sanitizeQuiz } from './resultShape.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('=== 形状清洗测试 ===\n');

/* ---------- 词条 ---------- */
{
  check('缺 id 返回 null（没有稳定 id 无法合并/删除）', sanitizeEntry({ head: 'x' }) === null);
  check('缺 head 返回 null（没法展示）', sanitizeEntry({ id: 'w1' }) === null);
  check('非对象返回 null', [null, undefined, 'x', 42, []].every((v) => sanitizeEntry(v) === null));

  const e = sanitizeEntry({
    id: 'w1', head: 'object', kind: '乱写',
    meanings: [{ cn: '物体' }, null, 'x', { cn: '' }],
    scenes: [1, 'ok', null],
    synonyms: [{ word: 'oppose' }, null, { diff: '没有 word 应被丢' }],
    examples: [{ en: 'a', cn: 'b' }, null, {}],
    mnemonic: 'not-object',
  });
  check('kind 非法时回落 word', e.kind === 'word', e.kind);
  check('meanings 丢掉非对象与空义项', e.meanings.length === 1, `剩 ${e.meanings.length}`);
  check('scenes 只留字符串', e.scenes.length === 1 && e.scenes[0] === 'ok');
  check('synonyms 缺 word 的条目被丢', e.synonyms.length === 1 && e.synonyms[0].word === 'oppose');
  check('examples 空对象被丢', e.examples.length === 1);
  check('mnemonic 不是对象时回落成空对象', typeof e.mnemonic === 'object' && e.mnemonic.parts === '');

  const long = sanitizeEntry({ id: 'w2', head: 'x', brief: 'a'.repeat(99999) });
  check('超长字段被截断（不是拒绝整条）', long.brief.length <= 600, String(long.brief.length));
  const huge = sanitizeEntry({ id: 'w3', head: 'x', examples: Array.from({ length: 500 }, () => ({ en: 'y'.repeat(9000), cn: 'z' })) });
  check('单条过大时丢弃该条（不拖垮整单同步）', huge === null);

  check('颜色/多余字段不会被带进结果', sanitizeEntry({ id: 'w4', head: 'x', __proto__: { bad: 1 }, extra: 'nope' }).extra === undefined);
}

/* ---------- 自测题 ---------- */
{
  const q = sanitizeQuiz({ title: '', questions: [
    { type: 'choice', stem: '题干', options: ['a', 'b'], answer: 'a', explanation: '因为…' },
    { type: 'weird', stem: '题干2', options: 'not-array', answer: 'b' },
    { stem: '', answer: 'x' },        // 缺题干
    { stem: '有题干', answer: '' },   // 缺答案
    'not-object',
  ] });
  check('缺题干或答案的题被丢', q.questions.length === 2, `保留 ${q.questions.length}`);
  check('未知题型回落 choice', q.questions[1].type === 'choice', q.questions[1].type);
  check('options 非数组时回落空数组', Array.isArray(q.questions[1].options) && q.questions[1].options.length === 0);
  check('没给标题时自动生成', /2 题/.test(q.title), q.title);
  check('非对象输入不崩', sanitizeQuiz(null).questions.length === 0 && sanitizeQuiz('x').questions.length === 0);
  check('题目数量有上限（不让一次返回几百题）', sanitizeQuiz({ questions: Array.from({ length: 200 }, (_, i) => ({ stem: 's' + i, answer: 'a' })) }).questions.length <= 80);
  check('词条体积上限常量存在且合理', ENTRY_LIMITS.entryBytes > 1000 && ENTRY_LIMITS.fieldChars > 100);
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
