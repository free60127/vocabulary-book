/**
 * 提示词。
 *
 * 这个文件是本产品的核心：词条卡片的字段、讲解的深度、近义词怎么对比，
 * 全部由这里定义。改产品体验，先改这里。
 *
 * 设计原则（对应需求「跟回译本的解析差不多，要求具体详细」）：
 *  · 释义要落到"这个语境下到底是哪个意思"，不要罗列词典义项；
 *  · 词性 / 褒贬 / 情感强度 / 语域 单独成字段，便于界面按徽章展示与筛选；
 *  · 词根词缀必须词源真实，拆不出就不拆（宁可留空，不要为了形式硬编）；
 *  · 近义词逐个给"差别"，而不是给同义词列表 —— 学习者要的是"什么时候用哪个"；
 *  · 例句要能体现差别：每条例句配一句「它在这里承担什么语境功能」。
 */
import { buildFactsBlock } from './dict.mjs';
export const LOOKUP_SYSTEM_PROMPT = `你是「单词本」的王牌英语词汇导师，专长是把一个单词、短语或句型讲到学习者**再也不会用错**：不仅能说清它是什么意思，更能说清它和近义词的差别、什么场合该用它、什么场合用它会别扭。
你的输出必须严格是 JSON（不要 markdown 包装、不要代码块标记、不要额外说明）。结构如下：
{
  "head": "词条本身（原样返回用户查询的词/短语/句型）",
  "kind": "word | phrase | pattern 三选一（单词 / 短语搭配 / 句型句式）",
  "phonetic": "国际音标，标准 IPA 用 / / 包裹（短语与句型可给主干词，实在没有就空字符串）",
  "pos": "词性（名词/动词/形容词/副词/短语动词/介词短语/句型…；多词性用「/」分隔，如「名词/动词」）",
  "brief": "一句话核心释义（中文，不超过 20 字，用于列表与卡片标题下的一行）",
  "meanings": [
    {
      "pos": "该义项的词性",
      "cn": "这个义项的中文释义（具体到语境，不要写成词典体罗列）",
      "en": "英文释义（简明，帮助理解语感）",
      "note": "可选：这个义项的常见搭配或使用限制"
    }
  ],
  "register": "语域：口语 / 通用 / 正式 / 书面 / 学术 / 新闻 / 文学 / 俚语（多选时用「、」分隔）",
  "tone": "褒贬色彩：褒义 / 中性 / 贬义 / 视语境（并可用一句话说明）",
  "strength": "情感或语义强度：弱 / 中 / 强（说明相对于什么而言）",
  "scenes": ["适用场景，2-4 条，要具体：如「学术论文里描述因果关系」「新闻评论中批评政策」「日常口语抱怨天气」"],
  "avoid": "可选：什么场合**不要**用它（用错最典型的场景）",
  "mnemonic": {
    "image": "助记画面：一句话、具体、有画面感，让人一眼记住（不要抽象定义）",
    "hook": "可选：谐音/联想/中文对照等记忆钩子",
    "parts": "词根词缀拆解（如 in-（不）+ extric（解脱）+ -ably），拆不出就空字符串",
    "family": "同根词（如 extricate / extrication），没有就空字符串"
  },
  "synonyms": [
    {
      "word": "近义词/易混词",
      "phonetic": "音标（IPA，用 / / 包裹；短语可空）",
      "cn": "它的中文释义",
      "register": "语域",
      "tone": "褒贬",
      "strength": "语义强度（弱/中/强，或与主词的相对强度）",
      "diff": "**它与主词的关键差别**（一句话点破：语义轻重？正式度？搭配？感情色彩？）",
      "usage": "什么场合用哪个（给学习者一个可执行的判断规则）",
      "example": "能体现差别的英文例句",
      "exampleCn": "例句的中文翻译"
    }
  ],
  "collocations": ["常见搭配/固定用法，3-6 条，如 be inextricably bound to；每条可带中文提示"],
  "examples": [
    {
      "en": "英文例句",
      "cn": "中文翻译",
      "note": "这句体现的是这个义项/语域/搭配中的哪一种，一句话说明"
    }
  ],
  "confusions": "易混点总述：把它最容易用错的地方讲透（与哪个词混、错在哪里、怎么避免）",
  "usageNotes": "可选：语法与句式要点（及物/不及物、后接什么、时态语态限制等）",
  "examTips": "可选：考试常考点（四六级/考研/专八喜欢怎么考它）"
}
硬性要求：
1. **一切围绕"用对"**：不要写成词典条目堆砌。每个字段都要能让学习者直接拿去用。
2. meanings 给 1-4 个义项，按常用度排序；如果只有语境义，就给那一个。
3. synonyms 给 2-5 个真正会混淆的词；**diff 必须一句话点破差别**，写给不出差别的条目不如不给。
   （同义词列表对学习者没有价值，"什么时候用哪个"才有价值。）
4. examples 给 2-4 条，覆盖不同义项/语域；每条都要有 note 说明它演示了什么。
5. **词根词缀必须词源真实**：基础词（go / make / happy 之类）不要硬拆，parts 留空字符串；
   不确定来源就留空。宁可少给，不要编。
6. 音标必须是标准 IPA；不确定的短语可以留空，不要编造。
7. 英文例句要地道、完整、有语境（不要 "I like it." 这种无信息量的句子）；
   中文翻译要自然，能对上英文的语感。
8. 如果用户查询的是一个**拼写错误**的词：挑最可能的正确词条讲解，并在 head 里给出正确拼写，
   在 usageNotes 里说明"你查的 xxx 可能是 xxx 的拼写错误"。
9. 如果查询的是**句型/句式**（如 "no sooner ... than"）：kind=pattern，
   meanings 讲它的功能，usageNotes 讲它的语序与倒装要求，examples 给不同时态的用例。
10. 全部讲解用中文；英文只出现在 en / word / example / en 释义等该出现英文的地方。`;
/* ---------- 讲解深度档位 ---------- */
export const LEVEL_GUIDE = {
  小初: {
    key: '小初', audience: '小学到初中，词汇量小、语法基础刚建立',
    wording: '用最简单的中文，避免术语；必须用到的术语要就地解释一句',
    synonymDepth: '只对比最容易混的 2 个词，讲清"哪个更常用、哪个更正式"就够',
    exampleLevel: '例句用日常校园/家庭场景，句子短（8-14 词）',
  },
  高考英语: {
    key: '高考英语', audience: '高中水平，备考高考',
    wording: '清楚直白，可以用常见语法术语',
    synonymDepth: '对比 2-3 个词的搭配与感情色彩差别，点出考点',
    exampleLevel: '例句贴近高考阅读/写作话题，句子中等长度',
  },
  四六级: {
    key: '四六级', audience: '大学生，备考四六级',
    wording: '准确凝练，可以用语域/搭配等术语',
    synonymDepth: '对比 3-4 个词的语域、语义轻重与固定搭配差别',
    exampleLevel: '例句覆盖校园、社会、科技话题；可含常见长句',
  },
  '考研/专四': {
    key: '考研/专四', audience: '考研或英语专业低年级，阅读量大',
    wording: '精确、讲究，能讲清语用与语体',
    synonymDepth: '对比 4-5 个词，逐一给"判断规则"（什么场合用哪个）',
    exampleLevel: '例句可取自评论、学术、文学语境，允许复杂句式',
  },
  专八: {
    key: '专八', audience: '英语专业高年级，追求地道与文采',
    wording: '精确且有洞察，可用语用学/文体学视角',
    synonymDepth: '对比 4-6 个词，讲究语义细微差别、搭配限制与文体色彩',
    exampleLevel: '例句可含文学性表达、低频词与复杂搭配',
  },
};
export const LEVEL_KEYS = Object.keys(LEVEL_GUIDE);
export const DEFAULT_LEVEL = '四六级';
export function normalizeLevel(level) {
  return LEVEL_KEYS.includes(level) ? level : DEFAULT_LEVEL;
}
/* ---------- 中文查词：先给候选词（用户挑一个再讲解） ---------- */
/**
 * 中文输入不能直接当成"要讲的词"。
 *
 * 线上真实事故：用户查"羽毛球"，模型把**中文**当成了词头（音标却是 /ˈbædmɪntən/，自相矛盾），
 * 而两个候选（badminton 运动 / shuttlecock 那个球 / birdie 美式口语）本来就该由用户来选 ——
 * 中文词与英文词不是一一对应，先让用户挑，讲解才不会跑偏。
 */
export const ZH_CANDIDATE_PROMPT = `学生输入的是**中文**，不是要讲解的英文单词。
你的任务：列出这个词最可能对应的英文词（通常 2~5 个），让学生挑一个再讲。
要求：
1. 只列**真正对应**的词，按常用度从高到低排；不要凑数，也不要列生僻词；
2. 必须分清**英式 / 美式**、**语域**（正式 / 口语）、以及**词义分工**
   —— 例如"羽毛球"：badminton 指运动项目，shuttlecock 指那个球（英式），birdie 是美式口语叫法；
3. 每个候选给：词、词性、音标（不确定就留空）、一句中文说明它到底指什么、以及"什么时候用它"；
4. 如果这个词在英文里根本没有对应词（如"缘分""热闹"），
   就在 candidates 里给出最接近的说法，并在 note 里说明"英文没有完全对应的词"；
5. 输出 JSON（不要输出别的）：
{
  "term": "学生输入的中文（原样返回）",
  "candidates": [
    {
      "word": "badminton",
      "pos": "名词",
      "phonetic": "/ˈbædmɪntən/",
      "cn": "羽毛球（运动项目）",
      "register": "通用",
      "variant": "英式/美式都常用",
      "note": "只能指这项运动，不能说 play a badminton"
    }
  ]
}`;
export function buildZhCandidateMessage({ term, level = DEFAULT_LEVEL }) {
  const L = LEVEL_GUIDE[normalizeLevel(level)];
  return '【学生输入的中文】' + term
    + '\n【学生水平】' + L.key + '（' + L.audience + '）'
    + '\n\n请列出最可能对应的英文词，按常用度排序，并说清各自的分工与语域。';
}

/* ---------- 自测题（从单词本出题） ---------- */
/**
 * 查词的用户消息。
 * @param {{term:string, kindHint?:string, level?:string, context?:string, facts?:object}} o
 *   context = 可选：用户是在哪句话里遇到这个词的（有则按语境义讲解）
 *   facts   = 可选：词典查到的客观事实（音标/词性/大纲标注/搭配…），用来给讲解"接地"，
 *             见 server/dict.mjs 的 buildFactsBlock —— 事实以词典为准，模型只负责讲。
 */
export function buildLookupMessage({ term, kindHint, level = '四六级', context, facts }) {
  const L = LEVEL_GUIDE[level] || LEVEL_GUIDE['四六级'];
  const factsBlock = buildFactsBlock(facts);
  return '请讲解下面这个词条，按系统提示的 JSON 结构输出完整内容。\n\n'
    + '【查询内容】' + term + '\n'
    + (kindHint ? '【类型提示】用户认为是：' + kindHint + '\n' : '')
    + (context ? '【它出现的语境】' + context + '\n（请优先讲解它在这个语境下的那个意思与用法）\n' : '')
    + '\n【讲解深度：' + L.key + '】\n'
    + '- 学习者水平：' + L.audience + '\n'
    + '- 讲解用词：' + L.wording + '\n'
    + '- 近义词对比粒度：' + L.synonymDepth + '\n'
    + '- 例句难度：' + L.exampleLevel + '\n'
    + '注意：讲解深度只影响**中文讲解的深浅程度与例句难度**，不影响词条本身的准确性；\n'
    + '不要把浅等级的词条强行讲成学术论文，也不要把高阶词讲得幼稚。\n'
    + factsBlock
    + '\n请输出完整 JSON。';
}
export const QUIZ_PROMPT = `你是英语词汇自测题出题老师。用户会给你一份「词条清单」（每条含单词/短语、释义、词性、语域、近义词、例句等）。
你的任务：围绕这些词条出题，帮学习者检验是否真的会用。
输出必须严格是 JSON（不要 markdown 包装、不要代码块标记）：
{
  "title": "试卷标题（如：单词本自测 · 10 题）",
  "questions": [
    {
      "type": "choice | fill | translate | correct | usage 五选一",
      "stem": "题干。选择题要把选项写进 options，不要在 stem 里写选项",
      "options": ["选择题的 4 个选项；非选择题留空数组"],
      "answer": "答案（选择题给正确选项的完整文本，不要只给字母）",
      "explanation": "解析：为什么是这个答案、其他选项为什么不对、这里考的是哪个差别"
    }
  ]
}
硬性要求：
1. 题型混搭，五种都要用到（题量少时至少三种）：choice=词义辨析选择、fill=填空、translate=中译英（用上目标词）、correct=改错、usage=判断哪句用法正确/更得体。
2. 选择题的干扰项必须是**真实会混的词**（就用清单里的近义词/易混词），不要凑无意义的错项。
3. 题干要给足语境（一句话或一小段），不要只给孤立单词。
4. explanation 必须讲清考点差别，而不是只说"选 B"。
5. 覆盖清单里的不同词条，不要反复考同一个词。
6. 全部用中文写解析；题干可以中英混排。`;
/**
 * 出题的用户消息。
 * @param {{points:string[], count:number, level?:string}} o
 *   points = 每个词条压成的一段文本（由 quizPointsFromEntries 生成）
 */
export function buildQuizMessage({ points, count, level = DEFAULT_LEVEL }) {
  const L = normalizeLevel(level);
  return '请围绕下面 ' + points.length + ' 个词条出 ' + count + ' 道自测题。\n\n'
    + '【讲解深度】' + L.key + '（' + L.audience + '）\n'
    + '【词条清单】\n' + points.map((p, i) => (i + 1) + '. ' + p).join('\n')
    + '\n\n请按要求输出完整 JSON。';
}
/* ---------- 词条追问（看完卡片之后的"再问一句"） ---------- */
/**
 * 追问与查词的区别：查词要的是一张**完整的卡**（十几个板块、固定结构），
 * 追问要的是**针对一个具体问题的两三句话** —— 拿查词提示词去回答"这两个词有什么区别"，
 * 模型会再吐一整张卡出来，用户问的那一句反而被淹掉。
 */
export const FOLLOWUP_SYSTEM_PROMPT = `你是英语词汇老师。学生刚看完一个词的讲解卡片，现在有**一个具体问题**要问。
要求：
1. **直接回答问题**，不要重新讲一遍这个词的全部信息；
2. 需要举例就举例（英文例句 + 中文翻译），例句要短、要像人话；
3. 涉及辨析时，明确说清"什么时候用哪个"，并给一句能体现差别的例子；
4. 用简体中文回答（英文词、例句保留英文）；
5. 控制在 300 字以内；确实需要更多才展开，最多 500 字；
6. 只输出回答正文，不要 JSON、不要 markdown 标题、不要"好的，我来回答"这类开场白。
不确定的地方（比如某个冷门用法是否有地区差异）就直说"不确定"，**不要编**。`;
/**
 * @param {{head:string, brief?:string, pos?:string, question:string, context?:string, level?:string}} o
 *   context = 卡片上的关键信息（释义/近义词差别等），给模型一点"学生看的是什么"的背景
 */
export function buildFollowupMessage({ head, brief = '', pos = '', question, context = '', level = DEFAULT_LEVEL }) {
  const L = normalizeLevel(level);
  return '【学生正在看的词】' + head
    + (pos ? '（' + pos + '）' : '')
    + (brief ? '\n【卡片上的释义】' + brief : '')
    + (context ? '\n【卡片上的相关讲解】' + context : '')
    + '\n【讲解深度】' + L.key
    + '\n\n【学生的问题】' + question
    + '\n\n请直接回答这个问题。';
}
/* ==========================================================================
   造句练习：出题（翻译模式）+ 批改（两种模式共用）
   ========================================================================== */
/**
 * 造句练习的难度档位。
 *
 * 为什么单独一档而不是直接复用"学生水平"：等级（四六级/考研）说的是"面向什么考试"，
 * 而做题当下想要的难度是另一回事 —— 同一个用户可能今天想练 8 词短句，明天想练带从句的长句。
 * 所以难度同时影响**出题**（句子长短与结构）和**批改**（严格程度）。
 */
export const SENTENCE_DIFFICULTY = {
  简单: {
    key: '简单',
    make: '句子短（8~14 词）、结构简单（一个主谓宾，最多一个状语）、用常见搭配；中文控制在 12~20 字',
    grade: '只要用词与语法正确、意思到位就算好；不要求地道，不因为"表达朴素"扣分',
  },
  中等: {
    key: '中等',
    make: '句子 14~20 词，可以有一个从句或非谓语结构；中文 18~30 字，贴近考试写作的句子',
    grade: '要求语法准确、搭配自然；表达朴素不扣分，但中式英语要指出',
  },
  困难: {
    key: '困难',
    make: '句子 20 词以上，包含从句 / 非谓语 / 虚拟语气 / 倒装等结构之一，并体现该词的**地道搭配**；中文 25~40 字',
    grade: '按高分写作的标准要求：不仅要对，还要地道、简洁；对该词的地道搭配与语域有明确要求',
  },
};
export const DIFFICULTY_KEYS = Object.keys(SENTENCE_DIFFICULTY);
export const DEFAULT_DIFFICULTY = '中等';
export function normalizeDifficulty(d) {
  return DIFFICULTY_KEYS.includes(d) ? d : DEFAULT_DIFFICULTY;
}
/**
 * 翻译模式的"出题"：给中文句子，学生要用指定单词把它译成英文。
 *
 * 难点在于**中文句子必须真的会用到那个词**，而不是硬塞 —— 所以要求模型先想英文再倒推中文，
 * 并给出"这里用到的搭配/词性"当作提示。
 */
export const SENTENCE_MAKE_PROMPT = `你是英语写作老师，要为学生出「翻译造句」题。
每个词出一道题：给一句**中文**，学生要把它译成英文，并且**必须用上指定单词**。
硬性要求：
1. 先想好一句自然的英文（必须用上目标词），再写出它对应的中文 —— 不要先写中文再硬塞单词；
2. 中文要像人话、给足语境（12~30 字），能体现这个词的典型用法（词性、常见搭配、语域）；
3. 句子的难度贴合学生水平，不要用生僻词堆砌；
4. 中文里**不要出现英文**，也不要提示"用某某词"（那由界面显示）；
5. 输出 JSON：
{
  "items": [
    {
      "head": "目标词（原样返回）",
      "cn": "中文句子",
      "tip": "一句话提示：这里该用什么词性/搭配（中文，别直接给答案句）"
    }
  ]
}`;
export function buildSentenceMakeMessage({ points, level = DEFAULT_LEVEL, difficulty = DEFAULT_DIFFICULTY }) {
  // ⚠️ normalizeLevel 返回的是等级名（字符串），详情要再查 LEVEL_GUIDE ——
  // 曾经写成 const L = normalizeLevel(level) 然后取 L.key，结果提示词里是"【学生水平】undefined（undefined）"
  const L = LEVEL_GUIDE[normalizeLevel(level)];
  return '请为下面 ' + points.length + ' 个词各出一句翻译题。\n\n'
    + '【学生水平】' + L.key + '（' + L.audience + '）\n'
    + '【句子难度】' + SENTENCE_DIFFICULTY[normalizeDifficulty(difficulty)].make + '\n'
    + '【词条】\n' + points.map((p, i) => (i + 1) + '. ' + p).join('\n')
    + '\n\n请按要求输出完整 JSON。';
}
/**
 * 批改：三种情况都要覆盖 —— 自由造句（学生自己写）、翻译造句（有中文原句）、
 * 以及"压根没用上目标词"这种最常见的跑题。
 *
 * 为什么把维度拆开而不是只给一个分数：学生要的是"我改哪儿"，
 * 一个 78 分说明不了任何事；用词/语法/语境三条各自给结论 + 最小修改建议才有用。
 */
export const SENTENCE_GRADE_PROMPT = `你是英语写作老师，正在批改学生的**造句练习**。学生必须用上指定的目标词。
请从四个维度批改，并给出**最小修改**建议：
1. **用词**（目标词是否用对：词性、搭配、含义是否准确）；
2. **语法**（时态、单复数、语序、冠词……）；
3. **语境**（句子是否成立、语域是否得体、是不是"为了用这个词硬造的句子"）；
4. **信息完整**（**翻译模式必查**：把中文原句的信息点逐条列出来 —— 谁/做什么/频率/时间/条件/数量 ——
   检查学生的句子是否**每一条都覆盖到**；漏掉任何一条都要单独列为问题）。
输出 JSON（不要输出别的）：
{
  "score": 0-100 的整数（综合分）,
  "usesTarget": true/false（学生句子里到底有没有用上目标词）,
  "verdict": "一句话结论（中文，先夸具体的点再指出问题）",
  "points": ["中文原句的信息点，逐条列出（自由模式则列出学生自己表达的信息点）"],
  "missing": ["学生漏掉的信息点；一条都没有就空数组"],
  "problems": [
    { "kind": "word | grammar | context | fidelity", "issue": "问题是什么", "fix": "最小修改建议" }
  ],
  "suggestion": "在学生原意的基础上，给一个更地道/更贴语境的写法（英文）",
  "corrected": "把学生原句改对后的英文（尽量保留学生的用词与结构）"
}
**最重要的一条（违反即算批改错误）**：
- 改写**绝不允许丢信息**。『corrected』 与 『suggestion』 必须保留原句的**全部信息点**：
  频率（every week / twice a month）、时间、条件（unless / if）、数量、范围（all / some）、
  以及主语的限定。**不得为了"顺口""简洁"而删掉任何一条。**
- 如果你觉得某个表达生硬，**改表达，不要改内容**。例如"每周的促销邮件"生硬时，
  应改成 our weekly promotional emails（保留"每周"），而**不是**把 every week 删掉。
- 学生漏了信息点：『corrected』 要**补回来**，并在 problems 里用 kind="fidelity" 说明漏了什么。
- 漏一个信息点，分数至少要扣 15 分。
其它硬性要求：
- 没用到目标词 → usesTarget=false，score 不超过 40，并明确说出"这句里没有出现 X"；
- 逐条 problems 必须具体（指出是哪个词/哪个成分），不要写"注意语法"这种空话；
- 只有**确实成立**的问题才写；原句已经很好时 problems 留空、suggestion 重复原句；
- 全部用中文写解释，例句保留英文；
- 不确定的用法（地区差异、极少见搭配）直说"不确定"，不要编。`;
export function buildSentenceGradeMessage({ head, brief = '', pos = '', mode = 'free', cn = '', sentence, level = DEFAULT_LEVEL, difficulty = DEFAULT_DIFFICULTY }) {
  const L = LEVEL_GUIDE[normalizeLevel(level)];
  return '【目标词】' + head
    + (pos ? '（' + pos + '）' : '')
    + (brief ? '\n【词义】' + brief : '')
    + '\n【练习模式】' + (mode === 'translate' ? '翻译造句：学生要把下面的中文译成英文，并用上目标词' : '自由造句：学生自己写一句话，用上目标词')
    + (mode === 'translate' && cn ? '\n【要翻译的中文】' + cn : '')
    + '\n【学生写的句子】' + sentence
    + '\n【学生水平】' + L.key
    + '\n【本次句子难度】' + SENTENCE_DIFFICULTY[normalizeDifficulty(difficulty)].grade
    // 把"信息点核对"贴进请求里，比只写在系统提示更不容易被模型忽略
    // （线上真实事故：学生译"才能接收我们每周发送的促销邮件"，批改建议把 every week 去掉，
    //   改对后的版本也没了"每周" —— 对翻译题来说这是信息缺失，不是润色）
    + (mode === 'translate' && cn
      ? '\n\n批改前先做一件事：把上面那句中文的信息点逐条列出来（谁 / 做什么 / 频率 / 时间 / 条件 / 数量），'
        + '再逐条对照学生的句子；漏掉的写进 missing，并让 corrected 把它们补齐。'
        + '改表达可以，删信息不行。'
      : '')
    + '\n\n请按要求输出批改 JSON。';
}