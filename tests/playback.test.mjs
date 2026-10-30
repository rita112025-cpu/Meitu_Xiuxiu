// 以 Node VM 載入實際 main/tools-video 模組，模擬 DOM 與媒體回呼，不下載模型或啟動瀏覽器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function editor() {
  const nodes = new Map(), draws = [], callbacks = new Map(), cancelled = [], messages = [];
  const $ = (key) => {
    if (!nodes.has(key)) nodes.set(key, { textContent: '', value: '0', hidden: false, dataset: {}, classList: { toggle() {} }, addEventListener() {}, setAttribute() {}, innerHTML: '' });
    return nodes.get(key);
  };
  const modes = ['image', 'video'].map(mode => ({ ...$(mode), dataset: { mode } }));
  const canvas = () => {
    const c = { width: 320, height: 180, getContext: () => ({ fillRect() {}, drawImage(source) { draws.push({ target: c, source }); } }) };
    return c;
  };
  const S = { mode: 'image', doc: null, orig: null, hist: [], redo: [], view: { s: 1, x: 0, y: 0 } };
  let nextCallback = 0, pauses = 0, seek = async () => {}, play = async () => {};
  const video = {
    currentTime: 0, ended: false, pause() { pauses++; }, play: () => play(),
    requestVideoFrameCallback(cb) { callbacks.set(++nextCallback, cb); return nextCallback; },
    cancelVideoFrameCallback(id) { cancelled.push(id); },
  };
  const tools = Object.fromEntries(['new', 'adjust', 'text', 'erase', 'cutout', 'enhance', 'color'].map(key => [key, { noDoc: true, label: key, html: () => '' }]));
  const core = {
    S, $, $$: s => s === '.modes button' ? modes : [], mk: canvas, clone: c => c,
    clamp: (x, a, b) => Math.max(a, Math.min(b, x)), toast: msg => messages.push(msg),
    runJob: async () => null, render() {}, setImage(c) { S.doc = c; }, setCompare() {}, downloadBlob() {}, fit() {}, refreshHist() {}, fileToCanvas: async () => canvas(),
  };
  const mocks = {
    'core.js': core, 'tools-image.js': { tools, sl: () => '' },
    'video.js': { loadVideo: async () => ({ video, url: 'blob:test', w: 320, h: 180, dur: 10, fps: 30 }), seek: (...args) => seek(...args), supported: () => true },
    'ai.js': { detectGPU: async () => true }, 'comfy.js': {}, 'canvas.js': { canvasPool: () => canvas },
  };
  const context = vm.createContext({ console, setTimeout, clearTimeout, URL, Blob, document: { body: {} }, window: {}, addEventListener() {} });
  const cache = new Map();
  async function load(name) {
    if (cache.has(name)) return cache.get(name);
    const obj = mocks[name];
    const mod = obj
      ? new vm.SyntheticModule(Object.keys(obj), function () { for (const [key, val] of Object.entries(obj)) this.setExport(key, val); }, { context, identifier: name })
      : new vm.SourceTextModule(await readFile(new URL('../js/' + name, import.meta.url), 'utf8'), { context, identifier: name });
    cache.set(name, mod);
    await mod.link(spec => load(spec.replace('./', '')));
    return mod;
  }
  const main = await load('main.js'); await main.evaluate();
  return {
    S, $, modes, video, draws, cancelled, messages, callbacks,
    get pauses() { return pauses; }, get lastCallback() { return nextCallback; },
    set seek(fn) { seek = fn; }, set play(fn) { play = fn; },
    open: type => context.window.openFiles([{ type }]),
    tick: id => callbacks.get(id)(),
  };
}

test('播放影片後開啟圖片，取消舊回呼且不會覆寫新圖片', async () => {
  const e = await editor();
  await e.open('video/mp4'); e.$('#tlPlay').onclick();
  const id = e.lastCallback, pauses = e.pauses;
  await e.open('image/png');
  const doc = e.S.doc, draws = e.draws.length;
  e.tick(id); // 即使已取消的回呼仍送達，也不能改動圖片
  assert.equal(e.S.doc, doc);
  assert.equal(e.draws.length, draws);
  assert.equal(e.S.mode, 'image');
  assert.ok(e.pauses > pauses);
  assert.ok(e.cancelled.includes(id));
});

test('切回已開啟的圖片時，舊播放回呼不會修改保存的圖片', async () => {
  const e = await editor();
  await e.open('image/png'); const image = e.S.doc;
  await e.open('video/mp4'); e.$('#tlPlay').onclick();
  const id = e.lastCallback;
  e.modes[0].onclick();
  const draws = e.draws.length;
  e.tick(id);
  assert.equal(e.S.doc, image);
  assert.equal(e.draws.length, draws);
});

test('暫停後重新播放，過期回呼不會建立第二條播放迴圈', async () => {
  const e = await editor();
  await e.open('video/mp4'); e.$('#tlPlay').onclick();
  const old = e.lastCallback;
  e.$('#tlPlay').onclick(); e.$('#tlPlay').onclick();
  const current = e.lastCallback, draws = e.draws.length;
  e.tick(old);
  assert.equal(e.draws.length, draws);
  assert.equal(e.lastCallback, current);
  e.tick(current);
  assert.equal(e.draws.length, draws + 1);
  assert.equal(e.lastCallback, current + 1);
});

test('時間軸定位尚未完成就開啟圖片，不會在定位完成後覆寫圖片', async () => {
  const e = await editor();
  await e.open('video/mp4');
  let finish;
  e.seek = () => new Promise(resolve => { finish = resolve; });
  e.$('#tlRange').oninput();
  await e.open('image/png');
  const draws = e.draws.length;
  finish(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(e.draws.length, draws);
});

test('影片預覽會停止播放，避免回呼改動正在處理的影格', async () => {
  const e = await editor();
  await e.open('video/mp4');
  e.$('#tlPlay').onclick(); const id = e.lastCallback;
  e.$('#toolbar').onclick({ target: { closest: () => ({ dataset: { t: 'vwm' } }) } });
  e.S.tool.down({ x: 20, y: 20 }); e.S.tool.move({ x: 80, y: 80 }); e.S.tool.up();
  await e.$('#wPrev').onclick();
  const draws = e.draws.length;
  e.tick(id);
  assert.equal(e.draws.length, draws);
  assert.ok(e.cancelled.includes(id));
});

test('play() 失敗會停止播放並提供錯誤提示', async () => {
  const e = await editor();
  await e.open('video/mp4');
  e.play = async () => { throw new Error('blocked'); };
  e.$('#tlPlay').onclick(); const id = e.lastCallback;
  await new Promise(resolve => setTimeout(resolve, 0));
  const draws = e.draws.length;
  e.tick(id);
  assert.equal(e.draws.length, draws);
  assert.ok(e.messages.some(msg => msg.includes('blocked')));
});
