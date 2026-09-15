/**
 * 客户端 IP 解析（限流 + 登录失败锁定共用）。
 *
 * 为什么单独一个模块：这段逻辑**很容易写错，而写错的代价是限流形同虚设**——
 * X-Forwarded-For 是客户端可以自己写的请求头，只有代理**追加在右端**的那部分才可信：
 *
 *     攻击者发：X-Forwarded-For: 1.2.3.4, 5.6.7.8
 *     边缘代理追加后：1.2.3.4, 5.6.7.8, <真实 IP>
 *
 * 曾经取的是 `split(',')[0]`（最左）—— 等于"客户端说自己是哪个 IP 就是哪个"：
 * 每次换一个假 IP 就能无限刷模型接口，每个请求都在真花钱；登录失败锁定同理被绕过。
 *
 * 规则（按可信度从高到低）：
 *   1. CF-Connecting-IP：Cloudflare 边缘覆写，客户端改不动 —— **但只在确定流量必经 CF 时才可信**
 *      （源站能被直连时，攻击者自己带这个头反而绕过限流），所以是显式开关；
 *   2. X-Forwarded-For：从右往左数 `hops` 跳，取那一跳；左端一律不信；
 *   3. socket 地址：伪造不了，作为兜底。
 */

/** 从环境变量推断"可信代理跳数"。显式配置优先；否则托管平台默认 1 跳，本机直连 0 跳。 */
export function trustProxyHops(env = process.env, hosted = false) {
  const raw = String((env && env.TRUST_PROXY_HOPS) ?? '').trim();
  if (raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  if (hosted) return 1;
  return String((env && env.TRUST_PROXY) || '') === '1' ? 1 : 0;
}

export function trustCloudflareHeader(env = process.env) {
  return String((env && env.TRUST_CF_CONNECTING_IP) || '') === '1';
}

/**
 * 解析出用于限流的客户端标识。
 * @param {object} o
 * @param {object} o.headers 请求头（小写键）
 * @param {string} [o.socketIp] socket 对端地址
 * @param {number} [o.hops] 可信代理跳数（0 = 不信任何转发头）
 * @param {boolean} [o.trustCf] 是否信任 CF-Connecting-IP
 * @returns {string}
 */
export function resolveClientIp({ headers = {}, socketIp = '', hops = 0, trustCf = false } = {}) {
  const sock = String(socketIp || '').trim() || 'unknown';
  if (trustCf) {
    const cf = String(headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
  }
  if (hops > 0) {
    const chain = String(headers['x-forwarded-for'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // 右起第 hops 跳：hops=1 → 最后一跳（最外层代理看到的对端）
    const idx = chain.length - hops;
    if (idx >= 0 && idx < chain.length) return chain[idx];
    // 头比配置的跳数还短：多半是伪造（或配置不合），退回 socket —— 宁可共用一个桶，也不放行
  }
  return sock;
}
