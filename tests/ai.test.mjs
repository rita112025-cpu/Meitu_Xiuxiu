// AI 模型載入的回歸測試：並行載入去重、下載失敗後可重試（以假的 fetch 模擬，不連網）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSession, MODELS } from '../js/ai.js';

const savedFetch = globalThis.fetch;

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
