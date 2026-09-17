/**
 * 自测题的**质量体检**（本地、确定性、不花钱）。
 *
 * 起因是一个真实的尴尬：模型出了这样一道填空题 ——
 *
 *   Wearing a mask in the hospital is ______ for all visitors.（用 mandatory 的适当形式填空）
 *   答案：mandatory
 *
 * 题干把答案词**直接告诉**了用户，答案是原词、没有任何变化 —— 这题等于白送，做了没意义。
 * 提示词已经收紧（见 prompt.mjs），但模型不听话是常态，所以再加一道**代码侧的兜底**：
 * 把这类题**自动修好**（能修就修），修不了的直接剔除，并如实告诉用户剔了几道。
 *
 * 为什么不"发现有问题的就让模型重出"：那要多花一次调用与等待，而绝大多数情况
 * 只需要把泄题的提示语删掉 —— 题目本身是好的，句子就是语境。
 */

/** 「用 X 的适当形式填空」这类提示语的几种写法 */
const HINT_PATTERNS = [
  /[（(]\s*用\s*([A-Za-z][A-Za-z'\- ]{1,30}?)\s*的?适当形式(?:填空|填入|填写)?\s*[)）]/g,
  /[（(]\s*用\s*([A-Za-z][A-Za-z'\- ]{1,30}?)\s*填空\s*[)）]/g,
  /[（(]\s*用\s*(?:所给)?(?:单词|词|提示词)\s*([A-Za-z][A-Za-z'\- ]{1,30}?)\s*[)）]/g,
];

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[\s.。,，;；:：!！?？"'’“”()（）]/g, '');

/** 题干里的"给词提示"提取出来（用于判断是否泄题） */
export function hintWords(stem) {
  const out = [];
  for (const re of HINT_PATTERNS) {
    const r = new RegExp(re.source, re.flags);
    let m = r.exec(String(stem || ''));
    while (m) {
      if (m[1]) out.push(m[1].trim());
      m = r.exec(String(stem || ''));
    }
  }
  return out;
}

/** 去掉题干里的给词提示（保留句子本身） */
function stripHints(stem) {
  let s = String(stem || '');
  for (const re of HINT_PATTERNS) {
    s = s.replace(new RegExp(re.source, re.flags), ' ');
  }
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([.。?？!！,，])/g, '$1').trim();
}

/**
 * 体检 + 修复。
 *
 * 规则：
 *  ① 填空题带了「用 X 的适当形式填空」但答案**就是 X**（原词）→ 删掉那截提示（题目变成正常的语境填空）；
 *  ② 填空题答案**原样出现在题干其他位置**（题干泄题，且不是给词提示）→ 无法修复，剔除；
 *  ③ 答案为空 → 剔除。
 * 选择题/其他题型不受影响（答案写在选项里是正常的）。
 *
 * @returns {{questions:Array, repaired:number, dropped:number, notes:string[]}}
 */
export function auditQuizQuestions(rawQuestions) {
  const list = Array.isArray(rawQuestions) ? rawQuestions : [];
  const questions = [];
  let repaired = 0;
  let dropped = 0;
  const notes = [];

  for (const q of list) {
    if (!q || typeof q !== 'object') continue;
    const answer = String(q.answer == null ? '' : q.answer).trim();
    const hasOptions = Array.isArray(q.options) && q.options.length > 0;
    if (!answer && !hasOptions) { dropped += 1; continue; }

    // 选择题：答案在选项里是正常的，只看题干有没有直接把答案词写出来（同一句里出现答案词也不算泄题）
    if (hasOptions) { questions.push(q); continue; }

    let stem = String(q.stem || '');
    const hints = hintWords(stem);
    const answerNorm = norm(answer);

    // ① 提示词 == 答案（原词）→ 删提示
    if (hints.some((h) => norm(h) === answerNorm)) {
      const next = stripHints(stem);
      if (next && next.replace(/[_＿\-—]{2,}/g, '').trim().length > 4) {
        stem = next;
        repaired += 1;
        notes.push('有一道填空题把答案词写在提示里（"用 ' + hints[0] + ' 的适当形式填空"但答案就是原词），已把那截提示删掉');
      } else {
        dropped += 1;
        continue;
      }
    }

    // ② 答案仍原样出现在题干里（去掉提示之后）→ 泄题，剔除
    const stemForCheck = norm(stripHints(stem));
    if (answerNorm.length >= 3 && stemForCheck.includes(answerNorm)) {
      dropped += 1;
      continue;
    }

    questions.push(stem === String(q.stem || '') ? q : { ...q, stem });
  }

  return { questions, repaired, dropped, notes };
}
