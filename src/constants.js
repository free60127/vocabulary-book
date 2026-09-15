/** 前后端共用的展示常量与超时 —— 改一处就够。 */

/** 查词：模型要跑 20-90 秒，1.5 秒问一次足够跟手，也不会把接口打爆 */
export const POLL_LOOKUP_MS = 1500;
/** 出题：稍慢一点 */
export const POLL_QUIZ_MS = 2000;

/** 前端等待上限。**必须大于**服务端判僵尸的阈值（server/job-stale.mjs），
 *  否则用户会先吃到"超时"、而服务端还认为任务在跑。 */
export const TIMEOUT_LOOKUP_MS = 5 * 60 * 1000;
export const TIMEOUT_QUIZ_MS = 5 * 60 * 1000;

/** 弱网容错：连续这么多次取不到任务才判定网络断了 */
export const POLL_MAX_FAILURES = 10;

/** 提示条停留时间 */
export const TIP_SHORT_MS = 2000;
export const TIP_NORMAL_MS = 2600;
export const TIP_LONG_MS = 4000;
export const TIP_VERY_LONG_MS = 6000;

/** 自动同步的防抖与静默期 */
export const SYNC_PUSH_DEBOUNCE_MS = 8000;
export const SYNC_QUIET_MS = 5000;
