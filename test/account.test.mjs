/**
 * 账号 ↔ 同步码的加解密链路测试。
 *
 * 为什么值得单独测：同步码在这条链路上**只有明文形态存在于浏览器内**，
 * 发给服务端的永远是密文（服务端连格式都只做浅校验，它自己解不开）。
 * 少写一步不会报错，只会出两种真故障 —— 而且是在**本地开发时完全看不出来**的
 * （本地没配 Upstash 时账号功能是关的）：
 *   1) 绑定时发明文 → 服务端 400「同步码密文格式不正确」，"存到账号"永远失败；
 *   2) 登录时把服务端返回的**密文**当同步码用 → 换设备同步码变成一串乱码，
 *      什么也拉不到，还会把本机原来那串好码覆盖掉。
 * 这两条都是在真实部署上冒烟才逮住的 —— 移植时只搬了调用、漏了加解密。所以这里逐条钉死。
 *
 * 跑法：node test/account.test.mjs
 */

/* storage.js / account.js 依赖 localStorage；Node 里给个内存实现 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.crypto ||= (await import('node:crypto')).webcrypto;

/**
 * 打桩方式：`src/api.js` 最终走 globalThis.fetch，而 ESM 的导出不能改，
 * 所以这里拦 fetch 并记录请求 —— 顺带能断言"发出去的到底是不是密文"。
 */
const calls = [];
let fetchScript = () => ({ status: 200, body: { ok: true } });
globalThis.fetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push({ url: String(url), method: opts.method || 'GET', body, auth: (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '' });
  const { status = 200, body: res = {} } = fetchScript(String(url), body) || {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', 'application/json']]),
    text: async () => JSON.stringify(res),
    json: async () => res,
  };
};

const account = await import('../src/account.js');
const { sealText, openText, isBox } = await import('../src/secretBox.js');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const lastCall = () => calls[calls.length - 1];
const SYNC = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PW = 'My-Password-2026!';

/* ---------- 加解密本身 ---------- */
{
  const box = await sealText(SYNC, PW);
  check('密文形状符合服务端校验（salt/iv/c 且都是 base64）',
    isBox(box) && Boolean(box.salt && box.iv && box.c) && /^[A-Za-z0-9+/=_-]+$/.test(box.salt + box.iv + box.c));
  check('用同一个密码能解回原文', (await openText(box, PW)) === SYNC);
  check('密码不对解不开，且**不抛错**（返回 null）', (await openText(box, 'wrong-password')) === null);
  check('密文里不含明文同步码', !JSON.stringify(box).includes(SYNC));
  const box2 = await sealText(SYNC, PW);
  check('两次加密结果不同（随机 salt/iv），但都能解开',
    JSON.stringify(box) !== JSON.stringify(box2) && (await openText(box2, PW)) === SYNC);
}

/* ---------- 注册：带同步码时必须加密后再发 ---------- */
{
  calls.length = 0;
  fetchScript = () => ({ status: 200, body: { ok: true, token: 'tk', user: { email: 'a@b.com' } } });
  await account.signUp({ email: 'a@b.com', password: PW, syncCode: SYNC });
  const sent = lastCall().body.sync;
  check('注册时把同步码**加密**后发送，而不是明文', isBox(sent), JSON.stringify(sent).slice(0, 60));
  check('服务端收到的密文能解回原同步码', (await openText(sent, PW)) === SYNC);
  check('请求体里没有明文同步码', !JSON.stringify(lastCall().body).includes(SYNC));
}

/* ---------- 登录：把账号里的密文解开 ---------- */
{
  const box = await sealText(SYNC, PW);
  fetchScript = () => ({ status: 200, body: { ok: true, token: 'tk', user: { email: 'a@b.com' }, sync: box } });
  const r = await account.signIn({ email: 'a@b.com', password: PW });
  check('登录后拿到的是**明文**同步码（不是密文）', r.syncCode === SYNC, r.syncCode.slice(0, 20));
  check('hasSync 标记账号里存过同步码', r.hasSync === true);
  check('登录成功时不报 syncError', !r.syncError);

  // 账号里没存过
  fetchScript = () => ({ status: 200, body: { ok: true, token: 'tk', user: { email: 'a@b.com' } } });
  const r2 = await account.signIn({ email: 'a@b.com', password: PW });
  check('账号里没存过 → hasSync=false（调用方据此立刻把本机码绑上去）',
    r2.hasSync === false && r2.syncCode === '');
}

/* ---------- 登录：密文解不开时不能假装没事 ---------- */
{
  const box = await sealText(SYNC, 'the-old-password');
  fetchScript = () => ({ status: 200, body: { ok: true, token: 'tk', user: { email: 'a@b.com' }, sync: box } });
  const r = await account.signIn({ email: 'a@b.com', password: 'brand-new-password' });
  check('密码与密文不匹配（改过密码）→ 照常登录但明确告知要重设同步码',
    r.ok === true && r.syncCode === '' && /解不开/.test(r.syncError || ''), r.syncError || '(无提示)');
}

/* ---------- 绑定：必须带密码，且发明文 ---------- */
{
  calls.length = 0;
  fetchScript = () => ({ status: 200, body: { ok: true } });
  const r = await account.bindSyncCode('tk', SYNC, PW);
  const sent = lastCall().body.sync;
  check('绑定同步码发的是密文', r.ok && isBox(sent) && (await openText(sent, PW)) === SYNC);
  check('绑定请求带了令牌', /Bearer\s+tk/.test(lastCall().auth), lastCall().auth);

  const noCode = await account.bindSyncCode('tk', '', PW);
  check('没有同步码时不发请求，直接给明确错误', noCode.ok === false && /没有可绑定的同步码/.test(noCode.error || ''));

  calls.length = 0;
  fetchScript = () => ({ status: 400, body: { error: '同步码密文格式不正确' } });
  const bad = await account.bindSyncCode('tk', SYNC, PW);
  check('服务端拒绝时把原因如实带回来', bad.ok === false && /密文格式/.test(bad.error || ''), bad.error);
}

/* ---------- 改密码：必须用新密码重新加密同步码 ---------- */
{
  calls.length = 0;
  fetchScript = () => ({ status: 200, body: { ok: true, token: 'tk2', user: { email: 'a@b.com' } } });
  const NEW = 'Brand-New-Password-2026!';
  await account.changePassword({ token: 'tk', oldPassword: PW, newPassword: NEW, syncCode: SYNC });
  const sent = lastCall().body;
  check('改密码时带上了用**新密码**加密的同步码',
    isBox(sent.sync) && (await openText(sent.sync, NEW)) === SYNC, '');
  check('旧密码解不开新密文（确认真的换了密钥）', (await openText(sent.sync, PW)) === null);
}

/* ---------- 启动时校验令牌：只拿 hasSync，不碰密文 ---------- */
{
  const box = await sealText(SYNC, PW);
  fetchScript = () => ({ status: 200, body: { ok: true, user: { email: 'a@b.com' }, sync: box } });
  const r = await account.fetchMe('tk');
  check('fetchMe 给出 hasSync（启动时没有密码，解不开是正常的）', r.ok && r.hasSync === true);
  check('fetchMe 不把密文当同步码返回（调用方无从误用）', r.syncCode === undefined);
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
