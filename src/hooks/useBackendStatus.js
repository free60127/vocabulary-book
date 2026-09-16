import { useCallback, useEffect, useRef, useState } from 'react';
import { getStatus } from '../api.js';

/**
 * 后端状态（顶栏那个小圆点）。
 *
 * 真实事故：用户看到「后端未连接」，但查词、复习、同步都正常。
 * 根因是这里**只在打开页面时查一次**：托管平台的免费实例休眠后冷启动要 30~60 秒，
 * 而 `/api/status` 的超时只有 15 秒 —— 第一次探活失败就被永久判成"未连接"，
 * 之后再也不会重试（哪怕随后每次查词都成功）。
 *
 * 所以这个 hook 做三件事：
 *  ① 打开时**退避重试**（3s / 8s / 20s / 45s），足够覆盖一次冷启动；
 *  ② 切回页面、窗口获得焦点时重新探活（用户常常是先切走等它醒，再切回来）；
 *  ③ 任何一次真实请求成功 = 后端活着 → `markUp()` 立刻纠正状态，
 *     不必等下一次探活（这是最直接的证据，比探活本身更可信）。
 */
const RETRY_DELAYS = [3000, 8000, 20000, 45000];

export function useBackendStatus() {
  const [status, setStatus] = useState(null);
  /** 正在探活（此时不该说"未连接"—— 还没失败呢） */
  const [checking, setChecking] = useState(true);
  const aliveRef = useRef(true);
  const triesRef = useRef(0);
  const timerRef = useRef(null);

  const check = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setChecking(true);
    try {
      const s = await getStatus();
      if (!aliveRef.current) return null;
      setStatus(s);
      setChecking(false);
      triesRef.current = 0;
      return s;
    } catch {
      if (!aliveRef.current) return null;
      const n = triesRef.current;
      triesRef.current = n + 1;
      // 前两次失败（约 11 秒）仍算"正在连接"：冷启动本来就要 30~60 秒，
      // 太早下"未连接"的结论，用户看到的就是"明明能查词却一直说未连接"。
      if (n >= 2) setChecking(false);
      if (n < RETRY_DELAYS.length) {
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => { check({ silent: true }); }, RETRY_DELAYS[n]);
      }
      return null;
    }
  }, []);

  /** 真实请求成功了：后端肯定是活的，直接把状态纠正过来 */
  const markUp = useCallback(() => {
    if (status) return;
    clearTimeout(timerRef.current);
    triesRef.current = RETRY_DELAYS.length;   // 不再退避重试，直接查一次
    check({ silent: true });
  }, [status, check]);

  useEffect(() => {
    aliveRef.current = true;
    check();
    const onWake = () => {
      if (document.visibilityState === 'hidden') return;
      if (status) return;
      check({ silent: true });
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      aliveRef.current = false;
      clearTimeout(timerRef.current);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
    // 只在挂载时启动；后续由退避/唤醒/markUp 驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, checking, retry: () => check(), markUp };
}
