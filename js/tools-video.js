// 影片工具：影片去水印 / 影片去背（影片摳圖）/ 影片放大
import { S, $, $$, mk, clone, clamp, toast, runJob, render, setImage, setCompare, downloadBlob, fit, refreshHist } from './core.js';
import * as AI from './ai.js';
import * as VD from './video.js';
import { sl } from './tools-image.js';

export const vtools = {};
export let V = null;
const val = (id) => +$('#' + id).value;
const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${String(Math.floor((t % 1) * 10))}`;
const even = (v) => Math.max(2, Math.round(v) & ~1);
const fitTo = (c, w, h) => { if (c.width === w && c.height === h) return c; const o = mk(w, h), g = o.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, w, h); return o; };

// ---------- 載入與時間軸 ----------
let playing = false;
export async function loadVideoFile(file) {
  stopPlay();
  const v = await VD.loadVideo(file);
  if (V) URL.revokeObjectURL(V.url);
  V = v;
  const c = mk(V.w, V.h); c.getContext('2d').drawImage(V.video, 0, 0);
  setImage(c); // 以第一格作為畫面
  $('#tlRange').value = 0; updTime(); $('#timeline').hidden = false;
  vtools.vwm.reset?.();
  toast(`已載入影片 ${V.w}×${V.h}，約 ${V.fps} fps，${fmtT(V.dur)}`);
}
function drawFrame() {
  S.doc.getContext('2d').drawImage(V.video, 0, 0);
  S.preview = null; S.compare = null; refreshHist(); render();
}
function updTime() { $('#tlTime').textContent = `${fmtT(V?.video.currentTime || 0)} / ${fmtT(V?.dur || 0)}`; }
async function gotoT(t) { await VD.seek(V.video, t); drawFrame(); updTime(); }
function stopPlay() { playing = false; V?.video.pause(); const b = $('#tlPlay'); if (b) b.textContent = '▶'; }
function startPlay() {
  if (!V) return; playing = true; $('#tlPlay').textContent = '⏸'; V.video.muted = false; V.video.play();
  const tick = () => {
    if (!playing) return;
    drawFrame(); $('#tlRange').value = (V.video.currentTime / V.dur) * 1000; updTime();
    if (V.video.ended) return stopPlay();
    V.video.requestVideoFrameCallback(tick);
  };
  V.video.requestVideoFrameCallback(tick);
}
$('#tlPlay').onclick = () => (playing ? stopPlay() : startPlay());
$('#tlRange').oninput = () => { if (!V) return; stopPlay(); gotoT((val('tlRange') / 1000) * V.dur); };
export const hasVideo = () => !!V;

// ---------- 共用：輸出區塊 ----------
const resultUrls = new Map();
const outBlock = (id, allowMp4 = true) => `
  <h3>輸出</h3>
  <div class="row2"><label>格式 <select id="${id}Fmt"><option value="mp4"${allowMp4 ? '' : ' disabled'}>MP4（H.264）</option><option value="webm"${allowMp4 ? '' : ' selected'}>WebM（VP9）</option></select></label>
  <label>影格率 <select id="${id}Fps"><option value="0">原始（≤30）</option><option value="24">24</option><option value="30">30</option><option value="60">60</option></select></label></div>
  <p class="hint">會保留原影片的聲音。處理時請保持此分頁在前景。</p>
  <button class="btn primary big" id="${id}Go">開始處理並輸出</button>
  <div id="${id}Res" class="result"></div>`;
const pickFps = (id) => { const v = val(id + 'Fps'); return v || Math.min(30, V.fps); };
function showResult(id, r, name) {
  const old = resultUrls.get(id);
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(r.blob), el = $('#' + id + 'Res');
  resultUrls.set(id, url);
  el.innerHTML = `<video controls src="${url}"></video><button class="btn primary" id="${id}Dl">下載 ${name}</button>${r.note ? `<p class="hint">${r.note}</p>` : ''}`;
  $('#' + id + 'Dl').onclick = () => downloadBlob(r.blob, name);
}
const needVideo = () => (V ? true : (toast('請先到「新增」載入影片', true), false));
const supportMsg = () => (VD.supported() ? '' : '<p class="warn">此瀏覽器不支援 WebCodecs，無法輸出影片，請改用最新版 Chrome / Edge。</p>');

// ============ 影片去水印 ============
vtools.vwm = (() => {
  let rects = [], cur = null;
  const PAD = 3; // 遮罩比框選範圍多出的邊界，蓋住水印邊緣
  // 遮罩的外接矩形（與 masks() 的填色範圍一致，並限制在影格內），每格重複使用，不必重掃遮罩
  const boxOf = (r) => {
    const x0 = Math.max(0, Math.floor(r.x - PAD)), y0 = Math.max(0, Math.floor(r.y - PAD));
    const x1 = Math.min(V.w, Math.ceil(r.x + r.w + PAD)), y1 = Math.min(V.h, Math.ceil(r.y + r.h + PAD));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  const masks = () => rects.map((r) => {
    const c = mk(V.w, V.h), g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(r.x - PAD, r.y - PAD, r.w + 2 * PAD, r.h + 2 * PAD);
    return { canvas: c, box: boxOf(r) };
  });
  const fill = async (frame, ms, { signal, onProgress } = {}) => {
    let s = frame;
    for (let i = 0; i < ms.length; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      s = (await AI.inpaint(s, ms[i].canvas, {
        signal, box: ms[i].box,
        onProgress: (p, label) => onProgress?.((i + (p ?? 0)) / ms.length, label),
      })) || s;
    }
    return s;
  };
  const listHtml = () => {
    $('#wList').innerHTML = rects.map((r, i) => `<div class="li"><span>區域 ${i + 1}：${Math.round(r.w)}×${Math.round(r.h)}</span><button data-i="${i}">刪除</button></div>`).join('') || '<p class="hint">尚未框選。在畫面上拖曳畫出水印、台標或 Logo 的位置（可框多個）。</p>';
  };
  return {
    label: '影片去水印', icon: 'drop',
    reset() { rects = []; cur = null; },
    html: () => `${supportMsg()}
      <p class="hint">① 在畫面上框住固定位置的水印／台標／Logo（可框多個）<br>② 拖動下方時間軸，按「預覽目前這格」確認填補效果<br>③ 開始處理，逐格用 MI-GAN 填補</p>
      <div id="wList"></div>
      <button class="btn" id="wPrev">預覽目前這格</button>
      ${outBlock('w')}`,
    bind() {
      listHtml();
      $('#wList').onclick = (e) => { const b = e.target.closest('button'); if (b) { rects.splice(+b.dataset.i, 1); listHtml(); render(); } };
      $('#wPrev').onclick = async () => {
        if (!needVideo() || !rects.length) return toast('請先框選水印位置', true);
        const before = clone(S.doc), ms = masks();
        const r = await runJob('生成中', ({ signal, progress }) => fill(before, ms, { signal, onProgress: progress }).then((x) => (progress(1), x)));
        if (r) { S.preview = r; setCompare(before); }
      };
      $('#wGo').onclick = async () => {
        if (!needVideo()) return; if (!rects.length) return toast('請先框選水印位置', true);
        const ms = masks(), fps = pickFps('w'), ow = even(V.w), oh = even(V.h), fmt = $('#wFmt').value;
        const r = await runJob('生成中', async ({ signal, progress }) => {
          await AI.getSession('migan', { signal, onProgress: progress });
          return VD.exportVideo({ V, fps, format: fmt, alpha: false, outW: ow, outH: oh, signal, onProgress: progress, frameFn: async (f) => fitTo(await fill(f, ms, { signal }), ow, oh) });
        });
        if (r) showResult('w', r, 'xiuxiu-去水印.' + fmt);
        await gotoT(V.video.currentTime);
      };
    },
    down(p) { if (!V) return; cur = { x0: clamp(p.x, 0, V.w), y0: clamp(p.y, 0, V.h), x1: p.x, y1: p.y }; },
    move(p) { if (cur) { cur.x1 = clamp(p.x, 0, V.w); cur.y1 = clamp(p.y, 0, V.h); render(); } },
    up() {
      if (!cur) return; const r = { x: Math.min(cur.x0, cur.x1), y: Math.min(cur.y0, cur.y1), w: Math.abs(cur.x1 - cur.x0), h: Math.abs(cur.y1 - cur.y0) };
      cur = null; if (r.w > 3 && r.h > 3) { rects.push(r); listHtml(); } render();
    },
    overlay(g, s) {
      g.lineWidth = 2 / s; g.setLineDash([6 / s, 4 / s]); g.strokeStyle = '#ff3b3b'; g.fillStyle = 'rgba(255,59,59,.25)'; g.font = `${14 / s}px sans-serif`;
      const all = [...rects]; if (cur) all.push({ x: Math.min(cur.x0, cur.x1), y: Math.min(cur.y0, cur.y1), w: Math.abs(cur.x1 - cur.x0), h: Math.abs(cur.y1 - cur.y0) });
      all.forEach((r, i) => { g.fillRect(r.x, r.y, r.w, r.h); g.strokeRect(r.x, r.y, r.w, r.h); g.save(); g.setLineDash([]); g.fillStyle = '#ff3b3b'; g.fillText(String(i + 1), r.x + 4 / s, r.y + 16 / s); g.restore(); });
    },
  };
})();

// ============ 影片去背 ============
vtools.vmatte = (() => {
  const bgOf = () => ({ bg: $('#mBg').value, color: $('#mColor').value });
  return {
    label: '影片摳圖', icon: 'video',
    html: () => `${supportMsg()}
      <p class="hint">逐格辨識人物或主體並去背（RVM 具時間記憶，邊緣較穩定）。首次需下載約 8 MB 模型。</p>
      <h3>背景</h3>
      <select id="mBg"><option value="transparent">透明（輸出 WebM）</option><option value="green">綠幕</option><option value="white">白色</option><option value="blur">原畫面模糊</option><option value="color">自訂顏色</option></select>
      <div class="row2"><label>顏色 <input type="color" id="mColor" value="#2f6fed"></label></div>
      <label class="chk"><input type="checkbox" id="mStab" checked> 減少邊緣閃爍</label>
      <button class="btn" id="mPrev">預覽目前這格</button>
      ${outBlock('m')}`,
    bind() {
      const sync = () => { const tr = $('#mBg').value === 'transparent'; if (tr) $('#mFmt').value = 'webm'; $('#mFmt').querySelector('[value=mp4]').disabled = tr; };
      $('#mBg').onchange = sync; sync();
      $('#mPrev').onclick = async () => {
        if (!needVideo()) return; const before = clone(S.doc), { bg, color } = bgOf();
        const r = await runJob('生成中', async ({ signal, progress }) => {
          const m = await AI.createVideoMatter({ signal, onProgress: progress });
          await m.step(before); const a = await m.step(before); // 先暖機一次，讓記憶生效
          return VD.applyMatte(before, a, bg, color);
        });
        if (r) { S.preview = r; setCompare(before); }
      };
      $('#mGo').onclick = async () => {
        if (!needVideo()) return; const { bg, color } = bgOf(), stab = $('#mStab').checked, fps = pickFps('m'), ow = even(V.w), oh = even(V.h), fmt = $('#mFmt').value, alpha = bg === 'transparent';
        const r = await runJob('生成中', async ({ signal, progress }) => {
          const m = await AI.createVideoMatter({ signal, onProgress: progress }); m.reset();
          let prev = null;
          return VD.exportVideo({
            V, fps, format: fmt, alpha, outW: ow, outH: oh, signal, onProgress: progress,
            frameFn: async (f) => { const a = await m.step(f); if (stab) { a.alpha = VD.stabilizeAlpha(prev, a); prev = a.alpha.slice(); } return fitTo(VD.applyMatte(f, a, bg, color), ow, oh); },
          });
        });
        if (r) showResult('m', r, 'xiuxiu-去背.' + fmt);
        await gotoT(V.video.currentTime);
      };
    },
  };
})();

// ============ 影片放大 ============
vtools.vup = (() => {
  const dims = () => {
    const sc = +$('#uScale .on').dataset.v; let f = sc;
    const mx = Math.max(V.w, V.h), mn = Math.min(V.w, V.h);
    if (mx * f > 3840 || mn * f > 2160) f = Math.min(3840 / mx, 2160 / mn);
    return { sc, f, w: even(V.w * f), h: even(V.h * f), capped: f < sc };
  };
  const info = () => {
    if (!V) return ($('#uInfo').textContent = '請先載入影片');
    const d = dims();
    const slow = d.f <= 2 && $('input[name=um]:checked').value !== 'std' ? '<br>此模型只有 4 倍版本，2 倍會先以 4 倍運算再縮小，耗時與 4 倍相同。' : '';
    $('#uInfo').innerHTML = `輸出：<b>${d.w} × ${d.h}</b>${d.capped ? '（已限制在 4K 上限）' : ''}${slow}<br><span class="hint">AI 放大每格都很耗時，長影片請預留較多時間。</span>`;
  };
  return {
    label: '影片放大', icon: 'sparkle',
    html: () => `${supportMsg()}
      <h3>放大倍率（上限 4K）</h3><div class="seg" id="uScale"><button data-v="2">2 倍</button><button class="on" data-v="4">4 倍</button></div>
      <h3>AI 模型</h3>
      <label class="radio"><input type="radio" name="um" value="fast" checked> <b>Real-ESRGAN 快速</b><small>影片建議使用</small></label>
      <label class="radio"><input type="radio" name="um" value="std"> <b>Upscayl 標準</b><small>細節最好，非常慢</small></label>
      <label class="radio"><input type="radio" name="um" value="art"> <b>Upscayl 數位藝術</b><small>動畫、插畫</small></label>
      <p id="uInfo"></p>${outBlock('u')}`,
    bind() {
      $('#uScale').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $$('#uScale button').forEach((x) => x.classList.toggle('on', x === b)); info(); };
      $$('input[name=um]').forEach((r) => (r.onchange = info));
      info();
      $('#uGo').onclick = async () => {
        if (!needVideo()) return; const d = dims(), m = $('input[name=um]:checked').value, modelKey = m === 'std' ? (d.f <= 2 ? 'std2' : 'std4') : m, fmt = $('#uFmt').value, fps = pickFps('u');
        const r = await runJob('生成中', async ({ signal, progress }) => {
          await AI.getSession(modelKey, { signal, onProgress: progress });
          return VD.exportVideo({
            V, fps, format: fmt, alpha: false, outW: d.w, outH: d.h, signal, onProgress: progress,
            frameFn: async (f) => fitTo(await AI.upscale(f, { model: modelKey, scale: d.f <= 2 ? 2 : 4, signal }), d.w, d.h),
          });
        });
        if (r) showResult('u', r, `xiuxiu-放大${d.w}x${d.h}.${fmt}`);
        await gotoT(V.video.currentTime);
      };
    },
    onVideo() { if ($('#uInfo')) info(); },
  };
})();

addEventListener('pagehide', () => {
  for (const url of resultUrls.values()) URL.revokeObjectURL(url);
  resultUrls.clear();
  if (V?.url) URL.revokeObjectURL(V.url);
});
