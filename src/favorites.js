/**
 * 收藏夹：把"在别人的近义词里看到、想回头再细看"的词先攒起来。
 *
 * 为什么单独存一层、而不是直接塞进单词本：
 *  · 近义词那一行只有**一行的信息**（释义、差别、一个例句），凑不出一张完整词条 ——
 *    直接塞进本子会得到一堆半成品卡片，反而把本子搞脏；
 *  · 收藏是"待办"性质：先标记，回头点一下就有完整讲解；那时候再加入本子才有意义。
 * 所以收藏项 = 词头 + 已知的一点上下文，**完整词条（entry）等查过之后再补上**，
 * 补上之后「加入词库」就能一步完成（缺 entry 时先查再存）。
 *
 * 与其它数据一致：删除留墓碑（云同步是并集合并，不留墓碑就会"删了又出现"）。
 */

/** 收藏项的稳定 id：按词头归一化，同一个词不会因为从不同词条收藏而出现两条 */
export const favoriteId = (head) => 'fav-' + String(head || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 50);

const S = (v, max) => String(v == null ? '' : v).slice(0, max);
/** 词头比较：大小写与首尾空格不敏感（"Grudge" 和 "grudge" 是同一个词） */
const headKey = (v) => S(v, 200).trim().toLowerCase();

/**
 * 规整一条收藏（导入/同步回来的同样不可信）。
 * 词头同时接受 `head` 与 `word`：调用方手上最自然的对象是**近义词那一行**（字段名是 `word`），
 * 只认 `head` 的话，谁直接把它传进来就会静默得到一条空收藏（测试里就踩了一次）。
 */
export function sanitizeFavorite(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const head = S(raw.head || raw.word, 200).trim();
  if (!head) return null;
  return {
    id: S(raw.id, 64) || favoriteId(head),
    head,
    brief: S(raw.brief, 600),
    phonetic: S(raw.phonetic, 120),
    register: S(raw.register, 60),
    tone: S(raw.tone, 60),
    strength: S(raw.strength, 60),
    // 从哪个词条里收藏的 —— 回头能想起来"当时是在看 enshrine 时看到的"
    from: S(raw.from, 200),
    /**
     * 「它与主词的关键差别」等在收藏那一刻就拿得到的辨析信息。
     *
     * 为什么必须存下来：这些字段只存在于**别人那张卡片**里（收藏 bespoke 时，
     * "bespoke 与 ad hoc 的差别"写在 ad hoc 的卡片上）。不存的话，
     * 复习到这条收藏时就只剩一个孤立释义，用户最需要的"什么时候用哪个"反而没了。
     */
    diff: S(raw.diff, 600),
    /**
     * 「它自己的近义词对比」里那一条（`ownDiffWord` 是比的对象）。
     * 与 `diff` 的区别：`diff` 说的是"本词相对收藏来源词"的差别（来自**别人**的卡片）；
     * `ownDiff` 来自**本词自己的卡片** —— 很多老收藏没有 `from`，只能靠这一条。
     */
    ownDiff: S(raw.ownDiff, 600),
    ownDiffWord: S(raw.ownDiffWord, 80),
    usage: S(raw.usage, 600),
    example: S(raw.example, 600),
    exampleCn: S(raw.exampleCn, 600),
    at: Number(raw.at) || Date.now(),
    // 查过之后把完整词条挂上来（加入词库时要用）
    entry: raw.entry && typeof raw.entry === 'object' ? raw.entry : undefined,
  };
}

export const loadFavorites = (list) => (Array.isArray(list) ? list : []).map(sanitizeFavorite).filter(Boolean);

/**
 * 加一条收藏；已存在则只更新上下文。
 * 两处刻意"保留旧的"：
 *  · `entry`：查过的完整词条不能被后一次收藏冲掉；
 *  · `head`：同一个词第二次收藏时写法可能不同（`CONSECRATE` / `consecrate`），
 *    跟着变会让列表里的词名莫名其妙改样子 —— 以第一次收藏的写法为准。
 */
export function addFavorite(list, raw) {
  const clean = sanitizeFavorite(raw);
  if (!clean) return Array.isArray(list) ? list : [];
  const prev = (list || []).find((f) => f && f.id === clean.id);
  const merged = prev
    ? { ...prev, ...clean, head: prev.head, entry: clean.entry || prev.entry, at: Date.now() }
    : clean;
  return [merged, ...(list || []).filter((f) => f && f.id !== clean.id)].slice(0, 500);
}

export function removeFavorite(list, id) {
  return (list || []).filter((f) => f && f.id !== id);
}

export const findFavorite = (list, head) => (list || []).find((f) => f && f.id === favoriteId(head)) || null;

/** 查完一个词条后，把结果补进对应的收藏项（没收藏过就原样返回） */
export function attachEntryToFavorite(list, entry) {
  if (!entry || !entry.head) return Array.isArray(list) ? list : [];
  const id = favoriteId(entry.head);
  let hit = false;
  const next = (list || []).map((f) => {
    if (!f || f.id !== id) return f;
    hit = true;
    return { ...f, entry };
  });
  return hit ? next : list;
}

/**
 * 用刚查到的词条**回填收藏的辨析信息**。
 *
 * 两种回填，都在"用户刚好看到那张卡片"时顺手做掉，不花额外的钱：
 *  ① 看的是**源词**（收藏时的主词，`favorite.from`）：它的近义词列表里就有这条收藏的 `diff/usage/例句`
 *     —— 这正是当初收藏时该存下来的东西；
 *  ② 看的是**收藏词自己**：它自己的例句可以补上（收藏时可能没有，或模型当时没给）。
 *
 * 为什么需要这个：2026-09-17 之前收藏的词**没有存过** diff/例句（那时没这个字段），
 * 光靠改代码补不回来 —— 但只要用户再看一眼源词，数据就自动补齐了。
 *
 * @returns {{list:Array, changed:boolean}}
 */
export function backfillFavoritesFromEntry(list, entry) {
  const src = Array.isArray(list) ? list : [];
  if (!entry || !entry.head) return { list: src, changed: false, fields: [] };
  const entryHead = headKey(entry.head);
  const syns = Array.isArray(entry.synonyms) ? entry.synonyms : [];
  const firstExample = Array.isArray(entry.examples) && entry.examples[0] ? entry.examples[0] : null;
  let changed = false;
  const fields = new Set();

  const next = src.map((f) => {
    if (!f || !f.head) return f;
    const patch = {};
    // ① 这条收藏当初是从 entry 上收的 → 在近义词里找它自己
    if (headKey(f.from) === entryHead) {
      const syn = syns.find((s) => s && headKey(s.word) === headKey(f.head));
      if (syn) {
        if (!f.diff && syn.diff) patch.diff = syn.diff;
        if (!f.usage && syn.usage) patch.usage = syn.usage;
        if (!f.example && syn.example) { patch.example = syn.example; patch.exampleCn = syn.exampleCn || ''; }
        if (!f.phonetic && syn.phonetic) patch.phonetic = syn.phonetic;
      }
    }
    // ② / ③ 看的就是收藏词自己：它自己的卡片里有例句与「近义词对比」
    if (headKey(f.head) === entryHead) {
      if (!f.example && firstExample && firstExample.en) {
        patch.example = firstExample.en;
        patch.exampleCn = firstExample.cn || '';
      }
      // 老收藏常常没有 from（不知道当初从哪收的），那就用它**自己的**近义词对比：
      // "它与 X 的差别"同样是复习时最需要的一行
      if (!f.diff && !f.ownDiff && syns.length && syns[0] && syns[0].diff) {
        patch.ownDiff = syns[0].diff;
        patch.ownDiffWord = syns[0].word || '';
      }
    }
    if (!Object.keys(patch).length) return f;
    changed = true;
    Object.keys(patch).forEach((k) => fields.add(k));
    return { ...f, ...patch };
  });
  return { list: changed ? next : src, changed, fields: [...fields] };
}

/** 收藏的并集合并：按 id 去重，新收藏在前；entry 谁有就用谁的（两个都有取更新的 at 那份） */
export function mergeFavorites(local, remote, limit = 500) {
  const best = new Map();
  for (const f of [...loadFavorites(local), ...loadFavorites(remote)]) {
    const prev = best.get(f.id);
    if (!prev) { best.set(f.id, f); continue; }
    const newer = (f.at || 0) >= (prev.at || 0) ? f : prev;
    best.set(f.id, { ...newer, entry: newer.entry || prev.entry || f.entry });
  }
  return [...best.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}
