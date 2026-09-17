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
      const segs = [];
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(firstTimer);
        close();
        setBusy(false);
        if (!result.fallback) setProgress('');
        resolve(result);
      };
      // 6 秒还没看到第一段 → 认为流式不可用，交回轮询（不打断服务端任务）
      firstTimer = setTimeout(() => {
        if (!gotAny) finish({ fallback: true, jobId });
      }, FIRST_SEGMENT_TIMEOUT_MS);

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
          segs.push(payload.seg);
          setPartial({ ...foldSegments(segs), id: 'stream-' + jobId });
          if (payload.label) setLabels((prev) => (prev.includes(payload.label) ? prev : [...prev, payload.label]));
          setProgress('正在生成：' + (payload.label || '…'));
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
        // EventSource 自身的错误（断线/被代理拦截）：没拿到任何一段就回退
        if (!settled && !gotAny) finish({ fallback: true, jobId });
      };
    });
    // aliveRef 是稳定引用（App 里的 useRef），不列入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [close]);

  return { run, close, partial, labels, busy, progress, setProgress, labelOf: (t) => SEGMENT_LABEL[t] || '' };
}
