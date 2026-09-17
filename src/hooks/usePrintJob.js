import React from 'react';

/**
 * 打印 / 导出 PDF 的会话。
 *
 * 统一出口：词条、整本、自测题都走这里。屏幕上看不见的 `.print-sheet` 承载内容，
 * 打印那一刻由 `body.printing` 把主界面藏起来（见 styles.css 的 @media print）。
 *
 * 为什么单独成 hook：这里有一处**平台差异**值得一个文件说清楚 ——
 * 手机上 `window.print()` 直接弹系统打印界面，而"存成文件"藏在右上角菜单里
 * （Android Chrome：⋮ → 分享/打印；iOS：分享 → 存储到"文件"），所以手机端先给一张说明卡。
 */
export function usePrintJob() {
  const [job, setJob] = React.useState(null);
  const [hint, setHint] = React.useState(null);

  const start = React.useCallback((next) => {
    const coarse = typeof window !== 'undefined'
      && ((window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || window.innerWidth <= 900);
    if (coarse) setHint(next);
    else setJob(next);
  }, []);

  React.useEffect(() => {
    if (!job) return undefined;
    document.body.classList.add('printing');
    // afterprint 在"取消"和"打印完成"后都会触发，用它收尾最稳；
    // 再挂一个兜底定时器，防止某些环境不触发 afterprint 导致 body 永远停在 printing。
    const cleanup = () => { document.body.classList.remove('printing'); setJob(null); };
    window.addEventListener('afterprint', cleanup);
    const fire = setTimeout(() => window.print(), 80);
    const safety = setTimeout(cleanup, 60_000);
    return () => {
      clearTimeout(fire); clearTimeout(safety);
      window.removeEventListener('afterprint', cleanup);
      document.body.classList.remove('printing');
    };
  }, [job]);

  /** 手机端说明卡上点「继续」：把待打印的任务真正交给打印流程 */
  const confirmHint = React.useCallback(() => {
    setHint((cur) => { if (cur) setJob(cur); return null; });
  }, []);

  return { job, hint, setHint, start, confirmHint };
}
