/**
 * 本地 CONNECT 隧道：把 github.com 钉到**可达的 IP** 上，绕开 DNS 污染。
 *
 * 背景：这台机器上 `github.com` 被 DNS 解析到 20.205.243.166（不可达），
 * 而 `api.github.com` / `codeload.github.com` 正常，140.82.113.4 也正常 ——
 * 典型的 DNS 污染。改 hosts 需要管理员权限，所以退一步：
 * 本机起一个 HTTP CONNECT 代理，把到 github.com:443 的连接直接建到可达 IP。
 *
 * 为什么不用「改 remote 成 IP + 关证书校验」：那样等于放弃 TLS 校验，
 * 而这个代理只转发字节流 —— 证书仍然是 github.com 的，校验照做。
 *
 * 跑法：
 *   node tools/gh-tunnel.mjs            # 前台跑，默认监听 127.0.0.1:8899
 *   git -c http.proxy=http://127.0.0.1:8899 push origin main
 */
import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.GH_TUNNEL_PORT || 8899);
/** 候选 IP：按实测可用性排序，连不上就换下一个 */
const GITHUB_IPS = (process.env.GH_IPS || '140.82.113.4,140.82.112.4,140.82.114.4,140.82.121.4').split(',');
const PIN_HOSTS = new Set(['github.com', 'www.github.com']);

/** 试着连一个可达 IP；全部失败就把原始主机交回去（至少不比直连更差） */
async function dial(host, port) {
  if (!PIN_HOSTS.has(host)) return net.connect({ host, port });
  for (const ip of GITHUB_IPS) {
    try {
      await new Promise((resolve, reject) => {
        const probe = net.connect({ host: ip, port }, () => { probe.destroy(); resolve(); });
        probe.setTimeout(4000, () => { probe.destroy(); reject(new Error('timeout')); });
        probe.on('error', reject);
      });
      const sock = net.connect({ host: ip, port });
      console.log(`[tunnel] ${host}:${port} → ${ip}`);
      return sock;
    } catch { /* 换下一个 IP */ }
  }
  console.warn(`[tunnel] github.com 的候选 IP 全部不可达，回退直连`);
  return net.connect({ host, port });
}

const server = http.createServer((req, res) => {
  res.writeHead(400, { 'Content-Type': 'text/plain' });
  res.end('这个隧道只支持 CONNECT');
});

server.on('connect', (req, clientSocket, head) => {
  const [host, portRaw] = String(req.url || '').split(':');
  const port = Number(portRaw) || 443;
  dial(host, port).then((upstream) => {
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  }).catch(() => {
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[tunnel] 监听 127.0.0.1:${PORT} —— git -c http.proxy=http://127.0.0.1:${PORT} push origin main`);
});
