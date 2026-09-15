/**
 * 从 public/icon.svg 生成全部图标尺寸。
 *
 * 跑法：node tools/make-icons.mjs
 *
 * 产出（都写进 public/，构建时会被 Vite 原样拷到 dist/）：
 *   favicon.ico          16 + 32 + 48 三档（真正的 ICO，内嵌 PNG）
 *   icon-16/32/48.png    浏览器标签栏 / 书签
 *   apple-touch-icon.png 180×180，iOS 加到主屏
 *   icon-192/512.png     PWA manifest
 *   icon-maskable-512.png 安卓自适应图标（四周留安全区，否则会被裁掉边角）
 *   icon.svg            矢量源文件本体
 *
 * 依赖 Playwright 做栅格化（复用 tools/shotter 里那份，不进项目依赖）。
 * 没有 Playwright 时**明确报错**，而不是悄悄产出一堆空文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const SRC = path.join(PUBLIC, 'icon.svg');

const CANDIDATES = [
  path.join(ROOT, 'tools', 'shotter', 'node_modules', 'playwright', 'index.mjs'),
  'file:///D:/AI/66666-main/tools/shotter/node_modules/playwright/index.mjs',
  'playwright',
];
async function loadChromium() {
  const errs = [];
  for (const c of CANDIDATES) {
    try {
      const spec = /^[A-Za-z]:[\\/]/.test(c)
        ? 'file:///' + c.replace(/\\/g, '/')
        : c;
      const mod = await import(spec);
      if (mod.chromium) return mod.chromium;
    } catch (e) { errs.push(`${c}: ${String(e.message).slice(0, 90)}`); }
  }
  throw new Error('找不到 Playwright，无法生成图标。\n' + errs.join('\n'));
}

const svg = fs.readFileSync(SRC, 'utf8');
/** 把 svg 根标签的尺寸固定成 size×size（viewBox 保持不变，自动缩放）。 */
function sized(source, size) {
  return source.replace(/<svg\b([^>]*?)>/, (m, attrs) =>
    `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, '')} width="${size}" height="${size}">`);
}
/**
 * 安卓自适应图标：底色铺满整块画布（去掉圆角，由系统裁），主体缩到 62% 居中。
 * 系统会把它裁成圆形/圆角/水滴等任意形状，四周约 33% 属于"可能被裁掉"的区域 ——
 * 主体必须留在中间的安全区里，否则圆角一裁就切到笔画。
 */
function maskable(source, size) {
  const inner = source
    .replace(/<rect width="512" height="512" rx="115" fill="url\(#bg\)"\/>/, '<rect width="512" height="512" fill="#1f6feb"/>')
    // 金色下划线是给"圆角方形"配的装饰，裁成圆形后位置会显得偏，索性只留字母
    .replace(/\n\s*<path d="M152 446[^/]*\/>/, '')
    .replace(
      /<g fill="none" stroke="#ffffff"/,
      '<g transform="translate(256,256) scale(0.62) translate(-256,-256)" fill="none" stroke="#ffffff"',
    );
  return sized(inner, size);
}

/**
 * 小尺寸（16px）专用变体：去掉金色下划线。
 *
 * 为什么：那条线 512 里只有 28 宽，缩到 16px 不足 1 个像素 —— 渲染出来是 A 下面
 * 一道半透明的灰糊，把本来干净的字母弄脏。装饰在小尺寸上不只要"看不见"，
 * 而是压根不该出现（favicon 的常见做法就是小尺寸单独做光学修正）。
 */
function small(source, size) {
  return sized(source.replace(/\n\s*<path d="M152 446[^/]*\/>/, ''), size);
}

/** 把若干 PNG 打包成 ICO（Vista+ 支持内嵌 PNG，不必退回 BMP）。 */
function buildIco(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);              // reserved
  head.writeUInt16LE(1, 2);              // type = icon
  head.writeUInt16LE(pngs.length, 4);    // count
  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);  // 256 用 0 表示
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);                       // 调色板数
    e.writeUInt8(0, 3);                       // reserved
    e.writeUInt16LE(1, 4);                    // color planes
    e.writeUInt16LE(32, 6);                   // bits per pixel
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += buf.length;
  }
  return Buffer.concat([head, ...entries, ...pngs.map((p) => p.buf)]);
}

const chromium = await loadChromium();
const browser = await chromium.launch();
const write = (name, buf) => {
  fs.writeFileSync(path.join(PUBLIC, name), buf);
  console.log(`  ${name.padEnd(24)} ${String(buf.length).padStart(7)} 字节`);
};

async function shoot(html, size, { opaque = true } = {}) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;padding:0;background:transparent">${html}</body></html>`, { waitUntil: 'load' });
  const buf = await page.screenshot({ type: 'png', omitBackground: !opaque });
  await page.close();
  return buf;
}

console.log('生成图标…\n');

const raster = {};
for (const size of [16, 32, 48, 180, 192, 512]) {
  const buf = await shoot(size === 16 ? small(svg, size) : sized(svg, size), size);
  raster[size] = buf;
  if ([16, 32, 48].includes(size)) write(`icon-${size}.png`, buf);
}
write('apple-touch-icon.png', raster[180]);
write('icon-192.png', raster[192]);
write('icon-512.png', raster[512]);
write('icon-maskable-512.png', await shoot(maskable(svg, 512), 512));
write('favicon.ico', buildIco([16, 32, 48].map((size) => ({ size, buf: raster[size] }))));

await browser.close();
console.log('\n完成。改了 icon.svg 之后重跑本脚本即可全部更新。');
