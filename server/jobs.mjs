/**
 * 任务生命周期 + 并发闸门。
 *
 * 从 index.mjs 抽出来的（原文件 1000+ 行：路由、限流、任务、模型调用混在一起，
 * 每次动一处都要读完上下文）。**实现逐行照搬，重构只搬位置、不改行为** ——
 * 下面几条都是踩过坑才长出来的，动一个字都会出事：
 *   · KV 里存的是 JSON **字符串**（file KV 只接受字符串，存对象会写坏）；
 *   · 每次 saveJob 都要向淘汰器记账，否则"上限 2000"只是 /api/status 里的一句谎话；
 *   · 错误文案是给用户看的（前端与模拟测试都在断言"服务端任务异常：…"这句）；
 *   · 并发闸门与任务同生命周期：任务跑完必须释放槽位，否则服务会慢慢"卡死"。
 */
import { staleMsFor } from './job-stale.mjs';
import { createJobEvictor } from './job-evict.mjs';

/** 并发闸门：限流（每分钟多少次）管不住"同时有多少个任务在跑"，这是两件事 */
export function createJobSlots({ max = 4, maxQueued = 50 } = {}) {
  let inflightJobs = 0;
  const jobQueue = [];
  async function acquireJobSlot() {
    if (inflightJobs < max) { inflightJobs += 1; return true; }
    if (jobQueue.length >= maxQueued) return false;
    await new Promise((resolve) => jobQueue.push(resolve));
    return true;
  }
  function releaseJobSlot() {
    const next = jobQueue.shift();
    if (next) next();
    else inflightJobs -= 1;
  }
  return {
    acquireJobSlot,
    releaseJobSlot,
    stats: () => ({ inflight: inflightJobs, queued: jobQueue.length, maxInflight: max, maxQueued }),
  };
}

export function createJobStore({ kv, prefix, ttlSec, max, slots }) {
  const JOB_PREFIX = prefix + 'job:';
  const JOB_TTL_SEC = ttlSec;
  const jobEvictor = createJobEvictor({ kv, prefix, max, ttlSec });
  const jobs = new Map();
  const jobRenewedAt = new Map();
  const JOB_RENEW_MS = 24 * 60 * 60 * 1000;

  function scheduleForget(jobId) {
    const t = setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
    if (t.unref) t.unref();
  }
  function saveJob(job) {
    jobs.set(job.jobId, job);
    scheduleForget(job.jobId);
    jobEvictor.track(job.jobId);      // 记账 + 超上限时淘汰最旧的（内部吞异常，不影响查词）
    return Promise.resolve(kv.set(JOB_PREFIX + job.jobId, JSON.stringify(job), JOB_TTL_SEC)).catch(() => {});
  }
  function renewJobTtl(job) {
    if (!job || !job.jobId) return;
    if (jobRenewedAt.size > 5000) jobRenewedAt.clear();
    const last = jobRenewedAt.get(job.jobId) || 0;
    if (Date.now() - last < JOB_RENEW_MS) return;
    jobRenewedAt.set(job.jobId, Date.now());
    Promise.resolve(kv.set(JOB_PREFIX + job.jobId, JSON.stringify(job), JOB_TTL_SEC)).catch(() => {});
  }
  async function findJob(jobId) {
    const mem = jobs.get(jobId);
    if (mem) return mem;
    try {
      const raw = await kv.get(JOB_PREFIX + jobId);
      if (!raw) return null;
      const job = JSON.parse(raw);
      if (job && job.jobId) {
        jobs.set(jobId, job);
        scheduleForget(jobId);
        renewJobTtl(job);
        return guardStale(job);
      }
    } catch (e) { console.error('读取任务失败:', e.message); }
    return null;
  }
  function guardStale(job) {
    if (!job || (job.status !== 'running' && job.status !== 'pending')) return job;
    const ts = Number(job.updatedAt || job.createdAt || 0);
    if (ts && Date.now() - ts > staleMsFor(job.kind)) {
      job.status = 'error';
      job.error = '这次任务超时没完成（常见原因：服务端重启，或模型接口长时间无响应）。请重新提交一次。';
      job.updatedAt = Date.now();
      saveJob(job);
    }
    return job;
  }
  function markJobFailed(jobId, e) {
    const message = (e && e.message) || '未知错误';
    const text = e && e.userFacing ? message : '服务端任务异常：' + message + '（请重试；若反复出现请把这句话发给开发者）';
    const apply = (job) => {
      if (!job) return;
      job.status = 'error';
      job.error = text;
      job.updatedAt = Date.now();
      saveJob(job);
    };
    const mem = jobs.get(jobId);
    if (mem) { apply(mem); return undefined; }
    return Promise.resolve().then(() => findJob(jobId)).then(apply).catch(() => {});
  }
  /**
   * refund：路由在 budget.spend() 成功后把它带回这里；任务失败（模型报错/超时/排队满）
   * 时回冲当日额度 —— 扣费在提交时、成败在任务里，不回冲的话失败的请求也白扣一次。
   */
  function safeRun(name, jobId, refund, fn) {
    return slots.acquireJobSlot().then((got) => {
      if (!got) {
        const busy = new Error('服务器正忙（同时在跑的任务已达上限），请过一会儿再试 —— 这次没有调用模型，不产生费用。');
        busy.userFacing = true;
        if (typeof refund === 'function') { try { refund(); } catch { /* 回冲失败不影响报错 */ } }
        return markJobFailed(jobId, busy);
      }
      return Promise.resolve().then(fn)
        .catch((e) => {
          console.error('[job] ' + name + ' 异常:', jobId, (e && e.stack) || e);
          if (typeof refund === 'function') { try { refund(); } catch { /* 回冲失败不影响报错 */ } }
          return markJobFailed(jobId, e);
        })
        .finally(slots.releaseJobSlot);
    });
  }

  return {
    jobs, jobEvictor, JOB_PREFIX, JOB_TTL_SEC,
    saveJob, findJob, guardStale, markJobFailed, safeRun,
    stats: () => ({ ttlSec: JOB_TTL_SEC, max, retained: jobs.size, evict: jobEvictor.stats, ...slots.stats() }),
  };
}
