/**
 * 私网过滤（SSRF 防线之一）的回归测试。
 *
 * 钉的是两类真实绕法：
 *  1) IPv6 **未压缩/内嵌点分**写法绕过前缀匹配 —— 实测 '0:0:0:0:0:0:0:1'（::1）原样放行，
 *     访客可拿 `http://[0:0:0:0:0:0:0:1]:端口/` 打到服务器本机。
 *     修法：先归一化展开成 8 组 4 位 hex 再判断（llm.mjs 的 expandIp6）。
 *  2) assertHostPublic 对字面量 IP / 本地域名 / 畸形地址的拦截（DNS 重绑定防护的两道闸之一；
 *     真正的 DNS 解析路径不在单测里跑 —— 那需要网络，这里只钉离线可判定的分支）。
 *
 * 跑法：node server/privateip.test.mjs
 */
import { createLlm } from './llm.mjs';

const llm = createLlm({});
const { isPrivateIp, assertHostPublic } = llm;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('=== IPv6 归一化展开（曾经绕过过滤的写法） ===');

const priv6 = [
  '0:0:0:0:0:0:0:1',                          // ::1 未压缩 —— 本次修的那个洞
  '0000:0000:0000:0000:0000:0000:0000:0001',  // 全展开
  '::1', '::',                                // 经典压缩
  '0:0:0:0:0:ffff:c0a8:101',                  // ::ffff:192.168.1.1 的 8 组未压缩写法
  '::ffff:192.168.1.1',                       // 映射地址点分写法（旧逻辑已覆盖，确认不回退）
  '::ffff:c0a8:101',                          // 映射地址 hex 写法
  'fc00::1', 'fd12:3456::a',                  // fc00::/7 唯一本地
  'fc00:0000:0000:0000:0000:0000:0000:0001',  // ULA 全展开
  'fe80::1', 'febf::1',                       // fe80::/10 链路本地（含上界）
  'ff02::1',                                  // ff00::/8 组播
  'fe80::1%eth0',                             // 带 zone
  '[::1]',                                    // 带 bracket
  '::ffff:127.0.0.1',                         // 映射环回
];
for (const ip of priv6) check(`私网/非法 IPv6 必须拦：${ip}`, isPrivateIp(ip) === true);

// NAT64 / 6to4 / fec0（新补的判定：内嵌 IPv4 是私网即拦）
const natCases = [
  ['64:ff9b::7f00:1', true], ['64:ff9b::c0a8:1', true], ['64:ff9b::808:808', false],
  ['fec0::1', true], ['fec0:1234::1', true],
  ['2002:7f00:1::', true], ['2002:c0a8:101::1', true], ['2002:808:808::1', false],
];
for (const [ip, want] of natCases) check(`NAT64/6to4/fec0 判定：${ip} → ${want}`, isPrivateIp(ip) === want);

const pub6 = [
  '::ffff:8.8.8.8',                           // 映射公网
  '0:0:0:0:0:ffff:808:808',                   // 映射公网全展开（8.8.8.8）
  '2606:4700:4700::1111',                     // 公网单播
  '2001:db8::1',                              // 文档前缀（不是私网，放行交给出网超时）
  '64:ff9b::192.0.2.33',                      // NAT64 公网前缀
];
for (const ip of pub6) check(`公网 IPv6 不得误拦：${ip}`, isPrivateIp(ip) === false);

console.log('=== 字面量与畸形输入（fail-closed） ===');

const priv4 = ['192.168.1.1', '10.0.0.1', '127.0.0.1', '169.254.1.1', '172.16.5.4', '100.64.0.1', '0.1.2.3', '224.0.0.1'];
for (const ip of priv4) check(`私网 IPv4 必须拦：${ip}`, isPrivateIp(ip) === true);
check('公网 IPv4 不得误拦：8.8.8.8', isPrivateIp('8.8.8.8') === false);
for (const bad of ['', 'not-an-ip', '999.1.1.1']) check(`畸形输入宁可拦：${JSON.stringify(bad)}`, isPrivateIp(bad) === true);

console.log('=== assertHostPublic（离线可判定分支） ===');

const blocked = ['http://[0:0:0:0:0:0:0:1]:9000/v1', 'http://localhost:11434', 'http://127.0.0.1:9000/x', 'not a url', 'http://box.local/v1'];
for (const u of blocked) {
  const r = await assertHostPublic(u).then(() => false).catch((e) => Boolean(e && e.blockedByDnsGuard));
  check(`必须拦：${u}`, r === true);
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(62));
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
