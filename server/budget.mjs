/**
 * 每日额度闸门 —— 公网开放 + 用服务端自己的 Key 时，**唯一真正兜住账单的东西**。
 *
 * 为什么单靠限流不够：限流是"每个 IP 每分钟"，换个 IP、换台设备就能接着刷；
 * 一个被转发到群里的网址，一天能烧掉多少钱是没有上限的。这里按**自然日**记一个总量，
 * 到顶就拒绝，第二天自动恢复（计数键自带 TTL，不会堆积成垃圾）。
 *
 * 两条刻意的语义：
 *  · **只算用服务端 Key 的请求**。访客自带 Key 花的是他自己的钱，没理由被我们的预算卡住
 *    （否则"填自己的 Key 就能继续用"这句话就不成立了，而那正是超限时给用户的出路）。
 *  · **先加后判、超了减回去**。先判后加在并发下会超额；只加不减会让被拒绝的请求
 *    也把计数越推越高，/api/status 上的"今天用了多少次"就成了假数（第一版实测 3 次上限显示成 5）。
 *  · 计数失败时**放行**（fail-open）：它是个保护措施，不该因为计数器读不出来就让所有人查不了词。
 */

export const budgetKey = (day, prefix = 'vb:') => prefix + 'spent:' + day;
export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export function createBudget({ kv, limit = 0, ttlSec = 48 * 3600, now = Date.now, log = console, prefix = 'vb:' }) {
  const enabled = Number(limit) > 0;
  const key = () => budgetKey(today(now()), prefix);

  /** 记一次消费。返回 { ok, used, limit }；ok=false 表示已超额度，调用方应拒绝。 */
  async function spend(n = 1) {
    if (!enabled) return { ok: true, used: 0, limit: 0 };
    try {
      const k = key();
      await kv.setNx(k, '0', ttlSec);
      const used = await kv.incrBy(k, n);
      if (used > limit) {
        try { await kv.incrBy(k, -n); } catch { /* 减不回去顶多显示偏高，不影响拦截 */ }
        return { ok: false, used: used - n, limit };
      }
      return { ok: true, used, limit };
    } catch (e) {
      log.error('[budget] 计数失败，本次放行：', e && e.message);
      return { ok: true, used: 0, limit, failed: true };
    }
  }

  /** 今天已经用掉多少（给 /api/status 显示） */
  async function used() {
    if (!enabled) return 0;
    try { return Number(await kv.get(key())) || 0; } catch { return 0; }
  }

  return { enabled, limit, spend, used, key };
}

/**
 * 超预算时的统一回应：说清楚**为什么**、**什么时候恢复**、**现在怎么办**，
 * 而不是一句"请求过于频繁"——用户看到那句话只会反复重试。
 */
export function budgetMessage(used, limit) {
  return `今天的额度用完了（${used}/${limit} 次）。这是管理员设的每日上限，防止站点被刷爆；`
    + '明天零点自动恢复。急着用的话，在「AI 设置」里填自己的 API Key 即可立刻继续（用自己的 Key 不占这里的额度）。';
}
