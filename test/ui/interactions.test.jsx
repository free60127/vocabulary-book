/**
 * 交互层组件测试（jsdom + @testing-library/react）。
 *
 * 为什么单独一个文件：`components.test.jsx` 管"结构约定"，这里管**交互约定** ——
 * 键盘能不能用、焦点会不会跑、空状态有没有话说、危险操作有没有二次确认。
 * 这些以前只能靠真机模拟（要起浏览器 + 后端）才能发现：
 * 可用性审计那一轮就是在这里发现"弹窗没有焦点陷阱""取消新建静默无反应"的，
 * 现在把同类约定钉在组件级，秒级就能跑。
 *
 * 跑法：npm run test:ui
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import ReviewPane from '../../src/components/ReviewPane.jsx';
import ReviewSetup from '../../src/components/ReviewSetup.jsx';
import SentencePane from '../../src/components/SentencePane.jsx';
import QuizPane from '../../src/components/QuizPane.jsx';
import ZhCandidates from '../../src/components/ZhCandidates.jsx';
import SafetyBanner from '../../src/components/SafetyBanner.jsx';
import BackToTop from '../../src/components/BackToTop.jsx';
import { NewBookModal, RenameBookModal, MergeBookModal } from '../../src/components/modals/RenameBookModal.jsx';
import SentenceBookModal from '../../src/components/modals/SentenceBookModal.jsx';
import WrongBookModal from '../../src/components/modals/WrongBookModal.jsx';
import KilledModal from '../../src/components/modals/KilledModal.jsx';

const noop = () => {};

beforeEach(() => {
  // 卡片上的朗读按钮会走 speechSynthesis，jsdom 没有实现
  window.speechSynthesis = { speak: vi.fn(), cancel: vi.fn(), getVoices: () => [] };
});

const word = (head, cn = '释义') => ({
  key: 'k-' + head, kind: 'entry', head, phonetic: '/test/',
  entry: { id: 'wb-' + head, head, meanings: [{ cn }], brief: cn },
  schedule: { due: Date.now(), interval: 1 },
});
const revProps = (over = {}) => ({
  queue: [word('alpha'), word('beta')], index: 0, revealed: false, schedule: {}, mode: 'review',
  practice: false, practiceLabel: '', killedCount: 0, wrongCount: 0, mix: { book: 2, fav: 0 },
  onSwitchMode: noop, onRestartSpell: noop, onManageKilled: noop, onManageWrong: noop,
  onSpellWrong: noop, onReveal: noop, onGrade: noop, onKill: noop, onExit: noop, ...over,
});

describe('ReviewPane 复习卡', () => {
  it('复习模式：显示词头，翻面前不显示答案与评分', () => {
    render(<ReviewPane {...revProps()} />);
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(document.querySelector('.review-answer')).toBeNull();
    expect(document.querySelector('.grade-bar')).toBeNull();
  });

  it('翻面后才出现三档评分', () => {
    render(<ReviewPane {...revProps({ revealed: true })} />);
    expect(document.querySelectorAll('.grade-bar button').length).toBe(3);
  });

  it('空格翻面、数字键评分（键盘可用）', () => {
    const onReveal = vi.fn();
    const { rerender } = render(<ReviewPane {...revProps({ onReveal })} />);
    fireEvent.keyDown(document, { key: ' ' });
    expect(onReveal).toHaveBeenCalled();
    const onGrade = vi.fn();
    rerender(<ReviewPane {...revProps({ revealed: true, onGrade })} />);
    fireEvent.keyDown(document, { key: '1' });
    expect(onGrade).toHaveBeenCalledWith('forgot');
  });

  it('Esc 退出复习', () => {
    const onExit = vi.fn();
    render(<ReviewPane {...revProps({ onExit })} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onExit).toHaveBeenCalled();
  });

  it('拼写模式：不显示词头（否则就是抄），给中文与输入框', () => {
    render(<ReviewPane {...revProps({ mode: 'spell' })} />);
    expect(document.querySelectorAll('.spell-input').length).toBe(1);
    expect(screen.queryByText('alpha')).toBeNull();
    expect(screen.getByText('释义')).toBeTruthy();
  });

  it('模式切换按钮成对出现，当前模式高亮', () => {
    render(<ReviewPane {...revProps()} />);
    const chips = [...document.querySelectorAll('.mode-switch .mode-chip')];
    expect(chips.map((c) => c.textContent)).toEqual(['复习', '拼写']);
    expect(chips[0].className).toContain('active');
  });

  it('收藏来的词：翻面后显示「与 X 的差别」与用法（翻面前不剧透）', () => {
    const favItem = {
      key: 'f1', kind: 'favorite', head: 'bespoke', phonetic: '/bɪˈspəʊk/',
      favorite: { id: 'f1', head: 'bespoke', brief: '定制的', from: 'ad hoc', diff: '褒贬正好相反：bespoke 是褒义', usage: '正式写作' },
      schedule: { due: Date.now(), interval: 1 },
    };
    const props = { queue: [favItem], index: 0, mix: { book: 0, fav: 1 } };
    const { container, rerender } = render(<ReviewPane {...revProps(props)} />);
    expect(container.querySelector('.review-diff')).toBeNull();          // 翻面前不给答案
    rerender(<ReviewPane {...revProps({ ...props, revealed: true })} />);
    const diff = container.querySelector('.review-diff');
    expect(diff).toBeTruthy();
    expect(diff.textContent).toContain('ad hoc');
    expect(diff.textContent).toContain('褒贬正好相反');
    expect(container.textContent).toContain('什么时候用哪个');
  });

  it('自测题：选项可点、未作答时禁用批改、批改后显示判定与反馈', () => {
    const quiz = {
      title: '自测题', questions: [
        { type: 'choice', stem: 'She ___ to the rules.', options: ['objected', 'opposed', 'against', 'object'], answer: 'objected', explanation: 'object 作动词要接 to。' },
        { type: 'translate', stem: '他把书放在桌上', options: [], answer: 'He put the book on the table.', explanation: '' },
      ],
    };
    const onAnswer = vi.fn();
    const onGrade = vi.fn();
    const { container, rerender } = render(
      <QuizPane quiz={quiz} showAnswers={false} answers={{}} onAnswer={onAnswer} onGrade={onGrade} graded={null} />,
    );
    // 选项可点
    const opts = container.querySelectorAll('.quiz-option.clickable');
    expect(opts.length).toBe(4);
    fireEvent.click(opts[0]);
    expect(onAnswer).toHaveBeenCalledWith(0, { choice: 0 });
    // 没作答 → 批改按钮禁用
    const gradeBtn = [...container.querySelectorAll('button')].find((b) => /批改/.test(b.textContent));
    expect(gradeBtn.disabled).toBe(true);
    // 作答后按钮可用且显示进度
    rerender(<QuizPane quiz={quiz} showAnswers={false} answers={{ 0: { choice: 0 } }} onAnswer={onAnswer} onGrade={onGrade} graded={null} />);
    const gradeBtn2 = [...container.querySelectorAll('button')].find((b) => /批改/.test(b.textContent));
    expect(gradeBtn2.disabled).toBe(false);
    expect(gradeBtn2.textContent).toContain('1/2');
    // 批改结果：判定徽章 + 反馈
    const graded = {
      results: [
        { index: 0, status: 'right', expected: 'objected' },
        { index: 1, status: 'wrong', expected: 'He put the book on the table.', score: 3, comment: '注意冠词', better: 'He placed the book on the table.' },
      ],
      objectiveRight: 1, objectiveTotal: 1, comment: '整体不错',
    };
    rerender(<QuizPane quiz={quiz} showAnswers={false} answers={{ 0: { choice: 0 }, 1: { text: 'He put book on table.' } }} onAnswer={onAnswer} onGrade={onGrade} graded={graded} />);
    expect(container.querySelectorAll('.quiz-badge.ok').length).toBe(1);
    expect(container.querySelectorAll('.quiz-badge.bad').length).toBe(1);
    expect(container.querySelector('.quiz-score').textContent).toContain('1');
    expect(container.textContent).toContain('注意冠词');
    expect(container.textContent).toContain('He placed the book on the table.');
  });

  it('自测题：未作答的题不揭晓答案；批改反馈能收起', () => {
    const quiz = {
      title: '自测题', questions: [
        { type: 'choice', stem: 'She ___ it.', options: ['a', 'b'], answer: 'a', explanation: '解析：选 a' },
        { type: 'fill', stem: 'He ___ it.', options: [], answer: 'did', explanation: '解析：did' },
      ],
    };
    const graded = {
      results: [
        { index: 0, status: 'right', expected: 'a' },
        { index: 1, status: 'blank', expected: 'did' },
      ],
      objectiveRight: 1, objectiveTotal: 1,
    };
    const { container, rerender } = render(
      <QuizPane quiz={quiz} showAnswers={false} answers={{ 0: { choice: 0 } }} graded={graded} />,
    );
    const items = [...container.querySelectorAll('.quiz-item')];
    expect(items[0].textContent).toContain('解析：选 a');          // 作答过 → 有反馈
    expect(items[1].textContent).not.toContain('参考答案');        // 未作答 → 不揭晓
    expect(items[1].textContent).not.toContain('解析：did');
    // 收起批改 → 反馈全部消失
    const hide = [...container.querySelectorAll('button')].find((b) => /收起批改/.test(b.textContent));
    expect(hide).toBeTruthy();
    fireEvent.click(hide);
    expect(container.querySelectorAll('.quiz-feedback').length).toBe(0);
    // 恢复按钮出现
    expect([...container.querySelectorAll('button')].some((b) => /显示批改/.test(b.textContent))).toBe(true);
    rerender(<QuizPane quiz={quiz} showAnswers={false} answers={{ 0: { choice: 0 } }} graded={graded} />);
  });

  it('收藏词缺「差别」时给出补齐入口，已有差别时不显示', () => {
    const bare = {
      key: 'f2', kind: 'favorite', head: 'grudge', phonetic: '/ɡrʌdʒ/',
      favorite: { id: 'f2', head: 'grudge', brief: '吝惜', from: 'begrudge' },
      schedule: { due: Date.now(), interval: 1 },
    };
    const props = { queue: [bare], index: 0, revealed: true, mix: { book: 0, fav: 1 } };
    const { container, rerender } = render(<ReviewPane {...revProps({ ...props, onFillFavorite: () => {} })} />);
    expect(container.querySelector('.fill-fav-btn')).toBeTruthy();
    // 有差别 → 不需要补齐入口，直接显示差别
    rerender(<ReviewPane {...revProps({ ...props, onFillFavorite: () => {} })} />);
    const withDiff = {
      ...bare,
      favorite: { ...bare.favorite, diff: '与 begrudge 的差别：grudge 是名词', example: 'bear a grudge' },
    };
    rerender(<ReviewPane {...revProps({ queue: [withDiff], index: 0, revealed: true, mix: { book: 0, fav: 1 }, onFillFavorite: () => {} })} />);
    expect(container.querySelector('.fill-fav-btn')).toBeNull();
    expect(container.querySelector('.review-diff')).toBeTruthy();
  });

  it('一轮走完：显示完成页与"用拼写再过一遍"', () => {
    render(<ReviewPane {...revProps({ index: 2 })} />);
    expect(document.querySelector('.review-done-line')).toBeTruthy();
    expect(screen.getByText(/用拼写再过一遍/)).toBeTruthy();
  });
});

describe('ReviewSetup 模式选择', () => {
  const setupProps = (over = {}) => ({
    queue: [word('alpha')], mix: { book: 1, fav: 0 }, kind: 'due', mode: 'review',
    setMode: noop, onStart: noop, onExit: noop, ...over,
  });

  it('两种模式都在，并说明这一批多少个词', () => {
    render(<ReviewSetup {...setupProps()} />);
    expect(screen.getByText('复习模式')).toBeTruthy();
    expect(screen.getByText('拼写模式')).toBeTruthy();
    expect(screen.getByText(/这一批/)).toBeTruthy();
  });

  it('点开始会把选中的模式传出去', () => {
    const onStart = vi.fn();
    render(<ReviewSetup {...setupProps({ onStart, mode: 'spell' })} />);
    fireEvent.click(screen.getByText(/开始/));
    expect(onStart).toHaveBeenCalledWith('spell');
  });

  it('点模式卡片会改模式（不能是个没接上的回调）', () => {
    const setMode = vi.fn();
    render(<ReviewSetup {...setupProps({ setMode, mode: 'review' })} />);
    fireEvent.click(screen.getByText('拼写模式'));
    expect(setMode).toHaveBeenCalledWith('spell');
  });

  it('没有词可练时不给"开始"，并说明原因', () => {
    render(<ReviewSetup {...setupProps({ queue: [] })} />);
    expect(document.querySelector('.review-setup .primary-btn').disabled).toBe(true);
    expect(screen.getByText(/今天还没有学过的词/)).toBeTruthy();
  });
});

describe('ZhCandidates 中文候选（内联在搜索栏下）', () => {
  const items = [
    { word: 'badminton', cn: '羽毛球（运动）', pos: '名词', variant: '通用', note: '只指运动' },
    { word: 'shuttlecock', cn: '羽毛球（那个球）', variant: '英式', last: true },
  ];

  it('列出候选、词性与英美分工', () => {
    render(<ZhCandidates term="羽毛球" items={items} onPick={noop} onDismiss={noop} />);
    expect(screen.getByText('badminton')).toBeTruthy();
    expect(screen.getByText('shuttlecock')).toBeTruthy();
    expect(screen.getByText('英式')).toBeTruthy();
    expect(screen.getByText('上次查的就是这个')).toBeTruthy();
  });

  it('点候选会把整个条目交出去（App 从里面取 word）', () => {
    const onPick = vi.fn();
    render(<ZhCandidates term="羽毛球" items={items} onPick={onPick} onDismiss={noop} />);
    fireEvent.click(screen.getByText('badminton'));
    expect(onPick.mock.calls[0][0].word).toBe('badminton');
  });

  it('可以关掉候选面板', () => {
    const onDismiss = vi.fn();
    render(<ZhCandidates term="羽毛球" items={items} onPick={noop} onDismiss={onDismiss} />);
    fireEvent.click(document.querySelector('.zh-picker .icon-btn'));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('SentencePane 造句', () => {
  const spProps = (over = {}) => ({
    items: [], index: 0, mode: 'free', setMode: noop, busy: false, error: '',
    count: 5, setCount: noop, difficulty: '中等', setDifficulty: noop,
    onStart: noop, onGrade: noop, onNext: noop, onExit: noop, grade: null, grading: false,
    onRetryGrade: noop, onSaveSentence: noop, isSaved: false, bookCount: 0, onOpenBook: noop, ...over,
  });

  it('开始页：两种模式 + 三档难度 + 题量 + 错句本入口', () => {
    render(<SentencePane {...spProps()} />);
    expect(screen.getByText('自由造句')).toBeTruthy();
    expect(screen.getByText('翻译造句')).toBeTruthy();
    expect(screen.getByText('困难')).toBeTruthy();
    expect(screen.getByText('20 题')).toBeTruthy();
    expect(screen.getByText(/错句本/)).toBeTruthy();
  });

  it('切难度会把值传出去', () => {
    const setDifficulty = vi.fn();
    render(<SentencePane {...spProps({ setDifficulty })} />);
    fireEvent.click(screen.getByText('困难'));
    expect(setDifficulty).toHaveBeenCalledWith('困难');
  });

  it('批改结果：分数、维度标签、漏掉的信息、收藏按钮', () => {
    const grade = {
      score: 78, usesTarget: true, verdict: '用词准确。',
      problems: [{ kind: 'fidelity', issue: '漏了"每周"', fix: '补上 every week' }],
      missing: ['每周'], corrected: 'Users opt in.', suggestion: '',
    };
    render(<SentencePane {...spProps({ items: [{ head: 'opt in', cn: '中文', meaning: '选择加入' }], grade })} />);
    expect(screen.getByText('78')).toBeTruthy();
    expect(screen.getByText('信息完整')).toBeTruthy();
    expect(screen.getByText(/漏掉的信息/)).toBeTruthy();
    expect(screen.getByText(/收进错句本/)).toBeTruthy();
  });

  it('已收藏时按钮变成"已在错句本"', () => {
    const grade = { score: 90, usesTarget: true, verdict: '好', problems: [] };
    render(<SentencePane {...spProps({ items: [{ head: 'x', meaning: 'y' }], grade, isSaved: true })} />);
    expect(screen.getByText(/已在错句本/)).toBeTruthy();
  });
});

describe('SafetyBanner 数据安全提醒', () => {
  it('有数据却没同步码 → 明确警告并给两个出口', () => {
    render(<SafetyBanner entries={12} syncCode="" accountEmail="" accountHasSync={false}
      onMakeCode={noop} onOpenBackup={noop} onDismiss={noop} />);
    expect(document.querySelector('.safety-banner.danger')).toBeTruthy();
    expect(screen.getByText(/只存在这台浏览器里/)).toBeTruthy();
    expect(screen.getByText(/生成同步码/)).toBeTruthy();
    expect(screen.getByText(/导出备份/)).toBeTruthy();
  });

  it('有同步码但没存进账号 → 只提醒绑定，不吓唬人', () => {
    render(<SafetyBanner entries={12} syncCode={'a'.repeat(32)} accountEmail="a@b.c" accountHasSync={false}
      onMakeCode={noop} onOpenBackup={noop} onDismiss={noop} />);
    expect(document.querySelector('.safety-banner.danger')).toBeNull();
    expect(screen.getByText(/还没存进账号/)).toBeTruthy();
  });

  it('一切就绪时不出现', () => {
    const { container } = render(<SafetyBanner entries={12} syncCode={'a'.repeat(32)} accountEmail="a@b.c" accountHasSync
      onMakeCode={noop} onOpenBackup={noop} onDismiss={noop} />);
    expect(container.querySelector('.safety-banner')).toBeNull();
  });
});

describe('NewBookModal 新建单词本（替代 window.prompt）', () => {
  it('默认带一个名字，回车即建', () => {
    const onSubmit = vi.fn();
    render(<NewBookModal onSubmit={onSubmit} onClose={noop} />);
    const input = document.querySelector('.rename-modal input');
    expect(input.value).toBe('我的单词本');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('我的单词本');
  });

  it('空名字不能提交（按钮禁用）', () => {
    render(<NewBookModal onSubmit={noop} onClose={noop} />);
    const input = document.querySelector('.rename-modal input');
    fireEvent.change(input, { target: { value: '   ' } });
    expect(document.querySelector('.rename-modal .primary-btn').disabled).toBe(true);
  });

  it('取消会回调 onClose（不再是静默无反应）', () => {
    const onClose = vi.fn();
    render(<NewBookModal onSubmit={noop} onClose={onClose} />);
    fireEvent.click(screen.getByText('取消'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('弹窗焦点管理（可用性审计修的那条）', () => {
  const cases = [
    ['新建单词本', () => <NewBookModal onSubmit={noop} onClose={noop} />],
    ['改名弹窗', () => <RenameBookModal book={{ name: '书', entries: [] }} onClose={noop} onSubmit={noop} />],
    ['合并弹窗', () => <MergeBookModal from={{ id: 'a', name: 'A', entries: [] }} books={[{ id: 'b', name: 'B', entries: [] }]} onClose={noop} onSubmit={noop} />],
    ['错句本', () => <SentenceBookModal items={[{ id: 's1', head: 'object', sentence: 'I object.', score: 80, mode: 'free' }]} onClose={noop} onDelete={noop} onPracticeWord={noop} />],
    ['错词本', () => <WrongBookModal items={[{ head: 'object', count: 2, reason: 'forgot', brief: '物体' }]} onClose={noop} onPractice={noop} onRemove={noop} onClearAll={noop} />],
    ['已斩掉', () => <KilledModal items={[{ head: 'object', brief: '物体' }]} onClose={noop} onRevive={noop} onReviveAll={noop} />],
  ];

  it.each(cases)('%s：是 dialog，打开后焦点在弹窗内，Tab 不跑到背景', (_label, make) => {
    render(make());
    const modal = document.querySelector('.modal');
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(modal.contains(document.activeElement)).toBe(true);
    const focusables = [...modal.querySelectorAll('button, input, select, textarea, a[href]')].filter((el) => !el.disabled);
    focusables[focusables.length - 1].focus();
    fireEvent.keyDown(modal, { key: 'Tab' });
    expect(modal.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
  });
});

describe('BackToTop 回到顶部', () => {
  it('没滚动时不显示（不占地方）', () => {
    const { container } = render(<BackToTop />);
    expect(container.querySelector('.back-to-top')).toBeNull();
  });
});
