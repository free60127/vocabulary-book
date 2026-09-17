# 查词流式输出 · 改造方案（**已实施完成**）

> 状态：2026-09-17 落地。实施记录见文末「实施结果」。文首的方案与最终实现一致（含两处实现中发现的问题）。

> 目标：把「等 20~60 秒 → 一次弹出整张卡片」改成「**2~3 秒看到第一批内容，其余边生成边长出来**」。
> 约束：**现有链路一条都不能坏** —— 轮询、缓存、历史、收藏、同步、复习、PDF、追问全部照旧可用。

---

## 0. 为什么不能用"最简单的流式"

卡片是**结构化 JSON**（15 个字段、三层嵌套）。直接流式吐 JSON 会遇到：

- 半截 JSON 无法 `JSON.parse` → 中途什么都渲染不出来；
- 强行用"补全括号"的容错解析，遇到模型少写一个引号就会**整张卡片崩掉**；
- 卡片有固定阅读顺序（音标 → 释义 → 场景 → 词根 → 近义词 → 搭配 → 例句 → 易混 → 用法 → 考试），
  乱序到达会导致**排版跳动**，比等 20 秒更难受。

所以方案的核心不是"打开 stream:true"，而是**换一个可增量解析的输出协议**。

---

## 1. 协议：一行一段的 NDJSON（按卡片阅读顺序）

模型按固定顺序输出，**每段一行 JSON**，段与段之间换行：

```
{"t":"meta","head":"object","kind":"word","phonetic":"/ˈɒbdʒɪkt/","pos":"名词/动词","brief":"物体；反对","register":"通用","tone":"中性","strength":"中"}
{"t":"meanings","items":[{"pos":"名词","cn":"物体、目标","en":"a thing you can see and touch","note":"可数"}]}
{"t":"scenes","items":["学术写作中表达不同意见","日常描述实物"],"avoid":"正式文书里避免用动词义的口语搭配"}
{"t":"mnemonic","image":"桌上摆着一个方方正正的物体","hook":"ob-（朝向）+ ject（扔）→ 朝你扔过来的东西","parts":"ob-（朝向）+ ject（投掷）","family":"objection / objective / objectify"}
{"t":"synonyms","items":[{"word":"oppose","phonetic":"/əˈpəʊz/","cn":"反对","register":"通用","tone":"中性","strength":"强","diff":"oppose 直接接宾语，object 必须接 to","usage":"正式表态用 oppose；口语吐槽用 object to","example":"She opposed the plan.","exampleCn":"她反对这个计划。"}]}
{"t":"collocations","items":["object to sth 反对某事","a solid object 固体"]}
{"t":"examples","items":[{"en":"I object to being treated like a child.","cn":"我反对被当成小孩对待。","note":"动词义 + to doing"}]}
{"t":"notes","confusions":"object 与 oppose 的差别在搭配……","usageNotes":"object 作动词是不及物，必须接 to。","examTips":"四六级翻译常考 object to doing。"}
{"t":"done"}
```

设计要点：

| 决定 | 理由 |
| --- | --- |
| **段顺序 = 卡片渲染顺序** | UI 自上而下长出来，永不跳动 |
| **行级切分（`\n`）** | 只处理"完整行"，残行留在缓冲等下一块数据 → 天然容忍任意截断 |
| **`t` 字段标识段落类型** | 新增字段（如以后加"词频"）不影响老前端：认不出的段直接忽略 |
| **最后一段 `done`** | 明确收尾；缺失 `done` 说明被截断，前端退回轮询拿完整结果 |
| **不输出数组、不加围栏** | 提示词明确要求；解析器仍会跳过 ``` / 说明文字（模型偶尔不听） |
| **词典事实单独一段 `{"t":"dict"}`** | 它在卡片里排第二位（紧跟头部），且**服务端在调模型前就拿到了** → 可以让用户最先看到"已用有道词典核对" |

---

## 2. 服务端改动（file by file）

### 2.1 `server/llm.mjs`（新增，不改现有函数）

```js
export async function callLLMStream({ baseUrl, model, apiKey, system, user, maxTokens, meta },
                                    { onDelta, signal }) { ... }
```
- 用 `fetch` + `body.stream = true`，按 SSE 逐块读 `data: {...}`，取 `choices[0].delta.content`；
- `onDelta(text)` 回调给上层；
- 返回累积全文（与 `callLLM` 同样的返回形态，方便降级复用）；
- 沿用 `postChat` 的安全约定：**自定义地址不跟随重定向**、超时、错误文案与现在一致。

> 注意：流式请求**不能用 `response_format: json_object`**（那是"一次性输出 JSON"的约束），
> 所以 `jsonMode` 保持 false，靠提示词约束格式 —— 这也是为什么要做"解析失败自动降级"。

### 2.2 `server/jobs.mjs`（小改）

- 任务对象加两个字段：`segments: []`、`streamState: 'running' | 'done' | 'fallback'`；
- **内存里追加**（每次都写 KV 会把 KV 打爆）；KV 只在完成时写一次（保持现状）；
- 每收到一段就 `job.updatedAt = Date.now()`（让现有的僵尸判定复用，不必新增逻辑）。

### 2.3 `server/index.mjs`（新增一处路由 + 改造 runLookupJob）

- `runLookupJob` 增加"流式分支"：
  1. 先查缓存（已有）→ 命中直接 `done`，**不走流式**；
  2. 取词典事实（已有，含 2.5s 限时）→ **立刻写入 `{"t":"dict"}` 段**，让用户先看到音标/词性/大纲标注；
  3. `callLLMStream` 边收边按行切分 → 完整行解析成段 → push 到 `job.segments`；
  4. 结束时：跑一次现有的 `sanitizeEntry`（**用同一条收敛路径**），把最终词条写入 `job.data`；
     若全过程一段都没解析出来（模型不听话）→ 走现有的 `parseJsonLoose` 兜底，并记 `streamState='fallback'` 以便排查。
- 新增 `GET /api/lookup/:id/stream`（SSE）：
  - 按 `Last-Event-ID` 或 `?from=N` 只推**新增**段（断线重连不重放）；
  - 每 15s 发一次注释心跳（`: ping`），防代理断开长连接；
  - 结束事件：`event: done`，`data` 里带**最终完整词条**（前端据此覆盖 partial，保证"看到的"和"存下的"一致）；
  - 失败：`event: error`，`data` 里带与现在完全相同的错误文案（`markJobFailed` 的文案，前端无需另写分支）；
  - 任务已完成时（用户切走又回来）：一次性推完所有段 + done。

### 2.4 `server/prompt.mjs`（新增流式版本）

- 新增 `LOOKUP_STREAM_SYSTEM_PROMPT`：内容与现有 `LOOKUP_SYSTEM_PROMPT` **逐条一致**（讲解质量不能降），
  只把"输出 JSON"一节换成"按上面的顺序，每段一行 JSON，不要数组、不要围栏、不要解释"。
- 抽公共部分：把"讲解要求"和"字段定义"拆成常量，两个提示词拼装，避免两份提示词日后各自漂移。

### 2.5 `server/job-stale.mjs` / `budget` / 限流
**不动**。流式不改变任务生命周期、额度与限流口径；SSE 连接不计入 `MAX_INFLIGHT_JOBS`（那管的是"同时在跑的模型任务"）。

---

## 3. 前端改动（file by file）

### 3.1 `src/api.js`
新增 `openLookupStream(jobId, handlers)`：封装 `EventSource`，暴露 `onSegment / onDone / onError / close()`。
（`EventSource` 全平台支持；不支持时抛错，调用方走轮询。）

### 3.2 `src/hooks/useLookupStream.js`（新文件）
职责：**把段拼成一个"部分词条"**。
- 输入：`jobId`；输出：`{ partial, progress, done, error }`；
- `partial` 是按段累积的普通对象（字段与最终词条同名）→ `EntryCard` 现有渲染逻辑**不用改**（每段都是
  `(entry.meanings||[]).length ? … : null` 这种条件渲染，字段没到就不渲染）；
- `progress`：已收到的段数 / 段类型列表（用于"正在生成：近义词对比…"这类文案）；
- `done` / `error` 时关闭连接；
- 组件卸载或切走时 `close()`（不 abort 服务端任务 —— 它继续跑完并写缓存）。

### 3.3 `src/App.jsx`
- `runLookup` 里：`if (settings.streamLookup !== false && 支持 SSE) 走流式 else 走现有 submitAndPoll`；
- 流式失败（`onError` 或 6 秒内一段都没到）→ **自动回退**到 `submitAndPoll`（同一 jobId 继续轮询，不重复提交、不重复计费）；
- 完成后用 `done` 事件里的最终词条覆盖 `partial`（并写入历史/缓存，与今天一致）。

### 3.4 `src/components/EntryCard.jsx`（小改）
- 卡片底部加一行"生成中"指示：`已就绪：释义 · 近义词对比 … 正在写：例句`（用 `progress`）；
- 未 `done` 时：**导出 PDF / 加入单词本 / 复制 / 追问** 禁用（避免存下半成品）；
- 段落出现时加一次性淡入（`animation: fade-in .18s`），避免"啪"地跳出来；
- 不改任何既有字段的渲染逻辑。

### 3.5 设置项
「AI 设置」里加一个开关「流式输出（边生成边看）」，默认开；关掉即回到今天的行为（纯粹为了出问题能一键退回）。

---

## 4. 失败与边界（每一种都要有确定行为）

| 情况 | 行为 |
| --- | --- |
| 模型加了 ``` 围栏 / 夹杂说明 | 解析器逐行尝试 JSON，跳过非 JSON 行；围栏行直接丢 |
| 模型完全不听（输出一次性 JSON） | 结束时兜底 `parseJsonLoose` → 仍能出完整卡片（`streamState='fallback'` 记日志） |
| 某行 JSON 缺引号/半截 | 该行丢弃 + 记日志；其余段照常渲染；最终结果仍以服务端收敛后的词条为准 |
| SSE 被代理切断 / 浏览器不支持 | 前端 `onerror` → 自动回退轮询（现有实现，零改动） |
| 用户切后台 / 锁屏 / 关页面 | 连接断开，服务端**继续跑完并写缓存**；回来时要么命中缓存，要么轮询拿到结果 |
| 任务真失败（模型 500） | SSE 推 `event: error`，文案与现在完全一致；前端走同一个错误分支 |
| 生成中途点了"退出/查别的词" | 关连接，任务照跑；下次查同一个词直接命中缓存 |
| 缓存命中 | 不走 SSE，直接给完整卡片（今天的路径） |

---

## 5. 测试计划

**单测（node，新增 `server/stream.test.mjs`）**
- 段解析器：正常多段 / 带围栏 / 夹杂中文说明 / 半截行 / 重复段 / 顺序错乱 / 空行；
- 降级：0 段可解析 → `parseJsonLoose` 兜底仍产出合法词条；
- 与 `sanitizeEntry` 的一致性：同一份内容，"流式拼出来的"与"一次性解析的"结果字段一致。

**mock 提供者（tools/mock-provider.mjs）**
- 新增 `stream: true` 分支：分块吐 NDJSON（块大小可控，模拟 200~800ms 间隔）；
- 三个可注入异常：`__streamgarbage__`（夹杂说明）、`__streamcut__`（中途断流）、`__streamplain__`（直接吐一次性 JSON）。

**用户模拟（tools/sim-user.mjs，8 设备 × 11 场景）**
- 首段可见时间 **< 完整结果时间的 1/3**（证明流式真的在起作用）；
- 中途断流 → 自动回退轮询 → 最终仍出完整卡片；
- 流式进行中：导出/入库/追问按钮**禁用**，完成后恢复；
- 完成后 partial 被最终词条覆盖（用 PDF 导出内容比对，确保不是半成品）；
- 切后台 10 秒再回来：结果不丢（走轮询/缓存）；
- **开关关闭时行为与今天逐项一致**（现有 1019 项断言必须全绿）。

**e2e**：现有 74 项不动，另加 2 项（流式开关默认开、缓存命中不触发流式）。

---

## 6. 实施顺序（每步都可独立上线，不会卡在中途）

| 步骤 | 内容 | 交付物 | 预估 |
| --- | --- | --- | --- |
| **1** | 协议 + 服务端（llm 流式、runLookupJob 分段、SSE 路由、提示词拆分） | 老前端不受影响；新端点可单独测 | ~1h |
| **2** | 段解析器 + 降级 + 单测 + mock 流式分支 | `npm test` 覆盖解析与降级 | ~40min |
| **3** | 前端 hook + EntryCard 增量渲染 + 按钮禁用 + 开关 | 本地可见"边生成边长" | ~1h |
| **4** | 模拟/e2e 新场景 + 全量回归 + 文档 + 版本号 | 一次提交推送 | ~1h |
| — | **合计** | | **≈3.5~4 小时** |

**默认策略**：第 3 步做完后开关**默认开**，但保留设置项；若线上出现"模型不吐 NDJSON"的比例偏高，
只需把默认值改成关（一行改动），用户无感。

---

## 7. 明确不做什么（避免范围膨胀）

- ❌ 不改轮询链路（它是流式的降级通道，必须留着）；
- ❌ 不改卡片字段与讲解质量要求（流式只改"什么时候给你看"，不改"讲什么"）；
- ❌ 不为追问/造句同时上流式（追问是纯文本、最适合，但属于下一轮；本轮先把查词做扎实）；
- ❌ 不做"用户可中断生成"（服务端任务照跑完并缓存，反而更省——下次查直接命中）。

---

## 8. 待你确认的两个取舍

1. **首屏内容**：第一批只给 `meta`（音标/词性/一句话释义）+ `dict`（词典核对）—— 约 2~3 秒；
   还是把 `meanings`（释义列表）也算进第一批（多等 2~3 秒，但首屏更"有用"）？
   → 我建议**后者**：`meta + dict + meanings` 一起，约 5 秒，性价比最高。
2. **partial 渲染风格**：段落"淡入长出来"（推荐，克制），还是加一条明显的进度条与骨架屏（更热闹但要更多样式）？

---

## 9. 实施结果（2026-09-17）

**做了什么**
- `server/stream.mjs`（新）：分段解析器（跨块残行 / 围栏 / 说明文字 / 坏行全兜住）+ 折叠 + 收尾降级；
- `server/llm.mjs`：新增 `callLLMStream`（SSE 增量，沿用"不跟随重定向"等安全约定）；
- `server/prompt.mjs`：新增 `buildLookupSystemPrompt({stream})` —— **讲解要求一字不改**，只追加输出格式说明；
- `server/index.mjs`：`GET /api/lookup/:id/stream`（SSE：按 `?from=` 续传、15s 心跳、`done` 带最终词条、`error` 文案一致）+ 查词任务分流式/一次性两条路；
- `src/hooks/useLookupStream.js`（新）+ `src/streamFold.js`（新，与服务端折叠同构）+ `EntryCard` 进度条与"生成中禁用写操作" + 设置里的开关。

**实测**（mock 放慢 350ms/段）
| 指标 | 结果 |
| --- | --- |
| 首块内容出现 | **70ms**（词典核对先到） |
| 完整卡片 | 3356ms |
| 生成中 | 保存/导出禁用、追问隐藏、进度条显示"正在生成：音标与词性" |
| SSE 被拦 | 自动回退轮询，卡片照常出现 |
| 异常注入 | 夹杂说明+围栏 ✓、一次性 JSON 兜底 ✓、中途断流（保留已得段落）✓ |

**过程中发现并修掉的两个真 bug**
1. `parseJsonLoose` 的第二次 `JSON.parse` **没有 try/catch** —— 遇到多行 JSON（正是 NDJSON）会抛
   "Unexpected non-whitespace character after JSON"，把一个可恢复情况变成任务失败。已改为返回 null 并由调用方决定提示。
2. 折叠函数把 `avoid`（"什么场合别用它"）只在 `notes` 段里找，而它实际跟着 `scenes` 段来 ——
   流式下这一整块会丢失。单测（含"服务端折叠 == 前端折叠"的交叉断言）抓到并修好。

**测试**：新增 `test/stream.test.mjs`（17 项，已挂进 `npm test`）；模拟新增 7 项流式检查；
另修了两处测试基建问题（每轮用全新数据目录，避免跨轮缓存污染；限流放宽，避免长跑把后续场景掐掉）。
