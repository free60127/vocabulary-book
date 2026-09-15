import { useCallback, useEffect, useRef, useState } from 'react';
import { pullCloudSync, pushCloudSync } from '../api.js';
import { mergeSnapshot } from '../storage.js';
import { deviceId, loadSyncCode, loadSyncMeta, newSyncCode, saveSyncCode, saveSyncMeta, syncOnce } from '../sync.js';
import { bindSyncCode, pullSyncCode } from '../account.js';
import { TIP_LONG_MS } from '../constants.js';

/** 后台自动同步的最小间隔：一次拉取就是一条 GET，快照只有几 KB */
const AUTO_SYNC_MIN_GAP_MS = 60_000;

/**
 * 云同步（同步码）。
 *
 * 抽出来的原因：这一块有 8 个状态 + 7 个操作 + 3 个自动同步副作用，
 * 而且它和"本机数据"的耦合只有两处（读快照、写回合并结果）——正好可以从界面里摘干净。
 *
 * @param {object} o
 * @param {() => object} o.getLocal   取"此刻"的本机快照（必须是函数：请求在飞的时候用户还会存词）
 * @param {(merged: object) => void} o.applyMerged 把合并结果写回本机数据层
 * @param {(msg: string, ms?: number) => void} o.flash 轻提示
 */
export function useCloud({ getLocal, applyMerged, flash }) {
  const [syncCode, setSyncCode] = useState(loadSyncCode);
  const [syncMeta, setSyncMeta] = useState(loadSyncMeta);
  const [syncTip, setSyncTip] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(() => Number(loadSyncMeta().lastSyncAt) || 0);

  const busyRef = useRef(false);
  const localRef = useRef(null);
  localRef.current = getLocal;   // 每次渲染都指向最新的取数函数

  const runSync = useCallback(async (manual = true, codeOverride) => {
    const code = codeOverride || syncCode;
    if (!code) { if (manual) setSyncTip('还没有同步码：先生成一个，或在另一台设备上把码填进来'); return { ok: false }; }
    if (busyRef.current) { if (manual) setSyncTip('正在同步中，请稍候'); return { ok: false }; }
    busyRef.current = true; setSyncBusy(true);
    if (manual) setSyncTip('正在同步…');
    try {
      const res = await syncOnce({ code, local: localRef.current() });
      if (!res.ok) { setSyncTip(res.error || '同步失败'); return res; }
      // ⚠️ 用**此刻**的本机数据再合并一次：res.merged 是"发起同步那一刻"的快照，
      // 请求在飞的这段时间里用户可能又存了词条 —— 直接写回会把它们抹掉（回译本上实测过）。
      const settled = mergeSnapshot(localRef.current(), res.merged);
      applyMerged(settled);
      const a = settled.added || {};
      const mine = {
        books: (settled.books || []).length,
        entries: (settled.books || []).reduce((n, b) => n + ((b.entries || []).length), 0),
      };
      const meta = {
        ...loadSyncMeta(), lastSyncAt: Date.now(), version: res.version,
        // 记下双方的数量：这是排查"为什么没同步过来"时唯一有用的两个数字
        localBooks: mine.books, localEntries: mine.entries,
        cloudBeforeBooks: res.cloudBefore ? res.cloudBefore.books : undefined,
        cloudBeforeEntries: res.cloudBefore ? res.cloudBefore.entries : undefined,
        pushedBooks: res.pushed ? res.pushed.books : undefined,
        pushedEntries: res.pushed ? res.pushed.entries : undefined,
      };
      // 推送后**回读校验**：只信 pushCloudSync 的 200 是不够的 ——
      // 数据可能在服务端被清洗掉、或写到了别的地方；回读一次拿真实数量对比。
      let verified = true;
      try {
        const back = await pullCloudSync(code);
        const rb = (back && back.data && back.data.books) || [];
        if (mine.books > 0 && rb.length < mine.books) verified = false;
      } catch { /* 回读失败不影响本次同步结论，只是少一层确认 */ }
      meta.verified = verified;
      saveSyncMeta(meta); setSyncMeta(meta); setLastSyncAt(meta.lastSyncAt);

      const localPart = `本机 ${mine.books} 个本子（${mine.entries} 个词条）`;
      if (!verified) {
        setSyncTip(`⚠️ 同步异常：本机 ${mine.books} 个本子已上传，但云端回读只有更少的内容。`
          + '请点「用本机覆盖云端」把本机数据强制推上去，再在另一台设备点「立即同步」。');
      } else if (manual) {
        if (a.booksAdded || a.entriesAdded) setSyncTip(`同步完成：从云端新增 ${a.booksAdded} 个本子、${a.entriesAdded} 个词条 · ${localPart}`);
        else if (res.cloudBefore && res.cloudBefore.books === 0 && mine.books > 0) {
          setSyncTip(`注意：云端这串码里是空的，本机有 ${mine.books} 个本子。已把本机数据推送上去；`
            + '若另一台设备仍看不到，请在那台设备上点「立即同步」。');
        } else setSyncTip(`同步完成：已是最新 · ${localPart}`);
      } else if (a.booksAdded || a.entriesAdded) flash('已从云端同步到新内容', TIP_LONG_MS);
      return res;
    } catch (e) {
      setSyncTip('同步失败：' + (e.message || '网络错误'));
      return { ok: false, error: e.message };
    } finally {
      busyRef.current = false; setSyncBusy(false);
    }
  }, [syncCode, applyMerged, flash]);

  /** 用本机数据**覆盖**云端（不做合并）—— 合并逻辑一旦有一边不对劲，这是唯一的逃生口 */
  const forcePush = useCallback(async () => {
    if (!syncCode) { setSyncTip('还没有同步码'); return; }
    const snap = localRef.current();
    const mine = {
      books: (snap.books || []).length,
      entries: (snap.books || []).reduce((n, b) => n + ((b.entries || []).length), 0),
    };
    if (!window.confirm(`用本机数据覆盖云端？

本机：${mine.books} 个本子（${mine.entries} 个词条）
`
      + '云端原有内容会被本机这份替换（另一台设备的旧数据不再保留，但两台设备各自的浏览器里仍有本地副本）。')) return;
    if (busyRef.current) return;
    busyRef.current = true; setSyncBusy(true); setSyncTip('正在上传本机数据…');
    try {
      const head = await pullCloudSync(syncCode).catch((e) => (e && e.status === 404
        ? { version: 0, data: {} }
        : Promise.reject(e)));
      const s = localRef.current();
      const r = await pushCloudSync(syncCode, {
        baseVersion: Number(head.version) || 0,
        device: deviceId(),
        data: {
          books: s.books || [], review: s.review || {}, days: s.days || [],
          history: s.history || [], favorites: s.favorites || [],
          deletedBooks: s.deletedBooks || [], deletedEntries: s.deletedEntries || [],
          deletedFavorites: s.deletedFavorites || [],
        },
      });
      if (!r.ok) { setSyncTip('覆盖失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status))); return; }
      const meta = { ...loadSyncMeta(), lastSyncAt: Date.now(), version: r.data.version, localBooks: mine.books, localEntries: mine.entries };
      saveSyncMeta(meta); setSyncMeta(meta); setLastSyncAt(meta.lastSyncAt);
      setSyncTip(`已用本机数据覆盖云端：${mine.books} 个本子、${mine.entries} 个词条。另一台设备点「立即同步」即可拿到。`);
    } catch (e) {
      setSyncTip('覆盖失败：' + (e.message || '网络错误'));
    } finally {
      busyRef.current = false; setSyncBusy(false);
    }
  }, [syncCode]);

  const startNewSync = useCallback(async () => {
    if (busyRef.current) { setSyncTip('正在同步中，请稍候'); return; }
    if (syncCode && !window.confirm('换一串新码？\n\n其它设备需要重新填新码才能继续同步；本机数据不受影响。')) return;
    busyRef.current = true; setSyncBusy(true); setSyncTip('');
    try {
      const r = await newSyncCode();
      if (!r || !r.code) throw new Error('服务器未返回同步码');
      saveSyncCode(r.code); setSyncCode(r.code);
      busyRef.current = false; setSyncBusy(false);
      await runSync(true, r.code);
    } catch (e) {
      setSyncTip('生成同步码失败：' + (e.message || '网络错误'));
      busyRef.current = false; setSyncBusy(false);
    }
  }, [syncCode, runSync]);

  const useExistingCode = useCallback(async (input) => {
    const code = String(input || '').trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(code)) { setSyncTip('同步码应为 32 位十六进制字符，请检查是否复制完整'); return; }
    saveSyncCode(code); setSyncCode(code);
    await runSync(true, code);
  }, [runSync]);

  const copySyncCode = useCallback(async () => {
    try { await navigator.clipboard.writeText(syncCode); setSyncTip('同步码已复制 —— 在另一台设备的这一栏粘贴即可'); }
    catch { setSyncTip('复制失败，请手动选中复制'); }
  }, [syncCode]);

  const stopSync = useCallback(() => {
    if (!window.confirm('停用云同步？\n\n本机数据不受影响。云端那份仍在这串码下，以后填回来还能继续用。')) return;
    saveSyncCode(''); setSyncCode(''); setSyncTip('已停用云同步（本机数据保留）');
  }, []);

  /** 把本机同步码存进账号（服务端只存密文，加密用的账号密码要在本地传进来） */
  const bindCode = useCallback(async (token, password) => {
    if (!syncCode) return;
    if (!password) { setSyncTip('请先填写账号密码（同步码要用它加密后才发出去）'); return; }
    setSyncBusy(true);
    const r = await bindSyncCode(token, syncCode, password);
    setSyncTip(r.ok ? '同步码已加密存进账号 —— 换设备登录后会自动带回来' : ('保存失败：' + (r.error || '')));
    setSyncBusy(false);
  }, [syncCode]);

  /** 从账号取回同步码（已登录但本机还没码） */
  const pullCode = useCallback(async (token, password) => {
    if (!password) { setSyncTip('请填写账号密码（同步码是用它加密的，只有你能解开）'); return; }
    setSyncBusy(true);
    const r = await pullSyncCode(token, password);
    if (r.ok) {
      saveSyncCode(r.syncCode); setSyncCode(r.syncCode);
      setSyncTip('已从账号取回同步码，正在同步…');
      await runSync(true, r.syncCode);
    } else setSyncTip(r.error || '取回失败');
    setSyncBusy(false);
  }, [runSync]);

  /* 打开页面自动同步一次（有码才跑） */
  const bootSyncedRef = useRef(false);
  useEffect(() => {
    if (bootSyncedRef.current || !syncCode) return;
    bootSyncedRef.current = true;
    runSync(false, syncCode);
  }, [syncCode, runSync]);

  /**
   * 回到页面时自动同步 —— 用户的原话是"我想之后电脑新增词汇，手机自动同步，反之亦然"。
   * 只在启动时同步一次是不够的：手机上的页面经常一直开着（加到主屏后更是长期驻留）。
   * 触发：切回前台 + 窗口获得焦点 + 页面可见时每 60 秒一次；距上次不足 60 秒不重复跑。
   */
  useEffect(() => {
    if (!syncCode) return undefined;
    const maybeSync = () => {
      if (document.visibilityState !== 'visible') return;
      const last = Number(loadSyncMeta().lastSyncAt) || 0;
      if (Date.now() - last < AUTO_SYNC_MIN_GAP_MS) return;
      runSync(false, syncCode);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') maybeSync(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', maybeSync);
    const timer = setInterval(maybeSync, AUTO_SYNC_MIN_GAP_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', maybeSync);
      clearInterval(timer);
    };
  }, [syncCode, runSync]);

  return {
    syncCode, setSyncCode, syncMeta, setSyncMeta, syncTip, setSyncTip, syncBusy, setSyncBusy,
    lastSyncAt, runSync, forcePush, startNewSync, useExistingCode, copySyncCode, stopSync,
    bindCode, pullCode,
  };
}
