import { useCallback, useEffect, useRef, useState } from 'react';
import { lookup } from '../api.js';
import { foldSegments, SEGMENT_LABEL } from '../streamFold.js';
import { API_BASE } from '../apiBase.js';

/**
 * 流式查词：**边生成边看**。
 *
 * 工作方式：
 *  1. 提交任务（`{ stream: true }`）；
 *  2. 用 EventSource 订阅 `/api/lookup/:id/stream`，每收到一段就折进 `partial`；
 *  3. `done` 事件带**最终完整词条**（服务端 sanitize + 词典校正后的）→ 覆盖 partial，
 *     保证"看到的"和"存下来的"是同一个东西；
 *  4. 任何一步出问题（EventSource 不可用 / 连接断 / 6 秒内一段都没到）
 *     → 返回 `{ fallback: true }`，由调用方回退到现有的轮询链路（同一个 jobId，不重复提交、不重复计费）。
 *
 * 为什么"部分词条"能直接渲染：EntryCard 里每个板块都是 `(entry.x||[]).length ? … : null`，
 * 字段没到就不画 —— 所以卡片组件几乎不用为流式改逻辑。
 */
const FIRST_SEGMENT_TIMEOUT_MS = 6000;
/* 首段之后的两道保险丝。
 *
 * 实测过的死法：SSE 收到第一段后连接被掐断（服务器重启/任务被淘汰/代理拦长连接），
 * EventSource 对"已有内容"的错误**永远静默重连**——onerror 里 gotAny=true 什么都不做，
 * run() 的 Promise 永不 resolve → App 的 lookupBusyRef 永不放锁，之后每次点「查一下」
 * 都只提示"正在查上一个词"，只能刷新整页（轮询那套 5 分钟总超时对流式完全不生效）。
 * 所以：
 *  · STALL：30 秒没有新段/完成事件 → 回退轮询（同一个 jobId，不重复计费）。
 *    服务端每 15s 发 SSE 注释心跳，注释不触发前端事件——正好：传输活着但生成停了也算"停顿"。
 *  · TOTAL：全程 150s 封顶（服务端流式超时是 6 分钟，等不了那么久）。
 * 回退后调用方用同一个 jobId 走轮询把剩余内容等完，一分钱不多花。 */
const STALL_TIMEOUT_MS = 30000;
const TOTAL_STREAM_MS = 150000;

export function useLookupStream({ aliveRef } = {}) {
  const [partial, setPartial] = useState(null);
  const [labels, setLabels] = useState([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const esRef = useRef(null);

  const close = useCallback(() => {
    if (esRef.current) { try { esRef.current.close(); } catch { /* 已关闭 */ } esRef.current = null; }
  }, []);
  useEffect(() => close, [close]);

  /**
   * 跑一次流式查词。
   * @returns {Promise<{data?:object, aborted?:true, fallback?:true}>}
   *   data     —— 最终词条（服务端收敛后的）
   *   fallback —— 需要调用方改用轮询
   */
  const run = useCallback(async ({ term, level, settings, onJobId }) => {
    setBusy(true); setPartial(null); setLabels([]); setProgress('正在提交…');
    let resp;
    try {
      resp = await lookup({
        term, stream: true, level,
        baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
      });
    } catch (e) {
      setBusy(false);
      return { fallback: true, error: e };
    }
    const jobId = resp && resp.jobId;
    if (!jobId) { setBusy(false); return { fallback: true }; }
    if (onJobId) onJobId(jobId);
    if (typeof EventSource === 'undefined') { setBusy(false); return { fallback: true }; }

    return new Promise((resolve) => {
      let settled = false;
      let gotAny = false;
      let firstTimer = null;
      let stallTimer = null;
      let totalTimer = null;
      const segs = [];
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(firstTimer);
        clearTimeout(stallTimer);
        clearTimeout(totalTimer);
        close();
        setBusy(false);
        if (!result.fallback) setProgress('');
        resolve(result);
      };
      // 6 秒还没看到第一段 → 认为流式不可用，交回轮询（不打断服务端任务）
      firstTimer = setTimeout(() => {
        if (!gotAny) finish({ fallback: true, jobId });
      }, FIRST_SEGMENT_TIMEOUT_MS);
      // 首段之后：30s 无新段 → 传输大概率断了/生成卡死，回退轮询兜住
      const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => finish({ fallback: true, jobId }), STALL_TIMEOUT_MS);
      };
      // 全程封顶：无论卡在哪一步，超时就交给轮询收尾
      totalTimer = setTimeout(() => finish({ fallback: true, jobId }), TOTAL_STREAM_MS);

      let es;
      try {
        es = new EventSource(API_BASE + '/api/lookup/' + jobId + '/stream');
      } catch {
        finish({ fallback: true, jobId });
        return;
      }
      esRef.current = es;

      es.addEventListener('segment', (ev) => {
        if (settled) return;
        if (aliveRef && !aliveRef.current) { finish({ aborted: true }); return; }
        gotAny = true;
        try {
          const payload = JSON.parse(ev.data);
          // 段带 index（服务端 SSE 事件带 id 行，断线重连浏览器自动带 Last-Event-ID 续传）。
          // 按 index 落位：就算服务端从头重放，折叠结果也不会叠出重复内容。
          if (payload && typeof payload.index === 'number') segs[payload.index] = payload.seg;
          else segs.push(payload.seg);
          setPartial({ ...foldSegments(segs.filter(Boolean)), id: 'stream-' + jobId });
          if (payload.label) setLabels((prev) => (prev.includes(payload.label) ? prev : [...prev, payload.label]));
          setProgress('正在生成：' + (payload.label || '…'));
          armStall();
        } catch { /* 单段坏了不影响其它段 */ }
      });
      es.addEventListener('done', (ev) => {
        if (settled) return;
        let data = null; let meta = {};
        try { const payload = JSON.parse(ev.data); data = payload.job && payload.job.data; meta = payload.job || {}; } catch { /* 忽略 */ }
        finish({ data, streamMode: meta.streamMode, streamIncomplete: meta.streamIncomplete, segments: segs.length });
      });
      es.addEventListener('error', (ev) => {
        if (settled) return;
        // 服务端明确报错 → 直接把错误交回去（文案与服务端一致）
        let message = '';
        try { message = JSON.parse(ev.data).error || ''; } catch { /* 网络层错误没有 data */ }
        if (message) finish({ error: new Error(message) });
        else finish({ fallback: true, jobId });   // 连接被掐：回退轮询
      });
      es.onerror = () => {
        if (settled) return;
        // 没拿到任何段：连接根本没建立过（服务端没起/代理拦截），照旧立即回退
        if (!gotAny) { finish({ fallback: true, jobId }); return; }
        // 已有内容断了：EventSource 默认会自动重连，服务端按 Last-Event-ID 从断点续传，
        // 段间停顿保险丝会在重连成功后照常续命 —— 这里**不能**一断就放弃（弱网卡一下就白等）。
        // 但若浏览器已判死（readyState = CLOSED，重连无望），等不来了，手工熔断回退轮询；
        // 还活着就交给 stall/total 两道保险丝兜底 —— 那才是修掉"永久锁死"的关键。
        if (es.readyState === EventSource.CLOSED) finish({ fallback: true, jobId });
      };
    });
    // aliveRef 是稳定引用（App 里的 useRef），不列入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [close]);

  return { run, close, partial, labels, busy, progress, setProgress, labelOf: (t) => SEGMENT_LABEL[t] || '' };
}
