/**
 * 本地 mock 供应商：假模型 + 假词典。
 *
 * 抽出来的原因：e2e（tools/e2e-vocab.mjs）和用户模拟（tools/sim-user.mjs）都要一套
 * 一模一样的假数据，各写一份必然漂移 —— 一边改了音标，另一边还在测旧结论。
 * 放在这里，两边 import 同一份。
 *
 * 特殊性：
 *  · 模型给的音标**故意是错的**、词性**故意漏了动词** —— 词典核对这条链路要能抓住；
 *  · 词典给的却是对的（ˈɒbdʒɪkt / n. + v.）—— 验证"客观事实以词典为准"。
 *
 * 触发词（把词头当命令用）：
 *   __error__   模型返回 500        → 前端要显示可读错误，不能白屏
 *   __garbage__ 模型返回非 JSON     → 前端要提示"格式不对，重试"
 *   __huge__    返回超长连写内容    → 验证长 token 不会把页面撑宽
 */
import http from 'node:http';

/* ---------- 词条 fixture ---------- */
export const entryFor = (head) => ({
  head,
  kind: head.includes(' ') ? 'phrase' : 'word',
  phonetic: '/ɒbˈdʒekt/', pos: '名词', brief: '物体；反对',
  register: '通用', tone: '中性', strength: '中',
  meanings: [
    { pos: '名词', cn: '物体、目标', en: 'a thing you can see and touch' },
  ],
  scenes: ['学术写作中表达不同意见', '日常描述实物'],
  avoid: '不要用它表示"拒绝"（那是 refuse）',
  mnemonic: { image: '把反对意见"扔"到对方面前', hook: 'ob（反）+ ject（扔）= 对着扔', parts: 'ob-（反对）+ ject（扔）', family: 'objection / objective' },
  synonyms: [{
    word: 'oppose', phonetic: '/əˈpəʊz/', cn: '反对', register: '正式', tone: '中性', strength: '强',
    diff: 'oppose 更强调公开、正式的反对', usage: '正式场合用 oppose，日常用 be against',
    example: 'They opposed the plan.', exampleCn: '他们反对这个计划。',
  }],
  collocations: ['object to sth', 'a solid object'],
  examples: [{ en: 'She objected to the new rules.', cn: '她反对新规定。', note: '演示 object to 这个搭配' }],
  confusions: 'object 作动词必须接 to；oppose 直接接宾语。',
  usageNotes: '作动词时重音在第二节。',
  examTips: '四六级常考 object to doing 这个结构。',
});

/** 超长 token：真实场景是模型吐出连写的德语复合词 / 长 URL */
export const hugeEntry = (head) => ({
  ...entryFor(head),
  brief: 'Donaudampfschifffahrtsgesellschaftskapitaenswitwe'.repeat(3),
  scenes: ['https://example.com/' + 'a'.repeat(160)],
  examples: [{ en: 'Pneumonoultramicroscopicsilicovolcanoconiosis'.repeat(2), cn: '一个超长的英文单词', note: '' }],
});

export const QUIZ = {
  title: '单词本自测 · 3 题',
  questions: [
    { type: 'choice', stem: '选出最合适的一项：She ___ to the new rules.', options: ['objected', 'opposed', 'against', 'object'], answer: 'objected', explanation: 'object 作动词要接 to。' },
    { type: 'fill', stem: '填空：They ___ the plan openly.（公开反对）', options: [], answer: 'opposed', explanation: 'oppose 直接接宾语，更正式。' },
    { type: 'choice', stem: '哪句更得体？', options: ['I object to this.', 'I oppose to this.'], answer: 'I object to this.', explanation: 'oppose 不与 to 连用。' },
  ],
};

/* ---------- 词典 fixture（与模型故意不一致） ---------- */
export const DICT_SAMPLE = {
  ec: {
    exam_type: ['初中', '高中', 'CET4', 'CET6', '考研'],
    word: [{
      ukphone: 'ˈɒbdʒɪkt; əbˈdʒekt', usphone: 'ˈɑːbdʒekt; əbˈdʒekt',
      trs: [{ tr: [{ l: { i: ['n. 物体，实物；目的，目标'] } }] }, { tr: [{ l: { i: ['v. 反对'] } }] }],
      'return-phrase': { l: { i: 'object' } },
    }],
  },
  simple: {
    query: 'object',
    word: [{ 'return-phrase': 'object', multiPhone: { uk: [{ phone: 'ˈɒbdʒɪkt', pos: ['n'] }], us: [{ phone: 'ˈɑːbdʒekt', pos: ['n'] }] } }],
  },
  meta: { input: 'object' },
};

/**
 * 起两个本地服务：AI（OpenAI 兼容）与词典。
 * @returns {Promise<{aiBaseUrl:string, dictBaseUrl:string, calls:object, close:()=>Promise<void>}>}
 */

/** 把词条对象拆成"一行一段"的 NDJSON（与生产协议一致，供流式分支使用） */
function entryToSegments(entry) {
  const one = (o) => JSON.stringify(o);
  const meta = { t: 'meta', head: entry.head, kind: entry.kind, phonetic: entry.phonetic, pos: entry.pos, brief: entry.brief, register: entry.register, tone: entry.tone, strength: entry.strength };
  const segs = [one(meta)];
  if (Array.isArray(entry.meanings) && entry.meanings.length) segs.push(one({ t: 'meanings', items: entry.meanings }));
  if ((entry.scenes || []).length || entry.avoid) segs.push(one({ t: 'scenes', items: entry.scenes || [], avoid: entry.avoid || '' }));
  if (entry.mnemonic) segs.push(one({ t: 'mnemonic', ...entry.mnemonic }));
  if ((entry.synonyms || []).length) segs.push(one({ t: 'synonyms', items: entry.synonyms }));
  if ((entry.collocations || []).length) segs.push(one({ t: 'collocations', items: entry.collocations }));
  if ((entry.examples || []).length) segs.push(one({ t: 'examples', items: entry.examples }));
  segs.push(one({ t: 'notes', confusions: entry.confusions || '', usageNotes: entry.usageNotes || '', examTips: entry.examTips || '' }));
  segs.push(one({ t: 'done' }));
  return segs;
}

export async function startMockProvider({ aiPort, dictPort, delayMs = 0 } = {}) {
  const calls = { ai: 0, dict: 0, terms: [], bodies: [] };

  const ai = http.createServer((q, r) => {
    let b = '';
    q.on('data', (c) => { b += c; });
    q.on('end', async () => {
      calls.ai += 1;
      calls.bodies.push(b);
      /**
       * 从请求体里取"用户消息文本"再抽词头。
       * ⚠️ 不能直接对 JSON 原文用正则：正文里的换行在 JSON 里是「反斜杠 + n」两个字符，
       * 边界很容易被吃穿（实测把整个请求体当成了词头）。
       * 先 JSON.parse 拿到真正的 messages，再在**解码后**的文本上抽。
       */
      /**
       * 从请求体里取"用户消息文本"，再按**字符串切分**抽词头。
       * 为什么不用正则：正文里的换行在 JSON 里是「反斜杠 + n」两个字符，
       * 边界很容易被吃穿（实测把整个请求体当成了词头）；而且正则里的转义在本项目的
       * 编辑链路上反复被踩坏。用 indexOf + split 最稳。
       */
      const bodyObj = (() => { try { return JSON.parse(b); } catch { return null; } })();
      const userText = bodyObj && Array.isArray(bodyObj.messages)
        ? bodyObj.messages.map((m) => String((m && m.content) || "")).join(String.fromCharCode(10))
        : b;
      const afterTag = (tag) => {
        const at = userText.indexOf(tag);
        if (at < 0) return "";
        return userText.slice(at + tag.length).split(String.fromCharCode(10))[0].trim();
      };
      let term = afterTag("【查询内容】") || "object";
      // __slow__ 标记：词头取标记之后的部分，但流式分段放慢 —— 让测试能观察到"边生成边看"
      const slowStream = term.startsWith('__slow__');
      if (slowStream) term = term.slice('__slow__'.length).trim() || 'object';
      calls.terms.push(term);
      const isQuiz = /自测题|出题/.test(b);
      const send = (code, payload) => {
        r.writeHead(code, { 'Content-Type': 'application/json' });
        r.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      /* 自测题批改（主观题）：请求里带"请批改下面 N 道题" */
      if (/请批改下面/.test(b) && !/【查询内容】/.test(b)) {
        const n = (String(b).match(/请批改下面 (\d+) 道题/) || [])[1] || '1';
        const count = Number(n) || 1;
        const items = Array.from({ length: count }, (_, i) => ({
          index: i,
          score: 4,
          correct: true,
          comment: '意思对，注意冠词（第 ' + (i + 1) + ' 题）',
          better: 'He placed the book on the table.',
        }));
        return send(200, { choices: [{ message: { content: JSON.stringify({ items, comment: '整体不错，注意冠词' }) }, finish_reason: 'stop' }] });
      }

      /* 视觉（拍照识别）：请求体里有 image_url。返回一段**手写风格的识别结果**，
         故意包含：疑问标记（? / ??）、? 占位行、无释义行 —— 覆盖前端的核对与编辑路径。 */
      if (/"image_url"|"type":"image/.test(b) || Array.isArray(bodyObj?.messages?.[1]?.content)) {
        const ocrText = [
          '1 | aggregation | 聚集',
          '2 | marsh | 沼泽',
          '3 | vacillate? | 犹豫不决',
          '4 | ? | 隐约的',
          '5 | sacrilege?? | 亵渎',
          '6 | woof |',
          '7 | graved | 刻',
        ].join(String.fromCharCode(10));
        // 模型名里没有 flash 就当作"不认图片"（模拟只支持文本的模型）→ 用来验证自动回退
        const bodyModel = String(bodyObj?.model || 'mock');
        if (!/flash/i.test(bodyModel)) {
          return send(400, { error: { message: 'This model does not support image input' } });
        }
        return send(200, { model: bodyModel, choices: [{ message: { content: ocrText }, finish_reason: 'stop' }] });
      }

      /* 标记词要在**流式分支之前**处理：否则 __error__ / __garbage__ 会被流式截胡，
         "错误路径"这类用例就永远等不到错误提示（实测踩过） */
      if (term === '__error__') return send(500, { error: { message: 'mock upstream exploded' } });
      if (term === '__garbage__') return send(200, { choices: [{ message: { content: '这不是 JSON' } }] });

      // 流式分支：按 NDJSON 分段吐（真实链路也是这个协议）
      const wantsStream = /"stream"\s*:\s*true/.test(b);
      if (wantsStream && !/【学生的问题】/.test(b) && !isQuiz && /【查询内容】/.test(b)) {
        const entry = term === '__huge__' ? hugeEntry(term) : entryFor(term);
        const segs = entryToSegments(entry);
        r.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        const sse = (delta) => r.write('data: ' + JSON.stringify({ choices: [{ delta: { content: delta } }] }) + String.fromCharCode(10) + String.fromCharCode(10));
        // 异常注入：__streamgarbage__ 夹杂说明与围栏；__streamcut__ 中途断流；__streamplain__ 直接一次性 JSON
        const garbage = term === '__streamgarbage__';
        const cut = term === '__streamcut__';
        const plain = term === '__streamplain__';
        if (garbage) sse('好的，下面开始输出：' + String.fromCharCode(10) + '```json' + String.fromCharCode(10));
        if (plain) {
          sse(JSON.stringify(entry));
        } else {
          for (let i = 0; i < segs.length; i += 1) {
            if (cut && i >= 2) break;                    // 中途断流
            sse(segs[i] + String.fromCharCode(10));
            const per = slowStream ? 350 : (delayMs ? Math.max(60, Math.round(delayMs / segs.length)) : 0);
            if (per) await new Promise((res) => setTimeout(res, per));
          }
        }
        if (garbage) sse('```' + String.fromCharCode(10));
        if (!cut) sse('[DONE-mark]');
        r.write('data: [DONE]' + String.fromCharCode(10) + String.fromCharCode(10));
        return r.end();
      }

      if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
      // 追问：返回**纯文本**回答（真实链路里也是纯文本，不是 JSON）
      if (/【学生的问题】/.test(b)) {
        // 请求体是 JSON：真实换行在里面是「反斜杠 + n」两个字符，
        // 所以字符类要连反斜杠一起排掉，否则会把后面那句"请直接回答"也吞进问题里
        const q = (/【学生的问题】([^\n\\]+)/.exec(b) || [])[1] || '';
        return send(200, { choices: [{ message: { content: '好的，我来回答：object 作名词是"物体"，作动词要接 to —— object to sth。' + (q ? '（问题：' + q.slice(0, 20) + '）' : '') } }] });
      }
      // 造句：出题（翻译模式的中文句子）与批改（三维评分）
      if (/造句|翻译题/.test(b) && /items/.test(b)) {
        // 只认【词条】那一段里的 "1. head｜词性｜释义"：
        // 系统提示词里也有编号行，不圈定范围就会把它们当成词头（第一版就这么翻车的）
        const seg = (b.split('【词条】')[1] || '').split('【')[0];
        const heads = [];
        for (const line of seg.split('\\n')) {
          const hit = /^\d+\.\s*([^｜]+)/.exec(line.trim());
          if (hit && hit[1]) heads.push(hit[1].trim());
        }
        const list = heads.length ? heads : ['object', 'oppose', 'banana'];
        return send(200, { choices: [{ message: { content: JSON.stringify({
          title: '造句练习 · ' + list.length + ' 题',
          items: list.map((h) => ({ head: h, cn: `请把这句话译成英文：我想用 ${h} 说一件事。`, tip: '注意它该用什么词性' })),
        }) } }] });
      }
      if (/批改|造句练习/.test(b) && /score/.test(b)) {
        // 用没用到目标词决定分数高低：这样"进错词本"那条分支也测得到。
        // 请求体是 JSON：真实换行在里面是「反斜杠 + n」，所以按 '\\n' 切分再取值。
        const field = (label) => {
          const i = b.indexOf('【' + label + '】');
          if (i < 0) return '';
          return b.slice(i + label.length + 2).split('\\n')[0].replace(/[（(].*$/, '').trim();
        };
        const head = field('目标词') || 'object';
        const sentence = field('学生写的句子');
        // 词头里可能带括号/空格/撇号 —— 正则里只保留字母，免得把测试搞崩（真实链路是模型判断，不靠正则）
        const probe = (head.split(/[\s（(]/)[0] || '').replace(/[^A-Za-z'-]/g, '');
        const used = probe ? new RegExp(probe, 'i').test(sentence) : false;
        return send(200, { choices: [{ message: { content: JSON.stringify({
          score: used ? 88 : 30,
          usesTarget: used,
          verdict: used ? '用词准确，语境也自然。' : '这句里没有出现目标词。',
          points: ['谁', '做什么', '频率'],
          missing: used ? [] : [],
          problems: used ? [] : [{ kind: 'word', issue: '句子里没有用上 ' + head, fix: '把 ' + head + ' 放进句子里再试' }],
          suggestion: used ? sentence : 'I want to use ' + head + ' in a sentence.',
          corrected: used ? sentence : 'I want to use ' + head + ' in a sentence.',
        }) } }] });
      }
      // 中文查词：给候选词（真实链路里也是先选词再讲解）
      if (/【学生输入的中文】/.test(b) && /candidates/.test(b)) {
        const zh = (/【学生输入的中文】([^\n\\]+)/.exec(b) || [])[1] || '羽毛球';
        return send(200, { choices: [{ message: { content: JSON.stringify({
          term: zh,
          candidates: [
            { word: 'badminton', pos: '名词', phonetic: '/ˈbædmɪntən/', cn: '羽毛球（运动项目）', register: '通用', variant: '英式/美式常用', note: '只能指运动，不说 play a badminton' },
            { word: 'shuttlecock', pos: '名词', phonetic: '/ˈʃʌtlkɒk/', cn: '羽毛球（那个球）', register: '通用', variant: '英式', note: '指实物；能 play 的是 badminton，能 hit 的是 shuttlecock' },
            { word: 'birdie', pos: '名词', phonetic: '/ˈbɜːdi/', cn: '羽毛球（美式口语）', register: '口语', variant: '美式', note: '球场闲聊可用；写作一律用 shuttlecock' },
          ],
        }) } }] });
      }
      if (term === '__error__') return send(500, { error: { message: 'mock upstream exploded' } });
      if (term === '__garbage__') return send(200, { choices: [{ message: { content: '这不是 JSON' } }] });
      const payload = isQuiz ? QUIZ : (term === '__huge__' ? hugeEntry(term) : entryFor(term));
      return send(200, { choices: [{ message: { content: JSON.stringify(payload) } }] });
    });
  });

  const dict = http.createServer((q, r) => {
    calls.dict += 1;
    r.writeHead(200, { 'Content-Type': 'application/json' });
    // 只有 object 查得到 —— 其余词条要验证"词典静默降级为纯 AI"
    const url = q.url || '';
    r.end(JSON.stringify(/object/i.test(decodeURIComponent(url)) ? DICT_SAMPLE : { ec: {}, simple: {}, meta: {} }));
  });

  await new Promise((res) => ai.listen(aiPort, '127.0.0.1', res));
  await new Promise((res) => dict.listen(dictPort, '127.0.0.1', res));

  return {
    aiBaseUrl: `http://127.0.0.1:${aiPort}/v1`,
    dictBaseUrl: `http://127.0.0.1:${dictPort}`,
    calls,
    close: () => Promise.all([
      new Promise((res) => ai.close(res)),
      new Promise((res) => dict.close(res)),
    ]),
  };
}
