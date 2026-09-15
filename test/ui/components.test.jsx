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
