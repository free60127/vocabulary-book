/**
 * 任务条数淘汰：把最旧的查词/出题记录删掉，保证 KV 不被慢慢塞满。
 *
 * 为什么需要：任务结果只靠 TTL 过期（默认 30 天）。TTL 能保证单个键最终消失，
 * 但**保证不了总量** —— 30 天里查一万次就有一万条记录同时在库里（每条几 KB 到几十 KB）。
 * 而 Upstash 免费额度是 256MB 且**按库算**：这个项目与姊妹项目「回译本」共用同一个库时，
 * 谁把库塞满，另一个应用就先遭殃（写不进去 = 账号、同步一起挂）。
 *
 * 实现刻意**不扫描键空间**（KEYS/SCAN 在 Upstash 上按命令计费，且会随库变大而变慢）：
 *   · 每落地一个任务：INCR 取一个递增序号 + 写一条「序号 → jobId」的小映射键（各 1 条命令）
 *   · 超过上限时：读最旧的那条映射 → 删任务键 + 删映射（1 读 2 删），每次只淘汰一条
 * 这套指针式淘汰与「回译本」里已经跑过测试的实现是同一个设计。
 *
 * 另一条原则：**淘汰失败不能影响查词**。所有调用都吞掉异常只记日志 ——
 * 它是清理工，不是关键路径。
 */
export function createJobEvictor({ kv, prefix = 'vb:', max = 2000, ttlSec = 30 * 86400, log = console, now = Date.now }) {
  const SEQ_KEY = prefix + 'jobs:seq';
  const seqKeyOf = (n) => prefix + 'jobseq:' + String(n).padStart(12, '0');

  let seq = 0;          // 已发放的最大序号
  let evicted = 0;      // 淘汰指针：<= 它的序号都已删除
  let ready = false;    // 是否已从 kv 读回指针（重启后接着上次的位点继续）
  let failures = 0;
  /**
   * 已经记过账的 jobId。
   *
   * 为什么必须去重：**一个任务会被 saveJob 写好几次**（提交时 pending、开跑时 running、
   * 结束再写一次 done），而 saveJob 每次都调 track。不去重的话一个任务占掉三个序号，
   * 淘汰指针就按三倍速度往前推 —— 实测 max=3、查 5 次，只剩 1 条（本该留 3 条）。
   * 上线后表现是"刚查完的词条，刷新一下就 404"，而且越忙丢得越快。
   * 有界：只留最近 max*2 个 id，避免这个 Set 自己变成内存泄漏。
   */
  const tracked = new Set();

  /** 启动时把序号读回来：否则重启后序号从 0 重新发，会把老任务当成"最新的"永远淘汰不到 */
  async function init() {
    try {
      seq = Number(await kv.get(SEQ_KEY)) || 0;
    } catch (e) {
      log.warn('[job-evict] 序号读取失败，本次从 0 开始（只影响淘汰顺序）：', e && e.message);
    }
    // 淘汰指针不需要持久化：从 seq - max 推出来，最多多留几轮的量
    evicted = Math.max(0, seq - max);
    ready = true;
    return seq;
  }

  /** 淘汰到"剩余不超过 max"为止；返回本次删掉的条数 */
  async function evictTo() {
    let removed = 0;
    while (seq - evicted > max) {
      evicted += 1;
      const sk = seqKeyOf(evicted);
      try {
        const jobId = String(await kv.get(sk) || '');
        if (jobId) await kv.del(prefix + 'job:' + jobId);
        await kv.del(sk);
        removed += 1;
      } catch (e) {
        failures += 1;
        log.warn('[job-evict] 淘汰失败（不影响查词）：', e && e.message);
        break;                      // 存储异常时别死循环，下一轮再试
      }
    }
    return removed;
  }

  /** 记一个新任务；超上限就顺手淘汰最旧的。**永不抛错**。 */
  async function track(jobId) {
    if (!jobId) return { tracked: false };
    if (tracked.has(jobId)) return { tracked: false, duplicate: true };
    // ⚠️ 占位必须**在第一个 await 之前**同步完成。
    // saveJob 是 fire-and-forget 调用（不 await），一个任务的 pending/running/done
    // 三次保存在同一轮事件循环里交叉执行：如果占位放在 await 之后，三次都会通过
    // `tracked.has` 检查，一个任务照样占掉三个序号（实测 2 次查词 seq=3）。
    tracked.add(jobId);
    // 有界：超了就按插入顺序丢最旧的（不能 clear，否则会连刚占的位一起丢掉）
    while (tracked.size > max * 2) tracked.delete(tracked.values().next().value);
    try {
      if (!ready) await init();
      const n = await kv.incrBy(SEQ_KEY, 1);
      seq = Number(n) || seq + 1;
      await kv.set(seqKeyOf(seq), jobId, ttlSec);
      const removed = seq - evicted > max ? await evictTo() : 0;
      return { tracked: true, seq, removed };
    } catch (e) {
      failures += 1;
      tracked.delete(jobId);        // 占位撤回：这次没记成，下次保存还能再试
      log.warn('[job-evict] 记账失败（不影响查词）：', e && e.message);
      return { tracked: false };
    }
  }

  return {
    init, track, evictTo,
    get stats() { return { max, seq, evicted, retained: Math.max(0, seq - evicted), tracked: tracked.size, failures, at: now() }; },
  };
}
