/**
 * 统一的异步任务轮询（分析 / 素材 / 自测题 / OCR 共用）。
 *
 * 抽出来的原因：四处原来各写了一份逐字重复的循环（sleep → 取任务 → 失败计数 →
 * deadline → done/error），差别只有间隔、超时和文案 —— 改一处要记得改四处。
 *
 * @returns {Promise<{data?: any, aborted?: true}>} 组件已卸载时返回 { aborted: true }
 */
export async function pollJob({ jobId, fetchJob, intervalMs, timeoutMs, maxFailures, netError, timeoutError, onProgress, isAlive }) {
  /**
   * 计时只算「页面在前台」的时间。
   *
   * 手机锁屏 / 切到别的 App 时，浏览器会冻结定时器：墙上时钟照走，但一次轮询都没发生。
   * 原来用的是纯墙钟 deadline，于是用户锁屏 12 分钟回来只看到「生成超时，请重新提交」——
   * 而服务端其实早就跑完了；更糟的是超时分支从不进 onData，本机历史里连这条记录都没有，
   * 用户没有任何入口找回这次批改，只能再花一次钱。
   *
   * 现在把「隐藏时长」从已用时间里扣掉：回到前台后继续轮询，跑完照常出结果。
   * 页面隐藏期间不额外延长 timeoutMs 之外的时间 —— 只是不把它算作等待。
   */
  const startedAt = Date.now();
  let hiddenMs = 0;
  let hiddenSince = typeof document !== 'undefined' && document.hidden ? Date.now() : 0;
  const onVisibility = () => {
    if (document.hidden) { if (!hiddenSince) hiddenSince = Date.now(); }
    else if (hiddenSince) { hiddenMs += Date.now() - hiddenSince; hiddenSince = 0; }
  };
  const canListen = typeof document !== 'undefined' && typeof document.addEventListener === 'function';
  if (canListen) document.addEventListener('visibilitychange', onVisibility);
  /** 已用的"前台时间"（毫秒） */
  const activeElapsed = () => Date.now() - startedAt - hiddenMs - (hiddenSince ? Date.now() - hiddenSince : 0);

  let failures = 0;
  let polls = 0;
  try {
    while (activeElapsed() < timeoutMs) {
      /**
       * 间隔前快后慢：任务通常要跑几十秒，但**完成的那一刻**只有靠下一次轮询才知道。
       * 固定 1.5 秒意味着平均白等 0.75 秒（最坏 1.5 秒）——用户感知就是"明明好了还不出"。
       * 前 12 次（约 6 秒）用 500ms 快速跟上，之后回到配置的间隔，省流量也不丢手感。
       */
      const warmup = Math.min(12, Math.ceil(6000 / Math.max(200, intervalMs)));
      const waitMs = polls < warmup ? Math.max(300, Math.round(intervalMs / 3)) : intervalMs;
      polls += 1;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      if (isAlive && !isAlive()) return { aborted: true };
      let r;
      try {
        r = await fetchJob(jobId);
        failures = 0;
      } catch (e) {
        /**
         * 服务端**已经明确答复**的 4xx 不要当网络抖动重试。
         *
         * 最典型的是 404「任务不存在或已过期」：服务重启/任务被淘汰之后它就永远不存在了，
         * 再重试 11 次也只是白等十几秒，最后抛出 netError ——把"任务没了"误报成"网络不稳定"，
         * 用户于是去检查 WiFi、反复重试同一件事。api.js 早就把 status 与服务端文案带出来了，
         * 这里直接用原文案，让用户看到真正的原因。
         * 5xx / 网络层失败仍然照旧重试（那才是真的抖动）。
         */
        const status = Number(e && e.status) || 0;
        if (status >= 400 && status < 500) throw new Error((e && e.message) || netError);
        failures += 1;
        if (failures > maxFailures) throw new Error(netError);
        continue;
      }
      const job = r && r.job;
      if (!job) continue;
      if (job.status === 'done') return { data: job.data };
      if (job.status === 'error') throw new Error(job.error || '任务失败，请重试');
      if (onProgress) onProgress({ ...(job || {}), elapsedMs: activeElapsed() });
    }
  } finally {
    if (canListen) document.removeEventListener('visibilitychange', onVisibility);
  }
  throw new Error(timeoutError);
}

/**
 * 提交任务 + 轮询到结束 —— 四条链路（分析 / 素材 / 自测题 / OCR）共用的前半段。
 *
 * 之前每处都要自己写六行完全相同的 pollJob 参数（间隔/超时/失败阈值/两句错误文案），
 * 参数写错（比如忘了 maxFailures）不会报错，只会表现成"偶尔卡住"。收到这里之后，
 * 调用方只管 submit 什么、拿到 data 做什么。
 *
 * `jobId`：**已经有任务号时直接用它，不再 submit**。
 * 查词的流式链路要用这个：流式连不上时它其实已经建好任务了（useLookupStream 会回传 jobId），
 * 调用方若丢掉那个 id 再 submit 一次，同一个词就会跑两遍模型、花两份钱 ——
 * 而 hook 的注释明确承诺"同一个 jobId，不重复提交、不重复计费"。弱网/代理拦 SSE 时必中。
 *
 * @returns {Promise<{data?: any, aborted?: true}>}
 */
export async function submitAndPoll({ submit, fetchJob, jobId: existingJobId, intervalMs, timeoutMs, maxFailures, netError, timeoutError, isAlive, onProgress, onJobId }) {
  let jobId = existingJobId;
  if (!jobId) {
    const resp = await submit();
    jobId = resp && resp.jobId;
    // 少数情况服务端会直接同步返回结果（没有任务号）：当作已完成，不再轮询
    if (!jobId && resp && resp.data) return { data: resp.data };
    if (!jobId) throw new Error('服务器未返回任务编号，请重试');
  }
  if (onJobId) onJobId(jobId);
  return pollJob({ jobId, fetchJob, intervalMs, timeoutMs, maxFailures, netError, timeoutError, isAlive, onProgress });
}
