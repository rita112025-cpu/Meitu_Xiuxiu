// ComfyUI 後端的回歸測試（純 Node，以假的 fetch 模擬 serve.py 代理後的 ComfyUI API）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe, buildUpscaleWorkflow, framesPerBatch, upscaleVideo } from '../js/comfy.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// routes: [[method, 路徑正規式, handler(url, init) -> Response]]；記錄所有請求
function withFetch(routes, fn) {
  const calls = [], saved = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, init });
    init.signal?.throwIfAborted();
    const r = routes.find(([m, re]) => m === method && re.test(url));
    return r ? r[2](url, init) : new Response('not found', { status: 404 });
  };
  return Promise.resolve().then(() => fn(calls)).finally(() => { globalThis.fetch = saved; });
}

const objectInfo = (spec) => [
  ['GET', /object_info\/UpscaleModelLoader$/, () => json({ UpscaleModelLoader: { input: { required: { model_name: spec } } } })],
  ['GET', /object_info\/VHS_LoadVideo$/, () => json({ VHS_LoadVideo: {} })],
];

test('probe 讀取舊格式與新格式的放大模型清單', async () => {
  await withFetch(objectInfo([['a.pth', 'RealESRGAN_x4plus.pth']]), async () => {
    assert.deepEqual(await probe(), { upscaleModels: ['a.pth', 'RealESRGAN_x4plus.pth'] });
  });
  await withFetch(objectInfo(['COMBO', { options: ['b.pth'] }]), async () => {
    assert.deepEqual(await probe(), { upscaleModels: ['b.pth'] });
  });
});

test('probe 在 ComfyUI 未啟動、缺少 VideoHelperSuite 或沒有代理時回傳 null', async () => {
  await withFetch([['GET', /./, () => json({ error: 'ComfyUI 無法連線' }, 502)]], async () => assert.equal(await probe(), null));
  await withFetch([...objectInfo([[]]).slice(0, 1), ['GET', /VHS_LoadVideo$/, () => json({})]], async () => assert.equal(await probe(), null));
  await withFetch([], async () => assert.equal(await probe(), null));
});

test('probe 逾時時回傳 null，不會永久等待', { timeout: 2000 }, async () => {
  await withFetch([['GET', /./, (_, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))))]], async () => {
    assert.equal(await probe({ timeoutMs: 30 }), null);
  });
});

test('buildUpscaleWorkflow 串接載入、放大、縮放到目標尺寸與合成（保留聲音）', () => {
  const wf = buildUpscaleWorkflow({ video: 'v.mp4', model: 'm.pth', fps: 24, outW: 1280, outH: 720, format: 'mp4', framesPerBatch: 8, job: 'j1' });
  const byType = Object.fromEntries(Object.entries(wf).map(([id, n]) => [n.class_type, { id, ...n }]));
  assert.equal(byType.VHS_LoadVideo.inputs.video, 'v.mp4');
  assert.equal(byType.VHS_LoadVideo.inputs.force_rate, 24);
  assert.deepEqual(byType.ImageUpscaleWithModel.inputs.image, [byType.VHS_LoadVideo.id, 0]);
  assert.equal(byType.ImageScale.inputs.width, 1280);
  assert.equal(byType.ImageScale.inputs.height, 720);
  const out = byType.VHS_VideoCombine.inputs;
  assert.deepEqual(out.images, [byType.ImageScale.id, 0]);
  assert.deepEqual(out.audio, [byType.VHS_LoadVideo.id, 2]);
  assert.equal(out.format, 'video/h264-mp4');
  assert.equal(out.frame_rate, 24);
  assert.equal(byType.VHS_BatchManager.inputs.job, 'j1');
  assert.equal(buildUpscaleWorkflow({ video: 'v', model: 'm', fps: 30, outW: 2, outH: 2, format: 'webm', framesPerBatch: 1, job: 'x' })['6'].inputs.format, 'video/webm');
  assert.throws(() => buildUpscaleWorkflow({ format: 'gif' }), /不支援的格式/);
});

test('framesPerBatch 隨輸出尺寸調整並限制在 2～32', () => {
  assert.equal(framesPerBatch(320, 180), 32);
  assert.ok(framesPerBatch(1920, 1080) > framesPerBatch(3840, 2160));
  assert.equal(framesPerBatch(1e5, 1e5), 2);
});

// 模擬 ComfyUI + VHS：只收到一次排程，之後每次輪詢推進一批；VHS 在伺服器端以新的 prompt_id 排入下一批。
// opts.fail：第幾批失敗；opts.stall：第一批後不再排入下一批（模擬中斷）
function fakeComfy({ batches = 3, fail = -1, stall = false, other = true } = {}) {
  const s = { posted: [], queue: [], history: {}, deleted: [], interrupted: [], step: 0 };
  const item = (id, prompt) => [0, id, prompt, {}, ['6']];
  const advance = () => {
    const cur = s.queue.shift();
    if (!cur) return;
    const [, id, prompt] = cur, n = s.step++;
    if (n === fail) { s.history[id] = { prompt: cur, status: { status_str: 'error', completed: false, messages: [['execution_error', { node_type: 'UpscaleModelLoader', exception_message: 'CUDA out of memory' }]] }, outputs: {} }; return; }
    const last = n === batches - 1;
    if (!last && !(stall && n >= 0)) s.queue.push(item(`vhs${n + 1}`, prompt)); // VHS 先排入下一批，再寫入本批歷史
    s.history[id] = { prompt: cur, status: { status_str: 'success', completed: true }, outputs: { 6: last ? { gifs: [{ filename: 'o.mp4', subfolder: 'xiuxiu', type: 'output' }] } : { unfinished_batch: [true] } } };
  };
  if (other) s.history.foreign = { prompt: item('foreign', { 1: { inputs: { job: 'someone-else' } } }), status: { status_str: 'success', completed: true }, outputs: { 6: { gifs: [{ filename: 'wrong.mp4' }] } } };
  const routes = [
    ['POST', /\/comfy\/upload\/image$/, () => json({ name: 'up.mp4', subfolder: '', type: 'input' })],
    ['POST', /\/comfy\/prompt$/, (_, init) => { const p = JSON.parse(init.body).prompt; s.posted.push(p); s.queue.push(item('p0', p)); return json({ prompt_id: 'p0' }); }],
    ['GET', /\/comfy\/queue$/, () => json({ queue_running: s.queue.slice(0, 1), queue_pending: s.queue.slice(1) })],
    ['GET', /\/comfy\/history\?/, () => { const h = json(s.history); advance(); return h; }],
    ['GET', /\/comfy\/view\?/, () => new Response(new Uint8Array([1, 2, 3]))],
    ['POST', /\/comfy\/queue$/, (_, init) => { s.deleted.push(...JSON.parse(init.body).delete); return json({}); }],
    ['POST', /\/comfy\/interrupt$/, (_, init) => { s.interrupted.push(JSON.parse(init.body).prompt_id); return json({}); }],
  ];
  return { s, routes };
}
const run = (extra = {}) => upscaleVideo({ file: new File([new Uint8Array(4)], 'clip.mov', { type: 'video/quicktime' }), model: 'm.pth', fps: 30, outW: 640, outH: 360, format: 'mp4', frames: 90, ...extra });

test('upscaleVideo 只排程一次，追蹤 VHS 自行排入的後續批次直到取得影片', { timeout: 10000 }, async () => {
  const { s, routes } = fakeComfy({ batches: 3 });
  await withFetch(routes, async (calls) => {
    const progress = [];
    const r = await run({ onProgress: (p, l) => progress.push([p, l]) });
    assert.equal(r.blob.type, 'video/mp4');
    assert.equal(r.blob.size, 3);
    assert.equal(s.posted.length, 1, '不可由前端重複排程（VHS 會自行排入下一批）');
    assert.equal(s.posted[0]['2'].inputs.video, 'up.mp4');
    assert.match(calls.find((c) => c.url.endsWith('/upload/image')).init.body.get('image').name, /^xiuxiu_\w+\.mov$/);
    const view = calls.find((c) => c.url.includes('/view?'));
    assert.match(view.url, /filename=o\.mp4/, '不可取用其他工作的結果');
    assert.match(view.url, /subfolder=xiuxiu/);
    assert.ok(progress.some(([, l]) => /第 2 \//.test(l || '')), '進度應隨批次前進');
    assert.equal(progress.at(-1)[0], 1);
  });
});

test('upscaleVideo 在任一批次執行錯誤時回報節點與訊息', { timeout: 10000 }, async () => {
  const { routes } = fakeComfy({ batches: 3, fail: 1 });
  await withFetch(routes, async () => {
    await assert.rejects(run(), /UpscaleModelLoader.*CUDA out of memory/);
  });
});

test('upscaleVideo 在佇列中已無此工作且沒有結果時回報中斷，不會永久等待', { timeout: 15000 }, async () => {
  const { routes } = fakeComfy({ batches: 3, stall: true });
  await withFetch(routes, async () => {
    await assert.rejects(run(), /分批處理中斷/);
  });
});

test('upscaleVideo 的排程驗證失敗時顯示節點錯誤', async () => {
  const { routes } = fakeComfy();
  routes.splice(1, 1, ['POST', /\/comfy\/prompt$/, () => json({ error: { message: 'Prompt outputs failed validation' }, node_errors: { 3: { class_type: 'UpscaleModelLoader', errors: [{ message: 'Value not in list', details: 'model_name: x' }] } } }, 400)]);
  await withFetch(routes, async () => {
    await assert.rejects(run(), /400.*failed validation.*UpscaleModelLoader：model_name: x/);
  });
});

test('upscaleVideo 取消時只刪除本工作待處理的批次，不中斷別人執行中的工作', { timeout: 5000 }, async () => {
  const ac = new AbortController();
  const { s, routes } = fakeComfy({ batches: 5 });
  routes.splice(3, 1, ['GET', /\/comfy\/history\?/, () => { setTimeout(() => ac.abort(), 5); return json({}); }]);
  await withFetch(routes, async () => {
    s.queue.push([0, 'foreign-running', { 1: { inputs: { job: 'someone-else' } } }, {}, []]); // 別人的工作正在執行，本工作排在後面
    await assert.rejects(run({ signal: ac.signal }), { name: 'AbortError' });
    assert.deepEqual(s.interrupted, []);
    assert.deepEqual(s.deleted, ['p0']);
  });
});

test('upscaleVideo 取消時中斷執行中的本工作批次', { timeout: 5000 }, async () => {
  const ac = new AbortController();
  const { s, routes } = fakeComfy({ batches: 5 });
  routes.splice(3, 1, ['GET', /\/comfy\/history\?/, () => { setTimeout(() => ac.abort(), 5); return json({}); }]);
  await withFetch(routes, async () => {
    await assert.rejects(run({ signal: ac.signal }), { name: 'AbortError' });
    assert.deepEqual(s.interrupted, ['p0']);
    assert.deepEqual(s.deleted, []);
  });
});
