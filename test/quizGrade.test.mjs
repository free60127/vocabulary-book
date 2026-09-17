/**
 * 自测题判分（客观题本地判）。
 *
 * 这些规则直接决定"我做对了却被判错"这类最伤人的体验，所以每条都要有断言钉住：
 * 大小写、前后空格、全角标点、参考答案给多个可接受写法、括号内容可选、只给选项字母。
 *
 * 跑法：node test/quizGrade.test.mjs
 */
import { gradeObjective, gradeChoice, isSubjective, gradePaper, normalizeText, alternatives } from '../src/quizGrade.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* ---------- 归一化 ---------- */
{
  check('忽略大小写与首尾空格', normalizeText('  Object  ') === normalizeText('object'));
  check('全角字母数字转半角', normalizeText('ＯＢＪＥＣＴ１２３') === 'object123');
  check('句末标点不影响比对', normalizeText('He put the book.') === normalizeText('he put the book'));
}

/* ---------- 填空题 ---------- */
{
  const q = { type: 'fill', answer: 'mandatory / compulsory' };
  const cases = [
    ['mandatory', 'right'], ['Compulsory', 'right'], [' mandatory ', 'right'],
    ['COMPULSORY', 'right'], ['required', 'wrong'], ['', 'blank'],
  ];
  let bad = [];
  for (const [input, want] of cases) {
    const got = gradeObjective(q, input).status;
    if (got !== want) bad.push(`${input || '(空)'} → ${got}（应 ${want}）`);
  }
  check('填空：多写法 / 大小写 / 空格 / 未答 都判对', bad.length === 0, bad.join(' ; '));
}

/* ---------- 括号内容可选（`object (to)`） ---------- */
{
  const q = { type: 'fill', answer: 'object (to)' };
  const ok = ['object (to)', 'object to', 'object', 'Object To'].every((x) => gradeObjective(q, x).status === 'right');
  check('填空：括号内容写不写都算对', ok);
}

/* ---------- 选择题 ---------- */
{
  const q = { type: 'choice', options: ['riveting', 'gripping', 'absorbing', 'engrossing'], answer: 'riveting' };
  check('选择：点对选项判对', gradeChoice(q, 0).status === 'right');
  check('选择：点错选项判错', gradeChoice(q, 2).status === 'wrong');
  check('选择：没选算未答', gradeChoice(q, null).status === 'blank');
  const letter = { ...q, answer: 'A' };
  check('选择：参考答案只给字母也能判对', gradeChoice(letter, 0).status === 'right', JSON.stringify(gradeChoice(letter, 0)));
  const withPrefix = { type: 'choice', options: ['A. riveting', 'B. gripping'], answer: 'riveting' };
  check('选择：选项带 "A." 前缀也能判对', gradeChoice(withPrefix, 0).status === 'right');
}

/* ---------- 题型分类 ---------- */
{
  check('翻译/改错算主观题（交模型批）', isSubjective({ type: 'translate' }) && isSubjective({ type: 'correct' }));
  check('有选项的用法判断题算客观题', !isSubjective({ type: 'usage', options: ['a', 'b'] }));
  check('填空算客观题', !isSubjective({ type: 'fill' }));
}

/* ---------- 整卷 ---------- */
{
  const questions = [
    { type: 'choice', options: ['a', 'b'], answer: 'a' },
    { type: 'fill', answer: 'mandatory' },
    { type: 'translate', answer: 'He put the book on the table.' },
  ];
  const answers = { 0: { choice: 0 }, 1: { text: 'Mandatory' }, 2: { text: '' } };
  const paper = gradePaper(questions, answers);
  check('整卷：客观题统计正确', paper.objectiveRight === 2 && paper.objectiveTotal === 2, JSON.stringify(paper.results.map((r) => r.status)));
  check('整卷：主观题未作答不进模型批改', paper.subjective.length === 0, JSON.stringify(paper.subjective));
  const answers2 = { 0: { choice: 1 }, 1: { text: 'x' }, 2: { text: 'He put book on table.' } };
  const paper2 = gradePaper(questions, answers2);
  check('整卷：主观题有作答才交模型', paper2.subjective.length === 1 && paper2.subjective[0].index === 2);
  check('整卷：未答的客观题不计入分母', paper2.objectiveTotal === 2 && paper2.objectiveRight === 0, JSON.stringify({ r: paper2.objectiveRight, t: paper2.objectiveTotal }));
}

/* ---------- 备选答案切分 ---------- */
{
  check('备选答案支持 / ； ; 、 四种分隔', alternatives('a / b；c; d、e').length === 5, JSON.stringify(alternatives('a / b；c; d、e')));
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
