import React, { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { scrollTop, toTop } from '../scroll.js';

/**
 * 回到顶部（浮在右下角）。
 *
 * 为什么需要：查完一个词，卡片很长（释义/近义/例句/词典核对/追问…），
 * 看到底部想查下一个词，只能一路往回滚 —— 手机上尤其难受（用户反馈）。
 *
 * 实现注意：
 *  · 两个滚动容器都要看（桌面端是 .editor，手机端是整页），见 scroll.js；
 *  · 滚动监听用**捕获**（window + capture）：内层容器的滚动事件不会冒泡到 window，
 *    不加 capture 的话桌面端点开词条后按钮永远不出现；
 *  · 手机端底部有提示条 / 复习的评分条，位置抬高一点，别压在它们身上。
 */
export default function BackToTop({ threshold = 480 }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const sync = () => setShow(scrollTop() > threshold);
    window.addEventListener('scroll', sync, true);      // capture：内层容器滚动也要收到
    window.addEventListener('resize', sync);
    /**
     * 兜底轮询：**内容变短时不会触发 scroll 事件** ——
     * 比如查完新词后我们把它滚回顶部（scrollTop 本来就是 0，等于没滚动、没有事件），
     * 按钮就会凭空留在屏幕上。500ms 读两次属性，代价可以忽略。
     */
    const timer = setInterval(sync, 500);
    sync();
    return () => {
      window.removeEventListener('scroll', sync, true);
      window.removeEventListener('resize', sync);
      clearInterval(timer);
    };
  }, [threshold]);

  if (!show) return null;
  return (
    <button className="back-to-top" onClick={() => toTop()} aria-label="回到顶部" title="回到顶部">
      <ArrowUp size={18} />
    </button>
  );
}
