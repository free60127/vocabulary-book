import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  loadBooks, loadDays, loadDeletedBooks, loadDeletedEntries, loadHistory,
  loadDeletedFavorites, loadFavorites, loadKilled, loadRevived, loadSchedule, loadWrong,
  localSnapshot, makeHistoryItem, mergeSnapshot, pushHistory, saveBooks, saveDays,
  saveDeletedBooks, saveDeletedEntries, saveFavorites, saveDeletedFavorites, saveHistory,
  loadDeletedSentences, loadSentences, saveDeletedSentences, saveKilled, saveLastExportAt,
  saveRevived, saveSchedule, saveSentences, saveWrong,
} from '../storage.js';
import {
  allEntries, createBook, entryTombstoneKey, removeBook, removeEntry, renameBook,
  summarizeBooks, upsertEntry,
} from '../wordbook.js';
import {
  addStudyDay, addWrong, buildReviewQueue, buildTodayQueue, buildWrongQueue, clearWrong, dayKey,
  headKey, scheduleOf, sm2Review, summarizeStreak, wrongList,
} from '../review.js';
import { addFavorite, attachEntryToFavorite, backfillFavoritesFromEntry, findFavorite, removeFavorite } from '../favorites.js';
import { TIP_LONG_MS, TIP_NORMAL_MS } from '../constants.js';

/**
 * 本机数据层：单词本 / 复习排期 / 学习天数 / 历史 / 收藏夹。
 *
 * 为什么从 App.jsx 里抽出来：这一层有 8 份 state、6 个持久化入口、十几个写操作，
 * 混在界面代码里之后，"改哪一处会动到哪份数据"要靠通读 1200 行才能答上来。
 * 抽出来以后界面只剩编排，数据规则集中在这里（也更容易对着测试看）。
 *
 * 约定：
 *  · 所有读写都经 storage.js 的 safeGet/safeSet —— 无痕模式下不能白屏；
 *  · 删除一律留墓碑（云同步是并集合并，不留墓碑 = 删了又回来）；
 *  · 写操作都返回结果给调用方，提示文案由调用方决定（数据层不猜用户看到什么）。
 */
export function useBooks({ flash }) {
  const [books, setBooks] = useState(loadBooks);
  const [schedule, setSchedule] = useState(loadSchedule);
  const [days, setDays] = useState(loadDays);
  const [history, setHistory] = useState(loadHistory);
  const [favorites, setFavorites] = useState(loadFavorites);
  const [deletedFavorites, setDeletedFavorites] = useState(loadDeletedFavorites);
  const [deletedBooks, setDeletedBooks] = useState(loadDeletedBooks);
  const [deletedEntries, setDeletedEntries] = useState(loadDeletedEntries);
  /** 已斩掉的词（{词头: 时间戳}）与"复活"记录 —— 两个都要留着才能正确合并，见 review.js */
  const [killed, setKilled] = useState(loadKilled);
  const [revived, setRevived] = useState(loadRevived);
  /** 错词本：复习里"没答上来"的词，答对一次就出本 */
  const [wrong, setWrong] = useState(loadWrong);
  /* 错句本：自己收藏的造句练习（含批改结果），跟着云同步走 */
  const [sentences, setSentences] = useState(loadSentences);
  const [deletedSentences, setDeletedSentences] = useState(loadDeletedSentences);
  const persistSentences = useCallback((next) => { setSentences(next); saveSentences(next); }, []);
  const persistDeletedSentences = useCallback((next) => { setDeletedSentences(next); saveDeletedSentences(next); }, []);

  /* ---------- 落盘 ---------- */
  const persistBooks = useCallback((next) => { setBooks(next); saveBooks(next); }, []);
  const persistSchedule = useCallback((next) => { setSchedule(next); saveSchedule(next); }, []);
  const persistFavorites = useCallback((next) => { setFavorites(next); saveFavorites(next); }, []);
  const persistDays = useCallback((next) => { setDays(next); saveDays(next); }, []);
  const persistHistory = useCallback((next) => { setHistory(next); saveHistory(next); }, []);
  const persistDeletedBooks = useCallback((next) => { setDeletedBooks(next); saveDeletedBooks(next); }, []);
  const persistDeletedEntries = useCallback((next) => { setDeletedEntries(next); saveDeletedEntries(next); }, []);
  const persistDeletedFavorites = useCallback((next) => { setDeletedFavorites(next); saveDeletedFavorites(next); }, []);
  const persistKilled = useCallback((next) => { setKilled(next); saveKilled(next); }, []);
  const persistRevived = useCallback((next) => { setRevived(next); saveRevived(next); }, []);
  const persistWrong = useCallback((next) => { setWrong(next); saveWrong(next); }, []);
  const markStudied = useCallback(() => setDays((d) => { const n = addStudyDay(d); saveDays(n); return n; }), []);

  /* ---------- 派生 ---------- */
  const entries = useMemo(() => allEntries(books), [books]);
  const stats = useMemo(() => summarizeBooks(books), [books]);
  const streak = useMemo(() => summarizeStreak(days), [days]);
  /**
   * "今天是哪天"是会变的：页面可能整夜开着（手机加到主屏后更是长期驻留）。
   * 这里每 30 秒对一次本地日期，跨过 00:00 就让它变一次 → 下面的 due 重算。
   * 用户的原话："这个我昨天晚上复习的，今天早上没刷新" —— 不刷新也该是新的一天。
   */
  const [today, setToday] = useState(() => dayKey(Date.now()));
  useEffect(() => {
    const check = () => {
      const k = dayKey(Date.now());
      setToday((prev) => (prev === k ? prev : k));
    };
    const timer = setInterval(check, 30_000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, []);

  /**
   * 另一个标签页改了本机数据 → 跟着刷新。
   *
   * 审计发现的真实场景：同一个浏览器开两个标签页（很常见：一个查词一个复习），
   * 在 A 里加了词条，B 的界面不会变 —— 因为 localStorage 的改动不会跨标签页通知 React 状态。
   * `storage` 事件只在**其它**标签页触发（正是我们要的），收到就整份重读。
   */
  useEffect(() => {
    const onStorage = (e) => {
      if (!e.key || !e.key.startsWith('vb-')) return;
      // 只重读这几个"另一个标签页可能改了"的集合；重读是幂等的，也不会回写
      setBooks(loadBooks());
      setSchedule(loadSchedule());
      setDays(loadDays());
      setHistory(loadHistory());
      setFavorites(loadFavorites());
      setKilled(loadKilled());
      setRevived(loadRevived());
      setWrong(loadWrong());
      setSentences(loadSentences());
      setDeletedBooks(loadDeletedBooks());
      setDeletedEntries(loadDeletedEntries());
      setDeletedFavorites(loadDeletedFavorites());
      setDeletedSentences(loadDeletedSentences());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  /* 今日待复习 = 本子里到期的词条 + 收藏夹里还没收进本子的词（斩掉的除外） */
  const due = useMemo(
    () => buildReviewQueue({ entries, favorites, schedule, killed, revived }),
    // today 只是"跨天"的信号：它变了就重算（届时 now 已经是新的一天）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, favorites, schedule, killed, revived, today],
  );
  /* 今天碰过的词（复习过的 + 新加的 + 收藏的）：复习完之后还能再进去练一遍 */
  const todayQueue = useMemo(
    () => buildTodayQueue({ entries, favorites, schedule, killed, revived }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, favorites, schedule, killed, revived, today],
  );
  /** 错词本清单（带释义与"还在不在本子里"），给界面和"只练错词"用 */
  const wrongItems = useMemo(() => wrongList(wrong, entries, favorites), [wrong, entries, favorites]);
  /**
   * 本机快照（云同步 / 备份导出的事实源）。
   *
   * ⚠️ 这里**必须把每一个本机数据集都列全**。localSnapshot 对没传的字段一律给空数组，
   * 而 applyMerged 又用 `merged.x || []` 写回本机 —— 只要漏一个字段，
   * 就会出现"本机有数据 → 快照里是空 → 合并回来还是空 → 写回把本机清空"的静默数据销毁。
   * 错句本（sentences）就是这么被漏掉的：函数签名支持它、storage.js 也存它，
   * 只有这个真实调用点没传，于是**每一次同步成功都会清空本机的错句本**（含批改结果，不可恢复）。
   * 新增本机数据集时，请同步检查：① 这里传了没 ② applyMerged 有没有兜底 ③ sync.js 推不推。
   */
  const local = useMemo(
    () => localSnapshot({ books, schedule, days, history, favorites, deletedBooks, deletedEntries, deletedFavorites, killed, revived, wrong, sentences, deletedSentences }),
    [books, schedule, days, history, favorites, deletedBooks, deletedEntries, deletedFavorites, killed, revived, wrong, sentences, deletedSentences],
  );

  /* ---------- 词条增删改 ---------- */
  /**
   * 把一个词条放进指定本子。
   * base 必须能显式传入：`books` 是本次渲染的闭包快照，新建本子后紧接着存词条时，
   * 新本子并不在 `books` 里 —— 沿用闭包会把刚建好的本子连同词条一起抹掉。
   * @returns {{list: Array, replaced: boolean, bookName: string, entry: object}}
   */
  const saveEntry = useCallback((bookId, entry, base) => {
    const from = Array.isArray(base) ? base : books;
    const { list, replaced } = upsertEntry(from, bookId, entry);
    persistBooks(list);
    // 新词条给一个"立刻到期"的排期，这样它当天就能进复习队列
    if (!replaced) persistSchedule({ ...schedule, [entry.id]: scheduleOf(schedule, entry.id, entry.createdAt) });
    const book = list.find((b) => b.id === bookId);
    return { list, replaced, bookName: book ? book.name : '', entry };
  }, [books, schedule, persistBooks, persistSchedule]);

  /**
   * 批量导入（拍照识别的词）。
   *
   * 只建**轻量词条**：词头 + 中文释义，不调用模型讲解 ——
   * 一页 30 个词要是逐个生成讲解，等于 30 次模型调用、用户要等半小时。
   * 想细看时点那个词即可走正常查词流程（服务端会按词头合并，不会重复入库）。
   *
   * 去重分两层：本批次内部（识别可能重复）、与已有词条（`upsertEntry` 按词头判重）。
   */
  const importEntries = useCallback((bookId, items) => {
    const list = Array.isArray(items) ? items : [];
    let booksNext = books;
    let scheduleNext = { ...schedule };
    let added = 0;
    let updated = 0;
    const seen = new Set();
    for (const raw of list) {
      const head = String((raw && raw.head) || '').trim();
      if (!head) continue;
      const key = head.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = {
        id: 'wb-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4),
        head,
        kind: 'word',
        brief: String((raw && raw.brief) || '').trim(),
        meanings: raw && raw.brief ? [{ pos: '', cn: String(raw.brief).trim(), en: '', note: '' }] : [],
        importedFrom: 'image',
        createdAt: Date.now(),
      };
      const res = upsertEntry(booksNext, bookId, entry);
      booksNext = res.list;
      if (res.replaced) updated += 1;
      else {
        added += 1;
        scheduleNext = { ...scheduleNext, [entry.id]: scheduleOf(scheduleNext, entry.id, entry.createdAt) };
      }
    }
    if (booksNext !== books) persistBooks(booksNext);
    persistSchedule(scheduleNext);
    const book = booksNext.find((b) => b.id === bookId);
    return { added, updated, bookName: book ? book.name : '' };
  }, [books, schedule, persistBooks, persistSchedule]);

  const newBook = useCallback((name) => {
    const list = createBook(books, name);
    persistBooks(list);
    return { list, id: list[list.length - 1].id };
  }, [books, persistBooks]);

  const deleteEntry = useCallback((bookId, entry) => {
    persistBooks(removeEntry(books, bookId, entry.id));
    persistDeletedEntries([...deletedEntries, entryTombstoneKey(bookId, entry.id)]);
    const nextSchedule = { ...schedule };
    delete nextSchedule[entry.id];
    persistSchedule(nextSchedule);
  }, [books, deletedEntries, schedule, persistBooks, persistDeletedEntries, persistSchedule]);

  const deleteBook = useCallback((book) => {
    persistBooks(removeBook(books, book.id));
    persistDeletedBooks([...deletedBooks, book.id]);
  }, [books, deletedBooks, persistBooks, persistDeletedBooks]);

  /** 改名：跨设备会跟着同步（id 不变，所以别的设备不会看成"删一个建一个"） */
  const renameBookById = useCallback((bookId, name) => {
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) return false;
    persistBooks(renameBook(books, bookId, { name: clean }));
    return true;
  }, [books, persistBooks]);

  /**
   * 合并两个本子：把 from 的词条并进 to，然后把 from 删掉（留墓碑）。
   *
   * 为什么不只是"移过去就完"：被合并掉的那个本子**必须留墓碑**，
   * 否则下一次云同步会把它从云端旧副本里带回来 —— 用户看到的就是"合并完又冒出两个本子"。
   * 同词头的词条由 upsertEntry 就地覆盖（保留各自 id，复习进度不丢）。
   */
  const mergeBooksInto = useCallback((fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return { moved: 0, skipped: 0 };
    const from = books.find((b) => b.id === fromId);
    const to = books.find((b) => b.id === toId);
    if (!from || !to) return { moved: 0, skipped: 0 };
    let list = books;
    let moved = 0;
    let skipped = 0;
    for (const e of from.entries || []) {
      const before = (list.find((b) => b.id === toId) || {}).entries || [];
      const sameHead = before.some((x) => x.id === e.id);
      const r = upsertEntry(list, toId, e);
      list = r.list;
      if (sameHead) skipped += 1; else moved += 1;
    }
    list = removeBook(list, fromId);
    persistBooks(list);
    persistDeletedBooks([...deletedBooks, fromId]);
    return { moved, skipped };
  }, [books, deletedBooks, persistBooks, persistDeletedBooks]);

  /* ---------- 历史 / 收藏 ---------- */
  const pushHistoryEntry = useCallback((entry) => {
    const next = pushHistory(history, makeHistoryItem(entry));
    persistHistory(next);
    return next;
  }, [history, persistHistory]);
  const clearHistory = useCallback(() => persistHistory([]), [persistHistory]);

  /** 查完这个词之后，把完整词条挂到收藏夹里对应的那条上（下次可一步加入词库） */
  const attachFavoriteEntry = useCallback((entry) => {
    setFavorites((list) => {
      const next = attachEntryToFavorite(list, entry);
      if (next !== list) saveFavorites(next);
      return next;
    });
  }, []);

  const isFavorite = useCallback((head) => Boolean(findFavorite(favorites, head)), [favorites]);
  const favoriteOf = useCallback((head) => findFavorite(favorites, head), [favorites]);

  const toggleFavorite = useCallback((syn, fromEntry) => {
    const head = String((syn && syn.word) || '').trim();
    if (!head) return null;
    const existing = findFavorite(favorites, head);
    if (existing) {
      persistFavorites(removeFavorite(favorites, existing.id));
      persistDeletedFavorites([...deletedFavorites, existing.id]);
      flash('已取消收藏：' + head, TIP_NORMAL_MS);
      return { added: false, head };
    }
    const added = addFavorite(favorites, {
      head,
      brief: (syn && syn.cn) || '',
      phonetic: (syn && syn.phonetic) || '',
      register: (syn && syn.register) || '',
      tone: (syn && syn.tone) || '',
      strength: (syn && syn.strength) || '',
      from: (fromEntry && fromEntry.head) || '',
      // 辨析信息一起存（它只存在于主词那张卡片上，不存就永久丢了）
      diff: (syn && syn.diff) || '',
      usage: (syn && syn.usage) || '',
      example: (syn && syn.example) || '',
      exampleCn: (syn && syn.exampleCn) || '',
    });
    persistFavorites(added);
    // 收藏的词**当天就进复习队列**（"回头细看"不能只是躺在侧栏里）
    const fav = added.find((f) => f && headKey(f.head) === headKey(head));
    if (fav && !schedule[fav.id]) persistSchedule({ ...schedule, [fav.id]: scheduleOf(schedule, fav.id, Date.now()) });
    flash('已收藏「' + head + '」—— 在左侧收藏夹里可以点它查详细讲解，或直接加进单词本', TIP_LONG_MS);
    return { added: true, head };
  }, [favorites, deletedFavorites, schedule, persistFavorites, persistDeletedFavorites, persistSchedule, flash]);

  /**
   * 用刚查到的词条回填收藏的辨析信息（差别 / 用法 / 例句）。
   * 老收藏（2026-09-17 之前收的）没存过这些字段，靠"再看一眼源词"自动补齐。
   */
  /** 按词头取实时收藏对象（复习卡要用它，而不是队列里那份快照 —— 补齐后卡片要立刻变） */
  const getFavorite = useCallback((head) => findFavorite(favorites, head), [favorites]);

  const backfillFavorites = useCallback((entry) => {
    const res = backfillFavoritesFromEntry(favorites, entry);
    if (res.changed) persistFavorites(res.list);
    // 回**具体补了哪些字段**：调用方要靠它决定怎么跟用户说话
    // （踩过：只看 changed 就报"已补上差别和例句"，其实补的是音标，界面上什么都没变）
    return { changed: res.changed, fields: res.fields || [] };
  }, [favorites, persistFavorites]);

  const removeFavoriteById = useCallback((fav) => {
    persistFavorites(removeFavorite(favorites, fav.id));
    persistDeletedFavorites([...deletedFavorites, fav.id]);
    flash('已从收藏夹移除：' + fav.head, TIP_NORMAL_MS);
  }, [favorites, deletedFavorites, persistFavorites, persistDeletedFavorites, flash]);

  /* ---------- 斩掉（不再复习） ----------
   * 存的是**词头**而不是词条 id：同一个词重新查一次会拿到新的 id，
   * 按 id 存的话"斩掉又查了一遍"就把它放回队列了（用户的原话是"以后别再问我"）。
   * 复活同理记一条时间戳，同步时按"谁更晚"决定胜负。 */
  const killWord = useCallback((item) => {
    const key = headKey(item && (item.head || item));
    if (!key) return;
    persistKilled({ ...killed, [key]: Date.now() });
    const nextSchedule = { ...schedule };
    if (item && item.key) delete nextSchedule[item.key];
    if (item && item.entry && item.entry.id) delete nextSchedule[item.entry.id];
    if (item && item.favorite && item.favorite.id) delete nextSchedule[item.favorite.id];
    persistSchedule(nextSchedule);
  }, [killed, schedule, persistKilled, persistSchedule]);

  const reviveWord = useCallback((head) => {
    const key = headKey(head);
    if (!key) return;
    persistRevived({ ...revived, [key]: Date.now() });
  }, [revived, persistRevived]);

  /* ---------- 错词本 ----------
   * 进本：评「忘了」、拼写出错、拼写提示点满（看过答案）；
   * 出本：评「简单」或一次拼对 —— 说明这个坎过去了。
   * 出本必须也走"写回"，否则错词本只会越攒越多，最后没人看。 */
  const markWrong = useCallback((item, reason = 'forgot') => {
    const head = (item && (item.head || item)) || '';
    if (!head) return;
    const entry = item && item.entry;
    persistWrong(addWrong(wrong, head, reason, {
      brief: (item && item.brief) || (entry && ((entry.meanings && entry.meanings[0] && entry.meanings[0].cn) || entry.brief)) || '',
      phonetic: (item && item.phonetic) || (entry && entry.phonetic) || '',
    }));
  }, [wrong, persistWrong]);

  const clearWrongWord = useCallback((head) => {
    const key = headKey(head);
    if (!wrong || !wrong[key]) return;
    persistWrong(clearWrong(wrong, head));
  }, [wrong, persistWrong]);

  /** 只练错词（不动排期，练完仍然按用户的表现决定进出本） */
  const wrongQueue = useCallback(() => buildWrongQueue({
    wrong, entries, favorites, schedule, killed, revived,
  }), [wrong, entries, favorites, schedule, killed, revived]);

  /* ---------- 复习 ---------- */
  /** 记一次评分。返回是否还有下一张（队列推进由界面决定）。 */
  const gradeEntry = useCallback((item, grade) => {
    const id = item && (item.key || item.id);
    if (!id) return;
    const createdAt = (item && ((item.entry && item.entry.createdAt) || (item.favorite && item.favorite.at))) || 0;
    persistSchedule({ ...schedule, [id]: sm2Review(scheduleOf(schedule, id, createdAt), grade) });
    markStudied();
  }, [schedule, persistSchedule, markStudied]);

  /* ---------- 合并写回（云同步 / 导入备份共用） ---------- */
  /* ---------- 错句本 ---------- */
  const addSentence = useCallback((rec) => {
    if (!rec || !rec.head || !rec.sentence) return null
    // 同一条句子（同一个词 + 同一句）只留一份，重复收藏就更新批改结果
    const id = 'st-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const item = {
      id,
      head: rec.head,
      phonetic: rec.phonetic || '',
      meaning: rec.meaning || '',
      mode: rec.mode || 'free',
      cn: rec.cn || '',
      sentence: rec.sentence,
      score: Number(rec.score) || 0,
      verdict: rec.verdict || '',
      corrected: rec.corrected || '',
      suggestion: rec.suggestion || '',
      problems: Array.isArray(rec.problems) ? rec.problems : [],
      difficulty: rec.difficulty || '',
      at: Date.now(),
    }
    const same = sentences.find((x) => headKey(x.head) === headKey(item.head) && x.sentence === item.sentence)
    const next = same ? sentences.map((x) => (x.id === same.id ? { ...x, ...item, id: x.id, at: x.at } : x)) : [item, ...sentences]
    persistSentences(next.slice(0, 1000))
    flash(same ? '这条句子已在错句本里，已更新批改结果' : '已收进错句本', TIP_NORMAL_MS)
    return same ? same.id : id
  }, [sentences, persistSentences, flash])

  const deleteSentence = useCallback((id) => {
    persistSentences(sentences.filter((x) => x.id !== id))
    persistDeletedSentences([...deletedSentences, id].slice(-2000))
    flash('已从错句本移除', TIP_NORMAL_MS)
  }, [sentences, deletedSentences, persistSentences, persistDeletedSentences, flash])

  /**
   * 把"合并结果"写回本机。
   *
   * ⚠️ 字段**不在合并结果里**时（undefined）必须保留本机现状，不能当空数组写回。
   * 云端快照是白名单重建的（server/sync.mjs），本机没推上去的字段（错句本、斩掉、错词本）
   * 在 remote 里永远是 undefined；一旦这里用 `|| []` 兜底，就等于"每次同步清空一次本机"。
   * 只有明确拿到数组/对象时才覆盖。
   */
  const applyMerged = useCallback((merged) => {
    persistBooks(merged.books); persistSchedule(merged.review);
    persistFavorites(merged.favorites || []);
    persistDays(merged.days); persistHistory(merged.history);
    persistDeletedBooks(merged.deletedBooks); persistDeletedEntries(merged.deletedEntries);
    persistDeletedFavorites(merged.deletedFavorites || []);
    if (Array.isArray(merged.sentences)) persistSentences(merged.sentences);
    if (Array.isArray(merged.deletedSentences)) persistDeletedSentences(merged.deletedSentences);
    persistKilled(merged.killed || {}); persistRevived(merged.revived || {});
    persistWrong(merged.wrong || {});
  }, [persistBooks, persistSchedule, persistFavorites, persistDays, persistHistory, persistDeletedBooks, persistDeletedEntries, persistDeletedFavorites, persistSentences, persistDeletedSentences, persistKilled, persistRevived, persistWrong]);

  const exportBackup = useCallback(() => {
    const payload = { app: 'vocabulary-book', version: 1, exportedAt: new Date().toISOString(), ...local };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vocabulary-book-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    saveLastExportAt(Date.now());
    flash('已导出备份文件', TIP_LONG_MS);
  }, [local, flash]);

  const importBackup = useCallback(async (file) => {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object') throw new Error('文件格式不正确');
    if (!Array.isArray(data.books) && !Array.isArray(data.history)) throw new Error('这个文件里没有可导入的单词本数据');
    const merged = mergeSnapshot(local, data);
    applyMerged(merged);
    flash(`导入完成：新增 ${merged.added.booksAdded} 个单词本、${merged.added.entriesAdded} 个词条`
      + (merged.favorites && merged.favorites.length ? `、收藏夹共 ${merged.favorites.length} 条` : ''), TIP_LONG_MS);
    return merged;
  }, [local, applyMerged, flash]);

  return {
    // 数据
    books, schedule, days, history, favorites, deletedBooks, deletedEntries, deletedFavorites,
    killed, revived, wrong, sentences, deletedSentences,
    addSentence, deleteSentence,
    entries, stats, streak, due, todayQueue, local,
    // 落盘
    persistBooks, persistSchedule, persistFavorites, persistDays, persistHistory,
    persistDeletedBooks, persistDeletedEntries, persistDeletedFavorites, markStudied, applyMerged,
    // 词条 / 本子
    saveEntry, importEntries, newBook, deleteEntry, deleteBook, renameBook: renameBookById, mergeBooksInto,
    // 历史 / 收藏
    pushHistoryEntry, clearHistory, attachFavoriteEntry, isFavorite, favoriteOf,
    toggleFavorite, removeFavoriteById, backfillFavorites, getFavorite,
    // 复习 / 斩掉
    gradeEntry, killWord, reviveWord,
    // 错词本（wrong 本身在上面「数据」一节已经导出）
    wrongItems, markWrong, clearWrongWord, wrongQueue,
    // 备份
    exportBackup, importBackup,
  };
}
