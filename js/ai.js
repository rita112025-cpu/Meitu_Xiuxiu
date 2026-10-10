// AI 推論層：onnxruntime-web (WebGPU 優先，失敗退回 WASM)。所有影像資料只留在瀏覽器；只有模型權重會從網路下載並快取。
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const HF = 'https://huggingface.co/';

export const MODELS = {
  migan: { name: 'MI-GAN', url: HF + 'anyisalin/migan-onnx/resolve/main/onnx/migan_pipeline.onnx', size: 28 },
  u2net: { name: 'U²-Net', url: HF + 'Heliosoph/u2net-onnx/resolve/main/u2net.onnx', size: 176 },
  u2netp: { name: 'U²-Net (輕量)', url: HF + 'Heliosoph/u2net-onnx/resolve/main/u2netp.onnx', size: 5 },
  rvm: { name: 'RVM 影片摳圖', url: HF + 'inverseaibd/rvm_mobilenetv3_fp16/resolve/main/rvm_mobilenetv3_fp16.onnx', size: 8 },
  // 放大模型。tile 為單次推論的圖塊大小
  fast: { name: 'Real-ESRGAN 快速', url: HF + 'Heliosoph/realesrgan-onnx/resolve/main/realesr-general-x4v3.onnx', size: 5, scale: 4, tile: 256 },
  std4: { name: 'Upscayl 標準 ×4', url: HF + 'SceneWorks/real-esrgan-onnx/resolve/main/real_esrgan_x4.onnx', size: 67, scale: 4, tile: 160 },
  std2: { name: 'Upscayl 標準 ×2', url: HF + 'SceneWorks/real-esrgan-onnx/resolve/main/real_esrgan_x2.onnx', size: 67, scale: 2, tile: 224 },
  art: { name: 'Upscayl 數位藝術', url: HF + 'RekluzLabs/realesrgan_anime6b.onnx/resolve/main/realesrgan_anime6b.onnx', size: 18, scale: 4, tile: 192 },
};

export const hasGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
const sessions = new Map();
const loading = new Map(); // 進行中的模型載入，避免並行呼叫重複下載與建立 session
let ortP;
function getOrt() {
  // 失敗時清除快取，下次呼叫可以重新嘗試載入（否則一次網路失敗會讓 AI 功能直到重新整理前都不能用）
  ortP ||= import(ORT_BASE + 'ort.webgpu.min.mjs').then((o) => {
    o.env.wasm.wasmPaths = ORT_BASE;
    o.env.wasm.numThreads = 1;
    return o;
  }).catch((e) => { ortP = null; throw e; });
  return ortP;
}

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
const abortCheck = (s) => { if (s?.aborted) throw new DOMException('Aborted', 'AbortError'); };

async function fetchModel(key, onProgress, signal) {
  const m = MODELS[key];
  let cache;
  try {
    cache = await caches.open('xiuxiu-models-v1');
    const hit = await cache.match(m.url);
    if (hit) return await hit.arrayBuffer();
  } catch { /* 無快取可用 */ }
  const res = await fetch(m.url, { signal });
  if (!res.ok) throw new Error(`模型下載失敗 (${res.status})`);
  const total = +res.headers.get('content-length') || m.size * 1e6;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(Math.min(1, got / total), `下載 ${m.name} 模型 ${(got / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB（僅首次）`);
  }
  const blob = new Blob(chunks);
  try { await cache?.put(m.url, new Response(blob)); } catch { /* 忽略 */ }
  return await blob.arrayBuffer();
}

async function createSession(key, buf, eps) {
  const ort = await getOrt();
  const s = await ort.InferenceSession.create(buf, { executionProviders: eps, graphOptimizationLevel: 'all' });
  return { s, ep: eps[0], ort };
}

async function loadSession(key, { onProgress, signal }) {
  const buf = await fetchModel(key, onProgress, signal);
  abortCheck(signal);
  onProgress?.(1, `載入 ${MODELS[key].name}…`);
  let entry;
  try { entry = await createSession(key, buf, hasGPU ? ['webgpu', 'wasm'] : ['wasm']); }
  catch (e) { console.warn('WebGPU 建立失敗，改用 WASM', e); entry = await createSession(key, buf, ['wasm']); }
  sessions.set(key, entry);
  return entry;
}

// 同一模型的並行呼叫共用同一個載入 Promise；失敗後移除，讓下一次呼叫可以重試。
// 注意：共用的載入只受發起者的 signal 控制。
export async function getSession(key, { onProgress, signal } = {}) {
  if (sessions.has(key)) return sessions.get(key);
  if (!loading.has(key)) {
    loading.set(key, loadSession(key, { onProgress, signal }).finally(() => loading.delete(key)));
  }
  return loading.get(key);
}

// 執行推論；WebGPU 執行失敗時自動退回 WASM 重試一次
async function run(key, feedsFn, opts) {
  let ent = await getSession(key, opts);
  try { return await ent.s.run(feedsFn(ent.ort), undefined); }
  catch (e) {
    if (ent.ep === 'wasm') throw e;
    console.warn('WebGPU 推論失敗，改用 WASM', e);
    sessions.delete(key);
    try { await ent.s.release?.(); } catch (re) { console.warn('釋放 WebGPU session 失敗', re); }
    const buf = await fetchModel(key);
    ent = await createSession(key, buf, ['wasm']);
    sessions.set(key, ent);
    return await ent.s.run(feedsFn(ent.ort));
  }
}

export const backendName = () => (hasGPU ? 'WebGPU' : 'WASM(CPU)');

// ---------- 影像工具 ----------
function bbox(maskCanvas) {
  const { width: w, height: h } = maskCanvas;
  const d = maskCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
const r8 = (v) => Math.max(64, Math.round(v / 8) * 8);

// ---------- MI-GAN 消除 ----------
// maskCanvas：要消除處 alpha>0。回傳新的 canvas（與 src 同尺寸）。
export async function inpaint(src, maskCanvas, { signal, onProgress } = {}) {
  const W = src.width, H = src.height;
  const bb = bbox(maskCanvas);
  if (!bb) return null;
  const pad = 6;
  const ctxPad = Math.round(Math.max(bb.w, bb.h) * 0.6 + 48);
  const cx0 = Math.max(0, bb.x - ctxPad), cy0 = Math.max(0, bb.y - ctxPad);
  const cx1 = Math.min(W, bb.x + bb.w + ctxPad), cy1 = Math.min(H, bb.y + bb.h + ctxPad);
  const cw = cx1 - cx0, ch = cy1 - cy0;
  const f = Math.min(1, 512 / Math.max(cw, ch));
  const tw = r8(cw * f), th = r8(ch * f);

  const inC = mk(tw, th), ic = inC.getContext('2d');
  ic.imageSmoothingQuality = 'high';
  ic.drawImage(src, cx0, cy0, cw, ch, 0, 0, tw, th);
  const mC = mk(tw, th), mc = mC.getContext('2d');
  mc.filter = `blur(${pad / 2}px)`;
  mc.drawImage(maskCanvas, cx0, cy0, cw, ch, 0, 0, tw, th);
  // 把遮罩往外擴一點，避免殘邊
  mc.filter = 'none'; mc.globalAlpha = 1;
  mc.drawImage(mC, 0, 0);
  const id = ic.getImageData(0, 0, tw, th).data, md = mc.getImageData(0, 0, tw, th).data;
  const n = tw * th;
  const img = new Uint8Array(3 * n), msk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    img[i] = id[i * 4]; img[n + i] = id[i * 4 + 1]; img[2 * n + i] = id[i * 4 + 2];
    msk[i] = md[i * 4 + 3] > 8 ? 0 : 255; // MI-GAN：0 = 要補的洞，255 = 已知
    if (msk[i] === 0) { img[i] = img[n + i] = img[2 * n + i] = 0; }
  }
  abortCheck(signal);
  onProgress?.(0.3, 'MI-GAN 生成中…');
  const out = await run('migan', (ort) => ({
    image: new ort.Tensor('uint8', img, [1, 3, th, tw]),
    mask: new ort.Tensor('uint8', msk, [1, 1, th, tw]),
  }), { signal, onProgress });
  abortCheck(signal);
  const od = out[Object.keys(out)[0]].data;
  const patch = new ImageData(tw, th);
  for (let i = 0; i < n; i++) {
    patch.data[i * 4] = od[i]; patch.data[i * 4 + 1] = od[n + i]; patch.data[i * 4 + 2] = od[2 * n + i]; patch.data[i * 4 + 3] = 255;
  }
  const pC = mk(tw, th); pC.getContext('2d').putImageData(patch, 0, 0);
  // 回到原解析度，只保留遮罩範圍（邊緣羽化）
  const full = mk(cw, ch), fc = full.getContext('2d');
  fc.imageSmoothingQuality = 'high';
  fc.drawImage(pC, 0, 0, cw, ch);
  fc.globalCompositeOperation = 'destination-in';
  const soft = mk(cw, ch), sc = soft.getContext('2d');
  sc.filter = 'blur(1.5px)';
  sc.drawImage(maskCanvas, cx0, cy0, cw, ch, 0, 0, cw, ch);
  fc.drawImage(soft, 0, 0);
  const res = mk(W, H), rc = res.getContext('2d');
  rc.drawImage(src, 0, 0);
  rc.drawImage(full, cx0, cy0);
  onProgress?.(1);
  return res;
}

// ---------- U²-Net 摳圖 ----------
// 回傳 {alpha: Float32Array(W*H) 0..1}
export async function matteImage(src, { signal, onProgress, model = 'u2net' } = {}) {
  const W = src.width, H = src.height, S = 320;
  const c = mk(S, S), g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, S, S);
  const d = g.getImageData(0, 0, S, S).data;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const inp = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) for (let k = 0; k < 3; k++) inp[k * S * S + i] = (d[i * 4 + k] / 255 - mean[k]) / std[k];
  abortCheck(signal);
  onProgress?.(0.5, 'U²-Net 辨識主體中…');
  const ent = await getSession(model, { signal, onProgress });
  const name = ent.s.inputNames[0];
  const out = await run(model, (ort) => ({ [name]: new ort.Tensor('float32', inp, [1, 3, S, S]) }), { signal, onProgress });
  abortCheck(signal);
  const o = out[ent.s.outputNames[0]].data;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < o.length; i++) { if (o[i] < mn) mn = o[i]; if (o[i] > mx) mx = o[i]; }
  const small = mk(S, S), sg = small.getContext('2d'), sid = sg.createImageData(S, S);
  for (let i = 0; i < S * S; i++) { const v = ((o[i] - mn) / (mx - mn + 1e-8)) * 255; sid.data[i * 4] = sid.data[i * 4 + 1] = sid.data[i * 4 + 2] = v; sid.data[i * 4 + 3] = 255; }
  sg.putImageData(sid, 0, 0);
  const big = mk(W, H), bg = big.getContext('2d');
  bg.imageSmoothingQuality = 'high';
  bg.drawImage(small, 0, 0, W, H);
  const bd = bg.getImageData(0, 0, W, H).data;
  const alpha = new Float32Array(W * H);
  for (let i = 0; i < alpha.length; i++) alpha[i] = bd[i * 4] / 255;
  onProgress?.(1);
  return { alpha };
}

// ---------- Real-ESRGAN / Upscayl 放大 ----------
export async function upscale(src, { model, scale, signal, onProgress } = {}) {
  const m = MODELS[model], ms = m.scale;
  const W = src.width, H = src.height;
  const out = mk(W * scale, H * scale), oc = out.getContext('2d');
  oc.imageSmoothingEnabled = true; oc.imageSmoothingQuality = 'high';
  const sd = src.getContext('2d').getImageData(0, 0, W, H).data;
  const T = m.tile, P = 12;
  const nx = Math.ceil(W / T), ny = Math.ceil(H / T);
  const ent = await getSession(model, { signal, onProgress });
  const inName = ent.s.inputNames[0], outName = ent.s.outputNames[0];
  let done = 0;
  for (let ty = 0; ty < H; ty += T) for (let tx = 0; tx < W; tx += T) {
    abortCheck(signal);
    const x0 = Math.max(0, tx - P), y0 = Math.max(0, ty - P), x1 = Math.min(W, tx + T + P), y1 = Math.min(H, ty + T + P);
    const w = x1 - x0, h = y1 - y0, n = w * h;
    const inp = new Float32Array(3 * n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * W + x0 + x) * 4, di = y * w + x;
      inp[di] = sd[si] / 255; inp[n + di] = sd[si + 1] / 255; inp[2 * n + di] = sd[si + 2] / 255;
    }
    const res = await run(model, (ort) => ({ [inName]: new ort.Tensor('float32', inp, [1, 3, h, w]) }), { signal, onProgress });
    const od = res[outName].data;
    const ow = w * ms, oh = h * ms, on = ow * oh;
    const tw = Math.min(T, W - tx), th = Math.min(T, H - ty);
    const ix = (tx - x0) * ms, iy = (ty - y0) * ms, iw = tw * ms, ih = th * ms;
    const img = new ImageData(iw, ih);
    for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
      const si = (iy + y) * ow + ix + x, di = (y * iw + x) * 4;
      img.data[di] = od[si] * 255; img.data[di + 1] = od[on + si] * 255; img.data[di + 2] = od[2 * on + si] * 255; img.data[di + 3] = 255;
    }
    const tc = mk(iw, ih); tc.getContext('2d').putImageData(img, 0, 0);
    oc.drawImage(tc, tx * scale, ty * scale, tw * scale, th * scale);
    onProgress?.(++done / (nx * ny), `AI 放大 ${done}/${nx * ny}`);
  }
  // 保留透明度（Alpha 以一般縮放處理）
  let hasAlpha = false;
  for (let i = 3; i < sd.length; i += 4 * 7) if (sd[i] < 250) { hasAlpha = true; break; }
  if (hasAlpha) {
    const a = mk(W * scale, H * scale), ac = a.getContext('2d');
    ac.imageSmoothingQuality = 'high';
    ac.drawImage(src, 0, 0, W * scale, H * scale);
    oc.globalCompositeOperation = 'destination-in';
    oc.drawImage(a, 0, 0);
    oc.globalCompositeOperation = 'source-over';
  }
  return out;
}

// ---------- RVM 影片摳圖（有時間記憶，邊緣較穩定）；不支援時退回 U²-Net-p ----------
function f32ToF16(src) {
  const out = new Uint16Array(src.length);
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  for (let i = 0; i < src.length; i++) {
    f[0] = src[i]; const x = u[0];
    const sign = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 0xff) - 112; const mant = x & 0x7fffff;
    if (e <= 0) out[i] = sign;
    else if (e >= 31) out[i] = sign | 0x7c00;
    else out[i] = sign | (e << 10) | (mant >>> 13);
  }
  return out;
}
function f16ToF32(src) {
  if (!(src instanceof Uint16Array)) return Float32Array.from(src);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const h = src[i], s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    out[i] = e === 0 ? s * 2 ** -14 * (m / 1024) : e === 31 ? (m ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + m / 1024);
  }
  return out;
}

// 回傳 {step(canvas)->Float32Array alpha, w, h, reset()}。alpha 解析度為 (w,h)，呼叫端自行縮放
export async function createVideoMatter({ signal, onProgress, longSide = 768 } = {}) {
  let engine = 'rvm';
  try { await getSession('rvm', { signal, onProgress }); }
  catch (e) { if (e.name === 'AbortError') throw e; console.warn('RVM 無法使用，改用 U²-Net-p', e); engine = 'u2netp'; await getSession('u2netp', { signal, onProgress }); }
  let state = null;
  const ort = await getOrt();
  const zero = () => new ort.Tensor('float16', new Uint16Array(1), [1, 1, 1, 1]);
  const m = {
    engine,
    reset() { state = null; },
    async step(canvas) {
      const W = canvas.width, H = canvas.height;
      const k = Math.min(1, longSide / Math.max(W, H));
      const w = Math.max(32, Math.round((W * k) / 32) * 32), h = Math.max(32, Math.round((H * k) / 32) * 32);
      if (engine === 'u2netp') {
        const r = await matteImage(canvas, { signal, model: 'u2netp' });
        return { alpha: r.alpha, w: W, h: H };
      }
      const c = mk(w, h), g = c.getContext('2d');
      g.drawImage(canvas, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h).data, n = w * h;
      const inp = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) { inp[i] = d[i * 4] / 255; inp[n + i] = d[i * 4 + 1] / 255; inp[2 * n + i] = d[i * 4 + 2] / 255; }
      const ratio = Math.min(1, 512 / Math.max(w, h));
      const s = state || [zero(), zero(), zero(), zero()];
      const out = await run('rvm', (o) => ({
        src: new o.Tensor('float16', f32ToF16(inp), [1, 3, h, w]),
        r1i: s[0], r2i: s[1], r3i: s[2], r4i: s[3],
        downsample_ratio: new o.Tensor('float32', new Float32Array([ratio]), [1]),
      }), { signal });
      state = [out.r1o, out.r2o, out.r3o, out.r4o];
      return { alpha: f16ToF32(out.pha.data), w, h };
    },
  };
  return m;
}
