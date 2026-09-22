/**
 * 词根拆解 + 助记块的内行（词根词缀 / 助记画面 / 记忆钩子 / 同根词）。
 *
 * 词条卡（EntryCard）与复习卡（ReviewPane）共用：外面一个套 `section.sheet-section.vocab-morph`，
 * 一个套 `div.vocab-morph`（复习答案面没有小节标题，直接一块紫卡）。
 * 字段都可能缺 —— AI 没给或老数据没有，缺哪行就不渲染哪行。
 */
export default function MnemonicBlock({ m }) {
  if (!m) return null;
  return (
    <>
      {m.parts ? <div className="morph-line"><b>词根词缀</b>：{m.parts}</div> : null}
      {m.image ? <div className="morph-line"><b>助记画面</b>：<span className="morph-image">{m.image}</span></div> : null}
      {m.hook ? <div className="morph-line"><b>记忆钩子</b>：{m.hook}</div> : null}
      {m.family ? <div className="morph-line"><b>同根词</b>：{m.family}</div> : null}
    </>
  );
}
