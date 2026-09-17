import { useCallback, useEffect, useState } from 'react';
import { sentencePractice, getSentenceJob } from '../api.js';
import { submitAndPoll } from './pollJob.js';
import { safeGet, safeSet, SENTENCE_PREF_KEY } from '../storage.js';
import {
  POLL_MAX_FAILURES, POLL_SENTENCE_MS, TIMEOUT_SENTENCE_MS,
} from '../constants.js';

/**
 * 造句练习的会话状态。
 *
 * 从 App.jsx 抽出来的理由（原文件 1100+ 行，改一处要读完上下文）：
 * 这一块是**自成一体**的 —— 出题、批改、收藏错句、模式与难度偏好，
 * 只依赖"抽词池 + 三件事"（submitAndPoll、进错词本、清错词本），
 * 不碰查词/复习/同步的任何状态，是四个会话里最适合先拆的一块。
 *
 * 抽词口径复用复习队列：练什么和复习什么保持一致（本子 + 收藏，斩掉的排除）。
 */
export function useSentencePractice({
  pool, fallbackWords, aliveRef, level, settings, markWrong, clearWrongWord, addSentence, sentences,
}) {
  const [mode, setMode] = useState('free');            // free | translate
  const [items, setItems] = useState([]);
  const [index, setIndex] = useState(0);
  const [grade, setGrade] = useState(null);
  const [busy, setBusy] = useState(false);
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState('');
  const [savedIds, setSavedIds] = useState([]);
  const [bookOpen, setBookOpen] = useState(false);
  /* 难度与题量：记在本机（"今天想练几句"是当下心情，不需要跨设备同步） */
  const [count, setCount] = useState(() => {
    const v = Number(safeGet(SENTENCE_PREF_KEY, '') ? JSON.parse(safeGet(SENTENCE_PREF_KEY, '{}')).count : 0);
    return v >= 1 && v <= 30 ? v : 5;
  });
  const [difficulty, setDifficulty] = useState(() => {
    try { return JSON.parse(safeGet(SENTENCE_PREF_KEY, '{}')).difficulty || '中等'; } catch { return '中等'; }
  });
  useEffect(() => {
    safeSet(SENTENCE_PREF_KEY, JSON.stringify({ count, difficulty }));
  }, [count, difficulty]);

  const reset = useCallback(() => {
    setItems([]); setGrade(null); setError('');
  }, []);

  /** 开始一轮：抽词 → 出题（翻译模式的中文句子由模型给） */
  const start = useCallback(async (chosenMode) => {
    const source = pool.length ? pool : fallbackWords;
    if (!source.length) { setError('还没有词可以练 —— 先查几个词，或在收藏夹里收几个'); return; }
    setError(''); setBusy(true); setGrade(null);
    try {
      // 一次抽 N 个：太少不像练习，太多一次批改等太久
      const chosen = [...source].sort(() => Math.random() - 0.5).slice(0, count);
      const points = chosen.map((x) => {
        const e = x.entry || {};
        const f = x.favorite || {};
        return [
          x.head,
          e.pos || f.pos || '',
          (e.meanings && e.meanings[0] && e.meanings[0].cn) || e.brief || f.brief || '',
          (e.synonyms || []).slice(0, 2).map((s) => s.word + (s.diff ? '（' + s.diff + '）' : '')).join('；'),
        ].filter(Boolean).join('｜');
      });
      const out = await submitAndPoll({
        submit: () => sentencePractice({
          mode: 'make', points, count: chosen.length, level, difficulty,
          baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
        }),
        fetchJob: getSentenceJob,
        intervalMs: POLL_SENTENCE_MS,
        timeoutMs: TIMEOUT_SENTENCE_MS,
        maxFailures: POLL_MAX_FAILURES,
        netError: '网络不稳定，没拿到题目，请重试',
        timeoutError: '出题超时了，稍后再点一次「开始」即可',
        isAlive: () => aliveRef.current,
      });
      if (out.aborted) return;
      const list = (out.data && out.data.items) || [];
      if (!list.length) throw new Error('模型没有给出题目，请重试');
      const byHead = new Map(chosen.map((x) => [String(x.head).toLowerCase(), x]));
      setItems(list.map((it) => {
        const hit = byHead.get(String(it.head).toLowerCase()) || {};
        const e = hit.entry || {};
        const f = hit.favorite || {};
        return {
          ...it,
          phonetic: e.phonetic || f.phonetic || '',
          meaning: (e.meanings && e.meanings[0] && e.meanings[0].cn) || e.brief || f.brief || '',
          key: hit.key || it.head,
          entry: hit.entry || null,
        };
      }));
      setMode(chosenMode || 'free');
      setIndex(0);
    } catch (e) {
      setError(e.message || '出题失败');
    } finally {
      setBusy(false);
    }
  }, [pool, fallbackWords, count, level, difficulty, settings, aliveRef]);

  /** 提交批改：结果同时决定"进不进错词本"（与复习、拼写同一套出口） */
  const submit = useCallback(async (sentence) => {
    const cur = items[index];
    if (!cur || !sentence || !String(sentence).trim()) return;
    setGrading(true); setError(''); setGrade(null);
    try {
      const out = await submitAndPoll({
        submit: () => sentencePractice({
          mode: 'grade', head: cur.head, brief: cur.meaning || '',
          cn: mode === 'translate' ? cur.cn : '',
          sentence: String(sentence).trim(), level, difficulty,
          baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
        }),
        fetchJob: getSentenceJob,
        intervalMs: POLL_SENTENCE_MS,
        timeoutMs: TIMEOUT_SENTENCE_MS,
        maxFailures: POLL_MAX_FAILURES,
        netError: '网络不稳定，没拿到批改结果，请再提交一次',
        timeoutError: '批改超时了，再点一次「提交批改」即可',
        isAlive: () => aliveRef.current,
      });
      if (out.aborted) return;
      const g = out.data || {};
      setGrade({ ...g, sentence: String(sentence).trim() });
      if (g.usesTarget === false || (Number(g.score) || 0) < 60) {
        markWrong({ head: cur.head, entry: cur.entry, brief: cur.meaning }, 'forgot');
      } else if ((Number(g.score) || 0) >= 85) {
        clearWrongWord(cur.head);
      }
    } catch (e) {
      setError(e.message || '批改失败');
    } finally {
      setGrading(false);
    }
  }, [items, index, mode, level, difficulty, settings, aliveRef, markWrong, clearWrongWord]);

  /** 收进错句本：完全由用户决定（不做自动收藏，那是"私人收藏"而不是"薄弱项"） */
  const save = useCallback(() => {
    const cur = items[index];
    if (!cur || !grade) return;
    const id = addSentence({
      head: cur.head, phonetic: cur.phonetic, meaning: cur.meaning,
      mode, cn: mode === 'translate' ? cur.cn : '',
      sentence: grade.sentence || '', score: grade.score,
      verdict: grade.verdict, corrected: grade.corrected,
      suggestion: grade.suggestion, problems: grade.problems, difficulty,
    });
    if (id) {
      setSavedIds((prev) => [...prev, id]);
      setGrade((g) => (g ? { ...g, savedId: id } : g));
    }
  }, [items, index, grade, mode, difficulty, addSentence]);

  const next = useCallback(() => { setGrade(null); setIndex((i) => i + 1); }, []);

  /** 从错句本里挑一条再练一次这个词 */
  const practiceWord = useCallback((item) => {
    setBookOpen(false);
    setItems([{ head: item.head, cn: item.cn || '', tip: '', phonetic: item.phonetic || '', meaning: item.meaning || '', key: item.head }]);
    setMode(item.mode === 'translate' && item.cn ? 'translate' : 'free');
    setIndex(0); setGrade(null); setError('');
  }, []);

  return {
    mode, setMode, items, index, grade, busy, grading, error, setError,
    count, setCount, difficulty, setDifficulty,
    savedIds, bookOpen, setBookOpen, bookCount: sentences.length,
    isSaved: Boolean(grade && (grade.savedId || savedIds.includes(grade.id))),
    start, submit, save, next, practiceWord, reset,
  };
}
