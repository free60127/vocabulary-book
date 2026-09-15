/**
 * 僵尸任务阈值 vs 前端轮询上限的一致性测试。
 *
 * 为什么单独一条：这两个数字分居两个文件（server/job-stale.mjs、src/constants.js），
 * 谁改都不会报错，只会表现成「用户等到超时、服务端还认为在跑」。
 *
 * 跑法：node server/jobstale.test.mjs
 */
import { JOB_STALE_BY_KIND, JOB_STALE_MS, staleMsFor } from './job-stale.mjs';
import { TIMEOUT_FOLLOWUP_MS, TIMEOUT_LOOKUP_MS, TIMEOUT_QUIZ_MS } from '../src/constants.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const min = (ms) => `${ms / 60000} 分钟`;

console.log('=== 僵尸任务阈值一致性测试 ===\n');

/** 每个 kind 对应的前端等待上限 —— 服务端必须先判死 */
const FRONTEND = { lookup: TIMEOUT_LOOKUP_MS, quiz: TIMEOUT_QUIZ_MS, followup: TIMEOUT_FOLLOWUP_MS };

for (const [kind, frontendMs] of Object.entries(FRONTEND)) {
  const serverMs = JOB_STALE_BY_KIND[kind];
  check(`${kind}：服务端判僵尸早于前端超时（${min(serverMs)} < ${min(frontendMs)}）`,
    Number.isFinite(serverMs) && serverMs < frontendMs,
    Number.isFinite(serverMs) ? '' : '阈值缺失');
}

for (const [kind, serverMs] of Object.entries(JOB_STALE_BY_KIND)) {
  check(`${kind}：阈值不至于误杀（≥ 1 分钟）`, serverMs >= 60 * 1000, min(serverMs));
}

check('前端注册的每个 kind 都在阈值表里', Object.keys(FRONTEND).every((k) => k in JOB_STALE_BY_KIND), Object.keys(JOB_STALE_BY_KIND).join(','));
check('未知 kind 回退到兜底阈值', staleMsFor('nope') === JOB_STALE_MS, min(staleMsFor('nope')));
check('兜底阈值同样小于最长的前端上限', JOB_STALE_MS < TIMEOUT_LOOKUP_MS, `${min(JOB_STALE_MS)} < ${min(TIMEOUT_LOOKUP_MS)}`);

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
