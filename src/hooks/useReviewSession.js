import { useCallback, useState } from 'react';
import { loadSpell, saveSpell } from '../storage.js';

/**
 * 复习会话状态：一轮复习/拼写的全过程。
 *
 * 从 App.jsx 抽出来的第二块。这一块的状态机最容易出错（模式、练习轮、加练、错词练习
 * 四者交叉），单独放一个文件后，规则能一眼读完：
 *
 *  模式（review / spell）在**进去之前**定好，进去就按它跑整轮；
 *  轮内可以换模式，但**换模式 = 从头开始**（不做"半路把手里的卡变成另一种题"）；
 *  practice（只练不写排期）由两件事决定：这一轮是不是加练/错词练习，或者是不是拼写轮。
 */
export function useReviewSession({
  due, todayQueue, wrongQueue,
  gradeEntry, markStudied, markWrong, clearWrongWord, killWord, flash,
}) {
  const [queue, setQueue] = useState(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [mode, setMode] = useState(() => (loadSpell() ? 'spell' : 'review'));
  const [practice, setPractice] = useState(false);
  const [kind, setKind] = useState('due');           // due | today | wrong
  const [pending, setPending] = useState(null);      // 选模式之前的"待开始队列"

  /** 新一轮开始前把界面复位 */
  const resetRound = useCallback((items, nextKind, nextMode) => {
    setQueue(items);
    setIndex(0);
    setRevealed(false);
    setKind(nextKind);
    setMode(nextMode);
    saveSpell(nextMode === 'spell');
    // 练习轮（加练 / 错词）和拼写轮都**不写排期**：同一个词一天内被评两次会把间隔越推越长
    setPractice(nextKind !== 'due' || nextMode === 'spell');
  }, []);

  /**
   * 点「今日待复习」：有到期的词就进复习；今天已经复习完则进「今日加练」
   * （把今天碰过的词再走一遍）；今天一个词都没碰过才是真的没得练。
   * 两种情况都先让用户**选模式**，选完直接开跑。
   */
  const openSetup = useCallback(() => {
    if (due.length) { setPending({ items: due, kind: 'due' }); return 'setup'; }
    if (todayQueue.length) {
      setPending({ items: todayQueue, kind: 'today' });
      flash('今天的复习已完成 —— 这一轮是加练，不改变复习排期', 2600);
      return 'setup';
    }
    flash('今天还没有学过的词 —— 去查几个新词，或在收藏夹里收几个');
    return 'empty';
  }, [due, todayQueue, flash]);

  const begin = useCallback((chosenMode) => {
    const p = pending || { items: [], kind: 'due' };
    if (!p.items.length) return;
    resetRound(p.items, p.kind, chosenMode || mode);
    setPending(null);
  }, [pending, mode, resetRound]);

  /** 轮内换模式：重新开始这一轮（可预期，不玩"半路变题"） */
  const switchMode = useCallback((next) => {
    if (next === mode || !queue) return;
    setMode(next);
    saveSpell(next === 'spell');
    setIndex(0); setRevealed(false);
    setPractice(kind !== 'due' || next === 'spell');
    flash(next === 'spell' ? '已切到拼写模式 —— 这一轮从头开始拼' : '已切回复习模式 —— 这一轮从头开始', 2600);
  }, [mode, queue, kind, flash]);

  /** 评分：错词本进出 + 写排期（练习轮只记不写） */
  const grade = useCallback((g) => {
    const cur = queue && queue[index];
    if (!cur) return;
    if (g === 'forgot') markWrong(cur, 'forgot');
    else if (g === 'easy') clearWrongWord(cur.head);
    if (!practice) gradeEntry(cur, g);
    else markStudied();
    setIndex((i) => i + 1);
    setRevealed(false);
  }, [queue, index, practice, markWrong, clearWrongWord, gradeEntry, markStudied]);

  /** 斩掉：立刻从这一轮里也拿掉（不然用户还要再看它一次） */
  const kill = useCallback((item) => {
    killWord(item);
    setQueue((q) => (q ? q.filter((x) => String(x.head).toLowerCase() !== String(item.head).toLowerCase()) : q));
    setRevealed(false);
    flash('已斩掉「' + (item.head || '') + '」，以后不再进复习清单', 2600);
  }, [killWord, flash]);

  /** 只练错词：不动排期，练完按表现进出本 */
  const startWrong = useCallback(() => {
    const q = wrongQueue();
    if (!q.length) { flash('错词本里还没有能练的词'); return false; }
    resetRound(q, 'wrong', 'review');
    return true;
  }, [wrongQueue, resetRound, flash]);

  /** 完成页的「用拼写再过一遍」 */
  const restartSpell = useCallback(() => {
    if (!queue || !queue.length) return;
    setMode('spell');
    saveSpell(true);
    setPractice(true);
    setIndex(0); setRevealed(false);
  }, [queue]);

  const exit = useCallback(() => {
    const n = queue ? Math.min(index, queue.length) : 0;
    setQueue(null); setPractice(false); setPending(null);
    return n;
  }, [queue, index]);

  /**
   * 在"模式选择页"里改模式：只改选择、并把偏好记在本机，
   * 真正的切换（重开本轮）走 switchMode。
   * ⚠️ 必须暴露出去：App 把它传给 ReviewSetup 的模式卡片，漏了就会点一下就报
   * "o is not a function"（模拟的"全程无 JS 报错"规则抓到的）。
   */
  const chooseMode = useCallback((next) => {
    setMode(next);
    saveSpell(next === 'spell');
  }, []);

  return {
    queue, index, revealed, mode, practice, kind, pending,
    setPending, setRevealed, setMode: chooseMode,
    openSetup, begin, switchMode, grade, kill, startWrong, restartSpell, exit,
    noteSpellWrong: markWrong,
    /** 队列为空（完成页）时要显示的总数 */
    total: queue ? queue.length : 0,
  };
}
