import { useCallback, useRef, useState } from 'react';
import { ocrImport, getOcrJob } from '../api.js';
import { submitAndPoll } from './pollJob.js';
import { POLL_LOOKUP_MS, TIMEOUT_LOOKUP_MS, POLL_MAX_FAILURES } from '../constants.js';

/**
 * 拍照/上传识别单词表。
 *
 * 三件事：**压缩** → **上传识别** → **落库**。
 *
 * ## 为什么先压缩
 * 手机原图 3~8MB，直传又慢又容易顶到服务端体积上限；而识别只需要"字看得清"。
 * 长边压到 1600、JPEG 0.82，一页单词表大约 200~400KB —— 上传秒级，字仍然清楚。
 * （手写体最怕压缩糊掉，所以下限给到 1600 而不是 1024。）
 *
 * ## 识别结果的处理
 * 结果是一串「序号 / 英文 / 中文」，可能带疑问标记（`word?`）。这里只负责把它变成
 * 可编辑、可勾选的列表；「要不要入库、进哪个本子」交给界面。
 */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

/** 把 File/Blob 压成 dataURL（长边 ≤ MAX_EDGE） */
export function compressImage(file, { maxEdge = MAX_EDGE, quality = JPEG_QUALITY } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('当前浏览器不支持图片压缩，请换一个浏览器试试')); return; }
      // 白底：手机拍的照片常有透明或黑边，铺白底能让纸面更接近原始观感
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve({ dataUrl: canvas.toDataURL('image/jpeg', quality), width: w, height: h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图片读不出来，换一张试试')); };
    img.src = url;
  });
}

export function useImageImport({ settings, aliveRef, books, onImport, flash }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState('pick');   // pick | working | review
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');
  const [items, setItems] = useState([]);       // [{index, word, cn, doubt, checked}]
  const [bookId, setBookId] = useState('');
  const [newBookName, setNewBookName] = useState('');
  const lastFileRef = useRef(null);

  const reset = useCallback(() => {
    setPhase('pick'); setProgress(''); setError(''); setPreview(''); setItems([]); lastFileRef.current = null;
  }, []);

  const close = useCallback(() => { setOpen(false); reset(); }, [reset]);
  const start = useCallback(() => { reset(); setOpen(true); }, [reset]);

  /** 选好图 / 拍好照 → 压缩 → 上传识别 */
  const recognize = useCallback(async (file) => {
    if (!file) return;
    lastFileRef.current = file;
    setError(''); setPhase('working'); setProgress('正在压缩图片…');
    try {
      const { dataUrl, width, height } = await compressImage(file);
      setPreview(dataUrl);
      setProgress('正在识别（手写体建议拍清楚一点，约 10~40 秒）…');
      const out = await submitAndPoll({
        submit: () => ocrImport({
          image: dataUrl,
          visionModel: settings.visionModel || '',
          baseUrl: settings.baseUrl, apiKey: settings.apiKey,
        }),
        fetchJob: getOcrJob,
        intervalMs: POLL_LOOKUP_MS,
        timeoutMs: TIMEOUT_LOOKUP_MS,
        maxFailures: POLL_MAX_FAILURES,
        netError: '网络不稳定，暂时取不到识别结果，请重试',
        timeoutError: '识别超时了。任务可能还在后台跑：稍后重传同一张图会直接命中结果。',
        isAlive: () => aliveRef.current,
        onProgress: (info) => {
          const sec = Math.round((Number(info && info.elapsedMs) || 0) / 1000);
          setProgress(sec >= 8
            ? `正在识别…已等 ${sec} 秒（整页手写约 20~40 秒；可以先放着，回来结果还在）`
            : '正在识别…');
        },
      });
      if (out.aborted) return;
      const list = (out.data && out.data.items) || [];
      if (!list.length) throw new Error('没有认出单词 —— 换个角度、让字更大更清楚，或者分两张拍');
      // 默认**全部勾选**（用户明确要求）；但"没认出来"的占位行（`?`）例外 ——
      // 勾了也导不进去，会让"我选了 6 个怎么只进来 5 个"变成困惑。
      setItems(list.map((x) => ({ ...x, checked: x.word !== '?' })));
      setBookId((prev) => prev || (books[0] && books[0].id) || '');
      setPhase('review');
      setProgress('');
      const q = out.data.quality || {};
      if (q.doubt) flash(`识别出 ${list.length} 个词，其中 ${q.doubt} 个把握不大（已标出，请核对）`, 4200);
      else flash(`识别出 ${list.length} 个词，全部勾选，确认后一键导入`, 3600);
      void width; void height;
    } catch (e) {
      setError((e && e.message) || '识别失败，请重试');
      setPhase('pick');
      setProgress('');
    }
  }, [settings, aliveRef, books, flash]);

  /** 勾选 / 取消 / 编辑 / 删除 —— 都在导入前做，避免把错词写进本子 */
  const toggle = useCallback((i) => {
    setItems((prev) => prev.map((x, idx) => (idx === i ? { ...x, checked: !x.checked } : x)));
  }, []);
  const setAll = useCallback((checked) => setItems((prev) => prev.map((x) => ({ ...x, checked: checked && x.word === '?' ? false : checked }))), []);
  const edit = useCallback((i, patch) => {
    setItems((prev) => prev.map((x, idx) => (idx === i ? { ...x, ...patch, doubt: patch.word ? 0 : x.doubt } : x)));
  }, []);
  const drop = useCallback((i) => setItems((prev) => prev.filter((_, idx) => idx !== i)), []);

  const checkedCount = items.filter((x) => x.checked && x.word && x.word !== '?').length;

  /** 导入：只为勾选的词建"轻量词条"（词头 + 中文释义），不调用模型讲解 —— 想细看时点它即可 */
  const doImport = useCallback(async () => {
    const picked = items.filter((x) => x.checked && x.word && x.word !== '?');
    if (!picked.length) { setError('至少要选一个词'); return null; }
    setPhase('working'); setProgress('正在写入单词本…');
    try {
      const res = await onImport(bookId, picked.map((x) => ({ head: x.word, brief: x.cn })));
      setPhase('pick');
      close();
      return res;
    } catch (e) {
      setError((e && e.message) || '导入失败');
      setPhase('review');
      return null;
    } finally {
      setProgress('');
    }
  }, [items, bookId, onImport, close]);

  const retry = useCallback(() => { if (lastFileRef.current) recognize(lastFileRef.current); }, [recognize]);

  return {
    open, start, close, phase, progress, error, preview, items, bookId, setBookId, newBookName, setNewBookName,
    recognize, toggle, setAll, edit, drop, checkedCount, doImport, retry,
  };
}
