// 本機 ComfyUI 後端（選用）：經由 serve.py 的 /comfy/ 同源代理呼叫，影片只在本機的瀏覽器與 ComfyUI 之間傳遞。
// 整段影片交給 ComfyUI（VideoHelperSuite 解碼／合成並保留聲音），在 CUDA 上推論，比逐格在瀏覽器跑快得多。
import { abortCheck } from './canvas.js';

const BASE = '/comfy';
const POLL_MS = 1000;
// 工作流程節點編號（固定，方便讀取輸出）
const N = { batch: '1', load: '2', model: '3', up: '4', scale: '5', out: '6' };
const FORMATS = {
  mp4: { format: 'video/h264-mp4', crf: 19, ext: 'mp4', type: 'video/mp4' },
  webm: { format: 'video/webm', crf: 20, ext: 'webm', type: 'video/webm' },
};

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); res(); }, ms);
  const onAbort = () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

async function api(path, { method = 'GET', json, body, signal } = {}) {
  const init = { method, signal };
  if (json !== undefined) { init.body = JSON.stringify(json); init.headers = { 'Content-Type': 'application/json' }; }
  else if (body !== undefined) init.body = body;
  const res = await fetch(BASE + path, init);
  if (!res.ok) {
    let detail = '';
    try { detail = errorText(await res.json()); } catch { /* 非 JSON 回應 */ }
    throw new Error(`ComfyUI 回應錯誤 (${res.status})${detail ? '：' + detail : ''}`);
  }
  return res;
}

// 從 ComfyUI 的錯誤回應（/prompt 驗證失敗、代理連線失敗）取出可讀訊息
function errorText(j) {
  if (!j) return '';
  if (typeof j.error === 'string') return j.error;
  const parts = [j.error?.message];
  for (const n of Object.values(j.node_errors || {})) for (const e of n.errors || []) parts.push(`${n.class_type}：${e.details || e.message}`);
  return parts.filter(Boolean).join('；');
}

// combo 輸入的選項：舊格式 [[...options]]，新格式 ['COMBO', {options:[...]}]
function comboOptions(spec) {
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0];
  return spec[1]?.options ?? [];
}

// 偵測 ComfyUI 是否可用。回傳 { upscaleModels } 或 null（未啟動、未經 serve.py 開啟或缺少 VideoHelperSuite）
export async function probe({ signal, timeoutMs = 2500 } = {}) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const [up, vhs] = await Promise.all(['UpscaleModelLoader', 'VHS_LoadVideo'].map((n) => api('/object_info/' + n, { signal: ac.signal }).then((r) => r.json())));
    if (!vhs?.VHS_LoadVideo || !up?.UpscaleModelLoader) return null;
    return { upscaleModels: comboOptions(up.UpscaleModelLoader.input?.required?.model_name) };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort', onAbort);
  }
}

// 影片放大工作流程：VHS 載入（分批）→ 放大模型 → 縮放到目標尺寸 → VHS 合成（保留聲音）
export function buildUpscaleWorkflow({ video, model, fps, outW, outH, format, framesPerBatch, job }) {
  const f = FORMATS[format];
  if (!f) throw new Error(`不支援的格式：${format}`);
  return {
    // job 不是節點宣告的輸入，只用來讓 ComfyUI 不沿用上一個工作的快取；requeue 由 VHS 用來接續下一批
    [N.batch]: { class_type: 'VHS_BatchManager', inputs: { frames_per_batch: framesPerBatch, requeue: 0, job } },
    [N.load]: {
      class_type: 'VHS_LoadVideo',
      inputs: { video, force_rate: fps, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1, meta_batch: [N.batch, 0] },
    },
    [N.model]: { class_type: 'UpscaleModelLoader', inputs: { model_name: model } },
    [N.up]: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: [N.model, 0], image: [N.load, 0] } },
    [N.scale]: { class_type: 'ImageScale', inputs: { image: [N.up, 0], upscale_method: 'lanczos', width: outW, height: outH, crop: 'disabled' } },
    [N.out]: {
      class_type: 'VHS_VideoCombine',
      inputs: {
        images: [N.scale, 0], audio: [N.load, 2], meta_batch: [N.batch, 0],
        frame_rate: fps, loop_count: 0, filename_prefix: `xiuxiu/${job}`, format: f.format, pingpong: false, save_output: true,
        pix_fmt: 'yuv420p', crf: f.crf, save_metadata: false, trim_to_audio: false,
      },
    },
  };
}

// 每批影格數：讓單批放大後的 float32 影格約占 1.5 GB 以內
export const framesPerBatch = (outW, outH) => Math.max(2, Math.min(32, Math.floor(1.5e9 / (outW * outH * 3 * 4))));

async function uploadVideo(file, name, signal) {
  const fd = new FormData();
  fd.append('image', file, name);
  fd.append('overwrite', 'true');
  const r = await (await api('/upload/image', { method: 'POST', body: fd, signal })).json();
  return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
}

// VHS 每處理完一批會在伺服器端自行排入下一批（新的 prompt_id），所以只排程一次，
// 再以工作流程裡的 job 標記，在 ComfyUI 的佇列與歷史中找出屬於這個工作的所有批次。
// 佇列與歷史項目的格式：[number, prompt_id, prompt, extra_data, outputs_to_execute]
const jobOf = (item) => item?.[2]?.[N.batch]?.inputs?.job;

async function jobQueue(job, signal) {
  const q = await (await api('/queue', { signal })).json();
  const mine = (list) => (list || []).filter((it) => jobOf(it) === job).map((it) => it[1]);
  return { running: mine(q.queue_running), pending: mine(q.queue_pending) };
}

async function jobHistory(job, signal) {
  const h = await (await api('/history?max_items=200', { signal })).json();
  return Object.values(h || {}).filter((e) => jobOf(e.prompt) === job);
}

async function cancelJob(job) {
  try {
    const { running, pending } = await jobQueue(job);
    if (pending.length) await api('/queue', { method: 'POST', json: { delete: pending } });
    for (const id of running) await api('/interrupt', { method: 'POST', json: { prompt_id: id } });
  } catch { /* 盡力取消；ComfyUI 可能已結束 */ }
}

// 等待整個分批工作完成，回傳合成節點的影片資訊
async function waitJob(job, { signal, onBatch }) {
  let idle = 0;
  for (;;) {
    abortCheck(signal);
    // 先讀佇列再讀歷史：批次結束前 VHS 已排入下一批，結束時才寫入歷史，所以兩者都沒有就表示工作中斷
    const q = await jobQueue(job, signal);
    const hist = await jobHistory(job, signal);
    const failed = hist.find((e) => e.status?.status_str === 'error');
    if (failed) {
      const m = failed.status.messages?.find(([type]) => type === 'execution_error')?.[1];
      throw new Error('ComfyUI 處理失敗' + (m ? `（${m.node_type}）：${m.exception_message}` : ''));
    }
    const g = hist.map((e) => e.outputs?.[N.out]?.gifs?.[0]).find(Boolean);
    if (g) return g;
    onBatch?.(hist.filter((e) => e.status?.completed).length);
    idle = q.running.length || q.pending.length ? 0 : idle + 1;
    if (idle >= 3) throw new Error('ComfyUI 的分批處理中斷（佇列中已沒有這個工作），請重試');
    await sleep(POLL_MS, signal);
  }
}

const extOf = (file) => (/\.(mp4|webm|mov|mkv|m4v)$/i.exec(file.name || '')?.[1] || (file.type?.includes('webm') ? 'webm' : 'mp4')).toLowerCase();

// 以 ComfyUI 放大整段影片。frames：預估總影格數（只用於進度）
export async function upscaleVideo({ file, model, fps, outW, outH, format, frames, signal, onProgress }) {
  const job = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const f = FORMATS[format];
  onProgress?.(0, '上傳影片到本機 ComfyUI…');
  const video = await uploadVideo(file, `xiuxiu_${job}.${extOf(file)}`, signal);
  const fpb = framesPerBatch(outW, outH), batches = Math.max(1, Math.ceil(frames / fpb));
  const wf = buildUpscaleWorkflow({ video, model, fps, outW, outH, format, framesPerBatch: fpb, job });
  const onBatch = (n) => onProgress?.(Math.min(0.95, n / batches), `ComfyUI 放大中：第 ${Math.min(n + 1, batches)} / ${batches} 批`);
  onBatch(0);
  await api('/prompt', { method: 'POST', json: { prompt: wf }, signal });
  let g;
  try { g = await waitJob(job, { signal, onBatch }); }
  catch (e) { if (e?.name === 'AbortError') await cancelJob(job); throw e; }
  onProgress?.(0.97, '下載結果…');
  const q = new URLSearchParams({ filename: g.filename, subfolder: g.subfolder, type: g.type });
  const blob = await (await api('/view?' + q, { signal })).blob();
  onProgress?.(1);
  return { blob: new Blob([blob], { type: f.type }), note: '由本機 ComfyUI 處理；暫存的影片會留在 ComfyUI 的 input／output 資料夾。' };
}
