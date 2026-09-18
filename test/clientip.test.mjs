/**
 * 客户端 IP 解析回归测试（限流与登录失败锁的根基）。
 *
 * 钉三件事：
 *  1. hops=0（本机/局域网直连）时**完全不读** X-Forwarded-For —— 客户端自写的头当真，
 *     限流就形同虚设；
 *  2. hops≥1 时取右起第 hops 跳（代理追加在右端的那部分才可信）；
 *  3. TRUST_PROXY_IPS 名单：对端不是名单内的代理时不采信 XFF（防"直连源站伪造恰好
 *     hops 个条目"换头重置限流/登录锁）。
 *
 * 跑法：node test/clientip.test.mjs
 */
import { resolveClientIp, trustProxyHops, trustedProxyIps } from '../server/client-ip.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const R = (headers, socketIp, hops, proxyAllowlist = [], trustCf = false) =>
  resolveClientIp({ headers, socketIp, hops, proxyAllowlist, trustCf });

console.log('=== hops=0：转发头一概不信 ===');
check('hops=0 不读 XFF', R({ 'x-forwarded-for': '9.9.9.9' }, '1.1.1.1', 0) === '1.1.1.1');
check('hops=0 多个伪造条目也不读', R({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8' }, '1.1.1.1', 0) === '1.1.1.1');

console.log('=== hops≥1：取右起第 hops 跳 ===');
check('hops=1 取最右（代理追加的那段）',
  R({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8' }, '10.0.0.2', 1) === '8.8.8.8');
check('hops=2 取右起第二跳',
  R({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8' }, '10.0.0.2', 2) === '9.9.9.9');
check('条目比 hops 还短：退回 socket（宁可共用桶也不放行）',
  R({ 'x-forwarded-for': '9.9.9.9' }, '10.0.0.2', 2) === '10.0.0.2');

console.log('=== TRUST_PROXY_IPS 名单 ===');
const list = ['10.0.0.2'];
check('对端在名单内：采信 XFF',
  R({ 'x-forwarded-for': '9.9.9.9' }, '10.0.0.2', 1, list) === '9.9.9.9');
check('对端直连（伪造恰好 hops 个条目）：不信 XFF',
  R({ 'x-forwarded-for': '9.9.9.9' }, '5.5.5.5', 1, list) === '5.5.5.5');

console.log('=== CF 头：只在显式开启时可信 ===');
check('未开启时不读 CF-Connecting-IP',
  R({ 'cf-connecting-ip': '9.9.9.9' }, '1.1.1.1', 0, [], false) === '1.1.1.1');
check('开启后读 CF-Connecting-IP',
  R({ 'cf-connecting-ip': '9.9.9.9' }, '1.1.1.1', 0, [], true) === '9.9.9.9');

console.log('=== 配置解析 ===');
check('hops 显式配置优先', trustProxyHops({ TRUST_PROXY_HOPS: '2' }, true) === 2);
check('未配置且非托管 → 0', trustProxyHops({}, false) === 0);
check('未配置且托管 → 1', trustProxyHops({}, true) === 1);
check('名单解析：去空格/去空项', JSON.stringify(trustedProxyIps({ TRUST_PROXY_IPS: ' 10.0.0.2 , 10.0.0.3, ' })) === '["10.0.0.2","10.0.0.3"]');

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(62));
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
