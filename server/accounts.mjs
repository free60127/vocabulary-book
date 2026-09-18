/**
 * 账号体系（KV 版）。
 *
 * 移植自 study platform 的 workers/src/auth.js（已线上验证），改动：
 *   - D1 SQL → KV（键值 + TTL），因此不引入任何 npm 依赖
 *   - 去掉学习平台特有的 R2 证据清理
 *   - **会话失效改用「世代号」**（见下），比 SQL 版逐个删会话更干净
 *
 * 四条不能动的前提：
 *
 * 1) **密码：PBKDF2-SHA256**，存成 `pbkdf2:iter:salt:hash`。
 *    迭代数写进串里 —— 以后调高不会让存量账号集体登录失败（verify 用串里那个 iter）。
 *
 * 2) **会话：库里只存 token 的 SHA-256 哈希**。存储泄露也拿不到可用令牌。
 *
 * 3) **同步码用「密码派生密钥」加密，服务端解不开**。
 *    只能存/取密文，泄露不会连坐任何用户的云端数据；
 *    代价是「重置密码后同步码会丢」—— 所以找回邮件里必须写清。
 *
 * 4) **会话失效用「世代号」而不是"遍历删会话"**。
 *    KV 没有 `DELETE WHERE user_id = ?`，但用户记录上加一个 sessionEpoch，
 *    会话里记下签发时的 epoch；改密码/重置时把 epoch +1，
 *    所有旧会话下一次校验就自动失效 —— 不需要索引，也不需要清理。
 *    注册的原子性同理：先写用户记录，再用 SET NX 抢邮箱；抢不到就回滚删掉用户。
 */
import { pbkdf2, randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { kvPrefix, rateLimit } from './kv.mjs';

/**
 * PBKDF2 迭代数。
 * study platform 那版跑在 Cloudflare Workers（免费版 CPU 只有 10ms），被迫压到 10k。
 * Node 没有这个限制，所以按 OWASP 的口径调高。实测值见 accounts.test.mjs 输出的耗时。
 */
export const PBKDF2_ITERATIONS = Number(process.env.PBKDF2_ITERATIONS || 210000);

const SESSION_TTL_SEC = 30 * 24 * 3600;   // 30 天
const RESET_TTL_SEC = 15 * 60;            // 15 分钟
const FAIL_TTL_SEC = 15 * 60;
const LOGIN_FAIL_MAX = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ---------- 密码 ---------- */
const hashPassword = (password, salt, iterations) => new Promise((resolve, reject) => {
  pbkdf2(String(password), salt, iterations, 32, 'sha256', (e, dk) => (e ? reject(e) : resolve(dk)));
});

async function makeHash(password) {
  const salt = randomBytes(16);
  const dk = await hashPassword(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2:${PBKDF2_ITERATIONS}:${salt.toString('base64')}:${dk.toString('base64')}`;
}

async function verifyHash(password, stored) {
  try {
    const [algo, iter, saltB64, hashB64] = String(stored).split(':');
    if (algo !== 'pbkdf2' || !iter) return false;
    // 必须用串里记录的迭代数，否则调高默认值会让存量账号全部登录失败
    const dk = await hashPassword(password, Buffer.from(saltB64, 'base64'), Number(iter));
    const expect = Buffer.from(hashB64, 'base64');
    return dk.length === expect.length && timingSafeEqual(dk, expect);
  } catch { return false; }
}

/* ---------- 令牌 ---------- */
const newToken = () => randomBytes(32).toString('hex');
const sha256Hex = (s) => createHash('sha256').update(String(s)).digest('hex');

/* ---------- 输入校验 ---------- */
function validate({ email, password, nickname }) {
  const e = String(email || '').trim().toLowerCase();
  const p = String(password || '');
  const n = String(nickname || '').trim().slice(0, 20);
  if (!EMAIL_RE.test(e)) return { error: '邮箱格式不正确' };
  if (p.length < 8) return { error: '密码至少 8 位' };
  if (p.length > 128) return { error: '密码过长（最多 128 位）' };
  return { email: e, password: p, nickname: n };
}
const newPasswordError = (p) => {
  const s = String(p || '');
  if (s.length < 8) return '密码至少 8 位';
  if (s.length > 128) return '密码过长（最多 128 位）';
  return '';
};

/**
 * 同步码密文：{salt, iv, c}，均 base64。
 * 服务端只校验格式，**永远解不开**。
 * @returns {object|null|undefined} undefined = 非法
 */
export function sanitizeSync(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const salt = String(value.salt || '');
  const iv = String(value.iv || '');
  const c = String(value.c || '');
  if (!salt || !iv || !c) return undefined;
  if (salt.length > 64 || iv.length > 64 || c.length > 8192) return undefined;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(salt + iv + c)) return undefined;
  return { salt, iv, c };
}

const publicUser = (u) => ({ id: u.id, email: u.email, nickname: u.nickname || '' });
const readJson = (raw, fb = null) => { try { return raw ? JSON.parse(raw) : fb; } catch { return fb; } };

/**
 * @param {object} o
 * @param {object} o.kv       createKv() 产物
 * @param {Function} o.mail   sendMail()（测试时可注入假实现）
 * @param {object} [o.env]    环境变量（SMTP_TEST_MODE / SERVICE_NAME 等）
 * @param {Array} [o.sent]    测试用：收集发出的邮件
 */
export function createAccounts({ kv, mail, env = process.env, sent, prefix }) {
  // 前缀由调用方注入（默认取 KV_PREFIX）：账号是本项目与姊妹项目**最容易串库**的一块，
  // 详见 kv.mjs 里 kvPrefix 的说明。
  const PREFIX = String(prefix === undefined ? kvPrefix(env) : prefix) + 'acct:';
  const K_EMAIL = (e) => PREFIX + 'email:' + e;
  const K_USER = (id) => PREFIX + 'user:' + id;
  const K_SESS = (h) => PREFIX + 'sess:' + h;
  const K_FAIL = (e) => PREFIX + 'fail:' + e;
  const K_RESET = (e) => PREFIX + 'reset:' + e;
  const K_RATE = (s) => PREFIX + 'rate:' + s;
  /** 发验证码失败的统一兜底文案 */
  const MAIL_FAIL = '邮件发送失败，请稍后重试或联系管理员';
  /**
   * 按失败原因给出**能直接照着修**的提示。
   * 之前一律回"发送失败"，服务端日志又是空的，排查全靠猜 —— 这几种原因的处理方式完全不同，
   * 所以必须分开说。这些文案不涉及任何用户数据，公开展示也无风险。
   */
  const MAIL_REASON = {
    not_configured: '邮件服务未配置：服务端缺少 SMTP_USER / SMTP_PASS 环境变量',
    auth: '邮件服务认证失败：SMTP_PASS 应该是邮箱「授权码」而不是登录密码，且需先在邮箱设置里开启 SMTP 服务',
    // Render 免费实例**明确禁止**出站 SMTP（官方 changelog: "Free web services will no longer
    // allow outbound traffic to SMTP ports"）—— 这不是配置问题，换授权码、换端口都没用。
    // 把这条写进提示里，免得以后再花一晚上排查同一个坑。
    connect: '连不上邮件服务器（465 与 587 都试过）。若部署在 Render 免费实例上，这是平台策略：'
      + '官方明确禁止出站 SMTP，需升级实例，或改用 HTTPS 邮件 API（Resend / Brevo 等）',
    timeout: '连接邮件服务器超时，请稍后重试',
    refused: '邮件服务器拒绝了该收件地址，请确认邮箱地址是否正确',
  };

  async function loadUserById(id) {
    return readJson(await kv.get(K_USER(id)));
  }
  async function loadUserByEmail(email) {
    const id = await kv.get(K_EMAIL(email));
    return id ? loadUserById(id) : null;
  }
  /** 会话 → 用户；世代号对不上视为失效 */
  async function sessionUser(token) {
    if (!token) return null;
    const s = readJson(await kv.get(K_SESS(sha256Hex(token))));
    if (!s || !s.userId) return null;
    const u = await loadUserById(s.userId);
    if (!u) return null;
    if (Number(s.epoch) !== Number(u.sessionEpoch)) return null; // 已被改密/重置踢下线
    return u;
  }

  /**
   * 用户记录的「读-改-写」必须串行化 —— 这是**并发覆盖**的根因。
   *
   * 原来每个写路径都是：`sessionUser()` 拿到一份用户对象 → 在内存里改几个字段 →
   * 整条 `kv.set(K_USER(id), ...)` 写回去。两个请求并发时，后写的那份会把先写的改动
   * **整条盖掉**（因为写的是完整对象，不是字段）。最危险的一组是：
   *   · 设备1 改密码（写新的 passwordHash）
   *   · 设备2（或被窃令牌方）同时 logout-all（读到的还是旧记录，写回时把**旧密码**一起带回去）
   * 结果就是"改密被静默撤销"，用户以为已经踢掉了攻击者，实际密码还是旧的。
   * 云同步那边专门做了 CAS（server/sync.mjs），账号这边当时漏了。
   *
   * 这里用 KV 已有的原子原语 `setNx` 做短锁（与 sync.mjs 在 EVAL 不可用时的兜底同一套做法）：
   * 锁只在"读→改→写"这几毫秒里持有，带 5 秒 TTL 防进程崩溃后死锁。
   * 抢不到锁宁可返回 503，**也绝不拿着旧数据写回去** —— 这正是要消灭的行为。
   */
  const K_LOCK = (id) => PREFIX + 'lock:user:' + id;
  async function withUserLock(id, fn) {
    const lockKey = K_LOCK(id);
    for (let i = 0; i < 40; i += 1) {
      const got = await kv.setNx(lockKey, String(Date.now()), 5);
      if (got) {
        try { return await fn(); } finally { await kv.del(lockKey).catch(() => {}); }
      }
      await new Promise((r) => setTimeout(r, 10 + i * 5));
    }
    return { ok: false, status: 503, error: '操作太频繁，请稍后重试' };
  }

  /**
   * 「带着有效会话进锁」—— 会话校验放在锁**里面**、基于刚读到的用户记录。
   * 不能在锁外先 sessionUser() 再进锁：那份对象在进锁时可能已经过期
   * （比如并发发生了改密，世代号已经 +1），拿它做判断等于把失效的会话放进来。
   */
  async function withSession(token, fn) {
    if (!token) return { ok: false, status: 401, error: 'unauthorized' };
    const s = readJson(await kv.get(K_SESS(sha256Hex(token))));
    if (!s || !s.userId) return { ok: false, status: 401, error: 'unauthorized' };
    return withUserLock(s.userId, async () => {
      const u = await loadUserById(s.userId);
      if (!u) return { ok: false, status: 401, error: 'unauthorized' };
      if (Number(s.epoch) !== Number(u.sessionEpoch)) return { ok: false, status: 401, error: 'unauthorized' };
      return fn(u);
    });
  }
  /** 把改好的用户写回去（锁内调用） */
  async function saveUser(u) {
    u.updatedAt = Date.now();
    await kv.set(K_USER(u.id), JSON.stringify(u));
    return u;
  }
  /** 签发新会话 */
  async function issueSession(user, device = '') {
    const token = newToken();
    await kv.set(K_SESS(sha256Hex(token)), JSON.stringify({ userId: user.id, epoch: user.sessionEpoch, at: Date.now(), device: String(device).slice(0, 40) }), SESSION_TTL_SEC);
    return token;
  }

  return {
    /* ---------- 注册 ---------- */
    async register({ email, password, nickname, sync, ip }) {
      const v = validate({ email, password, nickname });
      if (v.error) return { ok: false, status: 400, error: v.error };

      const syncEnc = sanitizeSync(sync);
      if (syncEnc === undefined) return { ok: false, status: 400, error: '同步码密文格式不正确' };

      const rIp = await rateLimit(kv, K_RATE('reg:ip:' + ip), 600, 30);
      if (rIp.failed) return { ok: false, status: 503, error: '服务繁忙，请稍后再试' };
      if (rIp.over) return { ok: false, status: 429, error: '注册太频繁，请稍后再试' };
      const rEmail = await rateLimit(kv, K_RATE('reg:email:' + v.email), 3600, 5);
      if (rEmail.failed) return { ok: false, status: 503, error: '服务繁忙，请稍后再试' };
      if (rEmail.over) return { ok: false, status: 429, error: '该邮箱注册过于频繁，请稍后再试' };

      const now = Date.now();
      const user = {
        id: randomBytes(16).toString('hex'),
        email: v.email,
        nickname: v.nickname,
        passwordHash: await makeHash(v.password),
        syncEnc,
        sessionEpoch: 1,
        createdAt: now,
        updatedAt: now,
      };

      // 先写用户记录，再用 SET NX 抢邮箱 —— 抢不到说明并发注册，回滚删掉刚写的记录。
      // 顺序不能反：反了会出现"邮箱被占住但用户不存在"的僵尸索引。
      await kv.set(K_USER(user.id), JSON.stringify(user));
      const won = await kv.setNx(K_EMAIL(v.email), user.id);
      if (!won) {
        await kv.del(K_USER(user.id));
        return { ok: false, status: 409, error: '该邮箱已注册，请直接登录' };
      }

      const token = await issueSession(user);
      return { ok: true, status: 201, token, user: publicUser(user), sync: syncEnc };
    },

    /* ---------- 登录 ---------- */
    async login({ email, password, ip, device }) {
      const v = validate({ email, password });
      // 密码不合规也走同一条错误路径，避免泄露"这个邮箱存在但密码太短"
      if (v.error) return { ok: false, status: 400, error: v.error };

      const rIp = await rateLimit(kv, K_RATE('login:ip:' + ip), 600, 30);
      if (rIp.failed) return { ok: false, status: 503, error: '服务繁忙，请稍后再试' };
      if (rIp.over) return { ok: false, status: 429, error: '尝试过于频繁，请稍后再试' };

      const fail = readJson(await kv.get(K_FAIL(v.email)));
      if (fail && Number(fail.lock) > Date.now()) {
        return { ok: false, status: 429, error: '登录尝试过多，请 15 分钟后再试' };
      }

      const user = await loadUserByEmail(v.email);
      const passOk = user ? await verifyHash(v.password, user.passwordHash) : false;
      if (!user || !passOk) {
        // 记失败次数：KV 没有原子自增+自定义结构，但这里并发窗口极小，
        // 且最坏后果只是"少记一次"，不影响安全性（限流本身按 IP 也有一道）。
        const n = Number(fail && fail.n || 0) + 1;
        await kv.set(K_FAIL(v.email), JSON.stringify({
          n,
          lock: n >= LOGIN_FAIL_MAX ? Date.now() + FAIL_TTL_SEC * 1000 : 0,
        }), FAIL_TTL_SEC);
        // 不区分"邮箱不存在"和"密码错"，避免账号枚举
        return { ok: false, status: 401, error: '邮箱或密码不正确' };
      }

      await kv.del(K_FAIL(v.email));
      const token = await issueSession(user, device);
      return { ok: true, status: 200, token, user: publicUser(user), sync: user.syncEnc || null };
    },

    /* ---------- 会话 ---------- */
    async logout(token) {
      if (!token) return { ok: false, status: 401, error: 'unauthorized' };
      await kv.del(K_SESS(sha256Hex(token)));
      return { ok: true, status: 200 };
    },

    /**
     * 退出所有设备（含当前这台）。
     *
     * 用途：怀疑令牌泄露时的一键止血。不必改密码 —— 因为「会话失效」本来就靠世代号实现，
     * 把它 +1 就行，所有已签发的会话下一次校验就全部作废。
     * 客户端拿到成功响应后应当清掉本地令牌（它自己也失效了）。
     *
     * ⚠️ 必须在锁内改（见 withUserLock 的说明）：它与「改密码」写的是同一条用户记录，
     * 并发时后写的那份会把前一份的改动整条盖掉 —— 实测过的后果就是改密被静默撤销。
     */
    async logoutAll(token) {
      return withSession(token, async (u) => {
        u.sessionEpoch = Number(u.sessionEpoch) + 1;
        await saveUser(u);
        return { ok: true, status: 200 };
      });
    },

    async me(token) {
      const u = await sessionUser(token);
      if (!u) return { ok: false, status: 401, error: 'unauthorized' };
      return { ok: true, status: 200, user: publicUser(u), sync: u.syncEnc || null };
    },

    /* ---------- 绑定 / 更新同步码保险箱 ---------- */
    async setSync(token, sync) {
      const s = sanitizeSync(sync);
      if (s === undefined) return { ok: false, status: 400, error: '同步码密文格式不正确' };
      return withSession(token, async (u) => {
        u.syncEnc = s;
        await saveUser(u);
        return { ok: true, status: 200 };
      });
    },

    /* ---------- 改密码 ----------
     * 客户端必须同时提交「用新密码重新加密的同步码」——
     * 服务端没有旧密码，代劳不了。没提交就沿用旧的（会解不开，所以前端必须传）。 */
    async changePassword(token, { oldPassword, newPassword, sync }) {
      const err = newPasswordError(newPassword);
      if (err) return { ok: false, status: 400, error: err };
      if (!oldPassword) return { ok: false, status: 400, error: '请输入当前密码' };
      const s = sanitizeSync(sync);
      if (s === undefined) return { ok: false, status: 400, error: '同步码密文格式不正确' };

      return withSession(token, async (u) => {
        // 校验放在锁内：拿锁外的旧记录去验旧密码，等于允许"改密与改密并发"互相覆盖
        if (!(await verifyHash(String(oldPassword), u.passwordHash))) {
          return { ok: false, status: 401, error: '当前密码不正确' };
        }
        u.passwordHash = await makeHash(String(newPassword));
        if (s) u.syncEnc = s;
        u.sessionEpoch = Number(u.sessionEpoch) + 1; // 世代号 +1 → 所有旧会话失效
        await saveUser(u);

        await kv.del(K_SESS(sha256Hex(token)));     // 当前这条也过期了，换一条新的
        const fresh = await issueSession(u);
        return { ok: true, status: 200, token: fresh, user: publicUser(u), sync: u.syncEnc || null };
      });
    },

    /* ---------- 注销账号 ----------
     * 只删账号侧数据。云端同步快照在同步服务那边，服务端拿不到同步码（它是加密的），删不了 ——
     * 客户端应在注销前自行调 /api/sync 清空，或保留（那是用户自己攒的学习数据）。 */
    async deleteAccount(token, { password }) {
      return withSession(token, async (u) => {
        if (!(await verifyHash(String(password || ''), u.passwordHash))) {
          return { ok: false, status: 401, error: '密码不正确，无法注销' };
        }
        await kv.del(K_USER(u.id));
        await kv.del(K_EMAIL(u.email));
        await kv.del(K_FAIL(u.email));
        // 会话不用遍历删：用户没了，sessionUser() 自然查不到
        return { ok: true, status: 200 };
      });
    },

    /* ---------- 找回密码第 1 步：发验证码 ---------- */
    async forgot({ email, ip }) {
      const e = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(e)) return { ok: false, status: 400, error: '邮箱格式不正确' };

      const rEmail = await rateLimit(kv, K_RATE('forgot:' + e), 60, 1);
      if (rEmail.failed) return { ok: false, status: 503, error: '服务繁忙，请稍后再试' };
      if (rEmail.over) return { ok: false, status: 429, error: '发送太频繁，请 1 分钟后再试' };
      const rIp = await rateLimit(kv, K_RATE('forgot:ip:' + ip), 600, 10);
      if (rIp.failed) return { ok: false, status: 503, error: '服务繁忙，请稍后再试' };
      if (rIp.over) return { ok: false, status: 429, error: '发送太频繁，请稍后再试' };
      const rGlobal = await rateLimit(kv, K_RATE('forgot:global'), 60, 30);
      if (rGlobal.failed) return { ok: false, status: 503, error: '系统繁忙，请稍后再试' };
      if (rGlobal.over) return { ok: false, status: 429, error: '系统繁忙，请稍后再试' };

      const user = await loadUserByEmail(e);
      // 邮箱不存在也回 ok，避免账号枚举
      if (!user) return { ok: true, status: 200 };

      const code = String(randomInt(0, 100000000)).padStart(8, '0'); // CSPRNG，绝不能用 Math.random

      await kv.set(K_RESET(e), JSON.stringify({ h: sha256Hex(code), at: Date.now() }), RESET_TTL_SEC);

      // 默认服务名必须是这个应用自己的：这段代码从姊妹项目搬来，默认值原来写死成
      // 「回译本」—— 没设 SERVICE_NAME 的部署里，用户收到的密码重置邮件会署名另一个产品。
      const service = env.SERVICE_NAME || '单词本';
      const r = await mail({
        to: e,
        subject: `${service} - 密码重置验证码`,
        text: `你的密码重置验证码是：${code}\n\n15 分钟内有效。\n\n`
          + `⚠️ 重要：重置密码后，用旧密码加密的「同步码」将无法自动解锁。\n`
          + `如果你还想找回原来的单词本与复习进度，请先在还登录着的设备上导出备份，\n`
          + `或提前把同步码抄下来。\n`,
        env, sent,
      });
      if (!r || !r.ok) {
        // 用 JSON.stringify 打日志：空字符串也会显示成 {"error":""}，
        // 不会再出现"forgot mail error: " 后面什么都没有、没法排查的情况。
        console.error('forgot mail error:', JSON.stringify(r));
        await kv.del(K_RESET(e)); // 发不出去就把码撤掉，避免"用户没收到但库里占着"
        // 附上底层细节（截断）—— 只关系到服务端自己的发信能力，不涉及任何用户数据；
        // 有它才能一眼看出是"认证失败"还是"连接被拒"，否则又得去翻日志。
        const detail = r && r.error ? ` [${String(r.error).slice(0, 140)}]` : '';
        return { ok: false, status: 503, error: (MAIL_REASON[r && r.code] || MAIL_FAIL) + detail };
      }
      return { ok: true, status: 200 };
    },

    /* ---------- 找回密码第 2 步：校验码 + 设新密码 ---------- */
    async resetPassword({ email, code, newPassword, sync, ip }) {
      const e = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(e)) return { ok: false, status: 400, error: '邮箱格式不正确' };
      const err = newPasswordError(newPassword);
      if (err) return { ok: false, status: 400, error: err };
      const c = String(code || '').trim();
      if (!/^\d{8}$/.test(c)) return { ok: false, status: 400, error: '验证码应为 8 位数字' };

      const rIp = await rateLimit(kv, K_RATE('reset:ip:' + ip), 600, 20);
      if (rIp.failed) return { ok: false, status: 503, error: '服务繁忙，请稍后再试' };
      if (rIp.over) return { ok: false, status: 429, error: '尝试过于频繁，请稍后再试' };
      const rEmail = await rateLimit(kv, K_RATE('reset:' + e), 900, 10);
      if (rEmail.failed) return { ok: false, status: 503, error: '服务繁忙，请稍后再试' };
      if (rEmail.over) return { ok: false, status: 429, error: '尝试次数过多，请重新获取验证码' };

      const rec = readJson(await kv.get(K_RESET(e)));
      if (!rec || !rec.h) return { ok: false, status: 400, error: '验证码无效或已过期，请重新获取' };
      // 恒定时间比较，防逐字符猜测
      const a = Buffer.from(sha256Hex(c));
      const b = Buffer.from(String(rec.h));
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return { ok: false, status: 400, error: '验证码不正确' };
      }

      const found = await loadUserByEmail(e);
      if (!found) return { ok: false, status: 404, error: '账号不存在' };

      const s = sanitizeSync(sync);
      if (s === undefined) return { ok: false, status: 400, error: '同步码密文格式不正确' };

      /**
       * 与「改密码」同一条写路径，同样要在锁内改（否则并发时会互相整条覆盖）。
       * 锁内重新读一次用户：外面的 found 只是用来确认账号存在，不能拿它直接写回去。
       */
      return withUserLock(found.id, async () => {
        // 验证码是一次性的：锁内再确认一次还在，避免两个并发请求都拿同一个码重置
        const still = readJson(await kv.get(K_RESET(e)));
        if (!still || still.h !== rec.h) return { ok: false, status: 400, error: '验证码已使用，请重新获取' };

        const user = await loadUserById(found.id);
        if (!user) return { ok: false, status: 404, error: '账号不存在' };

        user.passwordHash = await makeHash(String(newPassword));
        // 重置时没有旧密码 → 旧同步码解不开，只能清掉（前端可传新密码加密的那份）
        user.syncEnc = s || null;
        user.sessionEpoch = Number(user.sessionEpoch) + 1; // 全部旧会话失效
        await saveUser(user);
        await kv.del(K_RESET(e)); // 一次性：用完立刻删，重放必失败

        return { ok: true, status: 200 };
      });
    },

    /** 清理接口（可选）：删除某邮箱的失败计数，客服兜底用 */
    async clearLoginFail(email) {
      const e = String(email || '').trim().toLowerCase();
      await kv.del(K_FAIL(e));
      return { ok: true, status: 200 };
    },
  };
}
