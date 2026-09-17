/**
 * 流式输出的**分段协议**与解析。
 *
 * 为什么不用"流式吐 JSON"：卡片是 15 个字段、三层嵌套的结构化数据，
 * 半截 JSON 没法 parse，中途什么都渲染不出来；补全括号的容错解析遇到少一个引号就整张崩。
 *
 * 所以约定：模型按**卡片阅读顺序**，每段一行 JSON（NDJSON）：
 *   {"t":"meta", ...}  {"t":"meanings","items":[...]}  {"t":"scenes",...}  …  {"t":"done"}
 *
 * 三条硬规则（解析器据此容错）：
 *   1. 只处理**完整行**（以换行结束）—— 残行留在缓冲里等下一块数据，天然容忍任意截断；
 *   2. 认不出的行（围栏 ```、说明文字、坏 JSON）**直接跳过**并计数，绝不抛错；
 *   3. 段可以乱序/重复：同一 `t` 后到的覆盖先到的，缺失的段就等于"还没生成到"。
 */
import { sanitizeEntry } from './resultShape.mjs';

/** 段落顺序 = 卡片渲染顺序（前端据此自上而下长出来，不会跳） */
export const SEGMENT_ORDER = [
  'meta', 'meanings', 'scenes', 'mnemonic', 'synonyms', 'collocations', 'examples', 'notes',
];

/** 每段对应卡片里的哪一块（给前端显示"正在写：近义词对比"） */
export const SEGMENT_LABEL = {
  meta: '音标与词性',
  dict: '词典核对',
  meanings: '释义',
  scenes: '适用场景',
  mnemonic: '词根词缀与助记',
  synonyms: '近义词对比',
  collocations: '常见搭配',
  examples: '例句',
  notes: '易混点与考试要点',
};

/**
 * 逐块喂数据，吐出**新完成的段**。
 *
 * 用法：`const feed = createSegmentReader(); ... feed(chunk) → Segment[]`
 * 返回的段已经过基本校验（有 t、是对象），坏行计入 `reader.stats.bad`。
 */
export function createSegmentReader() {
  let buffer = '';
  const stats = { lines: 0, bad: 0, seen: {} };

  const parseLine = (line) => {
    const s = line.trim();
    if (!s) return null;
    // 模型偶尔会加围栏或"好的，下面开始："这类说明 —— 一律跳过
    if (s.startsWith('```') || s.startsWith('//') || s.startsWith('#')) { stats.bad += 1; return null; }
    if (!s.startsWith('{')) { stats.bad += 1; return null; }
    try {
      const obj = JSON.parse(s);
      if (!obj || typeof obj !== 'object' || !obj.t) { stats.bad += 1; return null; }
      stats.lines += 1;
      stats.seen[obj.t] = (stats.seen[obj.t] || 0) + 1;
      return obj;
    } catch {
      stats.bad += 1;
      return null;
    }
  };

  return {
    stats,
    /** @returns {Array<object>} 本次新完成的段 */
    feed(chunk) {
      buffer += String(chunk || '');
      const out = [];
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const seg = parseLine(line);
        if (seg) out.push(seg);
        idx = buffer.indexOf('\n');
      }
      // 有些模型最后一段不换行 —— 收尾时把残行也试着解析掉
      return out;
    },
    /** 收尾：把缓冲里的残行也算上（可能是不完整的 JSON，解析失败就丢） */
    flush() {
      const rest = buffer;
      buffer = '';
      const seg = parseLine(rest);
      return seg ? [seg] : [];
    },
    get leftover() { return buffer; },
  };
}

/**
 * 把收到的段拼成一个词条对象（供前端**增量渲染**用）。
 *
 * 关键：这里只做"字段搬运"，**不做质量收敛** —— 收敛统一交给 sanitizeEntry，
 * 免得"流式渲染出来的"和"最后存下来的"不是一个东西。
 */
export function foldSegments(segments) {
  const out = {};
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg || !seg.t) continue;
    switch (seg.t) {
      case 'meta':
        for (const k of ['head', 'kind', 'phonetic', 'pos', 'brief', 'register', 'tone', 'strength']) {
          if (seg[k] !== undefined && seg[k] !== '') out[k] = seg[k];
        }
        break;
      case 'scenes':
        if (Array.isArray(seg.items)) out.scenes = seg.items;
        // ⚠️ avoid（"什么场合别用它"）跟着 scenes 段来，不在这里取就会整块丢失（单测抓到过）
        if (seg.avoid) out.avoid = seg.avoid;
        break;
      case 'meanings':
      case 'synonyms':
      case 'collocations':
      case 'examples':
        if (Array.isArray(seg.items)) out[seg.t] = seg.items;
        break;
      case 'mnemonic':
        out.mnemonic = {
          image: seg.image || '', hook: seg.hook || '', parts: seg.parts || '', family: seg.family || '',
        };
        break;
      case 'notes':
        for (const k of ['confusions', 'usageNotes', 'examTips']) {
          if (seg[k]) out[k] = seg[k];
        }
        break;
      case 'dict':
        // 词典事实：前端只用来先显示"已用有道核对"那一行
        out.__dict = seg.facts || null;
        break;
      default:
        break;      // 认不出的段直接忽略（以后加字段也不会炸老前端）
    }
  }
  return out;
}

/**
 * 收尾：把"累积的原文"收敛成最终词条。
 *
 * 两条路：
 *   ① 分段解析成功（正常情况）→ 用 foldSegments 的结果过 sanitizeEntry；
 *   ② 模型完全不按分段来（少见但会发生）→ 把原文当一整个 JSON 解析（parseLoose），
 *      再走同一条 sanitizeEntry —— **保证无论哪种情况都能出卡片**，不会白等一场。
 *
 * @returns {{entry: object|null, mode: 'segments'|'fallback'|'failed'}}
 */
export function finalizeStreamEntry({ segments, rawText = '', parseLoose, base = {} }) {
  const folded = foldSegments(segments);
  const hasCore = Boolean(folded.head) && (Array.isArray(folded.meanings) ? folded.meanings.length > 0 : Boolean(folded.brief));
  if (hasCore) {
    const entry = sanitizeEntry({ ...base, ...folded, head: folded.head || base.head });
    if (entry) return { entry, mode: 'segments' };
  }
  // 兜底：整段原文当作一个 JSON 来解析
  try {
    const whole = parseLoose ? parseLoose(rawText) : JSON.parse(rawText);
    if (whole) {
      const entry = sanitizeEntry({ ...base, ...whole, head: whole.head || base.head });
      if (entry) return { entry, mode: 'fallback' };
    }
  } catch { /* 落到 failed */ }
  return { entry: null, mode: 'failed' };
}
