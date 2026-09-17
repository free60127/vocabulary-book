/**
 * 自测题质量体检。
 *
 * 起因就是一道真实的白送题：
 *   「Wearing a mask is ______ for all visitors.（用 mandatory 的适当形式填空）」答案：mandatory
 * 题干把答案词告诉了学生、答案又是原词 —— 做了等于没做。
 *
 * 跑法：node test/quizQuality.test.mjs
 */
import { auditQuizQuestions, hintWords } from '../server/quizQuality.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* ---------- 白送题：提示词就是答案 → 修好（删掉那截提示） ---------- */
{
  const q = { type: 'fill', stem: 'Wearing a mask in the hospital is ______ for all visitors.（用 mandatory 的适当形式填空）', answer: 'mandatory', options: [] };
  const r = auditQuizQuestions([q]);
  check('提示词==答案的白送题被修好（保留题目、删掉泄题提示）',
    r.repaired === 1 && r.questions.length === 1 && !/适当形式/.test(r.questions[0].stem), JSON.stringify(r.questions[0]));
  check('修好后仍是一道正常填空（空格还在）', /_{3,}/.test(r.questions[0].stem), r.questions[0].stem);
}

/* ---------- 真的考词形变化 → 保留（不能误伤） ---------- */
{
  const q = { type: 'fill', stem: 'His decision was ______ justified.（用 mandatory 的适当形式填空）', answer: 'mandatorily', options: [] };
  const r = auditQuizQuestions([q]);
  check('答案确实是变形时保留原题（提示词留着有用）',
    r.repaired === 0 && r.dropped === 0 && /适当形式/.test(r.questions[0].stem), JSON.stringify(r.questions[0]));
}

/* ---------- 题干直接写了答案（另一种泄题）→ 剔除 ---------- */
{
  const q = { type: 'fill', stem: 'The scandal was a ______ in an otherwise successful campaign.', answer: 'scandal', options: [] };
  const r = auditQuizQuestions([q]);
  check('答案原样出现在题干里 → 剔除', r.dropped === 1 && r.questions.length === 0, JSON.stringify(r));
}

/* ---------- 选择题不受影响（答案写在选项里是正常的） ---------- */
{
  const q = { type: 'choice', stem: '选出最合适的：She ___ the new rules.', options: ['objected', 'opposed'], answer: 'objected' };
  const r = auditQuizQuestions([q]);
  check('选择题原样保留', r.questions.length === 1 && r.dropped === 0 && r.repaired === 0);
}

/* ---------- 没答案的题剔除 ---------- */
{
  const r = auditQuizQuestions([{ type: 'fill', stem: 'X is ______.', answer: '', options: [] }]);
  check('没答案也没选项的题剔除', r.dropped === 1);
}

/* ---------- 提示语识别：几种写法都要认出来 ---------- */
{
  const cases = [
    'Wearing a mask is ______.（用 mandatory 的适当形式填空）',
    'The right is ______.（用 enshrine 填空）',
    'He was ______.（用所给单词 decide）',
  ];
  const ok = cases.every((c) => hintWords(c).length === 1);
  check('语「用 X 的适当形式填空 / 用 X 填空 / 用所给单词 X」都能识别', ok, cases.map((c) => hintWords(c).join(',')).join(' | '));
}

/* ---------- 空输入不炸 ---------- */
{
  check('空输入 / 非数组不抛错', auditQuizQuestions(null).questions.length === 0 && auditQuizQuestions([null, 1, 'x']).questions.length === 0);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
