import { useEffect, useRef } from 'react';

/**
 * 弹窗的键盘出口：按 ESC 关闭。
 *
 * 为什么要有：这个项目有 6 个弹窗（AI 设置 / 备份同步 / 账号 / 收藏夹 / 出题 / 导出说明），
 * 之前**一个都没有** —— 键盘用户唯一的出路是去点右上角那个 16px 的 X，
 * 摸黑找不说，屏幕阅读器用户更是直接卡在弹窗里。
 *
 * 为什么用模块级栈而不是各自监听：账号弹窗是从备份弹窗里打开的，两个同时挂在 DOM 上，
 * 各听各的会导致按一次 ESC 把两层一起关掉（用户还在填密码，底下的面板也没了）。
 * 只有**最后打开的那个**响应。
 */
const stack = [];

export function useEscape(onClose, active = true) {
  const cbRef = useRef(onClose);
  cbRef.current = onClose;
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined;
    const token = {};
    stack.push(token);
    const onKey = (e) => {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      if (stack[stack.length - 1] !== token) return;   // 不是最上层：让给上面那个
      e.preventDefault();
      cbRef.current?.();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}
