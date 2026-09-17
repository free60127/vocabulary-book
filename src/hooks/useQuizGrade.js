import { useCallback, useMemo, useState } from 'react';
import { quizGrade } from '../api.js';
import { gradePaper } from '../quizGrade.js';
import { submitAndPoll } from './pollJob.js';
import { POLL_QUIZ_MS, TIMEOUT_QUIZ_MS, POLL_MAX_FAILURES } from '../constants.js';

/**
 * 自测题的"作答 + 批改"。
 *
 * 分工（这是刻意的）：
 *  · **客观题本地判**（选择/填空/用法）—— 秒出结果、不花钱、规则有单测钉住；
 *  · **主观题交给模型**（翻译、改错）—— 没有唯一答案，一次请求批完整卷主观题，
 *    返回逐题得分与点评，再和本地结果合并展示。
 *
 * 用户没答的题按"未答"处理，不算错：批改的意义是看哪里不会，不是扣分羞辱。
 */
export function useQuizGrade({ settings, aliveRef, flash }) {
  const [answers, setAnswers] = useState({});      // { [题号]: { choice?: number, text?: string } }
  const [graded, setGraded] = useState(null);      // { results, objectiveRight, objectiveTotal, comment }
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  const setAnswer = useCallback((index, patch) => {
    setAnswers((prev) => ({ ...prev, [index]: { ...(prev[index] || {}), ...patch } }));
  }, []);

  const reset = useCallback(() => { setAnswers({}); setGraded(null); setProgress(''); }, []);

  /** 已作答的题数（用于"批改 N 题"按钮文案与禁用判断） */
  const answeredCount = useMemo(() => Object.values(answers).filter((a) => {
    if (!a) return false;
    if (a.choice !== undefined && a.choice !== null && a.choice >= 0) return true;
    return Boolean(String(a.text || '').trim());
  }).length, [answers]);

  /**
   * 批改整卷。
   * @returns {Promise<{results:Array, objectiveRight:number, objectiveTotal:number}>}
   */
  const grade = useCallback(async (questions) => {
    const list = Array.isArray(questions) ? questions : [];
    if (!list.length || busy) return null;
    setBusy(true); setProgress('正在批改客观题…');
    const local = gradePaper(list, answers);
    // 先把客观题结果亮出来，主观题再慢慢补 —— 不让用户对着一个转圈等全部
    setGraded({ ...local, comment: '' });
    try {
      if (local.subjective.length) {
        setProgress(`客观题已批完，正在看 ${local.subjective.length} 道主观题…`);
        const out = await submitAndPoll({
          submit: () => quizGrade({
            items: local.subjective.map((s) => ({
              stem: s.question.stem, type: s.question.type,
              answer: s.question.answer, userAnswer: s.userAnswer,
            })),
            baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
          }),
          fetchJob: (jobId) => quizGrade.job(jobId),
          intervalMs: POLL_QUIZ_MS,
          timeoutMs: TIMEOUT_QUIZ_MS,
          maxFailures: POLL_MAX_FAILURES,
          netError: '网络不稳定，暂时取不到批改结果，请重试',
          timeoutError: '批改超时了，稍后再点一次「批改」即可。',
          isAlive: () => aliveRef.current,
        });
        if (!out.aborted) {
          const back = (out.data && out.data.items) || [];
          const merged = local.results.map((r) => {
            const sub = local.subjective.find((s) => s.index === r.index);
            if (!sub) return r;
            const hit = back.find((x) => Number(x.index) === local.subjective.indexOf(sub));
            if (!hit) return { ...r, status: 'ungraded' };
            return {
              ...r,
              status: hit.correct ? 'right' : 'wrong',
              score: hit.score,
              comment: hit.comment || '',
              better: hit.better || '',
            };
          });
          setGraded({ ...local, results: merged, comment: (out.data && out.data.comment) || '' });
          flash('批改完成：客观题 ' + local.objectiveRight + '/' + local.objectiveTotal, 3600);
        }
      } else {
        flash('批改完成：客观题 ' + local.objectiveRight + '/' + local.objectiveTotal, 3600);
      }
      return local;
    } catch (e) {
      // 主观题批不了不影响客观题结果（已经显示了）
      flash('主观题批改失败：' + ((e && e.message) || '请稍后再试'), 4200);
      return local;
    } finally {
      setBusy(false); setProgress('');
    }
  }, [answers, busy, settings, aliveRef, flash]);

  return { answers, setAnswer, graded, setGraded, busy, progress, grade, reset, answeredCount };
}
