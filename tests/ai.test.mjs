// AI 模型載入的回歸測試：並行載入去重、下載失敗後可重試（以假的 fetch 模擬，不連網）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSession, MODELS, hasTransparency } from '../js/ai.js';

const savedFetch = globalThis.fetch;

test('取消後立即重試會建立新的下載，不沿用已中止的工作', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('', { status: 503 }); };
  try {
    const ac = new AbortController();
    const first = getSession('fast', { signal: ac.signal });
    ac.abort();
    const retry = getSession('fast');
    await assert.rejects(first, { name: 'AbortError' });
    await assert.rejects(retry, /模型下載失敗 \(503\)/);
    assert.equal(calls, 1, '只啟動仍有呼叫者的新下載');
  } finally { globalThis.fetch = savedFetch; }
});

test('共用下載廣播進度，取消的訂閱停止接收', async () => {
  let controller;
  const updates = [[], []];
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { controller = c; } }));
  try {
    const ac = new AbortController();
    const a = getSession('std4', { signal: ac.signal, onProgress: (p) => updates[0].push(p) });
    const b = getSession('std4', { onProgress: (p) => updates[1].push(p) });
    const result = Promise.allSettled([a, b]);
    await new Promise((r) => setTimeout(r, 0));
    controller.enqueue(new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(updates[0].length, 1);
    assert.deepEqual(updates[0], updates[1]);
    ac.abort();
    controller.enqueue(new Uint8Array([2]));
    controller.close();
    const [ra, rb] = await result;
    assert.equal(ra.reason.name, 'AbortError');
    assert.notEqual(rb.reason.name, 'AbortError');
    assert.equal(updates[0].length, 1);
    assert.ok(updates[1].length >= 2);
  } finally { globalThis.fetch = savedFetch; }
});

test('空模型下載可重試；中途串流失敗會取消 reader 並釋放鎖', async () => {
  let cancelled = false, released = false;
  const streamError = new Error('stream disconnected');
  globalThis.fetch = async () => new Response('');
  try {
    await assert.rejects(getSession('rvm'), /模型下載內容為空/);
    globalThis.fetch = async () => ({ ok: true, headers: new Headers(), body: { getReader: () => ({
      read: async () => { throw streamError; },
      cancel: async () => { cancelled = true; },
      releaseLock: () => { released = true; },
    }) } });
    await assert.rejects(getSession('rvm'), (e) => e === streamError);
    assert.equal(cancelled, true);
    assert.equal(released, true);
  } finally { globalThis.fetch = savedFetch; }
});

test('未知模型回報明確錯誤；已取消的請求不啟動下載', async () => {
  await assert.rejects(getSession('missing'), /未知模型/);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(getSession('migan', { signal: ac.signal }), { name: 'AbortError' });
});

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    await new Promise((r) => setTimeout(r, 15));
    return handler(url, opts, calls.length);
  };
  return calls;
}

test('同一模型並行呼叫 getSession 只下載一次', { timeout: 5000 }, async () => {
  const calls = stubFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  const results = await Promise.allSettled([getSession('migan'), getSession('migan')]);
  globalThis.fetch = savedFetch;
  assert.equal(calls.filter((u) => u === MODELS.migan.url).length, 1, '應只發出一次模型下載');
  assert.ok(results.every((r) => r.status === 'rejected'), '測試環境沒有 CDN，兩者都應回報載入失敗而非卡住');
});

test('模型下載失敗會回報狀態碼，且之後可以重新嘗試', { timeout: 5000 }, async () => {
  let n = 0;
  const calls = stubFetch(() => (++n === 1 ? new Response('', { status: 500 }) : new Response(new Uint8Array([1]), { status: 200 })));
  await assert.rejects(getSession('u2netp'), /模型下載失敗 \(500\)/);
  // 失敗後不應殘留在 in-flight 快取中，第二次呼叫要重新下載
  await assert.rejects(getSession('u2netp')); // 測試環境無 CDN，後續會在建立 session 時失敗
  globalThis.fetch = savedFetch;
  assert.equal(calls.length, 2, '第二次呼叫應重新發出下載請求');
});

test('兩個呼叫者共用載入時，其中一個取消不會中止另一個', { timeout: 5000 }, async () => {
  const calls = stubFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  const ac = new AbortController();
  const a = getSession('art', { signal: ac.signal });
  const b = getSession('art');
  ac.abort();
  const [ra, rb] = await Promise.allSettled([a, b]);
  globalThis.fetch = savedFetch;
  assert.equal(ra.status, 'rejected');
  assert.equal(ra.reason.name, 'AbortError', '取消的呼叫者應收到 AbortError');
  assert.equal(rb.status, 'rejected');
  assert.notEqual(rb.reason.name, 'AbortError', '未取消的呼叫者不應收到 AbortError（應是測試環境無 CDN 的載入錯誤）');
  assert.equal(calls.filter((u) => u === MODELS.art.url).length, 1, '共用的載入只下載一次');
});

test('所有呼叫者都取消時，共用的下載會被中止', { timeout: 5000 }, async () => {
  let aborted = false;
  globalThis.fetch = (url, opts) => new Promise((_, rej) => {
    opts.signal.addEventListener('abort', () => { aborted = true; rej(new DOMException('Aborted', 'AbortError')); });
  });
  const ac = new AbortController();
  const p = getSession('std2', { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 0)); // 等到 fetch 已啟動再測試中止下載
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  await new Promise((r) => setTimeout(r, 10));
  globalThis.fetch = savedFetch;
  assert.equal(aborted, true, '最後一個呼叫者取消後，底層 fetch 應被中止');
});

test('hasTransparency 逐像素檢查，不會漏掉稀疏的透明像素', () => {
  const rgba = new Uint8ClampedArray(4 * 1000).fill(255);
  assert.equal(hasTransparency(rgba), false, '全不透明應回傳 false');
  // 第 501 個像素的 alpha 不在舊的抽樣位置（每 7 個像素取一次）上
  rgba[501 * 4 + 3] = 0;
  assert.equal(hasTransparency(rgba), true, '單一透明像素也必須被偵測到');
});

test('模型網址固定為 commit SHA，不使用浮動的 main', () => {
  for (const [key, m] of Object.entries(MODELS)) {
    assert.match(m.url, /\/resolve\/[0-9a-f]{40}\//, `${key} 應使用 40 碼 commit SHA`);
  }
});

