/**
 * 拍照/截图识别单词表 → 词条列表。
 *
 * 用途：学生手写或打印的单词表（一页 20~50 个词 + 中文释义），拍张照片就能入库。
 *
 * ## 为什么这份提示词是**按手写体**写的
 * 印刷体/电子版几乎不会认错，真正难的是**手写**：
 *  · 连笔（cursive）让字母粘在一起：`rn` 看起来就是 `m`、`cl` 像 `d`、`li` 像 `h`；
 *  · 形近字母：a/o、u/v、i/l/1、g/q、s/5、t/f；
 *  · 涂改与插入：划掉的、用箭头补写的、写得越来越潦草的后半页；
 *  · 拍摄条件：横线本、倾斜、阴影、反光、局部虚焦。
 *
 * 所以规矩是：**宁可标"不确定"也不许跳过**（跳过会让整表错位），
 * 并且允许给出"最可能的拼写" —— 用户在前端可以逐条改，标了记号的还会重点提示。
 * （服务端还会拿词典把标了记号的词核一遍：词典里有 → 说明认对了，去掉记号。）
 *
 * ## 另一个刻意的选择：输出纯文本、一行一条
 * 识图是"抄写"任务，纯文本对模型比 JSON 更自然，也没有半截 JSON 的问题；
 * 解析容错（`parseOcrText`）放在我们这边做，比强求模型输出格式更稳。
 */
export const OCR_PROMPT = `你是 OCR 助手，专门识别**手写**单词表（照片可能是横线本、倾斜、有阴影或局部模糊）。

图片里是一页**单词表**：英文单词/短语 + 中文释义，可能分两栏、带序号，也可能是手写连笔。

## 一、阅读顺序（很重要）
1. 图片分**左右两栏** → 先把**左栏从上到下**读完，再读**右栏从上到下**；
2. 只有一栏 → 从上到下；
3. 保留原图**序号**（没有就按顺序自己编号）。

## 二、手写体的处理规矩
1. **一律不跳过**：认不出来就写 \`?\` 占位，编号照排 —— 跳过会让整张表错位，比认错更难修。
2. **拿不准的加问号**：在**英文词后面**加一个 \`?\`（很确定不加；非常不确定加 \`??\`）。
   例：\`12 | vacillate? | 犹豫不决\`
3. **给最可能的拼写**：按英语常见词形判断连笔字。手写里**形近/连笔**的高频混淆是：
   · \`rn\` ↔ \`m\`、\`cl\` ↔ \`d\`、\`li\` ↔ \`h\`、\`ti\` ↔ \`d\`
   · \`a\` ↔ \`o\`、\`u\` ↔ \`v\`、\`i\` ↔ \`l\` ↔ \`1\`、\`g\` ↔ \`q\`、\`s\` ↔ \`5\`
   结合"这是一份英语学习词表、多半是真实存在的词"来判断，给出**最可能正确的拼写**并加 \`?\`。
4. **涂改以最终写法为准**：划掉的不抄；用箭头/插入符号补写的，放在它该在的位置。
5. **中文释义同样处理**：手写中文认不准时写 \`?\`，或写出最接近的词并加 \`?\`。
6. **不要脑补**：图里没写的释义不要编；实在没有释义就留空（只写两段）。

## 三、输出格式（严格遵守）
- **每行一条**：\`序号 | 英文 | 中文释义\`
- 不要表头、不要 markdown 表格、不要代码块围栏、不要任何解释文字；
- 英文只抄单词/短语本身（词性缩写可以保留，如 \`n.\`、\`v.\`）；
- 一行读不出英文就写 \`?\`，不要整行省略。

示例输出（含手写不确定标记）：
1 | aggregation | 聚集
2 | marsh | 沼泽
3 | vacillate? | 犹豫不决
4 | ? | 隐约的
5 | sacrilege | 亵渎`;

/**
 * 置信度记号：`word?` / `word??`。
 * ⚠️ 只有"问号前面还有内容"才算记号 —— 整行就是一个 `?`（认不出来的占位）必须原样保留，
 * 否则那一行会被当成空词头丢掉，整张表跟着错位。
 */
const stripConfidence = (word) => {
  const text = String(word || '').trim();
  const m = text.match(/^(.*?)(\?{1,2})$/);
  if (!m || !m[1].trim()) return { word: text, doubt: 0 };
  return { word: m[1].trim(), doubt: m[2].length };
};

/**
 * 解析模型输出。
 *
 * 容错目标（都是实测里会遇到的形态）：
 *   `1 | word | 释义`（标准）、`1. word 释义`、`word\t释义`、`word  释义`、
 *   `word：释义`、只有英文没有释义、多了表头/围栏/说明行、序号缺失或重复、
 *   以及手写场景的 `word?` / `word??` 不确定标记。
 *
 * @returns {{index:string, word:string, cn:string, doubt:number, raw:string}[]}
 */
export function parseOcrText(text) {
  const lines = String(text || '')
    .replace(/```[a-zA-Z]*/g, '')          // 去掉可能的围栏
    .split(String.fromCharCode(10));
  const out = [];
  const seen = new Set();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // 跳过明显的表头/说明行
    if (/^(序号|单词|英文|中文|释义|word|meaning|no\.?|#)\b/i.test(line) && line.length < 24) continue;
    if (!/[A-Za-z?]/.test(line)) continue;   // 一行里既没英文也不是占位符 → 不是词条

    let index = '';
    let rest = line;
    const idxMatch = rest.match(/^[（(]?\s*(\d{1,3})\s*[)）.、:：|]\s*/);
    if (idxMatch) {
      index = idxMatch[1];
      rest = rest.slice(idxMatch[0].length).trim();
    }
    let word = '';
    let cn = '';
    const parts = rest.split(/\s*[|｜]\s*/).filter((x) => x !== '');
    if (parts.length >= 2) {
      word = parts[0];
      cn = parts.slice(1).join(' | ');
    } else {
      // 没有竖线：用「英文部分 / 中文部分」的边界切（第一个中文字符处）
      const m = rest.match(/^([^\u4e00-\u9fff]+?)\s*[\t:：\-—–]*\s*([\u4e00-\u9fff][\s\S]*)$/);
      if (m) { word = m[1]; cn = m[2]; }
      else { word = rest; cn = ''; }        // 只有英文
    }
    // 去掉行尾可能残留的分隔符（`word |` 这种），再做记号剥离
    const conf = stripConfidence(word.replace(/\s+/g, ' ').replace(/[|｜\s]+$/, '').trim());
    word = conf.word.slice(0, 80);
    cn = String(cn).replace(/\s+/g, ' ').replace(/[；;]+$/, '').trim().slice(0, 200);
    if (!word) continue;
    // 英文部分必须真的像英文（否则多半是误读的中文行）
    if (!/[A-Za-z]/.test(word) && word !== '?') continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;            // 同一页里重复出现的词只留第一条
    seen.add(key);
    out.push({ index: index || String(out.length + 1), word, cn, doubt: conf.doubt, raw: line });
  }
  return out;
}

/** 识别结果的"可信度"概览：一条都没解析出来 / 有多少条带疑问标记 */
export function ocrQuality(items) {
  const list = Array.isArray(items) ? items : [];
  return {
    total: list.length,
    doubt: list.filter((x) => x.doubt > 0).length,
    withoutMeaning: list.filter((x) => !x.cn).length,
  };
}
