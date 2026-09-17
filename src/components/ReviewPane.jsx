import React, { useEffect, useRef, useState } from 'react';
import { BookX, Check, Eye, Lightbulb, Skull, Sparkles, Volume2 } from 'lucide-react';
import { GRADES, GRADE_KEYS, checkSpelling, gradeHint, scheduleOf, spellHint } from '../review.js';
import { speak } from '../speak.js';

/** 键盘：1/2/3 = 忘了/一般/简单；空格或回车 = 翻面；Esc = 退出复习 */
const KEY_TO_GRADE = { 1: 'forgot', 2: 'normal', 3: 'easy' };
const HINT_MAX = 3;

/** 复习卡片上的内容：词条（本子里的）与收藏项字段不同，统一在这里取 */
/**
 * 把"队列项"整理成卡片要显示的字段。
 * `item.favorite` 是**进队列时的快照**；外面若给了 `favoriteOf`，用实时那份覆盖 ——
 * 否则「补上差别和例句」点完数据存进去了，卡片却还是旧的（实测踩过）。
 */
function cardOf(item, favoriteOf) {
  const e = item.entry || {};
  const live = favoriteOf ? favoriteOf(item.head || (item.favorite && item.favorite.head)) : null;
  const f = live || item.favorite || {};
  return {
    head: item.head || e.head || f.head || '',
    phonetic: item.phonetic || e.phonetic || f.phonetic || '',
    pos: e.pos || f.pos || '',
    register: e.register || f.register || '',
    tone: e.tone || f.tone || '',
    strength: e.strength || f.strength || '',
    meaning: (e.meanings && e.meanings[0] && e.meanings[0].cn) || e.brief || f.brief || item.brief || '',
    brief: e.brief || '',
    /**
     * 辨析信息（"什么时候用哪个"）—— 复习时最该看到的东西。
     *
     * 两种来源，方向不同，别搞混：
     *  · 词条里的：`e.synonyms[i].diff` 讲的是**近义词相对本词**的差别 → "与 {近义词} 的差别"
     *  · 收藏里的：`f.diff` 讲的是**本词相对主词**的差别（收藏 bespoke 时写的是"与 ad hoc 的差别"）
     *    → "与 {f.from} 的差别"
     * 以前只读第一种，于是"只收藏、还没收进单词本"的词翻面后只有一个孤立释义（用户反馈）。
     */
    diff: f.diff || (e.synonyms && e.synonyms[0] && e.synonyms[0].diff) || '',
    synWord: f.diff
      ? (f.from || '')
      : ((e.synonyms && e.synonyms[0] && e.synonyms[0].word) || ''),
    usage: f.usage || (e.synonyms && e.synonyms[0] && e.synonyms[0].usage) || '',
    example: (e.examples && e.examples[0])
      || (f.example ? { en: f.example, cn: f.exampleCn || '' } : null),
    fromFavorite: Boolean(item.favorite),
  };
}

/**
 * 复习面板（每日主循环）。
 *
 * 三块能力：
 *  ① **普通模式**：先回想 → 翻面 → 三档评分（键盘 1/2/3、手机左右滑动、点词头翻面）；
 *  ② **拼写模式**（可开关，选择记在本机）：给中文与音标，把单词**拼对**才放行；
 *     提示分三级（首字母 → 一半 → 整个答案），点到第 3 次就把答案摆出来并要求重打一遍 ——
 *     照着答案抄一遍也比直接跳过强（这一条是用户明确要的）。
 *  ③ **斩掉**：这个词我认识，以后别再进复习清单（可在「已斩掉的词」里恢复）。
 */
export default function ReviewPane({
  queue, index, revealed, schedule, mode, onSwitchMode, practice, practiceLabel, killedCount, wrongCount, mix,
  onReveal, onGrade, onKill, onRestartSpell, onExit, onManageKilled, onManageWrong,
  onSpellWrong, onFillFavorite, fillBusy, favoriteOf,
}) {
  // 模式在**进来之前**就定好了（见 ReviewSetup）：整轮要么复习、要么拼写，中途不玩花样。
  const spelling = mode === 'spell';
  const [answer, setAnswer] = useState('');
  const [hintLevel, setHintLevel] = useState(0);
  const [missCount, setMissCount] = useState(0);
  const [solved, setSolved] = useState(false);
  const inputRef = useRef(null);
  const touchStart = useRef(null);
  const item = queue[index];
  const done = !item;
  /* 完成页的文案用"刚刚那一轮是不是拼写轮"来定 */
  const spellingState = spelling;

  /* 换卡就清干净：输入框、提示级数、错误次数、上一张的"拼对了" */
  useEffect(() => {
    setAnswer(''); setHintLevel(0); setMissCount(0); setSolved(false);
    if (spelling && !done && inputRef.current) inputRef.current.focus();
  }, [index, spelling, done]);

  /* 键盘快捷键：拼写模式下不抢输入框的键（回车交给表单提交） */
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') { e.preventDefault(); onExit(); return; }
      if (spelling) return;                    // 拼写阶段只用输入框与按钮
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); onReveal(); return; }
      if (revealed && KEY_TO_GRADE[e.key]) { e.preventDefault(); onGrade(KEY_TO_GRADE[e.key]); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [revealed, spelling, onExit, onReveal, onGrade]);

  const onTouchStart = (e) => {
    const t = e.touches && e.touches[0];
    if (t) touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || spelling || !revealed) return;   // 拼写阶段左右滑动会把刚打的字滑没
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    onGrade(dx > 0 ? 'easy' : 'forgot');
  };

  /* ---------- 拼写检查 ---------- */
  const submitSpelling = (e) => {
    if (e) e.preventDefault();
    if (solved || !item) return;
    const c = cardOf(item, favoriteOf);
    if (!checkSpelling(answer, c.head)) {
      setMissCount((n) => n + 1);
      if (onSpellWrong) onSpellWrong(item, 'spell');   // 拼错就进错词本
      return;
    }
    setSolved(true);
    // 一次拼对 = 简单；用过提示 = 一般；提示点满（看过答案）= 忘了
    const grade = hintLevel >= HINT_MAX ? 'forgot' : hintLevel === 0 ? 'easy' : 'normal';
    setTimeout(() => onGrade(grade), 520);
  };
  const useHint = () => {
    const next = Math.min(HINT_MAX, hintLevel + 1);
    setHintLevel(next);
    if (next >= HINT_MAX) {
      // 第 3 次提示：把答案摆出来，并清空输入框要求重打一遍
      setAnswer('');
      if (onSpellWrong) onSpellWrong(item, 'reveal');   // "看了答案"也算没掌握
      if (inputRef.current) inputRef.current.focus();
    }
  };

  /* ---------- 一轮结束 ---------- */
  if (done) {
    return (
      <section className="editor">
        <div className="panel review-pane">
          <div className="panel-head"><h2>本轮完成</h2></div>
          <p className="review-done-line">
            这一轮复习了 <b>{queue.length}</b> 个词{practice ? '（' + (practiceLabel || (spellingState ? '拼写练习' : '练习')) + '）' : ''}。
            {practice ? '练习模式不改变复习排期。' : '下一次到期时会自动回到「今日待复习」。'}
          </p>
          <div className="review-done-actions">
            {/* 拼写阶段里"再来一遍"= 重新开始拼写；普通一轮完成时 = 进入拼写 */}
            <button className="primary-btn" onClick={onRestartSpell}>
              <Sparkles size={15} />{spellingState ? '再拼一轮这 ' + queue.length + ' 个词' : '用拼写再过一遍这 ' + queue.length + ' 个词'}
            </button>
            <button className="ghost-btn" onClick={onExit}>回到查词</button>
          </div>
          <p className="muted small review-killed-line">
            {wrongCount ? (
              <>
                错词本里现在有 <b>{wrongCount}</b> 个词。
                <button className="link-btn" onClick={onManageWrong}>打开错词本</button>
              </>
            ) : null}
            {killedCount ? (
              <>
                {wrongCount ? ' · ' : ''}已斩掉 {killedCount} 个词（不再进复习清单）。
                <button className="link-btn" onClick={onManageKilled}>管理</button>
              </>
            ) : null}
          </p>
        </div>
      </section>
    );
  }

  const c = cardOf(item, favoriteOf);
  const s = scheduleOf(schedule, item.key, 0);

  return (
    <section className="editor">
      <div className="panel review-pane">
        <div className="panel-head">
          <h2>复习 {index + 1} / {queue.length}{practice && practiceLabel ? ' · ' + practiceLabel : ''}</h2>
          {mix && (mix.fav > 0) ? (
            <span className="queue-mix muted small" title="今日待复习的构成：单词本里的到期词 + 收藏夹里还没收进本子的词">
              本子 {mix.book} · 收藏 {mix.fav}
            </span>
          ) : null}
          <div className="review-head-tools">
            <div className="mode-switch" role="group" aria-label="练习模式">
              <button className={'mode-chip' + (!spelling ? ' active' : '')}
                onClick={() => !spelling || onSwitchMode('review')} disabled={!spelling ? false : undefined}
                title="看词回想 → 翻面评分">复习</button>
              <button className={'mode-chip' + (spelling ? ' active' : '')}
                onClick={() => spelling || onSwitchMode('spell')}
                title="看中文释义拼出单词">拼写</button>
            </div>
            <button className="ghost-btn sm" onClick={onExit} title="Esc">退出复习</button>
          </div>
        </div>

        <div className={'review-word' + (!spelling && !revealed ? ' tappable' : '')}
          onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
          onClick={() => { if (!spelling && !revealed) onReveal(); }}>
          {/* 只有**真的在拼写**时才藏词头（不然就是抄）。
              ⚠️ 这里曾经用 spell（用户的勾选）判断 —— 于是刚勾上就变成中文释义，
              用户的原话是"一开拼写模式全变成中文？"。勾选只是预约，本轮照常显示词头。 */}
          {spelling
            ? <strong className="spell-question">{c.meaning || c.brief || '（这个词还没有释义）'}</strong>
            : <strong>{c.head}</strong>}
          {c.phonetic ? <span className="phonetic">{c.phonetic}</span> : null}
          <button className="icon-btn" title="朗读" aria-label="朗读"
            onClick={(e) => { e.stopPropagation(); speak(c.head); }}><Volume2 size={16} /></button>
        </div>
        <p className="muted small">
          {spelling
            ? '把对应的单词拼出来（拼对才进入下一个）'
            : `先回想它的意思与用法，再${revealed ? '评分' : '点一下这个词（或按空格）翻面核对'}`}
        </p>


        {spelling ? (
          <form className="spell-box" onSubmit={submitSpelling}>
            <div className="spell-input-row">
              <input ref={inputRef} className={'spell-input' + (missCount && !solved ? ' wrong' : '') + (solved ? ' ok' : '')}
                value={answer} onChange={(e) => setAnswer(e.target.value)}
                placeholder="在这里拼写这个单词" autoComplete="off" autoCapitalize="off" spellCheck={false}
                aria-label="拼写这个单词" disabled={solved} />
              <button className="primary-btn" type="submit" disabled={solved || !answer.trim()}>
                {solved ? <Check size={16} /> : null}{solved ? '拼对了' : '检查'}
              </button>
            </div>
            <div className="spell-help">
              <button type="button" className="ghost-btn sm" onClick={useHint} disabled={hintLevel >= HINT_MAX || solved}>
                <Lightbulb size={14} />提示 {hintLevel}/{HINT_MAX}
              </button>
              {hintLevel > 0 ? <code className="spell-hint">{spellHint(c.head, hintLevel)}</code> : null}
              {hintLevel >= HINT_MAX && !solved ? <span className="warn-text small">答案已给出 —— 照着重打一遍才能继续</span> : null}
              {missCount > 0 && !solved ? <span className="spell-wrong small">不对，再试试（已错 {missCount} 次）</span> : null}
            </div>
          </form>
        ) : revealed ? (
          <div className="review-answer" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
            <div className="chips">
              {c.pos ? <span className="chip">{c.pos}</span> : null}
              {c.register ? <span className="chip">{c.register}</span> : null}
              {c.tone ? <span className="chip">{c.tone}</span> : null}
              {c.strength ? <span className="chip">强度 {c.strength}</span> : null}
            </div>
            <p><strong>{c.meaning}</strong></p>
            {c.brief ? <p className="muted">{c.brief}</p> : null}
            {c.diff ? (
              <p className="muted small review-diff">
                与 <b>{c.synWord || '近义词'}</b> 的差别：{c.diff}
              </p>
            ) : null}
            {c.usage ? <p className="muted small">什么时候用哪个：{c.usage}</p> : null}
            {c.example ? (
              <div className="example-line">
                <em>{c.example.en}</em>
                <button className="icon-btn" title="朗读例句" aria-label="朗读例句" onClick={() => speak(c.example.en)}><Volume2 size={12} /></button>
                <span>{c.example.cn}</span>
              </div>
            ) : null}
            {c.fromFavorite ? (
              <p className="muted small">这条来自收藏夹（还没收进单词本）。</p>
            ) : null}
            {/* 老收藏（或模型当时没给辨析）会缺"差别/例句" —— 给一条自助补齐的路，
                用一次查词把数据取回来（查过的词走缓存，等于免费） */}
            {c.fromFavorite && !c.diff && !c.example && onFillFavorite ? (
              <button className="ghost-btn fill-fav-btn" disabled={fillBusy}
                onClick={() => onFillFavorite(item)}>
                {fillBusy ? '正在补…' : '补上「差别」和例句'}
              </button>
            ) : null}
            <div className="grade-bar">
              {GRADE_KEYS.map((g) => (
                <button key={g} className={'ghost-btn grade-' + GRADES[g].tone} onClick={() => onGrade(g)}
                  title={`快捷键 ${g === 'forgot' ? 1 : g === 'normal' ? 2 : 3}`}>
                  {GRADES[g].label}<span className="muted small">{gradeHint(s, g)}</span>
                </button>
              ))}
            </div>
            <p className="muted small grade-tip">
              <span className="desktop-only">键盘：空格翻面 · 1 忘了 / 2 一般 / 3 简单 · Esc 退出</span>
              <span className="touch-only">左右滑动也能评分：← 忘了 · 简单 →</span>
            </p>
          </div>
        ) : (
          <button className="primary-btn big" onClick={onReveal} title="空格">显示答案</button>
        )}

        <div className="review-foot">
          <button className="ghost-btn sm kill-btn" onClick={() => onKill(item)}
            title="这个词我认识，以后不要再进复习清单">
            <Skull size={14} />斩掉（不再复习）
          </button>
          {wrongCount ? (
            <button className="link-btn" onClick={onManageWrong}><BookX size={13} />错词本 {wrongCount} 个</button>
          ) : null}
          {killedCount ? (
            <button className="link-btn" onClick={onManageKilled}><Eye size={13} />已斩掉 {killedCount} 个</button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
