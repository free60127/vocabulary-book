/**
 * 自测题的判分（客观题本地判，主观题交给模型）。
 *
 * 为什么客观题要在本地判：
 *  · **即时**：点完「批改」立刻看到对错，不用等模型；
 *  · **免费**：一页 20 题如果都发给模型判，既慢又烧额度，而选择题/填空题本来就只有一个标准答案；
 *  · **可控**：判定规则写在代码里、有单测钉住，不会因为模型换个说法就把对的判成错的。
 *
 * 主观题（翻译、改错）没有唯一答案，才交给模型批（见 useQuizSession → /api/quiz/grade）。
 */

/** 归一化：全角转半角、去首尾标点与空白、压缩空格、小写 */
export function normalizeText(input) {
  let s = String(input == null ? '' : input);
  // 全角 → 半角（字母/数字/常见标点）
  s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  s = s.replace(/\u3000/g, ' ');
  s = s.replace(/[\u2018\u2019\u201C\u201D]/g, "'");
  s = s.trim().toLowerCase();
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/^[\s.,;:!?"'()[\]-]+/, '').replace(/[\s.,;:!?"'()[\]-]+$/, '');
  return s;
}

/** 参考答案里的"可接受写法"：用 / ； ; 、 分隔 */
export function alternatives(answer) {
  const parts = String(answer == null ? '' : answer)
    .split(/\s*[/；;、]\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : [String(answer == null ? '' : answer)];
}

/** 括号内容可选：`object (to)` 三种写法都接受 —— `object (to)` / `object to` / `object` */
function variants(text) {
  const raw = String(text == null ? '' : text);
  const out = new Set([raw]);
  // ① 去掉括号但**保留里面的内容**（用户往往不写括号）
  out.add(raw.replace(/[（(]/g, ' ').replace(/[）)]/g, ' '));
  // ② 连内容一起去掉
  out.add(raw.replace(/[（(][^）)]*[）)]/g, ''));
  return [...out].map((x) => x.trim()).filter(Boolean);
}

/**
 * 客观题判分。
 * @returns {{status:'right'|'wrong'|'blank', expected:string, got:string}}
 */
export function gradeObjective(question, answer) {
  const q = question || {};
  const expected = String(q.answer || '');
  const gotRaw = answer == null ? '' : String(answer);
  const got = normalizeText(gotRaw);
  if (!got) return { status: 'blank', expected, got: '' };

  const wants = [];
  for (const alt of alternatives(expected)) for (const v of variants(alt)) wants.push(normalizeText(v));
  const ok = wants.includes(got);
  return { status: ok ? 'right' : 'wrong', expected, got: gotRaw };
}

/** 选择题：支持"点了第几个选项"（比文字比对更稳，选项文本可能带前缀） */
export function gradeChoice(question, pickedIndex) {
  const q = question || {};
  const options = Array.isArray(q.options) ? q.options : [];
  if (pickedIndex == null || pickedIndex < 0 || !options[pickedIndex]) {
    return { status: 'blank', expected: String(q.answer || ''), got: '' };
  }
  const picked = options[pickedIndex];
  const answerNorm = normalizeText(q.answer);
  const pickedNorm = normalizeText(picked);
  // ① 文本一致；② 答案写在选项里（答案常常是选项的完整文本）；③ 答案只给了字母
  const letter = 'ABCDEFGH'[pickedIndex];
  const byLetter = normalizeText(q.answer).replace(/[^a-h]/g, '') === letter.toLowerCase();
  const ok = pickedNorm === answerNorm || answerNorm === letter.toLowerCase() || byLetter
    || (answerNorm.length > 3 && pickedNorm.length > 3 && (pickedNorm.includes(answerNorm) || answerNorm.includes(pickedNorm)));
  return { status: ok ? 'right' : 'wrong', expected: String(q.answer || ''), got: picked };
}

/** 这道题要不要交给模型批（没有唯一答案的题型） */
export function isSubjective(question) {
  const q = question || {};
  if (Array.isArray(q.options) && q.options.length) return false;   // 有选项就是客观题
  const t = String(q.type || '');
  return t === 'translate' || t === 'correct';
}

/** 整卷批改：客观题本地判，返回 {results, subjective:[待模型批的题]} */
export function gradePaper(questions, answers) {
  const list = Array.isArray(questions) ? questions : [];
  const ans = answers || {};
  const results = [];
  const subjective = [];
  list.forEach((q, i) => {
    const a = ans[i] || {};
    if (isSubjective(q)) {
      const text = String(a.text || '').trim();
      results.push({ index: i, status: text ? 'pending' : 'blank', expected: String(q.answer || ''), got: text });
      if (text) subjective.push({ index: i, question: q, userAnswer: text });
      return;
    }
    const r = (Array.isArray(q.options) && q.options.length)
      ? gradeChoice(q, a.choice)
      : gradeObjective(q, a.text);
    results.push({ index: i, ...r });
  });
  const scored = results.filter((r) => r.status === 'right' || r.status === 'wrong');
  return {
    results,
    subjective,
    objectiveRight: scored.filter((r) => r.status === 'right').length,
    objectiveTotal: scored.length,
  };
}
