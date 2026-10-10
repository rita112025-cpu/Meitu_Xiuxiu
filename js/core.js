// 核心：狀態、畫布檢視（縮放/平移）、歷史、AI 工作（進度/取消）、匯出
const HISTORY_MAX_ITEMS = 20;
const HISTORY_MAX_BYTES = 256 * 1024 * 1024;
const canvasBytes = (c) => c ? c.width * c.height * 4 : 0;

export const S = {
  mode: 'image', // image | video
  doc: null, orig: null, hist: [], redo: [],
  view: { s: 1, x: 0, y: 0 },
  hold: false, compare: null, // {before:canvas, pos:0..1}
  preview: null, tool: null, tools: {}, space: false,
};
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export function mk(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
export function clone(c) { const n = mk(c.width, c.height); n.getContext('2d').drawImage(c, 0, 0); return n; }

const cv = $('#cv'), ctx = cv.getContext('2d');
const stage = $('#stage');
let dpr = 1, lastSize = '';

// ---------- 提示 ----------
let toastTimer;
export function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), bad ? 5000 : 2600);
}

// AI 模型退回備用模型時通知使用者（ai.js 發出事件，不直接依賴 DOM）
addEventListener('xiuxiu:model-fallback', (e) => toast(`${e.detail?.from ?? '模型'} 無法使用，已改用 ${e.detail?.to ?? '備用模型'}（品質可能較低）`, true));

// ---------- AI 工作：生成中 + 進度 + 取消 ----------
// 單一工作鎖：底層工作（fn）真正結束前不允許啟動新工作，避免資源衝突。
// 工作進行中收到新請求會被拒絕（不執行 fn、不改動進度）。只有使用者按取消才會中止目前工作；
// UI 會立即返回，但鎖要等底層 fn 結束才釋放。
let jobBusy = false;
export async function runJob(title, fn) {
  if (jobBusy) { toast('目前有工作進行中，請完成或取消後再試', true); return null; }
  jobBusy = true;
  const ac = new AbortController();
  const box = $('#job');
  let uiOpen = true; // UI 返回後，舊工作的進度不再寫入畫面
  const setP = (p, label) => {
    if (!uiOpen) return;
    if (label) $('#jobLabel', box).textContent = label;
    if (p != null) { $('#jobBar', box).style.width = Math.round(clamp(p, 0, 1) * 100) + '%'; $('#jobPct', box).textContent = Math.round(clamp(p, 0, 1) * 100) + '%'; }
  };
  $('#jobTitle', box).textContent = title;
  setP(0, '準備中…');
  box.classList.add('show');
  $('#jobCancel', box).onclick = () => {
    if (!uiOpen || ac.signal.aborted) return;
    ac.abort();
    $('#jobLabel', box).textContent = '正在取消…';
  };
  // 取消後立即返回，不等待底層仍在執行的步驟（例如 ORT 推論無法中斷）
  const aborted = new Promise((_, rej) => ac.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')), { once: true }));
  aborted.catch(() => {});
  const work = Promise.resolve().then(() => fn({ signal: ac.signal, progress: setP }));
  // 底層工作真正結束（完成、失敗或取消後清理完）才釋放鎖
  const release = () => { jobBusy = false; };
  work.then(release, release);
  try {
    const r = await Promise.race([work, aborted]);
    if (ac.signal.aborted) { toast('已取消，畫面維持原樣'); return null; }
    return r;
  } catch (e) {
    if (e?.name === 'AbortError' || ac.signal.aborted) { toast('已取消，畫面維持原樣'); return null; }
    console.error(e); toast('處理失敗：' + (e?.message || e), true); return null;
  } finally {
    uiOpen = false;
    box.classList.remove('show');
    $('#jobCancel', box).onclick = null;
  }
}

// ---------- 渲染 ----------
let raf = 0;
export function render() { if (!raf) raf = requestAnimationFrame(draw); }
let checker;
function getChecker() {
  if (checker) return checker;
  const c = mk(16, 16), g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 16, 16); g.fillStyle = '#d9d9d9'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
  return (checker = ctx.createPattern(c, 'repeat'));
}
export function baseCanvas() { return S.hold ? (S.mode === 'image' ? S.orig : S.doc) : (S.preview || S.doc); }

function draw() {
  raf = 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const src = baseCanvas();
  if (!src) return;
  const { s, x, y } = S.view, W = S.doc.width, H = S.doc.height;
  ctx.save();
  ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * x, dpr * y);
  ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = getChecker(); ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * x, dpr * y);
  ctx.imageSmoothingEnabled = s < 1.5;
  ctx.imageSmoothingQuality = 'high';
  const cmp = S.compare && !S.hold;
  if (cmp) {
    const px = S.compare.pos * W;
    ctx.drawImage(src, 0, 0, W, H);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, px, H); ctx.clip();
    ctx.drawImage(S.compare.before, 0, 0, W, H); ctx.restore();
  } else ctx.drawImage(src, 0, 0, W, H);
  ctx.restore();
  ctx.save();
  ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * x, dpr * y);
  if (!S.hold) S.tool?.overlay?.(ctx, s);
  ctx.restore();
  if (cmp) { // 對比線
    const px = (x + S.compare.pos * W * s) * dpr;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    const y0 = Math.max(0, y * dpr), y1 = Math.min(cv.height, (y + H * s) * dpr);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 4;
    ctx.beginPath(); ctx.moveTo(px, y0); ctx.lineTo(px, y1); ctx.stroke();
    const cy = (y0 + y1) / 2; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px, cy, 14 * dpr, 0, 7); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#444'; ctx.font = `${12 * dpr}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('◀▶', px, cy);
    ctx.font = `${12 * dpr}px sans-serif`; ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(px - 44 * dpr, y0 + 8 * dpr, 40 * dpr, 20 * dpr); ctx.fillRect(px + 4 * dpr, y0 + 8 * dpr, 40 * dpr, 20 * dpr);
    ctx.fillStyle = '#fff'; ctx.fillText('原圖', px - 24 * dpr, y0 + 18 * dpr); ctx.fillText('處理後', px + 24 * dpr, y0 + 18 * dpr);
    ctx.restore();
  }
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  const r = stage.getBoundingClientRect();
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
  render();
}
new ResizeObserver(resize).observe(stage);

export function fit() {
  if (!S.doc) return;
  const r = stage.getBoundingClientRect();
  const s = clamp(Math.min((r.width - 48) / S.doc.width, (r.height - 48) / S.doc.height), 0.02, 2);
  S.view = { s, x: (r.width - S.doc.width * s) / 2, y: (r.height - S.doc.height * s) / 2 };
  updateZoom(); render();
}
export function zoomAt(mx, my, k) {
  const v = S.view, ns = clamp(v.s * k, 0.02, 32);
  const ix = (mx - v.x) / v.s, iy = (my - v.y) / v.s;
  v.s = ns; v.x = mx - ix * ns; v.y = my - iy * ns; updateZoom(); render();
}
function updateZoom() { $('#zoomTxt').textContent = Math.round(S.view.s * 100) + '%'; }
export function toImg(e) {
  const r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left - S.view.x) / S.view.s, y: (e.clientY - r.top - S.view.y) / S.view.s, sx: e.clientX - r.left, sy: e.clientY - r.top };
}

// ---------- 指標互動 ----------
let pan = null, cdrag = false;
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016));
}, { passive: false });
cv.addEventListener('pointerdown', (e) => {
  if (!S.doc) return;
  cv.setPointerCapture(e.pointerId);
  if (S.space || e.button === 1) { pan = { x: e.clientX, y: e.clientY, vx: S.view.x, vy: S.view.y }; cv.style.cursor = 'grabbing'; return; }
  if (e.button !== 0) return;
  const p = toImg(e);
  if (S.compare && !S.hold && Math.abs(p.sx - (S.view.x + S.compare.pos * S.doc.width * S.view.s)) < 18) { cdrag = true; return; }
  S.tool?.down?.(p, e);
});
cv.addEventListener('pointermove', (e) => {
  if (pan) { S.view.x = pan.vx + e.clientX - pan.x; S.view.y = pan.vy + e.clientY - pan.y; render(); return; }
  if (!S.doc) return;
  const p = toImg(e);
  if (cdrag) { S.compare.pos = clamp(p.x / S.doc.width, 0, 1); render(); return; }
  S.tool?.move?.(p, e);
});
const endPtr = (e) => {
  if (pan) { pan = null; cv.style.cursor = S.space ? 'grab' : ''; return; }
  if (cdrag) { cdrag = false; return; }
  if (S.doc) S.tool?.up?.(toImg(e), e);
};
cv.addEventListener('pointerup', endPtr);
cv.addEventListener('pointercancel', endPtr);
addEventListener('keydown', (e) => {
  const t = e.target.tagName;
  if (e.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t)) { e.preventDefault(); S.space = true; cv.style.cursor = 'grab'; }
  if ((e.ctrlKey || e.metaKey) && !['INPUT', 'TEXTAREA'].includes(t)) {
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  }
});
addEventListener('keyup', (e) => { if (e.code === 'Space') { S.space = false; cv.style.cursor = ''; } });

// ---------- 歷史 ----------
function sizeKey() { return S.doc ? S.doc.width + 'x' + S.doc.height : ''; }
function afterDocChange() {
  S.preview = null;
  S.tool?.onDocChange?.();
  const k = sizeKey(); if (k !== lastSize) { lastSize = k; fit(); }
  refreshHist(); render();
}
export function refreshHist() {
  $('#btnUndo').disabled = !S.hist.length; $('#btnRedo').disabled = !S.redo.length; $('#btnReset').disabled = !S.doc;
  $('#sizeTxt').textContent = S.doc ? `${S.doc.width} × ${S.doc.height}` : '';
  $('#cmpClose').hidden = !S.compare;
}
export function setImage(canvas) { // 載入新圖（清空歷史）
  S.orig = clone(canvas); S.doc = canvas; S.hist = []; S.redo = []; S.compare = null; lastSize = '';
  $('#empty').hidden = true; afterDocChange();
}
function trimHistory() {
  let bytes = S.hist.reduce((n, c) => n + canvasBytes(c), 0);
  while (S.hist.length > HISTORY_MAX_ITEMS || (S.hist.length > 1 && bytes > HISTORY_MAX_BYTES)) {
    bytes -= canvasBytes(S.hist.shift());
  }
}
export function commit(canvas) {
  if (S.doc) { S.hist.push(S.doc); trimHistory(); }
  S.redo = []; S.doc = canvas; S.compare = null; afterDocChange();
}
export function setCompare(before) { S.compare = { before, pos: 0.5 }; refreshHist(); render(); }
export function undo() { if (!S.hist.length) return; S.redo.push(S.doc); S.doc = S.hist.pop(); S.compare = null; afterDocChange(); }
export function redo() { if (!S.redo.length) return; S.hist.push(S.doc); trimHistory(); S.doc = S.redo.pop(); S.compare = null; afterDocChange(); }
export function resetAll() { if (!S.orig || S.mode !== 'image') return; commit(clone(S.orig)); toast('已重置為原圖（可復原）'); }

$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo; $('#btnReset').onclick = resetAll;
$('#btnFit').onclick = fit;
$('#zoomIn').onclick = () => zoomAt(cv.width / dpr / 2, cv.height / dpr / 2, 1.25);
$('#zoomOut').onclick = () => zoomAt(cv.width / dpr / 2, cv.height / dpr / 2, 0.8);
$('#cmpClose').onclick = () => { S.compare = null; refreshHist(); render(); };
const hold = $('#btnHold');
const setHold = (v) => { S.hold = v; render(); };
hold.addEventListener('pointerdown', (e) => { hold.setPointerCapture(e.pointerId); setHold(true); });
hold.addEventListener('pointerup', () => setHold(false));
hold.addEventListener('pointercancel', () => setHold(false));

// ---------- 匯出 ----------
export function downloadBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export function exportCanvas(canvas, fmt, q, name = 'xiuxiu') {
  const type = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[fmt];
  let c = canvas;
  if (fmt === 'jpg') { c = mk(canvas.width, canvas.height); const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(canvas, 0, 0); }
  c.toBlob((b) => { if (!b) return toast('匯出失敗', true); downloadBlob(b, `${name}.${fmt}`); }, type, q);
}
$('#btnExport').onclick = () => {
  if (!S.doc || S.mode !== 'image') return toast('請先開啟圖片', true);
  const fmt = $('#expFmt').value;
  exportCanvas(S.doc, fmt, +$('#expQ').value / 100, 'xiuxiu-edit');
  $('#expMenu').hidden = true;
};
$('#expFmt').onchange = () => ($('#expQRow').hidden = $('#expFmt').value === 'png');
$('#btnExpMenu').onclick = (e) => { e.stopPropagation(); $('#expMenu').hidden = !$('#expMenu').hidden; };
addEventListener('click', (e) => { if (!e.target.closest('#expWrap')) $('#expMenu').hidden = true; });
$('#expQ').oninput = () => ($('#expQv').textContent = $('#expQ').value);

// ---------- 載入圖片 ----------
export async function fileToCanvas(file) {
  const bmp = await createImageBitmap(file);
  const c = mk(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0); bmp.close?.();
  return c;
}
