// 影片工具：影片去水印 / 影片去背（影片摳圖）/ 影片放大
import { S, $, $$, mk, clone, clamp, toast, runJob, render, setImage, setCompare, downloadBlob, fit, refreshHist } from './core.js';
import * as AI from './ai.js';
import * as VD from './video.js';
import * as COMFY from './comfy.js';
import { canvasPool } from './canvas.js';
import { sl } from './tools-image.js';

export const vtools = {};
export let V = null;
const val = (id) => +$('#' + id).value;
const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${String(Math.floor((t % 1) * 10))}`;
const even = (v) => Math.max(2, Math.round(v) & ~1);
// pool（選填）：逐格輸出時傳入，重複使用同一張輸出畫布；回傳的畫布只在下一格之前有效
const fitTo = (c, w, h, pool) => {
  if (c.width === w && c.height === h) return c;
  const o = pool ? pool('fit', w, h) : mk(w, h), g = o.getContext('2d');
  g.clearRect(0, 0, w, h); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, w, h);
  return o;
};

// ---------- 載入與時間軸 ----------
let playing = false, playId = 0, frameRequest = null;
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
async function gotoT(t) {
  const source = V, doc = S.doc;
  await VD.seek(source.video, t);
  if (S.mode !== 'video' || V !== source || S.doc !== doc) return;
  drawFrame(); updTime();
}
export function stopPlay() {
  playing = false; playId++;
  if (frameRequest != null) V?.video.cancelVideoFrameCallback(frameRequest);
  frameRequest = null;
  V?.video.pause();
  const b = $('#tlPlay'); if (b) b.textContent = '▶';
}
function startPlay() {
  if (!V || S.mode !== 'video') return;
  const source = V, doc = S.doc, id = ++playId;
  playing = true; $('#tlPlay').textContent = '⏸'; source.video.muted = false;
  source.video.play().catch((e) => {
    if (id !== playId) return;
    stopPlay(); toast('無法播放影片：' + e.message, true);
  });
  const tick = () => {
    if (!playing || id !== playId) return;
    frameRequest = null;
    if (S.mode !== 'video' || V !== source || S.doc !== doc) return stopPlay();
    drawFrame(); $('#tlRange').value = (source.video.currentTime / source.dur) * 1000; updTime();
    if (source.video.ended) return stopPlay();
    frameRequest = source.video.requestVideoFrameCallback(tick);
  };
  frameRequest = source.video.requestVideoFrameCallback(tick);
}
$('#tlPlay').onclick = () => (playing ? stopPlay() : startPlay());
$('#tlRange').oninput = () => { if (!V) return; stopPlay(); gotoT((val('tlRange') / 1000) * V.dur).catch((e) => toast(e.message, true)); };
export const hasVideo = () => !!V;

// ---------- 共用：輸出區塊 ----------
const resultUrls = new Map();
const canSaveToDisk = typeof globalThis.showSaveFilePicker === 'function';
const outBlock = (id, allowMp4 = true) => `
  <h3>輸出</h3>
  <div class="row2"><label>格式 <select id="${id}Fmt"><option value="mp4"${allowMp4 ? '' : ' disabled'}>MP4（H.264）</option><option value="webm"${allowMp4 ? '' : ' selected'}>WebM（VP9）</option></select></label>
  <label>影格率 <select id="${id}Fps"><option value="0">原始（≤30）</option><option value="24">24</option><option value="30">30</option><option value="60">60</option></select></label></div>
  ${canSaveToDisk ? `<label class="chk"><input type="checkbox" id="${id}Disk"> 邊處理邊存到磁碟（長影片、高解析度建議）</label>` : ''}
  <p class="hint">會保留原影片的聲音。處理時請保持此分頁在前景。</p>
  <button class="btn primary big" id="${id}Go">開始處理並輸出</button>
  <div id="${id}Res" class="result"></div>`;
const pickFps = (id) => { const v = val(id + 'Fps'); return v || Math.min(30, V.fps); };

// 勾選存到磁碟時開啟存檔視窗；必須是點擊後第一個 await（檔案選擇器需要使用者手勢）。
// 回傳 { handle }（未勾選時 handle 為 null），使用者取消或失敗時回傳 null
async function saveTarget(id, name, fmt) {
  if (!canSaveToDisk || !$('#' + id + 'Disk')?.checked) return { handle: null };
  try {
    const mime = fmt === 'mp4' ? 'video/mp4' : 'video/webm';
    return { handle: await globalThis.showSaveFilePicker({ suggestedName: name, types: [{ description: fmt.toUpperCase(), accept: { [mime]: ['.' + fmt] } }] }) };
  } catch (e) {
    if (e.name !== 'AbortError') toast('無法開啟存檔視窗：' + e.message, true);
    return null;
  }
}
// 有 handle 時串流寫入該檔案，完成後以磁碟上的 File 作為結果；失敗或取消時丟棄寫入中的內容
async function exportTo(handle, opts) {
  if (!handle) return VD.exportVideo(opts);
  const writable = await handle.createWritable();
  try {
    const r = await VD.exportVideo({ ...opts, writable });
    await writable.close();
    return { ...r, blob: await handle.getFile(), saved: handle.name };
  } catch (e) {
    await writable.abort().catch(() => {});
    throw e;
  }
}
function showResult(id, r, name) {
  const old = resultUrls.get(id);
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(r.blob), el = $('#' + id + 'Res');
  resultUrls.set(id, url);
  el.innerHTML = `<video controls src="${url}"></video>${r.saved ? '<p class="hint" id="' + id + 'Saved"></p>' : `<button class="btn primary" id="${id}Dl">下載 ${name}</button>`}${r.note ? `<p class="hint">${r.note}</p>` : ''}`;
  if (r.saved) $('#' + id + 'Saved').textContent = `已儲存為「${r.saved}」`;
  else $('#' + id + 'Dl').onclick = () => downloadBlob(r.blob, name);
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
        signal, box: ms[i].box, staticMask: true,
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
        stopPlay();
        const before = clone(S.doc), ms = masks();
        const r = await runJob('生成中', ({ signal, progress }) => fill(before, ms, { signal, onProgress: progress }).then((x) => (progress(1), x)));
        if (r) { S.preview = r; setCompare(before); }
      };
      $('#wGo').onclick = async () => {
        if (!needVideo()) return; if (!rects.length) return toast('請先框選水印位置', true);
        stopPlay();
        const fmt = $('#wFmt').value, name = 'xiuxiu-去水印.' + fmt, dest = await saveTarget('w', name, fmt);
        if (!dest) return;
        const ms = masks(), fps = pickFps('w'), ow = even(V.w), oh = even(V.h), pool = canvasPool();
        const r = await runJob('生成中', async ({ signal, progress }) => {
          await AI.getSession('migan', { signal, onProgress: progress });
          return exportTo(dest.handle, { V, fps, format: fmt, alpha: false, outW: ow, outH: oh, signal, onProgress: progress, frameFn: async (f) => fitTo(await fill(f, ms, { signal }), ow, oh, pool) });
        });
        if (r) showResult('w', r, name);
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
        if (!needVideo()) return; stopPlay(); const before = clone(S.doc), { bg, color } = bgOf();
        const r = await runJob('生成中', async ({ signal, progress }) => {
          const m = await AI.createVideoMatter({ signal, onProgress: progress });
          await m.step(before); const a = await m.step(before); // 先暖機一次，讓記憶生效
          return VD.applyMatte(before, a, bg, color);
        });
        if (r) { S.preview = r; setCompare(before); }
      };
      $('#mGo').onclick = async () => {
        if (!needVideo()) return; stopPlay(); const { bg, color } = bgOf(), stab = $('#mStab').checked, fps = pickFps('m'), ow = even(V.w), oh = even(V.h), fmt = $('#mFmt').value, alpha = bg === 'transparent';
        const name = 'xiuxiu-去背.' + fmt, dest = await saveTarget('m', name, fmt);
        if (!dest) return;
        const r = await runJob('生成中', async ({ signal, progress }) => {
          const m = await AI.createVideoMatter({ signal, onProgress: progress }); m.reset();
          let prev = null;
          const pool = canvasPool();
          return exportTo(dest.handle, {
            V, fps, format: fmt, alpha, outW: ow, outH: oh, signal, onProgress: progress,
            frameFn: async (f) => { const a = await m.step(f); if (stab) { a.alpha = VD.stabilizeAlpha(prev, a); prev = a.alpha.slice(); } return fitTo(VD.applyMatte(f, a, bg, color, pool), ow, oh, pool); },
          });
        });
        if (r) showResult('m', r, name);
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
  const useComfy = () => $('input[name=uEng]:checked')?.value === 'comfy';
  const info = () => {
    if (!V) return ($('#uInfo').textContent = '請先載入影片');
    const d = dims(), comfy = useComfy();
    $('#uWebOpt').hidden = comfy; $('#uComfyOpt').hidden = !comfy;
    const slow = !comfy && d.f <= 2 && $('input[name=um]:checked').value !== 'std' ? '<br>此模型只有 4 倍版本，2 倍會先以 4 倍運算再縮小，耗時與 4 倍相同。' : '';
    const tip = comfy ? '由本機 ComfyUI 以顯示卡處理整段影片，處理期間可以切換分頁。' : 'AI 放大每格都很耗時，長影片請預留較多時間。';
    $('#uInfo').innerHTML = `輸出：<b>${d.w} × ${d.h}</b>${d.capped ? '（已限制在 4K 上限）' : ''}${slow}<br><span class="hint">${tip}</span>`;
  };
  // 偵測本機 ComfyUI；偵測不到或沒有放大模型時停用該選項，維持瀏覽器運算
  const detectComfy = async () => {
    const radio = $('input[name=uEng][value=comfy]'), msg = $('#uComfyMsg'), sel = $('#uComfyModel');
    radio.disabled = true; msg.textContent = '偵測中…';
    const st = await COMFY.probe();
    if (!radio.isConnected) return;
    const models = st?.upscaleModels ?? [];
    if (!st) msg.textContent = '未偵測到。請先啟動 ComfyUI（需安裝 VideoHelperSuite），並以 serve.py 開啟本頁';
    else if (!models.length) msg.textContent = '已連線，但 ComfyUI 的 models/upscale_models 資料夾沒有放大模型';
    else {
      radio.disabled = false; msg.textContent = `已連線，可用 ${models.length} 個放大模型，速度通常比瀏覽器快很多`;
      const keep = sel.value;
      sel.innerHTML = models.map((m) => `<option>${m.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`)}</option>`).join('');
      sel.value = models.includes(keep) ? keep : (models.find((m) => /x4plus\b/i.test(m)) ?? models[0]);
    }
    if (radio.disabled && radio.checked) { $('input[name=uEng][value=web]').checked = true; }
    info();
  };
  return {
    label: '影片放大', icon: 'sparkle',
    html: () => `${supportMsg()}
      <h3>放大倍率（上限 4K）</h3><div class="seg" id="uScale"><button data-v="2">2 倍</button><button class="on" data-v="4">4 倍</button></div>
      <h3>運算位置</h3>
      <label class="radio"><input type="radio" name="uEng" value="web" checked> <b>瀏覽器</b><small>使用 WebGPU，不需另外安裝</small></label>
      <label class="radio"><input type="radio" name="uEng" value="comfy" disabled> <b>本機 ComfyUI</b><small id="uComfyMsg">偵測中…</small></label>
      <button class="btn" id="uComfyRetry">重新偵測 ComfyUI</button>
      <div id="uComfyOpt" hidden><h3>放大模型</h3><select id="uComfyModel"></select></div>
      <div id="uWebOpt">
      <h3>AI 模型</h3>
      <label class="radio"><input type="radio" name="um" value="fast" checked> <b>Real-ESRGAN 快速</b><small>影片建議使用</small></label>
      <label class="radio"><input type="radio" name="um" value="std"> <b>Upscayl 標準</b><small>細節最好，非常慢</small></label>
      <label class="radio"><input type="radio" name="um" value="art"> <b>Upscayl 數位藝術</b><small>動畫、插畫</small></label>
      </div>
      <p id="uInfo"></p>${outBlock('u')}`,
    bind() {
      $('#uScale').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $$('#uScale button').forEach((x) => x.classList.toggle('on', x === b)); info(); };
      $$('input[name=um], input[name=uEng]').forEach((r) => (r.onchange = info));
      $('#uComfyRetry').onclick = detectComfy;
      info();
      detectComfy();
      $('#uGo').onclick = async () => {
        if (!needVideo()) return; stopPlay(); const d = dims(), m = $('input[name=um]:checked').value, modelKey = m === 'std' ? (d.f <= 2 ? 'std2' : 'std4') : m, fmt = $('#uFmt').value, fps = pickFps('u');
        const comfy = useComfy(), comfyModel = $('#uComfyModel').value, pool = canvasPool();
        const name = `xiuxiu-放大${d.w}x${d.h}.${fmt}`, dest = comfy ? { handle: null } : await saveTarget('u', name, fmt);
        if (!dest) return;
        const r = await runJob('生成中', async ({ signal, progress }) => {
          if (comfy) {
            return COMFY.upscaleVideo({ file: V.file, model: comfyModel, fps, outW: d.w, outH: d.h, format: fmt, frames: Math.ceil(V.dur * fps), signal, onProgress: progress });
          }
          await AI.getSession(modelKey, { signal, onProgress: progress });
          return exportTo(dest.handle, {
            V, fps, format: fmt, alpha: false, outW: d.w, outH: d.h, signal, onProgress: progress,
            frameFn: async (f) => fitTo(await AI.upscale(f, { model: modelKey, scale: d.f <= 2 ? 2 : 4, signal }), d.w, d.h, pool),
          });
        });
        if (r) showResult('u', r, name);
        await gotoT(V.video.currentTime);
      };
    },
    onVideo() { if ($('#uInfo')) info(); },
  };
})();

addEventListener('pagehide', () => {
  stopPlay();
  for (const url of resultUrls.values()) URL.revokeObjectURL(url);
  resultUrls.clear();
  if (V?.url) URL.revokeObjectURL(V.url);
});

