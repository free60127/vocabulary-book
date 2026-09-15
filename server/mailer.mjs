/**
 * 极简 SMTP 客户端（Node 内置 tls，零依赖）。
 *
 * 用途只有一个：**找回密码发验证码**。别拿它做日常通知 ——
 * QQ 免费邮箱有每日发信量上限，而且 QQ SMTP 发出的信容易被判垃圾邮件。
 *
 * 为什么是 QQ 邮箱：个人免费、零资质、零审核。
 * 手机短信要企业实名（阿里云已公告不支持个人自用资质），微信/QQ 登录要企业开发者认证，
 * 只有"用自己的邮箱当 SMTP"这条路是个人今天就能走通的。
 *
 * 配置（.env）：
 *   SMTP_USER  完整邮箱地址，例如 3338095791@qq.com
 *   SMTP_PASS  QQ 邮箱「授权码」（设置→账户→开启 IMAP/SMTP 服务 处生成，不是 QQ 密码）
 *   SMTP_HOST  缺省 smtp.qq.com
 *   SMTP_PORT  缺省 465；连不上会自动回退到 587（STARTTLS）
 *   SMTP_FROM  缺省同 SMTP_USER
 *
 * 两种加密方式都支持：
 *   - 465：隐式 TLS（连上就是加密的）
 *   - 587 / SMTP_SECURE=0：先明文连接，EHLO 后用 STARTTLS 升级
 * 不少云平台会拦出站 465，所以两条路都要能走。
 *
 * 返回结构统一带 code，便于上层区分原因（而不是只给一句"发送失败"）：
 *   not_configured | auth | connect | timeout | refused | unknown
 */
import tls from 'node:tls';
import net from 'node:net';

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
/** 邮件头里绝不允许出现换行（防头注入）。 */
const headerValue = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ');

const buildMessage = ({ from, to, subject, text, html }) => {
  const useHtml = typeof html === 'string' && html;
  const content = useHtml ? html : String(text || '');
  const body = Buffer.from(content, 'utf8').toString('base64');
  return [
    'From: ' + headerValue(from),
    'To: ' + headerValue(to),
    'Subject: =?UTF-8?B?' + b64(headerValue(subject)) + '?=',
    'MIME-Version: 1.0',
    'Content-Type: ' + (useHtml ? 'text/html' : 'text/plain') + '; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    (body.match(/.{1,76}/g) || []).join('\r\n'),
  ].join('\r\n');
};

/** 把底层异常映射成可判断的 code（上层据此给出不同的用户提示）。 */
function classify(err) {
  const m = String((err && err.message) || err || '');
  if (/AUTH|535|534|530/i.test(m)) return 'auth';
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET/i.test(m)) return 'connect';
  if (/timeout|超时|timed out/i.test(m)) return 'timeout';
  if (/RCPT|MAIL FROM|550|553|554/i.test(m)) return 'refused';
  return 'unknown';
}

/**
 * 走一次完整的 SMTP 会话。
 * @param {'implicit'|'starttls'} mode 465=隐式 TLS；587=先明文再 STARTTLS
 */
function session({ host, port, mode, user, pass, from, to, message, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch (_) { /* 已关闭 */ }
      resolve(r);
    };

    let buffer = '';
    const queue = [];
    let waiter = null;
    let rejectWaiter = null;

    const attach = (sock, onReady) => {
      sock.setTimeout(timeoutMs, () => {
        if (rejectWaiter) { const r = rejectWaiter; rejectWaiter = null; waiter = null; r(new Error('SMTP read timeout')); }
        else done({ ok: false, code: 'timeout', error: `SMTP 超时（${timeoutMs / 1000} 秒）` });
      });
      sock.on('error', (e) => done({ ok: false, code: classify(e), error: String((e && e.message) || e) }));
      sock.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (waiter) { const w = waiter; waiter = null; rejectWaiter = null; w(line); } else { queue.push(line); }
        }
      });
      sock.on('secureConnect', () => { if (onReady) onReady(); });
    };

    const readLine = () => (queue.length
      ? Promise.resolve(queue.shift())
      : new Promise((res, rej) => { waiter = res; rejectWaiter = rej; }));

    const write = (line) => { socket.write(line + '\r\n'); };
    const expect = (line, code, label) => {
      if (Number(String(line).slice(0, 3)) !== code) throw new Error(`SMTP ${label} failed: ${line}`);
    };

    try {
      if (mode === 'implicit') {
        socket = tls.connect({ host, port, servername: host });
        attach(socket);
      } else {
        socket = net.connect({ host, port });
        attach(socket);
      }
    } catch (e) {
      return done({ ok: false, code: classify(e), error: 'connect failed: ' + e.message });
    }

    (async () => {
      try {
        if (mode === 'implicit') {
          // 等 TLS 握手完成（隐式模式连上就是加密的）
          await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('TLS handshake timeout')), timeoutMs);
            socket.once('secureConnect', () => { clearTimeout(t); res(); });
            socket.once('error', (e) => { clearTimeout(t); rej(e); });
          });
        }

        expect(await readLine(), 220, 'greeting');

        write('EHLO hyt-studio');
        let line = await readLine();
        while (line.length >= 4 && line[3] === '-') line = await readLine(); // 多行响应
        expect(line, 250, 'EHLO');

        if (mode === 'starttls') {
          write('STARTTLS');
          expect(await readLine(), 220, 'STARTTLS');
          const plain = socket;
          socket = tls.connect({ socket: plain, servername: host });
          attach(socket);
          await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('STARTTLS handshake timeout')), timeoutMs);
            socket.once('secureConnect', () => { clearTimeout(t); res(); });
            socket.once('error', (e) => { clearTimeout(t); rej(e); });
          });
          // 升级后必须重新 EHLO
          write('EHLO hyt-studio');
          line = await readLine();
          while (line.length >= 4 && line[3] === '-') line = await readLine();
          expect(line, 250, 'EHLO after STARTTLS');
        }

        write('AUTH LOGIN');
        expect(await readLine(), 334, 'AUTH');
        write(b64(user));
        expect(await readLine(), 334, 'AUTH user');
        write(b64(pass));
        expect(await readLine(), 235, 'AUTH login');

        write('MAIL FROM:<' + from + '>');
        expect(await readLine(), 250, 'MAIL FROM');
        write('RCPT TO:<' + to + '>');
        expect(await readLine(), 250, 'RCPT TO');
        write('DATA');
        expect(await readLine(), 354, 'DATA');
        // 正文里以 . 开头的行必须转义成 ..（RFC 5321）
        write(message.replace(/^\./gm, '.$&'));
        write('.');
        expect(await readLine(), 250, 'DATA end');

        write('QUIT');
        done({ ok: true });
      } catch (e) {
        done({ ok: false, code: classify(e), error: String((e && e.message) || e) });
      }
    })();
  });
}

/**
 * 发一封邮件。返回 {ok:true} 或 {ok:false, code, error}。
 *
 * 先按配置的端口发（缺省 465 隐式 TLS）；**如果没显式指定 SMTP_PORT 且连接失败，
 * 自动回退到 587 + STARTTLS 再试一次** —— 云平台拦 465 是常见情况，不该让用户去查文档。
 */
export async function sendMail({ to, subject, text, html, env = process.env, sent }) {
  const from = env.SMTP_FROM || env.SMTP_USER || '';
  const message = buildMessage({ from, to, subject, text, html });

  if (env.SMTP_TEST_MODE === '1') {
    if (Array.isArray(sent)) sent.push({ to, subject, text, html, raw: message });
    return { ok: true, test: true };
  }
  if (!env.SMTP_USER || !env.SMTP_PASS) {
    return { ok: false, code: 'not_configured', error: 'smtp not configured' };
  }

  const host = env.SMTP_HOST || 'smtp.qq.com';
  const explicitPort = env.SMTP_PORT ? Number(env.SMTP_PORT) : 0;
  const secureFlag = env.SMTP_SECURE;
  const timeoutMs = Number(env.SMTP_TIMEOUT_MS || 20000);

  const attempts = (() => {
    if (explicitPort) {
      const mode = secureFlag === '0' || explicitPort === 587 || explicitPort === 25 ? 'starttls' : 'implicit';
      return [{ port: explicitPort, mode, label: `:${explicitPort}/${mode}` }];
    }
    if (secureFlag === '0') return [{ port: 587, mode: 'starttls', label: ':587/starttls' }];
    return [
      { port: 465, mode: 'implicit', label: ':465/implicit' },
      { port: 587, mode: 'starttls', label: ':587/starttls' },
    ];
  })();

  const failures = [];
  for (const a of attempts) {
    const r = await session({ host, port: a.port, mode: a.mode, user: env.SMTP_USER, pass: env.SMTP_PASS, from, to, message, timeoutMs });
    if (r.ok) return r;
    failures.push(`${a.label} → [${r.code}] ${r.error}`);
    // 认证失败/收件人被拒：换端口也没用，不必重试
    if (r.code === 'auth' || r.code === 'refused') return r;
  }
  return { ok: false, code: 'connect', error: failures.join('  |  ') };
}
