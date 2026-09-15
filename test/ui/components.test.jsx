/**
 * 组件层测试（jsdom + @testing-library/react）。
 *
 * 为什么要有这一层：e2e 需要 Playwright + 真后端，CI 上跑不了；
 * 而"默认藏答案""讲解板块一个都不能少"这类**结构约定**一旦被重构改掉，
 * 纯函数测试和 lint 都发现不了。这里用组件单测把约定钉死。
 *
 * 跑法：npm run test:ui
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import QuizPane from '../../src/components/QuizPane.jsx';
import EntryCard from '../../src/components/EntryCard.jsx';
import PrintSheet from '../../src/components/PrintSheet.jsx';
import FavoritesModal from '../../src/components/modals/FavoritesModal.jsx';

const QUIZ = {
  title: '单词本自测 · 2 题',
  questions: [
    { type: 'choice', stem: 'She ___ to the rules.', options: ['objected', 'opposed'], answer: 'objected', explanation: 'object 作动词要接 to。' },
    { type: 'fill', stem: '填空：They ___ the plan.', options: [], answer: 'opposed', explanation: 'oppose 直接接宾语。' },
  ],
};
const noop = () => {};

beforeEach(() => {
  // 组件里点朗读按钮会走 speechSynthesis，jsdom 没有实现
  window.speechSynthesis = { speak: vi.fn(), cancel: vi.fn(), getVoices: () => [] };
});

describe('QuizPane 自测题', () => {
  it('渲染题目、选项与题号', () => {
    render(<QuizPane quiz={QUIZ} showAnswers={false} busy={false} onToggleAnswers={noop} onCopy={noop} onRegenerate={noop} onExit={noop} />);
    expect(screen.getByText(QUIZ.title)).toBeTruthy();
    expect(screen.getByText('She ___ to the rules.')).toBeTruthy();
    expect(screen.getByText('objected')).toBeTruthy();
    expect(screen.getByText('opposed')).toBeTruthy();
    expect(document.querySelectorAll('.quiz-list .quiz-item').length).toBe(2);
  });

  it('默认不显示答案（否则题就白做了）', () => {
    render(<QuizPane quiz={QUIZ} showAnswers={false} busy={false} onToggleAnswers={noop} onCopy={noop} onRegenerate={noop} onExit={noop} />);
    expect(document.querySelector('.quiz-answers')).toBeNull();
    expect(document.body.textContent).not.toContain('object 作动词要接 to');
  });

  it('显示答案时给出答案与解析，且按钮文案跟着变', () => {
    render(<QuizPane quiz={QUIZ} showAnswers busy={false} onToggleAnswers={noop} onCopy={noop} onRegenerate={noop} onExit={noop} />);
    const answers = document.querySelectorAll('.quiz-answers .quiz-item');
    expect(answers.length).toBe(2);
    expect(answers[0].textContent).toContain('objected');
    expect(answers[0].textContent).toContain('object 作动词要接 to');
    expect(screen.getByText('隐藏答案')).toBeTruthy();
  });

  it('点「显示答案」触发回调，而不是自己改状态', () => {
    const onToggleAnswers = vi.fn();
    render(<QuizPane quiz={QUIZ} showAnswers={false} busy={false} onToggleAnswers={onToggleAnswers} onCopy={noop} onRegenerate={noop} onExit={noop} />);
    fireEvent.click(screen.getByText('显示答案'));
    expect(onToggleAnswers).toHaveBeenCalledTimes(1);
  });

  it('没题目时禁用答案/复制，避免空试卷上的死按钮', () => {
    render(<QuizPane quiz={{ title: '', questions: [] }} showAnswers={false} busy={false} onToggleAnswers={noop} onCopy={noop} onRegenerate={noop} onExit={noop} />);
    expect(screen.getByText('显示答案').disabled).toBe(true);
    expect(screen.getByText('复制题目').disabled).toBe(true);
  });

  it('出题中时「换一套」按钮显示进度并禁用', () => {
    render(<QuizPane quiz={QUIZ} showAnswers={false} busy onToggleAnswers={noop} onCopy={noop} onRegenerate={noop} onExit={noop} />);
    expect(screen.getByText('出题中…').disabled).toBe(true);
  });

  it('quiz 为 null 也不崩（出题失败后返回）', () => {
    render(<QuizPane quiz={null} showAnswers={false} busy={false} onToggleAnswers={noop} onCopy={noop} onRegenerate={noop} onExit={noop} />);
    expect(screen.getByText('自测题')).toBeTruthy();
  });
});

const ENTRY = {
  id: 'wb-1', head: 'object', kind: 'word', phonetic: '/ˈɒbdʒɪkt/', pos: '名词/动词', brief: '物体；反对',
  register: '通用', tone: '中性', strength: '中',
  meanings: [{ pos: '名词', cn: '物体', en: 'a thing' }],
  scenes: ['学术写作'], avoid: '别用来表示拒绝',
  mnemonic: { image: '对着扔', hook: 'ob+ject', parts: 'ob- + ject', family: 'objection' },
  synonyms: [{ word: 'oppose', diff: 'oppose 更正式' }],
  collocations: ['object to sth'],
  examples: [{ en: 'She objected.', cn: '她反对。', note: '演示 object to' }],
  confusions: 'object 作动词接 to',
  usageNotes: '重音在第二节', examTips: '常考 object to doing',
  createdAt: 1,
};

describe('EntryCard 词条卡片', () => {
  it('把用户要的讲解维度全都排出来', () => {
    render(<EntryCard entry={ENTRY} books={[{ id: 'b1', name: '我的本', entries: [] }]} existing={null} onSave={noop} onCreateBook={noop} />);
    const headings = [...document.querySelectorAll('.section-heading h2')].map((h) => h.textContent);
    expect(headings).toEqual(['释义', '使用场景', '近义词对比', '常用搭配', '例句', '易混点', '用法要点', '考试怎么考']);
  });

  it('词性/语域/褒贬/强度是独立徽章', () => {
    render(<EntryCard entry={ENTRY} books={[]} existing={null} onSave={noop} onCreateBook={noop} />);
    const chips = [...document.querySelectorAll('.chips-meta .chip')].map((c) => c.textContent);
    expect(chips).toEqual(['名词/动词', '通用', '中性', '强度 中']);
  });

  it('近义词给出"差别"，例句给出语境说明', () => {
    render(<EntryCard entry={ENTRY} books={[]} existing={null} onSave={noop} onCreateBook={noop} />);
    expect(document.querySelector('.syn-usage').textContent).toContain('oppose 更正式');
    // 语境说明跟在例句下面（.summary-card 里），不是塞进同一行
    expect(document.querySelector('.summary-card').textContent).toContain('演示 object to');
  });

  it('词根词缀与助记画面分两行显示', () => {
    render(<EntryCard entry={ENTRY} books={[]} existing={null} onSave={noop} onCreateBook={noop} />);
    const lines = [...document.querySelectorAll('.morph-line')].map((x) => x.textContent);
    expect(lines.some((l) => l.includes('ob- + ject'))).toBe(true);
    expect(lines.some((l) => l.includes('对着扔'))).toBe(true);
  });

  it('加入单词本：按钮把选中的本子 id 传出去', () => {
    const onSave = vi.fn();
    render(<EntryCard entry={ENTRY} books={[{ id: 'b1', name: '本一', entries: [] }, { id: 'b2', name: '本二', entries: [] }]} existing={null} onSave={onSave} onCreateBook={noop} />);
    fireEvent.change(document.querySelector('.save-bar select'), { target: { value: 'b2' } });
    fireEvent.click(screen.getByText('加入单词本'));
    expect(onSave).toHaveBeenCalledWith('b2');
  });

  it('已在本子里时显示归属，并把按钮文案改成"更新"', () => {
    render(<EntryCard entry={ENTRY} books={[{ id: 'b1', name: '我的本', entries: [ENTRY] }]} existing={{ id: 'b1', name: '我的本' }} onSave={noop} onCreateBook={noop} />);
    expect(document.querySelector('.saved-flag').textContent).toContain('我的本');
    expect(screen.getByText('更新到单词本')).toBeTruthy();
  });

  it('一个本子都没有时，按钮变成"新建单词本并加入"', () => {
    const onCreateBook = vi.fn();
    render(<EntryCard entry={ENTRY} books={[]} existing={null} onSave={noop} onCreateBook={onCreateBook} />);
    fireEvent.click(screen.getByText('新建单词本并加入'));
    expect(onCreateBook).toHaveBeenCalledTimes(1);
  });
});

/* ---------- 导出 PDF 的打印页 ----------
   两个容易漏的点：打印变体里不该有交互件（纸上用不到，还会占地方），
   整本导出必须把**全部**词条都放进去（不受筛选影响）。 */
describe('EntryCard 打印变体', () => {
  it('打印变体没有任何按钮（朗读/保存/导出都不该印在纸上）', () => {
    render(<EntryCard entry={ENTRY} variant="print" />);
    expect(document.querySelectorAll('.entry-card button').length).toBe(0);
    expect(document.querySelector('.save-bar')).toBeNull();
  });

  it('打印变体保留全部讲解板块与词典核对', () => {
    const withDict = { ...ENTRY, dict: { source: 'youdao', phonetics: { uk: '', us: '' }, perPosPhonetics: [], senses: [{ pos: 'n.', cn: '物体' }], examTypes: ['CET4'], forms: [], phrases: [] } };
    render(<EntryCard entry={withDict} variant="print" />);
    const headings = [...document.querySelectorAll('.section-heading h2')].map((h) => h.textContent);
    expect(headings).toContain('释义');
    expect(headings).toContain('词典核对');
  });

  it('屏幕变体照旧有按钮（别把打印变体的改动带到默认上）', () => {
    render(<EntryCard entry={ENTRY} books={[]} existing={null} onSave={noop} onCreateBook={noop} onExportPdf={noop} />);
    expect(document.querySelector('.save-bar')).toBeTruthy();
    expect(screen.getByText('导出 PDF')).toBeTruthy();
  });
});

describe('PrintSheet 打印页', () => {
  it('单个词条：只有一张卡片、没有整本封面', () => {
    render(<PrintSheet job={{ kind: 'entry', entry: ENTRY }} />);
    expect(document.querySelectorAll('.print-sheet .entry-card').length).toBe(1);
    expect(document.querySelector('.print-cover')).toBeNull();
  });

  it('整本：有封面（本子名 + 词条数 + 导出时间）且每个词条都在', () => {
    const book = { id: 'b1', name: '英语文摘2026', entries: [ENTRY, { ...ENTRY, id: 'wb-2', head: 'enshrine' }, { ...ENTRY, id: 'wb-3', head: 'resilient' }] };
    render(<PrintSheet job={{ kind: 'book', book }} />);
    expect(document.querySelector('.print-cover h1').textContent).toBe('英语文摘2026');
    expect(document.querySelector('.print-cover').textContent).toContain('共 3 个词条');
    expect(document.querySelector('.print-cover').textContent).toContain('导出');
    expect(document.querySelectorAll('.print-sheet .entry-card').length).toBe(3);
    expect(document.body.textContent).toContain('enshrine');
  });

  it('空本子也能导出（不报错，给出说明）', () => {
    render(<PrintSheet job={{ kind: 'book', book: { id: 'b1', name: '空的', entries: [] } }} />);
    expect(document.querySelectorAll('.print-sheet .entry-card').length).toBe(0);
    expect(document.body.textContent).toContain('这个本子还是空的');
  });

  it('自测题：答案与解析要带上（纸张上没法点「显示答案」）', () => {
    render(<PrintSheet job={{ kind: 'quiz', quiz: QUIZ }} />);
    expect(document.querySelector('.print-sheet .quiz-answers')).toBeTruthy();
    expect(document.body.textContent).toContain('object 作动词要接 to');
  });

  it('没有任务时什么都不渲染', () => {
    const { container } = render(<PrintSheet job={null} />);
    expect(container.querySelector('.print-sheet')).toBeNull();
  });
});

/* ---------- 近义词行上的收藏 / 查它 ---------- */
describe('近义词操作', () => {
  const SYN_ENTRY = { ...ENTRY, synonyms: [{ word: 'oppose', phonetic: '/əˈpəʊz/', cn: '反对', register: '正式', tone: '中性', strength: '强', diff: 'oppose 更正式' }] };

  it('每个近义词都有「收藏」和「查这个词」两个按钮', () => {
    render(<EntryCard entry={SYN_ENTRY} onToggleFavorite={noop} isFavorite={() => false} onLookupWord={noop} />);
    expect(document.querySelector('.syn-acts .icon-btn[aria-label="收藏"]')).toBeTruthy();
    expect(document.querySelector('.syn-acts .icon-btn[aria-label="查这个词"]')).toBeTruthy();
  });

  it('点 ⭐ 把整行信息交给回调（不只是词名）', () => {
    const onToggleFavorite = vi.fn();
    render(<EntryCard entry={SYN_ENTRY} onToggleFavorite={onToggleFavorite} isFavorite={() => false} onLookupWord={noop} />);
    fireEvent.click(document.querySelector('.syn-acts .icon-btn[aria-label="收藏"]'));
    const [syn, entry] = onToggleFavorite.mock.calls[0];
    expect(syn.word).toBe('oppose');
    expect(syn.register).toBe('正式');
    expect(entry.head).toBe('object');   // 第二个参数是来源词条，收藏时要记下来
  });

  it('点 → 把词名交给查词回调', () => {
    const onLookupWord = vi.fn();
    render(<EntryCard entry={SYN_ENTRY} onToggleFavorite={noop} isFavorite={() => false} onLookupWord={onLookupWord} />);
    fireEvent.click(document.querySelector('.syn-acts .icon-btn[aria-label="查这个词"]'));
    expect(onLookupWord).toHaveBeenCalledWith('oppose');
  });

  it('已收藏时星标是按下状态（视觉上实心）', () => {
    render(<EntryCard entry={SYN_ENTRY} onToggleFavorite={noop} isFavorite={(w) => w === 'oppose'} onLookupWord={noop} />);
    expect(document.querySelector('.syn-acts .icon-btn[aria-label="收藏"]').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.syn-acts .icon-btn.on')).toBeTruthy();
  });

  it('打印变体里不出现这两个按钮（纸上点不了）', () => {
    render(<EntryCard entry={SYN_ENTRY} variant="print" />);
    expect(document.querySelector('.syn-acts')).toBeNull();
  });
});

describe('FavoritesModal 收藏夹', () => {
  const FAV = [
    { id: 'fav-oppose', head: 'oppose', phonetic: '/əˈpəʊz/', brief: '反对', from: 'object', at: 2 },
    { id: 'fav-consecrate', head: 'consecrate', brief: '祝圣', from: 'enshrine', at: 1, entry: { id: 'wb-c', head: 'consecrate' } },
  ];
  const BOOKS = [{ id: 'b1', name: '我的本', entries: [] }];

  it('列出收藏项，并区分「还没查过 / 已查到完整讲解」', () => {
    render(<FavoritesModal favorites={FAV} books={BOOKS} busy={false} onClose={noop} onRemove={noop} onAddToBook={noop} onLookup={noop} />);
    const notes = [...document.querySelectorAll('.fav-row-note')].map((n) => n.textContent);
    expect(notes.length).toBe(2);
    expect(notes.some((t) => t.includes('还没查过'))).toBe(true);
    expect(notes.some((t) => t.includes('已查到完整讲解'))).toBe(true);
  });

  it('没查过的给「查详细讲解」，查过的才给「加入词库」', () => {
    render(<FavoritesModal favorites={FAV} books={BOOKS} busy={false} onClose={noop} onRemove={noop} onAddToBook={noop} onLookup={noop} />);
    const rows = [...document.querySelectorAll('.fav-row')].map((r) => r.textContent);
    expect(rows[0]).toContain('查详细讲解');
    expect(rows[0]).toContain('查后加入');
    expect(rows[1]).toContain('加入词库');
    expect(rows[1]).not.toContain('查详细讲解');
  });

  it('加入词库时带上选中的本子 id', () => {
    const onAddToBook = vi.fn();
    render(<FavoritesModal favorites={FAV} books={BOOKS} busy={false} onClose={noop} onRemove={noop} onAddToBook={onAddToBook} onLookup={noop} />);
    fireEvent.click(screen.getAllByText('加入词库')[0]);
    expect(onAddToBook).toHaveBeenCalledWith(FAV[1], 'b1');
  });

  it('空收藏夹给出说明而不是空白', () => {
    render(<FavoritesModal favorites={[]} books={BOOKS} busy={false} onClose={noop} onRemove={noop} onAddToBook={noop} onLookup={noop} />);
    expect(document.body.textContent).toContain('收藏夹是空的');
  });

  it('没有单词本时「加入词库」按钮禁用并说明原因', () => {
    render(<FavoritesModal favorites={FAV} books={[]} busy={false} onClose={noop} onRemove={noop} onAddToBook={noop} onLookup={noop} />);
    expect(document.body.textContent).toContain('还没有单词本');
    expect(screen.getAllByText('查后加入')[0].disabled).toBe(true);
  });
});
