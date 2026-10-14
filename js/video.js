// 影片處理：WebCodecs 逐格編碼 + 保留聲音（全部在瀏覽器內，不上傳）
import { mk, abortCheck } from './canvas.js';

const MUX ={ mp4: 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.mjs', webm: 'https://cdn.jsdelivr.net/npm/webm-muxer@5.0.3/build/webm-muxer.mjs' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const supported = () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';

// 定位到時間 t。會在 seeked 時解析；媒體錯誤、逾時或取消時拒絕，避免永久等待
export function seek(video, t, { signal, timeoutMs = 15000 } = {}) {
  return new Promise((res, rej) => {
    t = Math.min(Math.max(0, t), Math.max(0, video.duration - 0.001));
    if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) return res();
    let tm;
    const finish = (fn, v) => {
      clearTimeout(tm);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onSeeked = () => finish(res);
    const onError = () => finish(rej, new Error('影片讀取失敗，無法定位到指定畫面'));
    const onAbort = () => finish(rej, new DOMException('Aborted', 'AbortError'));
    tm = setTimeout(() => finish(rej, new Error('影片定位逾時，請確認影片可正常播放')), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = t;
  });
}

export async function loadVideo(file) {
  const url = URL.createObjectURL(file), video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = url;
  try {
    await new Promise((res, rej) => { video.onloadeddata = res; video.onerror = () => rej(new Error('無法讀取此影片（請使用 MP4 或 WebM）')); });
  } catch (e) {
    // 讀取失敗：釋放解碼器與 Blob URL，避免失敗的檔案一直佔用記憶體
    video.removeAttribute('src'); video.load?.();
    URL.revokeObjectURL(url);
    throw e;
  }
  if (!Number.isFinite(video.duration)) {
    // 部分 WebM（例如 MediaRecorder 產生的）沒有時長資訊：跳到極大時間，讓瀏覽器算出實際長度後再回到開頭
    video.currentTime = 1e101;
    await new Promise((res) => {
      const t = setTimeout(res, 5000);
      video.addEventListener('durationchange', () => { clearTimeout(t); res(); }, { once: true });
    });
    if (Number.isFinite(video.duration)) await seek(video, 0);
  }
  const V = { file, url, video, w: video.videoWidth, h: video.videoHeight, dur: video.duration, fps: 30 };
  // 估算影格率
  if (video.requestVideoFrameCallback) {
    try {
      const ts = [];
      await new Promise((res) => {
        const tm = setTimeout(res, 1500);
        const cb = (_, m) => { ts.push(m.mediaTime); if (ts.length >= 10) { clearTimeout(tm); res(); } else video.requestVideoFrameCallback(cb); };
        video.requestVideoFrameCallback(cb); video.play().catch(res);
      });
      video.pause();
      let mn = Infinity; for (let i = 1; i < ts.length; i++) { const d = ts[i] - ts[i - 1]; if (d > 0.004 && d < mn) mn = d; }
      if (isFinite(mn)) V.fps = Math.min(60, Math.max(10, Math.round(1 / mn)));
      await seek(video, 0);
    } catch { /* 採預設 30 */ }
  }
  return V;
}

async function decodeAudio(file) {
  let ac = null;
  try {
    ac = new AudioContext({ sampleRate: 48000 });
    const b = await ac.decodeAudioData(await file.arrayBuffer());
    return b.length ? b : null;
  } catch { return null; }
  finally { ac?.close().catch(() => {}); } // 解碼失敗時也要關閉，否則 AudioContext 會洩漏
}

// 透明 WebM：Chrome 的 WebCodecs 不支援 alpha 編碼，所以自己做 VP9 alpha（WebM BlockAdditions）：
// 顏色走一條 VP9、透明度（灰階）走另一條 VP9，再由補丁過的 webm-muxer 寫進同一個 WebM。
async function loadWebmMuxerWithAlpha() {
  const src = await (await fetch(MUX.webm)).text();
  const patched = src
    .replace('createInternalChunk_fn).call(this, data, type, timestamp, VIDEO_TRACK_NUMBER);', 'createInternalChunk_fn).call(this, data, type, timestamp, VIDEO_TRACK_NUMBER, void 0, meta && meta.additions);')
    .replace('chunk.additions ? { id: 30113', 'chunk.type === "delta" ? { id: 251, data: new Uint8Array([255]) } : null,\n      chunk.additions ? { id: 30113');
  if (patched === src) throw new Error('無法啟用透明 WebM 輸出');
  const url = URL.createObjectURL(new Blob([patched], { type: 'text/javascript' }));
  try { return await import(url); } finally { URL.revokeObjectURL(url); }
}
const vint8 = (n) => { const b = new Uint8Array(8); b[0] = 1; for (let i = 7; i >= 1; i--) { b[i] = n % 256; n = Math.floor(n / 256); } return b; };
function blockAdditions(alphaData) { // BlockMore{BlockAddID=1, BlockAdditional=alphaData}
  const inner = [new Uint8Array([0xee, 0x81, 0x01]), new Uint8Array([0xa5]), vint8(alphaData.length), alphaData];
  const len = 3 + 1 + 8 + alphaData.length, out = new Uint8Array(1 + 8 + len);
  out[0] = 0xa6; out.set(vint8(len), 1);
  let o = 9; for (const p of inner) { out.set(p, o); o += p.length; }
  return out;
}

// 逐格處理並輸出影片。frameFn(frameCanvas, index) -> canvas (outW×outH)，可為 async
// writable（選填）：FileSystemWritableFileStream。提供時直接串流寫入磁碟並回傳 blob: null；
// 開啟與 close()/abort() 由呼叫端負責。
export async function exportVideo({ V, fps, format, alpha, outW, outH, frameFn, signal, onProgress, writable }) {
  if (!supported()) throw new Error('此瀏覽器不支援 WebCodecs，請使用最新版 Chrome 或 Edge');
  outW &= ~1; outH &= ~1;
  const isMp4 = format === 'mp4', total = Math.max(1, Math.floor(V.dur * fps)), big = Math.max(outW, outH) > 1920;
  if (alpha && isMp4) throw new Error('透明背景只能輸出 WebM');
  if (!Number.isFinite(V.dur) || V.dur <= 0) throw new Error('無法取得影片長度，無法輸出');
  const mod = alpha ? await loadWebmMuxerWithAlpha() : await import(MUX[format]);
  const vcfg = {
    codec: isMp4 ? (big ? 'avc1.640034' : 'avc1.64002A') : (big ? 'vp09.00.51.08' : 'vp09.00.40.08'),
    width: outW, height: outH, framerate: fps, bitrate: Math.round(Math.min(80e6, Math.max(2e6, outW * outH * fps * 0.12))),
  };
  if (isMp4) vcfg.avc = { format: 'avc' };
  if (!(await VideoEncoder.isConfigSupported(vcfg)).supported) throw new Error('此瀏覽器不支援該解析度/編碼，請改選 WebM 或縮小尺寸');

  let audio = await decodeAudio(V.file), acfg = null, ach = 0, note = '';
  if (audio) {
    ach = Math.min(2, audio.numberOfChannels);
    acfg = { codec: isMp4 ? 'mp4a.40.2' : 'opus', sampleRate: audio.sampleRate, numberOfChannels: ach, bitrate: 128000 };
    if (typeof AudioEncoder === 'undefined' || !(await AudioEncoder.isConfigSupported(acfg)).supported) { audio = null; note = '此瀏覽器無法編碼該聲音格式，輸出將沒有聲音（可改選 WebM 試試）。'; }
  } else note = '來源沒有可解碼的聲音。';

  const target = writable ? new mod.FileSystemWritableFileStreamTarget(writable) : new mod.ArrayBufferTarget();
  const mo = { target, video: isMp4 ? { codec: 'avc', width: outW, height: outH } : { codec: 'V_VP9', width: outW, height: outH, frameRate: fps, alpha: !!alpha } };
  // webm-muxer 會把 codec 字串原樣寫入 Matroska CodecID，必須使用 'A_OPUS'（寫成 'opus' 時瀏覽器無法播放該音軌）
  if (audio) mo.audio = { codec: isMp4 ? 'aac' : 'A_OPUS', numberOfChannels: ach, sampleRate: audio.sampleRate };
  // fastStart 'in-memory' 需要整個檔案留在記憶體；寫入磁碟時改為 false（moov 寫在檔尾，本機播放不受影響）
  if (isMp4) mo.fastStart = writable ? false : 'in-memory';
  const muxer = new mod.Muxer(mo);

  // 編碼結果立即寫入 muxer，不在記憶體中累積全部 chunk（muxer 會自行依時間戳交錯影音）。
  // 透明影片：顏色與 alpha 兩個編碼器依相同順序輸出，各自排隊後一對一配對寫入。
  let err = null;
  const guard = (fn) => (...a) => { try { fn(...a); } catch (e) { err ||= e; } };
  const colorQ = [], alphaQ = [];
  const writeAlphaPairs = () => {
    while (colorQ.length && alphaQ.length) { const [c, m] = colorQ.shift(); muxer.addVideoChunk(c, { ...m, additions: blockAdditions(alphaQ.shift()) }); }
  };
  const venc = new VideoEncoder({
    output: guard((c, m) => { if (alpha) { colorQ.push([c, m]); writeAlphaPairs(); } else muxer.addVideoChunk(c, m); }),
    error: (e) => (err ||= e),
  });
  venc.configure(vcfg);
  let alphaEnc = null;
  if (alpha) {
    alphaEnc = new VideoEncoder({ output: guard((c) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); alphaQ.push(d); writeAlphaPairs(); }), error: (e) => (err ||= e) });
    alphaEnc.configure({ ...vcfg, bitrate: Math.round(vcfg.bitrate / 3) });
  }
  let aenc = null, aPos = 0;
  if (audio) { aenc = new AudioEncoder({ output: guard((c, m) => muxer.addAudioChunk(c, m)), error: (e) => (err ||= e) }); aenc.configure(acfg); }
  const feedAudio = (until) => {
    if (!aenc) return;
    const sr = audio.sampleRate, end = Math.min(audio.length, Math.floor(until * sr)), chs = [...Array(ach).keys()].map((i) => audio.getChannelData(i));
    while (aPos < end) {
      const len = Math.min(4800, end - aPos), data = new Float32Array(len * ach);
      chs.forEach((c, i) => data.set(c.subarray(aPos, aPos + len), i * len));
      const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: len, numberOfChannels: ach, timestamp: Math.round((aPos / sr) * 1e6), data });
      aenc.encode(ad); ad.close(); // encode() 不會接管 AudioData 的所有權，需自行關閉
      aPos += len;
    }
  };

  const fc = mk(V.w, V.h), fg = fc.getContext('2d');
  const ySize = outW * outH, yuv = alpha ? new Uint8Array(ySize * 1.5) : null;
  if (yuv) yuv.fill(128, ySize);
  try {
    for (let i = 0; i < total; i++) {
      abortCheck(signal); if (err) throw err;
      await seek(V.video, (i + 0.5) / fps, { signal });
      fg.drawImage(V.video, 0, 0);
      const out = await frameFn(fc, i);
      const ts = Math.round((i * 1e6) / fps), du = Math.round(1e6 / fps), kf = { keyFrame: i % 60 === 0 };
      if (alpha) {
        const px = out.getContext('2d').getImageData(0, 0, outW, outH).data;
        for (let p = 0; p < ySize; p++) yuv[p] = px[p * 4 + 3];
        const cf = new VideoFrame(px, { format: 'RGBX', codedWidth: outW, codedHeight: outH, timestamp: ts, duration: du });
        venc.encode(cf, kf); cf.close();
        const af = new VideoFrame(yuv, { format: 'I420', codedWidth: outW, codedHeight: outH, timestamp: ts, duration: du });
        alphaEnc.encode(af, kf); af.close();
      } else {
        const vf = new VideoFrame(out, { timestamp: ts, duration: du });
        venc.encode(vf, kf); vf.close();
      }
      while (venc.encodeQueueSize > 6 || (alphaEnc && alphaEnc.encodeQueueSize > 6)) await sleep(4);
      feedAudio((i + 1) / fps);
      onProgress?.((i + 1) / total, `處理第 ${i + 1} / ${total} 格`);
    }
    feedAudio(total / fps);
    await venc.flush(); if (alphaEnc) await alphaEnc.flush(); if (aenc) await aenc.flush();
    if (err) throw err;
    if (colorQ.length || alphaQ.length) throw new Error('透明影片的顏色與透明度畫格數不一致，無法輸出');
    muxer.finalize();
  } finally {
    for (const e of [venc, alphaEnc, aenc]) { try { e?.close(); } catch { /* */ } }
  }
  return { blob: writable ? null : new Blob([target.buffer], { type: isMp4 ? 'video/mp4' : 'video/webm' }), note };
}

// 套用 alpha 並合成背景
// a = {alpha: Float32Array, w, h}；bg: 'transparent'|'green'|'white'|'blur'|'color'
export function applyMatte(frame, a, bg, color) {
  const W = frame.width, H = frame.height, mc = mk(a.w, a.h), id = new ImageData(a.w, a.h);
  for (let i = 0, n = a.w * a.h; i < n; i++) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 255; id.data[i * 4 + 3] = Math.max(0, Math.min(255, a.alpha[i] * 255)); }
  mc.getContext('2d').putImageData(id, 0, 0);
  const fgc = mk(W, H), fx = fgc.getContext('2d');
  fx.drawImage(frame, 0, 0); fx.globalCompositeOperation = 'destination-in'; fx.imageSmoothingQuality = 'high'; fx.drawImage(mc, 0, 0, W, H);
  if (bg === 'transparent') return fgc;
  const out = mk(W, H), g = out.getContext('2d');
  if (bg === 'blur') { const m = Math.max(W, H); g.filter = `blur(${m / 60}px)`; g.drawImage(frame, -m * 0.03, -m * 0.03, W + m * 0.06, H + m * 0.06); g.filter = 'none'; }
  else { g.fillStyle = bg === 'green' ? '#00b140' : bg === 'white' ? '#ffffff' : color; g.fillRect(0, 0, W, H); }
  g.drawImage(fgc, 0, 0);
  return out;
}

// 邊緣閃爍抑制：與前一格做指數平均，並略為收斂灰階邊緣
export function stabilizeAlpha(prev, cur) {
  const a = cur.alpha;
  if (prev && prev.length === a.length) for (let i = 0; i < a.length; i++) a[i] = prev[i] * 0.45 + a[i] * 0.55;
  for (let i = 0; i < a.length; i++) { const v = a[i]; a[i] = v <= 0.04 ? 0 : v >= 0.96 ? 1 : v; }
  return a;
}
