/**
 * 云同步（同步码）：把本机的单词本 / 复习排期 / 学习天数与云端那份合并。
 *
 * 与回译本同一套机制：拉取 → 合并 → 推送，推送带 baseVersion 做**乐观锁**，
 * 版本对不上（409）就拿云端最新数据重新合并再推，最多 3 轮。
 *
 * 合并是**并集**，所以删除必须留墓碑（见 storage.js 的注释）——
 * 否则删掉的词条会在下一次同步时从云端旧副本里复活。
 */
import { createSyncCode, pullCloudSync, pushCloudSync } from './api.js';
import { mergeSnapshot, safeSet } from './storage.js';

const CODE_KEY = 'vb-sync-code';
const META_KEY = 'vb-sync-meta';

export function loadSyncCode() {
  try { return localStorage.getItem(CODE_KEY) || ''; } catch { return ''; }
}
export function saveSyncCode(code) {
  try {
    if (code) localStorage.setItem(CODE_KEY, code);
    else localStorage.removeItem(CODE_KEY);
  } catch { /* 无痕模式下忽略 */ }
}
export function loadSyncMeta() {
  try {
    const v = JSON.parse(localStorage.getItem(META_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
export function saveSyncMeta(meta) { safeSet(META_KEY, JSON.stringify(meta || {})); }

/** 设备标识：只用来在同步记录里区分"最后是哪台设备写的" */
export function deviceId() {
  const meta = loadSyncMeta();
  if (meta.device) return meta.device;
  const id = Math.random().toString(36).slice(2, 10);
  saveSyncMeta({ ...meta, device: id });
  return id;
}

export const newSyncCode = createSyncCode;

/**
 * 与云端做一次双向同步。
 * @returns {Promise<{ok:boolean, error?:string, version?:number, merged?:object, added?:object, recovered?:boolean}>}
 */
export async function syncOnce({ code, local, device, maxAttempts = 3 }) {
  if (!code) return { ok: false, error: '还没有同步码' };
  let remote;
  let recovered = false;
  try {
    remote = await pullCloudSync(code);
  } catch (e) {
    // 404 = 云端没有这串码。以前这里直接失败会把用户卡死：换过存储后端之后，
    // 老用户的码在云端"不存在"了，但本机数据完好、每台设备用的是同一串码 ——
    // 结果两台设备都推不上去也拉不下来。现在当成"空云端"继续走，第一台推送的设备把它建起来。
    if (e && e.status === 404) {
      remote = { version: 0, updatedAt: 0, data: { books: [], history: [], deletedBooks: [], deletedEntries: [], days: [], review: {} } };
      recovered = true;
    } else {
      return { ok: false, error: e.message || '读取云端失败' };
    }
  }

  let baseVersion = Number(remote.version) || 0;
  let payload = mergeSnapshot(local, remote.data);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const r = await pushCloudSync(code, {
      baseVersion,
      device: device || deviceId(),
      data: {
        books: payload.books,
        review: payload.review || {},
        days: payload.days || [],
        history: payload.history || [],
        // 墓碑也要推上去：其它设备才知道"这些已经删了"，否则它们本机的旧副本会把它并回来
        deletedBooks: payload.deletedBooks || [],
        deletedEntries: payload.deletedEntries || [],
      },
    });
    if (r.ok) return { ok: true, version: r.data.version, merged: payload, added: payload.added, recovered };
    if (r.status === 409 && r.data) {
      // 其它设备抢先写了：拿云端最新数据重新合并后再推
      baseVersion = Number(r.data.version) || 0;
      recovered = false;
      payload = mergeSnapshot(
        { books: payload.books, review: payload.review, days: payload.days, history: payload.history, deletedBooks: payload.deletedBooks, deletedEntries: payload.deletedEntries },
        r.data.data,
      );
      continue;
    }
    return { ok: false, error: (r.data && r.data.error) || ('同步失败：HTTP ' + r.status) };
  }
  return { ok: false, error: '云端数据变动频繁，请稍后再试' };
}
