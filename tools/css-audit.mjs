/**
 * 样式表体检：找出 styles.css 里**源码中已经不存在的类**。
 *
 * 为什么需要它：这个项目的样式表是从姊妹项目「回译本」整段搬过来的，
 * 那边有一整套这里用不到的界面（错误分布条、PC 分类对比、拍照取词、方向切换…）。
 * 搬过来时没删，于是每次改样式都要在一堆"看起来有关、其实没人用"的规则里找目标。
 * 手工清理很容易误删（有些类是**动态拼**出来的，比如 `'cat-' + tone`），所以做成脚本。
 *
 * 跑法：
 *   node tools/css-audit.mjs            # 汇总 + 成块的死类
 *   node tools/css-audit.mjs --list     # 逐条列出
 *   node tools/css-audit.mjs --json     # 机器可读（交给别的脚本做删除）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = path.join(ROOT, 'src', 'styles.css');

/** 收集源码里出现过的字符串（含 JSX 模板串与拼接前缀） */
function collectSource() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jsx?|mjs|html)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  files.push(path.join(ROOT, 'index.html'));
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

const css = fs.readFileSync(CSS, 'utf8');
const noComment = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const classes = new Set([...noComment.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const src = collectSource();

// 动态拼接：`'cat-' + tone`、`grade-${tone}` —— 这类前缀下面的类都算"可能被用到"
const dynPrefixes = new Set([
  // `'sentence-grade tone-' + x`、`'cat-' + tone` 这类：整段字面量里**最后一个词**才是动态前缀
  // （早期只认"字面量本身就是前缀"，于是 'tone-' 'kind-' 被漏掉，工具报出一堆假死类）
  ...[...src.matchAll(/['"`]([^'"`]*?)['"`]\s*\+/g)]
    .map((m) => m[1].trim().split(/\s+/).pop())
    .filter((t) => /^[a-zA-Z][\w-]*-$/.test(t)),
  ...[...src.matchAll(/`([^`]*?)([a-zA-Z][\w-]*-)\$\{/g)].map((m) => m[2]),
]);

const isUsed = (c) => {
  if (new RegExp(`[\\s"'\`.\\\\]${c.replace(/[-]/g, '\\-')}[\\s"'\`.,)\\]}]`).test(src)) return true;
  for (const p of dynPrefixes) if (c.startsWith(p)) return true;
  return false;
};

const dead = [...classes].filter((c) => !isUsed(c)).sort();
const argList = process.argv.slice(2);

if (argList.includes('--json')) {
  console.log(JSON.stringify({ total: classes.size, dead }, null, 1));
} else {
  console.log(`样式表体检：${css.split('\n').length} 行 · ${classes.size} 个类 · 源码里找不到的 ${dead.length} 个（${Math.round(dead.length / classes.size * 100)}%）`);
  if (dynPrefixes.size) console.log(`（已排除动态拼接前缀：${[...dynPrefixes].join(' ')}）`);
  const blocks = {};
  for (const c of dead) {
    const key = c.includes('-') ? c.split('-')[0] : '(单个词)';
    (blocks[key] = blocks[key] || []).push(c);
  }
  const top = Object.entries(blocks).sort((a, b) => b[1].length - a[1].length).filter(([, v]) => v.length >= 3);
  if (top.length) {
    console.log('\n成块的（很可能整段是从姊妹项目搬来、这里用不到的）：');
    for (const [k, v] of top) console.log(`  ${k.padEnd(14)} ${String(v.length).padStart(3)} 个   ${v.slice(0, 5).join(' ')}${v.length > 5 ? ' …' : ''}`);
  }
  if (argList.includes('--list')) {
    console.log('\n全部死类：');
    console.log('  ' + dead.join(' '));
  } else if (!argList.includes('--prune')) {
    console.log('\n（--list 逐条列出；--json 机器可读；--prune [--yes] 删除整条都死了的规则）');
  }
}

/* ---------- --prune：删掉"整条选择器里的类全死了"的规则 ----------
   安全边界（都是实测踩过的）：
    · 选择器里**只要有一个类还活着就整条保留** —— 元素可能同时带两个类（`.row.active`）；
    · 动态拼接的类（`'cat-' + tone`）一律当活的处理；
    · 规则前面的注释块跟着一起删（否则留下一堆"错误分布"这种没有下文的标题）；
    · 默认只打印要删什么，加 --yes 才真写。 */
if (argList.includes('--prune')) {
  const lines = css.split('\n');
  // 解析必须在"注释已抹掉"的副本上做：注释行与选择器同一行时（`... */ .book-tabs {`）
  // 选择器文本会被注释污染，注释里提到的类名也会被误当成选择器。
  // 用等长空白替换注释（换行保留），行号与原文严格一致。
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n');
  const owners = [];
  let selStart = -1;
  let buf = '';
  for (let i = 0; i < stripped.length; i += 1) {
    const line = stripped[i];
    if (selStart === -1) {
      const t = line.trim();
      // @media / @supports 这类块头不是规则，跳过
      if (!t || t.startsWith('@')) continue;
      // ⚠️ 单独一行的 `}`（闭合 @media）**不是选择器**。不排掉它就会被当成一条规则的开头，
      // 一路吞到下一个 `{`，把整段（连同大括号）误删 —— 第一版就是这么把 5 个 @media 的
      // 收尾括号删掉的，CSS 从那里开始整体错位（真机上表现为"有的规则在桌面端不生效"）。
      if (t.startsWith('}')) continue;
      selStart = i; buf = line;
    } else {
      buf += ' ' + line;
    }
    if (!buf.includes('{')) continue;
    // 配对到同深度的 '}'
    let d = 0; let end = -1;
    for (let j = i; j < stripped.length; j += 1) {
      for (const ch of stripped[j]) {
        if (ch === '{') d += 1;
        else if (ch === '}') { d -= 1; if (d === 0) { end = j; break; } }
      }
      if (end !== -1) break;
    }
    const selector = buf.slice(0, buf.indexOf('{'));
    owners.push({ start: selStart, end: end === -1 ? i : end, selector });
    selStart = -1; buf = '';
    i = end === -1 ? i : end;
  }
  const classOf = (sel) => [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
  const doomed = owners.filter((o) => {
    if (/^\s*@/.test(o.selector)) return false;
    const cs = classOf(o.selector);
    return cs.length > 0 && cs.every((c) => dead.includes(c));
  });
  // 连坐：紧贴在死规则上方的注释块一起删
  const kill = new Set();
  for (const o of doomed) {
    for (let i = o.start; i <= o.end; i += 1) kill.add(i);
    let k = o.start - 1;
    while (k >= 0 && !lines[k].trim()) k -= 1;
    if (k >= 0 && lines[k].trim().endsWith('*/')) {
      let s = k;
      while (s >= 0 && !lines[s].trim().startsWith('/*')) s -= 1;
      for (let i = s; i <= k; i += 1) kill.add(i);
    }
  }
  const kept = lines.filter((_, i) => !kill.has(i));
  // 自检：删完大括号必须仍然配平。不配平的 CSS 不会报错，只会从失衡处开始整体错位
  // （症状是"某些规则在桌面端突然不生效"）—— 这种错必须挡在写盘之前。
  const balance = (arr) => {
    let d = 0;
    for (const line of arr.join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ')) {
      if (line === '{') d += 1; else if (line === '}') d -= 1;
    }
    return d;
  };
  const before = balance(lines); const after = balance(kept);
  console.log(`\n--prune：可删除 ${doomed.length} 条规则 · ${kill.size} 行（${lines.length} → ${kept.length}）`);
  for (const o of doomed.slice(0, 20)) console.log(`   L${o.start + 1}  ${o.selector.trim().slice(0, 70)}`);
  if (doomed.length > 20) console.log(`   … 还有 ${doomed.length - 20} 条`);
  console.log(`大括号配平自检：删除前 ${before} · 删除后 ${after}${after === before ? ' ✓' : ' ✗ 拒绝写入'}`);
  if (argList.includes('--yes')) {
    if (after !== before) {
      console.error('删除后大括号不配平，已中止（需要修 tools/css-audit.mjs 的解析，而不是硬写）');
      process.exit(1);
    }
    fs.writeFileSync(CSS, kept.join('\n'), 'utf8');
    console.log('\n已写回 src/styles.css（原文件在 git 里，随时可回滚）');
    console.log('⚠️ 删完必须重跑：npm run build && npm run test:e2e && npm run test:sim');
  } else {
    console.log('\n（只预览。确认后加 --yes 真删）');
  }
}
