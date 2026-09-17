import { promises as dnsLookup } from 'node:dns';

/**
 * 模型调用层：Key 归一化 + 接入点安全边界 + 真正发请求。
 *
 * 从 index.mjs 抽出来（三段共 ~170 行，原本与路由、限流混在一个 1000 行的文件里）。
 * 这里值得单独读的原因：**服务端 Key 只允许发往自己配置的地址**，
 * 自定义地址要禁私网、不跟随重定向（防 SSRF）—— 这是被 PoC 打过的部分（照搬回译本）。
 *
 * 行为逐行照搬，只把"读 env"改成由调用方注入（HOSTED / ALLOW_SERVER_KEY 来自 index 的部署判定）。
 */
export function createLlm({ allowServerKey = true } = {}) {
  /* ---------- API Key 归一化 ----------
   * 实测踩过：在部署平台粘贴 Key 时把界面上的"必填"标记一起带了进去（值成了 `sk-… 必`），
   * 表现不是"认证失败"，而是 fetch 直接抛 ByteString 错误，且 hasKey 仍显示 true。
   * Key 只可能是可打印 ASCII —— 非 ASCII 与空白一律去掉，改动过就告警一次（不静默）。 */
  function normalizeApiKey(raw) {
    const s = String(raw == null ? '' : raw);
    const cleaned = s.replace(/[^\x21-\x7E]/g, '');
    return { key: cleaned, dirty: Boolean(s) && cleaned !== s };
  }
  const warnedKeys = new Set();
  const warnDirty = (name) => {
    if (warnedKeys.has(name)) return;
    warnedKeys.add(name);
    console.warn('⚠️  ' + name + ' 里混进了非 ASCII 字符或空白（常见于粘贴时带上了平台界面的提示文字），已自动清理后使用，请到部署平台核对该项。');
  };
  const envKey = () => { const { key, dirty } = normalizeApiKey(process.env.AI_API_KEY); if (dirty) warnDirty('AI_API_KEY'); return key; };

  const stat = {
    baseUrl: () => String(process.env.AI_BASE_URL || 'https://api.deepseek.com/v1').trim(),
    model: () => process.env.AI_MODEL || 'deepseek-chat',
    visionBaseUrl: () => String(process.env.AI_VISION_BASE_URL || process.env.AI_BASE_URL || 'https://api.deepseek.com/v1').trim(),
    visionModel: () => process.env.AI_VISION_MODEL || '',
    hasKey: () => Boolean(envKey()),
  };

  /* ---------- 接入点安全边界（照搬回译本：那里被 PoC 打过）----------
   * 1) 服务端 Key 只允许发往服务端自己配置的 baseUrl；
   * 2) 客户端要用自定义接口必须自带 Key；
   * 3) 自定义地址禁私网/环回/链路本地（含 IPv4 映射的 IPv6），并**解析域名**后再判一次。 */
    const ALLOW_SERVER_KEY = allowServerKey;
  const ALLOW_PRIVATE_BASE = process.env.ALLOW_PRIVATE_BASE_URL === '1';
  const sameEndpoint = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
  const looksLikeIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

  function isPrivateIp4(ip) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  function isPrivateIp6(ip) {
    if (ip === '::' || ip === '::1') return true;
    if (/^f[cd]/.test(ip)) return true;
    if (/^fe[89ab]/.test(ip)) return true;
    if (ip.startsWith('ff')) return true;
    return false;
  }
  function isPrivateIp(raw) {
    const ip = String(raw || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!ip) return true;
    const mapped = ip.match(/^::(?:ffff:)?(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
    if (mapped) {
      if (mapped[1]) return isPrivateIp4(mapped[1]);
      const hi = parseInt(mapped[2], 16);
      const lo = parseInt(mapped[3], 16);
      return isPrivateIp4([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.'));
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return isPrivateIp4(ip);
    if (ip.includes(':')) return isPrivateIp6(ip);
    return true;
  }
  const isPrivateName = (host) => {
    const h = String(host || '').toLowerCase();
    return !h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
  };
  async function isSafeBaseUrl(raw) {
    let u;
    try { u = new URL(raw); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (ALLOW_PRIVATE_BASE) return true;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (isPrivateName(host)) return false;
    if (looksLikeIp(host)) return !isPrivateIp(host);
    try {
      const addrs = await dnsLookup(host, { all: true });
      return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
    } catch { return false; }
  }
  async function resolveEndpoint({ bodyBase, bodyKey, fallbackBase, fallbackKey }) {
    const base = String(bodyBase || '').trim();
    const key = normalizeApiKey(bodyKey).key;
    // visitorKey = 这次用的是**访客自己带来的 Key**（而不是服务端那份）。
    // 每日额度只算服务端 Key 的请求：别人花自己的钱，没理由被我们的预算卡住。
    if (!base || sameEndpoint(base, fallbackBase)) {
      const visitorKey = Boolean(key);
      return { baseUrl: fallbackBase, apiKey: key || (ALLOW_SERVER_KEY ? fallbackKey : ''), visitorKey };
    }
    if (!(await isSafeBaseUrl(base))) {
      return { error: '该 Base URL 不被允许（只接受公网可解析的 http/https 地址）。如需指向内网地址，请改在服务端 .env 里配置 AI_BASE_URL，或设 ALLOW_PRIVATE_BASE_URL=1' };
    }
    if (!key) return { error: '使用自定义 Base URL 时，必须同时填写该接口的 API Key（服务端密钥不会发往自定义地址）' };
    return { baseUrl: base.replace(/\/+$/, ''), apiKey: key, visitorKey: true };
  }

  async function postChat({ url, headers, body, withFormat, timeoutMs = 120000 }) {
    let r;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      r = await fetch(url, {
        method: 'POST', headers,
        signal: controller.signal,
        // 不跟随重定向：跟随等于把"已验证是公网"的目标换成响应头里指定的任意地址
        redirect: 'manual',
        body: JSON.stringify(withFormat ? Object.assign({}, body, { response_format: { type: 'json_object' } }) : body),
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error('模型接口请求超时（' + Math.round(timeoutMs / 1000) + '秒），请稍后重试');
      throw new Error('无法连接模型接口: ' + e.message);
    } finally {
      clearTimeout(timer);
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location') || '(响应里没有 Location)';
      throw new Error('模型接口返回了重定向（' + r.status + ' → ' + loc + '）。出于安全考虑不自动跟随，请把 Base URL 直接写成最终地址。');
    }
    return r;
  }
  function parseJsonLoose(text) {
    const t = String(text || '').trim();
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1].trim() : t;
    try { return JSON.parse(body); } catch { /* 继续 */ }
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
      // ⚠️ 这次 parse 以前**没有 try/catch**，于是"多行 JSON"（比如流式的 NDJSON）会直接抛
      // "Unexpected non-whitespace character after JSON"，把一个可恢复的情况变成任务失败。
      // 现在统一返回 null，由调用方决定怎么提示。
      try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
  /**
   * 调一次模型。
   *
   * @param {boolean} [o.jsonMode] 是否要求模型返回 JSON。**查词/出题要，追问不要** ——
   *   追问的提示词明说"只输出回答正文，不要 JSON"，若同时又被 response_format 强制 JSON，
   *   两条指令打架，模型就可能回一个空壳（线上就是这么翻车的：追问报"模型没有给出回答"）。
   * @param {object} [o.meta] 诊断信息出口（finishReason / 内容长度），失败时能说清是"截断"还是"空"。
   */
  async function callLLM({ baseUrl, model, apiKey, system, user, maxTokens, jsonMode = true, meta }) {
    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const r = await postChat({
      url, headers, withFormat: jsonMode,
      body: {
        model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.4, max_tokens: Number(maxTokens || process.env.AI_MAX_TOKENS || 8000),
      },
    });
    const text = await r.text();
    if (!r.ok) throw new Error('模型接口错误 ' + r.status + ': ' + text.slice(0, 500));
    const data = JSON.parse(text);
    const choice = (data && data.choices && data.choices[0]) || {};
    const content = choice.message && choice.message.content;
    if (meta) {
      meta.finishReason = String(choice.finish_reason || '');
      meta.length = typeof content === 'string' ? content.length : 0;
      meta.reasoning = typeof (choice.message && choice.message.reasoning_content) === 'string'
        ? choice.message.reasoning_content.length : 0;
    }
    if (!content) throw new Error('模型没有返回内容，请重试');
    return content;
  }


  /**
   * 流式调用：边收边把增量交给调用方（查词的分段渲染靠它）。
   *
   * 三个要点：
   *  · **不能用 `response_format: json_object`** —— 那是"一次性输出一个 JSON"的约束，
   *    与"一行一段"冲突；格式约束交给提示词，解析端有兜底（见 server/stream.mjs）。
   *  · 返回**累积全文**，与 callLLM 同形 —— 万一分段解析全失败，还能当整段 JSON 兜底解析。
   *  · 沿用 postChat 的安全约定：不跟随重定向、超时、错误文案一致。
   * @param {(text:string)=>void} onDelta 每收到一段增量文本就回调（同步，别在里面 await 太久）
   */
  async function callLLMStream({ baseUrl, model, apiKey, system, user, maxTokens, meta },
                               { onDelta, timeoutMs = 300000 } = {}) {
    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers,
        redirect: 'manual',            // 同 postChat：跟随重定向等于把目标换成响应头指定的任意地址
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0.4,
          max_tokens: Number(maxTokens || process.env.AI_MAX_TOKENS || 8000),
          stream: true,
        }),
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('模型接口请求超时，请稍后重试');
      throw new Error('无法连接模型接口: ' + e.message);
    }
    if (r.status >= 300 && r.status < 400) {
      clearTimeout(timer);
      const loc = r.headers.get('location') || '(响应里没有 Location)';
      throw new Error('模型接口返回了重定向（' + r.status + ' → ' + loc + '）。出于安全考虑不自动跟随，请把 Base URL 直接写成最终地址。');
    }
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      clearTimeout(timer);
      throw new Error('模型接口错误 ' + r.status + ': ' + text.slice(0, 500));
    }
    if (!r.body) {
      clearTimeout(timer);
      throw new Error('模型接口没有返回流式响应体');
    }

    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let full = '';
    let finishReason = '';
    try {
      for await (const chunk of r.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx = buf.indexOf(String.fromCharCode(10));
        while (idx >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          idx = buf.indexOf(String.fromCharCode(10));
          if (!line || !line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let obj;
          try { obj = JSON.parse(payload); } catch { continue; }   // 半截行：跳过，下一块会补全
          const choice = (obj.choices && obj.choices[0]) || {};
          if (choice.finish_reason) finishReason = String(choice.finish_reason);
          const delta = (choice.delta && choice.delta.content) || '';
          if (delta) { full += delta; if (onDelta) onDelta(delta); }
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (meta) { meta.finishReason = finishReason; meta.length = full.length; meta.streamed = true; }
    if (!full.trim()) throw new Error('模型没有返回内容，请重试');
    return full;
  }



  /**
   * 视觉调用：一张图片 + 一段提示词 → 文本。
   *
   * 与 callLLM 的区别只有消息体形态：user 的 content 是一个数组
   * （`[{type:'text'}, {type:'image_url', image_url:{url:dataURI}}]`），这是 OpenAI 兼容接口的标准写法。
   *
   * ⚠️ 模型必须是**支持视觉**的（如 deepseek-flash）。用普通文本模型会被接口拒绝 ——
   * 那种情况下我们给出可操作的提示（"把识别模型换成支持图片的"），而不是把英文报错甩给用户。
   */
  async function callVision({ baseUrl, model, apiKey, prompt, imageDataUrl, maxTokens = 6000, timeoutMs = 180000 }) {
    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const r = await postChat({
      url, headers, withFormat: false, timeoutMs,
      body: {
        model,
        messages: [
          { role: 'system', content: '你是严谨的 OCR 助手：只输出要求格式的内容，不加任何解释。' },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        temperature: 0.1,
        // 实测：这个模型会先输出一段 reasoning_content 再给正文，
        // 额度给少了会出现"只有思考、content 为空"。整页 50 个词 ≈ 800 token 正文，
        // 留足余量给思考过程（6000 对单页照片足够，也不至于失控）。
        max_tokens: maxTokens,
      },
    });
    const text = await r.text();
    if (!r.ok) {
      const low = text.toLowerCase();
      // 模型/接口不认图片 —— 这是**配置问题**，要给可操作的提示，而不是甩英文报错
      if ((r.status === 400 || r.status === 404) && (low.includes('image') || low.includes('modal') || low.includes('vision') || low.includes('not found'))) {
        const err = new Error('这个模型不支持图片识别。DeepSeek 的 deepseek-flash 原生多模态，可以直接用它 —— 在「AI 设置 → 识别模型」里填 deepseek-flash（或让服务端配 AI_VISION_MODEL=deepseek-flash）。');
        err.visionUnsupported = true;
        throw err;
      }
      throw new Error('识别接口错误 ' + r.status + ': ' + text.slice(0, 300));
    }
    const data = JSON.parse(text);
    const choice = (data && data.choices && data.choices[0]) || {};
    const content = choice.message && choice.message.content;
    const finish = String(choice.finish_reason || '');
    // 被截断：多半是整页太多词 + 思考过程吃掉了额度 —— 让用户分两张拍，比反复重试有用
    if (!content && finish === 'length') {
      throw new Error('识别结果被截断了（这张图里的词太多或思考过长）。建议分成两张拍，或只拍词表那一部分。');
    }
    // content 空但模型返回了 model 名 → 有些兼容接口把内容放在别处；给出实际模型名便于排查
    if (!content) {
      throw new Error('模型没有返回识别内容' + (data && data.model ? '（实际调用的是 ' + data.model + '）' : '') + '，请重试');
    }
    return { text: content, model: (data && data.model) || model, finishReason: finish };
  }


  return {
    // stat：模型/地址的取值口（路由里到处在用，保持原样暴露）
    stat,
    model: stat.model, baseUrl: stat.baseUrl, hasKey: stat.hasKey, envKey,
    normalizeApiKey, warnDirty, isSafeBaseUrl, resolveEndpoint,
    postChat, parseJsonLoose, callLLM, callLLMStream, callVision,
    hasEnvKey: () => Boolean(envKey()), allowServerKey,
  };
}
