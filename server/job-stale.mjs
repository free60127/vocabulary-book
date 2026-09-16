/**
 * 「僵尸任务」判定阈值。
 *
 * 单独成文件的理由：`index.mjs` 一被 import 就会 listen，测试没法直接引用里面的常量，
 * 而这条不变式恰恰必须被测住：
 *
 *     服务端判僵尸的阈值  <  前端各自的轮询上限（src/constants.js）
 *
 * 反了会怎样：用户先吃到「等待超时」，服务端却仍认为任务在跑，两边说法不一致；
 * 而且客户端已经放弃之后，任务还在继续调模型、继续花钱，没人会来看它的结果。
 * 回归测试见 server/jobstale.test.mjs。
 */

/** 各 kind 的僵尸判定阈值（毫秒），key 与 saveJob 时写入的 kind 一致 */
export const JOB_STALE_BY_KIND = Object.freeze({
  lookup: 4 * 60 * 1000,   // 前端 TIMEOUT_LOOKUP_MS = 5 分钟
  quiz: 4 * 60 * 1000,     // 前端 TIMEOUT_QUIZ_MS   = 5 分钟
  followup: 90 * 1000,     // 前端 TIMEOUT_FOLLOWUP_MS = 2 分钟
  sentence: 2 * 60 * 1000, // 前端 TIMEOUT_SENTENCE_MS = 3 分钟（出题/批改各一次调用）
});

/** 未知 kind 的兜底阈值 */
export const JOB_STALE_MS = 4 * 60 * 1000;

export function staleMsFor(kind) {
  return JOB_STALE_BY_KIND[kind] || JOB_STALE_MS;
}
