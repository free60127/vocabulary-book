import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 应用内相机（拍照导入用）。
 *
 * ## 为什么不用 `<input capture="environment">`
 * 那是"请求系统相机"的语义，但**安卓上很不可靠**：
 * 安卓 Chrome 往往直接弹系统的照片选择器（照片 / 相册 两个标签），压根不打开相机 ——
 * 用户实测反馈"点拍照和从相册选一样"。
 * iOS Safari 认这个属性，所以只按 iOS 设计就会踩这个坑。
 *
 * ## 所以自己开相机
 * `getUserMedia` + `<video>` 预览 + canvas 抓帧，两端行为一致：
 *  · 需要 HTTPS（本站是 https，localhost 也可以）；
 *  · 首次会请求权限；被拒或不可用时**自动退回**系统选择器（原路仍可用，不是死路）。
 */
export function useCamera() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [facing, setFacing] = useState('environment');   // 默认后置（拍纸）
  const [ready, setReady] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  const stop = useCallback(() => {
    const s = streamRef.current;
    streamRef.current = null;
    if (s) { try { s.getTracks().forEach((t) => t.stop()); } catch { /* 已停 */ } }
    setReady(false);
  }, []);

  const close = useCallback(() => { stop(); setOpen(false); setError(''); }, [stop]);

  /* 每次打开/切换镜头都重新取流；关闭或卸载时一定要停掉轨道，否则手机相机会一直亮着 */
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const start = async () => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setError('这个浏览器不支持直接拍照，请用「从相册/文件选择」');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          // iOS 必须显式 play()，且要 playsInline 才不会全屏接管
          try { await v.play(); } catch { /* 用户手势之外可能被拒，等 onLoadedMetadata 再试 */ }
        }
        setReady(true);
      } catch (e) {
        const name = (e && e.name) || '';
        setError(name === 'NotAllowedError'
          ? '没有拿到相机权限。可以在浏览器地址栏左侧的权限设置里允许相机，或改用「从相册/文件选择」'
          : '打不开相机（' + (e && e.message ? e.message : '未知原因') + '），请改用「从相册/文件选择」');
      }
    };
    start();
    return () => { cancelled = true; stop(); };
  }, [open, facing, stop]);

  /** 可用性预判：不支持就别让用户点了才发现 */
  const canUse = typeof navigator !== 'undefined'
    && Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  /** 抓当前帧 → JPEG dataURL（长边由调用方统一压缩，这里给原始帧） */
  const capture = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.92);
  }, []);

  return {
    open, setOpen, close, error, ready, facing, setFacing, videoRef, capture, canUse,
  };
}

/** 把 dataURL 转成 File，好复用"压缩 → 识别"那条链路 */
export function dataUrlToFile(dataUrl, name = 'camera.jpg') {
  const [meta, b64] = String(dataUrl).split(',');
  const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
  const bin = atob(b64 || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}
