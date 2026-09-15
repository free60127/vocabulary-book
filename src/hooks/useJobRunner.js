/**
 * 一条「提交 → 轮询」任务链路的状态机：繁忙标记、已耗时、进度步骤与文案、卸载清理。
 *
 * 为什么抽出来：分析 / 素材 / 自测题三条链路原来各自维护一套
 * `busy + elapsed + interval + try/finally + 进度文案`，逻辑逐字重复，只有文案不同；
 * 每加一条链路就要再抄一遍（而且很容易漏掉 clearInterval 或 busy 复位 → 按钮永久转圈）。
 *
 * 这里**只管状态与计时**，不管"提交什么、拿到数据做什么" —— 那部分留在调用方，
 * 所以行为与原来完全一致，只是不再重复。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { submitAndPoll } from './pollJob.js'

export function useJobRunner() {
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);   // 秒（生成中每秒刷新，用于「已等待 N 秒」）
  const [step, setStep] = useState(0);         // 0 空闲 / 1 已提交 / 2 生成中 / 3 完成
  const [message, setMessage] = useState('');
  const timerRef = useRef(null);
  const aliveRef = useRef(true);

  const stopTimer = useCallback(() => {
    clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    const startedAt = Date.now();
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
  }, [stopTimer]);

  // 卸载时让仍在跑的轮询自行退出（否则会在后台一直打接口到超时），并清掉计时器
  useEffect(() => () => { aliveRef.current = false; stopTimer(); }, [stopTimer]);

  /** 「取消等待」用：界面立刻解锁，但**不停后台轮询**（任务已经提交、钱已经花了） */
  const cancelWait = useCallback(() => {
    setBusy(false);
    setStep(0);
    setMessage('');
    stopTimer();
  }, [stopTimer]);

  const reset = useCallback(() => {
    setBusy(false);
    setStep(0);
    setMessage('');
    setElapsed(0);
    stopTimer();
  }, [stopTimer]);

  /**
   * 跑一条链路。出错时**照常抛出**（调用方仍可用 try/catch 做兜底，比如自测题的本地题库）。
   * @returns {Promise<{data?: any, aborted?: true}>}
   */
  const run = useCallback(async ({
    submit, fetchJob, intervalMs, timeoutMs, maxFailures, netError, timeoutError,
    texts = {}, onData, onProgress, onJobId,
  }) => {
    setBusy(true);
    if (texts.submit) { setStep(1); setMessage(texts.submit); }
    startTimer();
    let finished = false;
    try {
      const outcome = await submitAndPoll({
        submit,
        fetchJob,
        intervalMs,
        timeoutMs,
        maxFailures,
        netError,
        timeoutError,
        isAlive: () => aliveRef.current,
        onJobId,
        onProgress: onProgress || (texts.running ? () => { setStep(2); setMessage(texts.running); } : undefined),
      });
      if (outcome.aborted) return { aborted: true };
      if (texts.running) { setStep(2); setMessage(texts.running); }
      if (texts.done) { setStep(3); setMessage(texts.done); }
      finished = true;
      const value = onData ? await onData(outcome.data) : undefined;
      return { data: outcome.data, value };
    } finally {
      stopTimer();
      setBusy(false);
      if (!finished) { setStep(0); setMessage(''); } // 失败/中止 → 进度条复位（成功时保留"完成"态）
    }
  }, [startTimer, stopTimer]);

  // setter 也一并暴露：分析链路有「同步返回 data」「取消等待后再落结果」这类特殊分支，
  // 需要手动驱动同一套状态；共享状态定义 + 计时器，避免各自再抄一份。
  return { busy, elapsed, step, message, setBusy, setStep, setMessage, setElapsed, run, cancelWait, reset, startTimer, stopTimer, aliveRef };
}
