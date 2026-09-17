/**
 * 拍照识别的解析层：把模型输出的自由文本变成词条列表。
 *
 * 重点覆盖**手写场景**：疑问标记（`word?` / `word??`）、认不出来的占位行（`?`）、
 * 各种分隔符与序号形态、表头/围栏/说明文字。
 *
 * 跑法：node test/ocr.test.mjs
 */
import { parseOcrText, ocrQuality, OCR_PROMPT } from '../server/ocr.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* ---------- 标准形态 ---------- */
{
  const items = parseOcrText(`1 | aggregation | 聚集
2 | marsh | 沼泽`);
  check('标准「序号 | 英文 | 中文」能解析',
    items.length === 2 && items[0].word === 'aggregation' && items[1].cn === '沼泽', JSON.stringify(items));
  check('没有疑问标记时 doubt=0', items.every((x) => x.doubt === 0));
}

/* ---------- 手写场景：疑问标记 ---------- */
{
  const items = parseOcrText(`3 | vacillate? | 犹豫不决
5 | sacrilege?? | 亵渎`);
  check('一个问号 → doubt=1，词头不含问号',
    items[0].word === 'vacillate' && items[0].doubt === 1, JSON.stringify(items[0]));
  check('两个问号 → doubt=2',
    items[1].word === 'sacrilege' && items[1].doubt === 2, JSON.stringify(items[1]));
}

/* ---------- 手写场景：认不出来的占位行必须保留（跳过会让整表错位） ---------- */
{
  const items = parseOcrText('4 | ? | 隐约的');
  check('占位行 `?` 原样保留（不被当成疑问标记吃掉）',
    items.length === 1 && items[0].word === '?' && items[0].cn === '隐约的', JSON.stringify(items));
}

/* ---------- 各种分隔符与序号形态 ---------- */
{
  const cases = [
    ['1. vacillate 犹豫不决', 'vacillate', '犹豫不决'],
    ['(2) marsh：沼泽', 'marsh', '沼泽'],
    ['3、woof\t纬线', 'woof', '纬线'],
    ['graved   刻', 'graved', '刻'],
    ['stray', 'stray', ''],
  ];
  const bad = [];
  for (const [line, word, cn] of cases) {
    const items = parseOcrText(line);
    if (!items.length || items[0].word !== word || items[0].cn !== cn) bad.push(`${line} → ${JSON.stringify(items[0])}`);
  }
  check('点号/括号/顿号/制表符/纯空格/无释义 都能解析', bad.length === 0, bad.join(' ; '));
}

/* ---------- 噪音：表头、围栏、说明文字、纯中文行 ---------- */
{
  const items = parseOcrText(`\`\`\`
序号 | 英文 | 中文
好的，识别结果如下：
1 | woof | 纬线
这不是词条的一行
\`\`\``);
  check('表头/围栏/说明文字/纯中文行都被跳过',
    items.length === 1 && items[0].word === 'woof', JSON.stringify(items.map((x) => x.word)));
}

/* ---------- 去重 ---------- */
{
  const items = parseOcrText(`1 | marsh | 沼泽
2 | Marsh | 沼泽地`);
  check('重复词（大小写不同）只留第一条', items.length === 1 && items[0].cn === '沼泽', JSON.stringify(items));
}

/* ---------- 质量概览（界面提示用） ---------- */
{
  const q = ocrQuality(parseOcrText(`1 | a? | 甲
2 | b?? | 乙
3 | c |`));
  check('质量概览统计疑问数 / 缺释义数',
    q.total === 3 && q.doubt === 2 && q.withoutMeaning === 1, JSON.stringify(q));
}

/* ---------- 提示词必须真的为手写体做了准备 ---------- */
{
  check('提示词含手写专章', /手写体的处理规矩/.test(OCR_PROMPT));
  check('提示词给了连笔/形近字母的具体混淆对（rn↔m、a↔o、u↔v 等）',
    /rn/.test(OCR_PROMPT) && /连笔/.test(OCR_PROMPT) && /形近/.test(OCR_PROMPT));
  check('提示词要求：不跳过、给最可能拼写、加问号标记',
    /一律不跳过/.test(OCR_PROMPT) && /最可能的拼写/.test(OCR_PROMPT) && /问号/.test(OCR_PROMPT));
  check('提示词规定两栏阅读顺序（左栏读完再右栏）',
    /左栏从上到下/.test(OCR_PROMPT) && /右栏从上到下/.test(OCR_PROMPT));
  check('提示词要求涂改以最终写法为准', /涂改以最终写法为准/.test(OCR_PROMPT));
  check('提示词要求编号连续、不许跳行', /不要跳过|不跳过/.test(OCR_PROMPT));
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
