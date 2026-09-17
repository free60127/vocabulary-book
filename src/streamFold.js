/**
 * 流式分段 → "部分词条"的折叠（浏览器侧）。
 *
 * 与 server/stream.mjs 的 foldSegments **同构**：字段搬运规则必须一致，
 * 否则会出现"边生成边看到的"和最后存下来的不是一个东西。
 * 两边各留一份是刻意的 —— 服务端那份要跟着 sanitizeEntry 走，
 * 这份只负责让 UI 尽早画出来；`test/stream.test.mjs` 里有交叉断言钉住"两边结果一致"。
 *
 * 只做字段搬运，**不做质量收敛**（收敛统一由服务端的 sanitizeEntry 负责）。
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
        out.__dict = seg.facts || null;
        break;
      default:
        break;      // 认不出的段忽略（后端以后加字段也不会炸老前端）
    }
  }
  return out;
}

/** 段类型 → 中文块名（底部进度行显示"正在写：近义词对比"） */
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
