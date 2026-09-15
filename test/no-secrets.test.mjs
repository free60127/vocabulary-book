/**
 * 凭证泄露扫描：仓库里不允许出现真实的 Key / Token。
 *
 * 为什么需要：这一轮我真的把线上那把 API Key 写进了测试文件的常量里，并推到了公开仓库
 * （后来才发现，只能靠吊销重发处置）。当时所有的质量门禁都是绿的 ——
 * lint 不关心字符串内容，测试也照样通过，**没有任何一道门会拦住它**。
 * 「我会注意」不是一个可靠的防线，所以补这一条。
 *
 * 扫描范围：`git ls-files`（= 能被提交、能被推上去的东西），而不是整个工作目录 ——
 * .env / node_modules / dist 本来就不该被跟踪，扫它们只会产生噪音。
 *
 * 判据（两类，都带占位符豁免）：
 *   A. `sk-` 开头的长串（DeepSeek / OpenAI 这类接口 Key 的形状）
 *   B. 名字里带 KEY / TOKEN / SECRET / PASSWORD 的赋值，右值是 ≥24 字符的字面量
 * 豁免：整串是同一个字符（sk-xxxx…）、或含 test/fake/example/dummy/placeholder/your 等
 * 明显的占位词、或右值是 process.env / 模板变量。
 *
 * 跑法：
 *   node test/no-secrets.test.mjs                     # 扫全部被跟踪的文件
 *   node test/no-secrets.test.mjs path/to/file.mjs    # 只扫指定文件（用于复现/验证扫描器本身）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* ---------- 占位符判定 ---------- */
const PLACEHOLDER_WORDS = /(test|fake|dummy|example|sample|placeholder|your|xxx|todo|changeme|<|\$\{|process\.env)/i;
function isPlaceholder(value) {
  const v = String(value);
  if (PLACEHOLDER_WORDS.test(v)) return true;
  const body = v.replace(/^sk-/, '');
  if (body && new Set(body).size <= 2) return true;   // sk-xxxx… / sk-0000…
  return false;
}
/** 打码后再输出，避免扫描器自己把 Key 又打印进 CI 日志 */
const mask = (s) => String(s).replace(/^(sk-)?(.{4}).*(.{4})$/, (m, p, a, b) => (p || '') + a + '…' + b);

/* ---------- 逐文件扫描 ---------- */
const SK_KEY = /\bsk-[A-Za-z0-9_-]{20,}\b/g;
const ASSIGN_SECRET = /\b([A-Za-z_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z_]*)\s*[:=]\s*['"]([^'"\n]{24,})['"]/g;

// 允许指定文件：`node test/no-secrets.test.mjs <path>` 只扫那一个。
// 用途是**验证扫描器本身**（拿一份真的含 Key 的文件喂给它，必须报出来）——
// 一个"永远通过"的扫描器等于没装。
const explicit = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = (explicit.length
  ? explicit
  : execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').map((f) => f.trim()).filter(Boolean))
  // 扫描器自己会包含判据里的正则与占位词，跳过；图片等二进制也跳过
  .filter((f) => f !== 'test/no-secrets.test.mjs')
  .filter((f) => !/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|pdf|zip|tgz)$/i.test(f));

const hits = [];
for (const file of files) {
  let text;
  try {
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) continue;               // 含 NUL：按二进制处理
    if (buf.length > 2 * 1024 * 1024) continue;  // 超大文件跳过
    text = buf.toString('utf8');
  } catch { continue; }

  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(SK_KEY)) {
      if (!isPlaceholder(m[0])) hits.push({ file, line: i + 1, why: 'sk- 形状的 Key', sample: mask(m[0]) });
    }
    for (const m of line.matchAll(ASSIGN_SECRET)) {
      const [, name, value] = m;
      if (isPlaceholder(value)) continue;
      // 长度够长又不像占位词：按真凭证处理
      if (/^[A-Za-z0-9_\-+/=.]{24,}$/.test(value)) hits.push({ file, line: i + 1, why: `${name} 被赋了长字面量`, sample: mask(value) });
    }
  });
}

console.log('=== 凭证泄露扫描 ===\n');
console.log(`扫描 ${files.length} 个被跟踪的文件\n`);

check('仓库里没有 sk- 形状的真实 Key / 没有把长字面量赋给 KEY/TOKEN/SECRET',
  hits.length === 0,
  hits.length ? hits.slice(0, 8).map((h) => `${h.file}:${h.line} ${h.why} → ${h.sample}`).join('  |  ') : '');

/* ---------- 自检：扫描器真的能抓到东西 ---------- */
{
  // 不然"永远通过"的扫描器等于没有
  const probe = 'const API_KEY = "sk-abcdef0123456789abcdef0123456789";';
  const found = [...probe.matchAll(SK_KEY)].filter((m) => !isPlaceholder(m[0]));
  check('自检：扫描器能认出真实形状的 Key', found.length === 1, found[0] ? mask(found[0][0]) : '(没认出)');
  const placeholders = [
    "AI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "const CLEAN = 'sk-test-fake-key-0123456789abcdef';",
    'const apiKey = process.env.AI_API_KEY;',
  ];
  const falsePositives = placeholders.filter((line) => {
    const a = [...line.matchAll(SK_KEY)].some((m) => !isPlaceholder(m[0]));
    const b = [...line.matchAll(ASSIGN_SECRET)].some((m) => !isPlaceholder(m[2]) && /^[A-Za-z0-9_\-+/=.]{24,}$/.test(m[2]));
    return a || b;
  });
  check('自检：占位符 / 环境变量引用不会被误报', falsePositives.length === 0, falsePositives.join(' | '));
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
