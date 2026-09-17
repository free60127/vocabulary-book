import React, { useRef } from 'react';
import { X, Camera, Image as ImageIcon, Check, AlertTriangle, Trash2, Upload, SwitchCamera } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap.js';
import { useEscape } from '../../hooks/useEscape.js';
import { useCamera, dataUrlToFile } from '../../hooks/useCamera.js';

/**
 * 拍照/上传 → 识别单词表 → 勾选 → 导入单词本。
 *
 * 界面按"三步"组织，每一步都让用户看得见自己在哪：
 *  ① **选图**（拍照 / 从相册选）：手机直接调摄像头（`capture="environment"` 后置）；
 *  ② **识别中**：显示已等秒数（整页手写要 20~40 秒）；
 *  ③ **核对清单**：默认**全部勾选**，可以逐条取消、改字、删行；疑问项（模型标了 `?`）
 *     高亮提示"请核对"；底部选本子 → 一键导入。
 *
 * 为什么要在导入前给这么强的编辑能力：手写识别一定会有个别字错，
 * 而"错了进本子"比"多点两下"代价大得多 —— 后者是几秒，前者要用户日后自己发现并清理。
 */
export default function ImageImportModal({ imp, books, onCreateBook, onClose }) {
  const trapRef = useFocusTrap();
  /**
   * 应用内相机。
   *
   * 原来「拍照」用的是 `<input capture="environment">`，但**安卓 Chrome 常常忽略它**、
   * 直接弹系统照片选择器（用户实测："点拍照和从相册选一样"）。
   * 现在改成自己开相机（getUserMedia + video + canvas 抓帧），两端行为一致；
   * 实在不可用（不支持 / 没权限）时退回系统选择器 —— 不是死路。
   */
  const cam = useCamera();
  useEscape(cam.open ? cam.close : onClose);
  const fileRef = useRef(null);
  const cameraRef = useRef(null);

  const pick = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';                    // 允许重复选同一张图
    if (f) imp.recognize(f);
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal import-modal" role="dialog" ref={trapRef} aria-modal="true" aria-label="拍照导入单词" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>拍照 / 上传导入</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>

        {/* ---------- ① 选图 ---------- */}
        {imp.phase === 'pick' ? (
          <div className="import-pick">
            <p className="muted small">
              拍下或上传你的**单词表**（手写、打印都行）。识别后会按阅读顺序列出来，
              <b>默认全部勾选</b>，你可以取消不要的、改掉认错的字，再选一个单词本导入。
            </p>
            <div className="import-actions">
              {/* 手机：应用内相机（安卓/iOS 行为一致）；不支持或没权限时退回系统相机/选择器 */}
              <button className="primary-btn" onClick={() => {
                if (cam.canUse) cam.setOpen(true);
                else if (cameraRef.current) cameraRef.current.click();
              }}>
                <Camera size={16} />拍照
              </button>
              <button className="ghost-btn" onClick={() => fileRef.current && fileRef.current.click()}>
                <ImageIcon size={16} />从相册/文件选择
              </button>
            </div>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={pick} />
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
            {imp.error ? <p className="import-error">{imp.error}</p> : null}
            <ul className="import-tips muted small">
              <li>把纸放平、尽量占满画面，光线均匀（避开阴影和反光）</li>
              <li>手写连笔多的话，可以离近一点分两张拍，识别更准</li>
              <li>同一张图再传一次会直接命中上次结果，不会重复花钱</li>
            </ul>
          </div>
        ) : null}

        {/* ---------- ①b 取景 ---------- */}
        {cam.open ? (
          <div className="camera-pane">
            <video ref={cam.videoRef} className="camera-video" playsInline muted autoPlay />
            {cam.error ? <p className="import-error">{cam.error}</p> : null}
            <div className="camera-actions">
              <button className="ghost-btn" onClick={cam.close}><X size={15} />取消</button>
              <button className="ghost-btn" onClick={() => cam.setFacing(cam.facing === 'environment' ? 'user' : 'environment')}
                title="切换前后摄像头">
                <SwitchCamera size={15} />换镜头
              </button>
              <button className="primary-btn" disabled={!cam.ready || Boolean(cam.error)}
                onClick={() => {
                  const shot = cam.capture();
                  if (!shot) return;
                  cam.close();
                  imp.recognize(dataUrlToFile(shot));
                }}>
                <Camera size={16} />拍摄
              </button>
            </div>
            <p className="muted small">让单词表占满画面、光线均匀，字迹清楚即可。</p>
          </div>
        ) : null}

        {/* ---------- ② 识别中 ---------- */}
        {imp.phase === 'working' ? (
          <div className="import-working">
            {imp.preview ? <img className="import-preview" src={imp.preview} alt="待识别的单词表" /> : null}
            <p className="import-progress"><Upload size={14} />{imp.progress || '正在识别…'}</p>
          </div>
        ) : null}

        {/* ---------- ③ 核对清单 ---------- */}
        {imp.phase === 'review' ? (
          <div className="import-review">
            {imp.visionInfo && imp.visionInfo.model ? (
              <p className="muted small import-model">
                识别模型：{imp.visionInfo.model}
                {imp.visionInfo.fellBack ? '（当前模型不支持图片，已自动改用 deepseek-flash）' : ''}
                {imp.visionInfo.cached ? ' · 命中上次结果（没重复计费）' : ''}
              </p>
            ) : null}
            <div className="import-bar">
              <span className="import-count">已选 <b>{imp.checkedCount}</b> / {imp.items.length}</span>
              <button className="link-btn" onClick={() => imp.setAll(true)}>全选</button>
              <button className="link-btn" onClick={() => imp.setAll(false)}>全不选</button>
              <button className="link-btn" onClick={imp.retry}>重新识别</button>
            </div>
            <ul className="import-list">
              {imp.items.map((it, i) => (
                <li key={i} className={'import-row' + (it.checked ? ' on' : '') + (it.doubt ? ' doubt' : '')}>
                  <label className="import-check">
                    <input type="checkbox" checked={it.checked} onChange={() => imp.toggle(i)} />
                    <span className="import-idx">{it.index}</span>
                  </label>
                  {/* 词与释义放一组：桌面端并排，手机端上下两行（否则一行要占三四行高度） */}
                  <span className="import-fields">
                    <input className="import-word" value={it.word}
                      placeholder="（没认出来，请补全）"
                      onChange={(e) => imp.edit(i, { word: e.target.value })} aria-label={'第 ' + it.index + ' 个词'} />
                    <input className="import-cn" value={it.cn} placeholder="（没有释义）"
                      onChange={(e) => imp.edit(i, { cn: e.target.value })} aria-label={'第 ' + it.index + ' 个词的中文'} />
                  </span>
                  {it.word === '?' ? (
                    <span className="import-doubt" title="这一行没认出来 —— 补全单词后就能导入">
                      <AlertTriangle size={13} />待补全
                    </span>
                  ) : it.doubt ? (
                    <span className="import-doubt" title="手写体不好认，模型把握不大 —— 请核对拼写">
                      <AlertTriangle size={13} />核对
                    </span>
                  ) : null}
                  <button className="icon-btn" onClick={() => imp.drop(i)} aria-label="删除这一条"><Trash2 size={13} /></button>
                </li>
              ))}
            </ul>
            {imp.error ? <p className="import-error">{imp.error}</p> : null}
            <div className="import-foot">
              {books.length ? (
                <select className="ocr-mode" value={imp.bookId} onChange={(e) => imp.setBookId(e.target.value)} aria-label="导入到哪个单词本">
                  {books.map((b) => <option key={b.id} value={b.id}>{b.name}（{b.entries.length}）</option>)}
                </select>
              ) : (
                /* 还没有任何本子 → 就地建一个（不再弹第二个对话框，模态叠模态很难用） */
                <span className="import-newbook">
                  <input className="import-newbook-name" placeholder="新单词本名字（如 英语文摘2026）"
                    value={imp.newBookName || ''} aria-label="新单词本名字"
                    onChange={(e) => imp.setNewBookName(e.target.value)} />
                  <button className="ghost-btn" onClick={() => {
                    const b = onCreateBook(imp.newBookName);
                    if (b) imp.setBookId(b.id);
                  }}>建立</button>
                </span>
              )}
              <button className="primary-btn" disabled={!imp.checkedCount || !books.length} onClick={imp.doImport}>
                <Check size={16} />导入 {imp.checkedCount} 个词
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
