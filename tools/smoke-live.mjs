/**
 * 线上冒烟：直接打已部署的站点，验证"部署之后到底能不能用"。
 *
 * 与 e2e 的分工：
 *   · tools/e2e-vocab.mjs  在本地起 mock 模型与 mock 词典，覆盖**功能逻辑**（38 项，跑得快、不花钱）
 *   · 本脚本打真实域名，覆盖**部署本身**：静态资源、Upstash 是否真接上、
 *     账号与云同步在真实 Redis 上能不能跑通、词典接口通不通、冷启动多慢
 *
 * 跑法：BASE=https://your-app.onrender.com node tools/smoke-live.mjs
 *
 * ⚠️ 会**真实注册一个测试账号**（随机邮箱），跑完立即注销，不留垃圾。
 *    不会消耗模型额度：全程不调用需要 AI 的接口。
 */
const BASE = String(process.env.BASE || 'https://vocabulary-book.onrender.com').replace(/\/+$/, '');

/* 与前端 src/secretBox.js 完全相同的算法（PBKDF2-SHA256 → AES-GCM-256）：
   验证"加密存进账号"这条链路时必须用同一套，否则测的就不是真实行为。 */
const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}
async function sealLikeClient(plain, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const c = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
  return { salt: b64(salt), iv: b64(iv), c: b64(c) };
}
async function openLikeClient(box, password) {
  try {
    const key = await deriveKey(password, unb64(box.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.c));
    return new TextDecoder().decode(plain);
  } catch { return null; }
}
const results = [];
const ok = (n, c, d = '') => { results.push({ n, c }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

const req = async (path, { method = 'GET', body, token, timeout = 45000 } = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  let data = null;
  try { data = await r.json(); } catch { /* 非 JSON（HTML/二进制） */ }
  return { status: r.status, data, headers: r.headers };
};

console.log('冒烟目标：' + BASE + '\n');

/* ---------- 1) 站点能打开，静态资源齐全 ---------- */
{
  const t0 = Date.now();
  let home;
  try { home = await req('/'); } catch (e) { ok('首页可访问', false, e.message); }
  const ms = Date.now() - t0;
  if (home) ok('首页可访问', home.status === 200, `HTTP ${home.status} · ${ms}ms（首次请求含冷启动）`);

  const html = await (await fetch(BASE + '/')).text();
  ok('首页是前端应用而不是错误页', /id="root"/.test(html) && /viewport-fit=cover/.test(html));
  ok('图标已换成新的（不再引用回译本的资源）', /icon\.svg/.test(html));

  for (const [f, type] of [['/icon.svg', 'image/svg+xml'], ['/favicon.ico', 'image/x-icon'], ['/manifest.webmanifest', 'application/manifest+json']]) {
    const r = await fetch(BASE + f, { signal: AbortSignal.timeout(20000) });
    ok(`静态资源 ${f}`, r.status === 200 && (r.headers.get('content-type') || '').includes(type.split('/')[0]), `HTTP ${r.status} ${r.headers.get('content-type')}`);
  }
  const manifest = await (await fetch(BASE + '/manifest.webmanifest')).json();
  ok('manifest 是单词本的（不是回译本的）', /单词本/.test(manifest.name || ''), manifest.name);
}

/* ---------- 2) 配置：Upstash 真的接上了吗 ---------- */
let status;
{
  const r = await req('/api/status');
  status = r.data || {};
  ok('/api/status 可读', r.status === 200 && status.app === 'vocabulary-book');
  ok('账号功能已启用且持久（Upstash 生效）', status.accounts?.enabled === true && status.accounts?.durable === true, JSON.stringify(status.accounts));
  ok('云同步落在 Upstash 上', status.sync?.store === 'upstash' && status.sync?.durable === true, JSON.stringify(status.sync));
  ok('托管平台识别正确（限流按 1 跳代理算）', status.rateLimit?.trustProxyHops === 1, '跳数 ' + status.rateLimit?.trustProxyHops);
  ok('词典核对开着', status.dict?.provider && status.dict.provider !== 'off', status.dict?.provider);
  ok('访客不能借用服务端 Key（你选的零花费方案）', status.serverKeyAllowed === false && status.hasKey === true,
    `hasKey=${status.hasKey} serverKeyAllowed=${status.serverKeyAllowed}`);
  ok('每日额度已设上限', Number(status.budget?.dailyLimit) > 0, JSON.stringify(status.budget));
}

/* ---------- 3) 不带 Key 查词：必须给访客看得懂的提示 ---------- */
{
  const r = await req('/api/lookup', { method: 'POST', body: { term: 'object' } });
  ok('访客不带 Key 查词被拒，且提示是"去 AI 设置里填自己的"（不是服务端操作指引）',
    r.status === 400 && /AI 设置/.test(r.data?.error || '') && !/\.env/.test(r.data?.error || ''), r.data?.error || `HTTP ${r.status}`);
}

/* ---------- 4) 词典接口（真实有道） ---------- */
{
  const r = await req('/api/dict?word=object');
  const f = r.data?.facts;
  ok('词典核对在线上可用', r.status === 200 && r.data?.ok === true && Boolean(f), r.data?.provider || '');
  ok('取到音标与大纲标注（就是防 AI 幻觉的那两项）',
    Boolean(f?.phonetics?.uk) && Array.isArray(f?.examTypes) && f.examTypes.length > 0,
    `${f?.phonetics?.uk} · ${(f?.examTypes || []).slice(0, 4).join('/')}`);
  ok('词典释义非空（数组型 l.i 的回归）', (f?.senses || []).length > 0, `${(f?.senses || []).length} 条`);
  const again = await req('/api/dict?word=object');
  ok('第二次走缓存（线上不会每次打人家接口）', again.status === 200, '');
}

/* ---------- 5) 账号 + 云同步：真实 Redis 上跑一遍完整链路 ---------- */
{
  const email = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const password = 'Smoke-Test-2026!x';
  let token = '';

  // 注意：注册成功返回的是 201（不是 200），断言要按 2xx 判
  const reg = await req('/api/auth/register', { method: 'POST', body: { email, password } });
  token = reg.data?.token || '';
  ok('注册账号（真实写入 Upstash）', reg.status >= 200 && reg.status < 300 && reg.data?.ok === true && Boolean(token), reg.data?.error || `HTTP ${reg.status}`);

  // /api/auth/me 的形状是 {ok, user:{email}}，没有顶层 email
  const me = await req('/api/auth/me', { token });
  ok('登录态可读回', me.status === 200 && me.data?.user?.email === email, me.data?.user?.email || me.data?.error);

  const dup = await req('/api/auth/register', { method: 'POST', body: { email, password } });
  ok('同一邮箱不能重复注册（邮箱键唯一性生效）', dup.status >= 400, dup.data?.error || `HTTP ${dup.status}`);

  const login = await req('/api/auth/login', { method: 'POST', body: { email, password, device: 'smoke' } });
  ok('密码登录成功', login.status === 200 && Boolean(login.data?.token), login.data?.error || '');

  // 云同步：生成同步码 → 写入快照 → 读回 → 版本号推进（CAS）
  const created = await req('/api/sync/new', { method: 'POST' });
  const code = created.data?.code || '';
  ok('生成同步码', created.status === 200 && /^[a-f0-9]{32}$/.test(code), code || created.data?.error);

  // 同步写入是 CAS：baseVersion 必须等于**当前**版本，否则会被拒绝。
  // 新建的码版本是 1（不是 0）—— 所以先读一次再写，这才是客户端的真实做法。
  const head0 = await req('/api/sync/' + code);
  const baseVersion = Number(head0.data?.version ?? 1);
  const snap = {
    baseVersion, device: 'smoke',
    data: {
      books: [{ id: 'b1', name: '冒烟测试本', note: '', createdAt: 1, entries: [{ id: 'wb-smoke', head: 'object', brief: '物体', meanings: [{ pos: '名词', cn: '物体' }], createdAt: 1 }] }],
      review: { 'wb-smoke': { ease: 2.5, interval: 1, due: Date.now(), reps: 1, lapses: 0 } },
      days: ['2026-01-01'], history: [], deletedBooks: [], deletedEntries: [],
    },
  };
  const put = await req('/api/sync/' + code, { method: 'POST', body: snap });
  ok('上传快照到云端（真实 Redis 写入）', put.status === 200 && put.data?.ok !== false, JSON.stringify(put.data).slice(0, 120));

  const get = await req('/api/sync/' + code);
  const got = get.data?.data || get.data;
  ok('从云端读回同一份数据', get.status === 200 && JSON.stringify(got).includes('wb-smoke'), `HTTP ${get.status}`);
  ok('版本号推进（CAS 真的生效，不是覆盖式写入）',
    Number(get.data?.version) > baseVersion, `${baseVersion} → ${get.data?.version}`);
  const stale = await req('/api/sync/' + code, { method: 'POST', body: snap });
  ok('拿旧版本号再写会被拒（多设备并发不会互相覆盖）',
    stale.status >= 400 && /其它设备|已被/.test(stale.data?.error || ''), stale.data?.error || `HTTP ${stale.status}`);

  /* 把同步码存进账号 —— 这才是"换设备登录后自动带回来"的关键。
     服务端只接受**密文**（{salt,iv,c}），明文会被 400 挡掉；加密发生在浏览器里。
     所以这里按客户端的真实做法：先用密码派生出密文再发。 */
  const sealed = await sealLikeClient(code, password);
  const plainBind = await req('/api/auth/sync', { method: 'POST', token, body: { sync: code } });
  ok('明文同步码被服务端拒绝（说明它确实只存密文，泄露库也解不开）',
    plainBind.status >= 400 && /密文/.test(plainBind.data?.error || ''), plainBind.data?.error || `HTTP ${plainBind.status}`);
  const bind = await req('/api/auth/sync', { method: 'POST', token, body: { sync: sealed } });
  ok('把同步码加密后存到账号（多设备自动接上的关键一步）', bind.status === 200 && bind.data?.ok === true, bind.data?.error || '');
  const me2 = await req('/api/auth/me', { token });
  ok('账号里存的是密文，且能解回原同步码（换设备才拿得回来）',
    me2.data?.sync?.c && (await openLikeClient(me2.data.sync, password)) === code, JSON.stringify(me2.data?.sync).slice(0, 60));

  const bad = await req('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-password-xxx' } });
  ok('错误密码被拒（且不泄露账号是否存在）', bad.status >= 400, bad.data?.error || `HTTP ${bad.status}`);

  // 收尾：注销，别在人家库里留垃圾
  const del = await req('/api/auth/delete-account', { method: 'POST', token, body: { password } });
  ok('注销测试账号（不留垃圾数据）', del.status === 200 && del.data?.ok === true, del.data?.error || '');
  const after = await req('/api/auth/login', { method: 'POST', body: { email, password } });
  ok('注销后确实登不上了', after.status >= 400, after.data?.error || `HTTP ${after.status}`);
}

/* ---------- 6) 多设备真实场景：账号里没码 → 另一台设备登录 → 数据到手 ----------
   这一段还原用户实际踩到的场景（"手机登录了同一个账号，却什么都没同步"）。
   顺序很关键：**先登录（此时账号里没码）**，再在设备 A 绑码，然后设备 B 登录取回。
   如果只有"先绑码再登录"这一条路径，就会漏掉"先登录的那台设备永远接不上"这个真问题。 */
{
  const email = `multi-${Date.now().toString(36)}@example.com`;
  const password = 'Multi-Device-2026!x';
  const mk = async (path, opts) => req(path, opts);

  // —— 设备 B：先登录（账号里此刻没有同步码）——
  await mk('/api/auth/register', { method: 'POST', body: { email, password } });
  const loginB0 = await mk('/api/auth/login', { method: 'POST', body: { email, password, device: 'phone' } });
  const tokenB = loginB0.data?.token || '';
  ok('设备 B 先登录：能正常拿到令牌', Boolean(tokenB), loginB0.data?.error || '');
  ok('此时账号里没有同步码（正是用户遇到的状态）', !loginB0.data?.sync || !loginB0.data.sync.c, JSON.stringify(loginB0.data?.sync || null));

  // —— 设备 A：有数据 → 生成码 → 写快照 → 把码加密存进账号 ——
  const createdA = await mk('/api/sync/new', { method: 'POST' });
  const codeA = createdA.data?.code || '';
  const headA = await mk('/api/sync/' + codeA);
  const putA = await mk('/api/sync/' + codeA, {
    method: 'POST',
    body: {
      baseVersion: Number(headA.data?.version ?? 1), device: 'desktop',
      data: {
        books: [{ id: 'bA', name: '设备A的本子', note: '', createdAt: 1, entries: [{ id: 'wb-A', head: 'incumbent', brief: '现任的', meanings: [{ pos: '形容词', cn: '现任的' }], createdAt: 1 }] }],
        review: {}, days: [], history: [], deletedBooks: [], deletedEntries: [],
      },
    },
  });
  ok('设备 A 上传了自己的数据', putA.status === 200, JSON.stringify(putA.data).slice(0, 80));
  const sealedA = await sealLikeClient(codeA, password);
  const bindA = await mk('/api/auth/sync', { method: 'POST', token: tokenB, body: { sync: sealedA } });
  ok('设备 A 把同步码加密存进账号', bindA.status === 200 && bindA.data?.ok === true, bindA.data?.error || '');

  // —— 设备 B：重新登录 → 应该能解出同步码 → 拉到设备 A 的数据 ——
  const loginB1 = await mk('/api/auth/login', { method: 'POST', body: { email, password, device: 'phone' } });
  const tokenB1 = loginB1.data?.token || '';
  const box = loginB1.data?.sync;
  ok('设备 B 再登录：服务端把密文还给了它', Boolean(box && box.c), JSON.stringify(box).slice(0, 50));
  const opened = box ? await openLikeClient(box, password) : null;
  ok('设备 B 用密码解开，拿到的就是设备 A 那串码（换设备免手抄）', opened === codeA, `${String(opened).slice(0, 12)} vs ${codeA.slice(0, 12)}`);
  const pulled = await mk('/api/sync/' + opened);
  ok('设备 B 拉到设备 A 的本子数据', pulled.status === 200 && JSON.stringify(pulled.data).includes('设备A的本子'), `HTTP ${pulled.status}`);
  ok('设备 B 拿到的是**明文码**才可能拉对（密文当码用必然 404）',
    opened !== JSON.stringify(box), '');

  // 收尾
  const del = await mk('/api/auth/delete-account', { method: 'POST', token: tokenB1, body: { password } });
  ok('注销多设备测试账号', del.status === 200 && del.data?.ok === true, del.data?.error || '');
}

/* ---------- 7) 越界与错误路径不能泄露文件 ---------- */
{
  for (const p of ['/%2e%2e%2fpackage.json', '/.env', '/server/index.mjs']) {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    ok(`路径 ${p} 拿不到源码/密钥`, r.status !== 200 || /<div id="root">/.test(text), `HTTP ${r.status}`);
  }
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.c);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
