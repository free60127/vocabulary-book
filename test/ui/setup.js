/**
 * vitest 的 jsdom 环境准备。
 *
 * 显式 cleanup：不写的话，上一个用例渲染的 DOM 会留在 document 里，
 * 断言 `document.querySelector('.modal')` 会命中**上一个用例的弹窗** ——
 * 这类错误很隐蔽（报的错和真实原因完全不相干）。
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
