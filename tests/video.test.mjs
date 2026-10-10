// 影片模組的回歸測試（純 Node，使用假的 video 元素，不需要瀏覽器或 CDN）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seek, loadVideo, exportVideo } from '../js/video.js';

// 最小的 EventTarget 版假 video 元素
function fakeVideo({ duration = 10, readyState = 0 } = {}) {
  const target = new EventTarget();
  let currentTime = 0;
  return Object.assign(target, {
    duration,
    readyState,
    get currentTime() { return currentTime; },
    set currentTime(v) { currentTime = v; this.seekRequests = (this.seekRequests || 0) + 1; },
  });
}

test('seek 在 seeked 事件後解析', async () => {
  const v = fakeVideo();
  const p = seek(v, 2);
  v.dispatchEvent(new Event('seeked'));
  await p;
  assert.equal(v.currentTime, 2);
});

test('seek 在媒體錯誤時拒絕，不會永久等待', { timeout: 2000 }, async () => {
  const v = fakeVideo();
  const p = seek(v, 2, { timeoutMs: 60000 });
  v.dispatchEvent(new Event('error'));
  await assert.rejects(p, /無法定位/);
});

test('seek 超過逾時時間會拒絕', { timeout: 2000 }, async () => {
  const v = fakeVideo();
  await assert.rejects(seek(v, 2, { timeoutMs: 30 }), /逾時/);
});

test('seek 被取消時以 AbortError 結束並移除監聽器', { timeout: 2000 }, async () => {
  const v = fakeVideo();
  const ac = new AbortController();
  const p = seek(v, 2, { signal: ac.signal, timeoutMs: 60000 });
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  // 取消後不應殘留 seeked 監聽器（以事件派發確認不會有後續動作）
  v.dispatchEvent(new Event('seeked'));
});

test('loadVideo 讀取失敗時釋放 Blob URL 並回報錯誤', { timeout: 2000 }, async () => {
  const revoked = [];
  const savedDoc = globalThis.document;
  const savedCreate = URL.createObjectURL, savedRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:fake-1';
  URL.revokeObjectURL = (u) => revoked.push(u);
  const el = { muted: false, playsInline: false, preload: '', src: '', onloadeddata: null, onerror: null, removeAttribute() {}, load() {} };
  globalThis.document = { createElement: () => el };
  try {
    const p = loadVideo({ type: 'video/mp4' });
    setTimeout(() => el.onerror?.(), 5);
    await assert.rejects(p, /無法讀取此影片/);
    assert.deepEqual(revoked, ['blob:fake-1']);
  } finally {
    globalThis.document = savedDoc;
    URL.createObjectURL = savedCreate;
    URL.revokeObjectURL = savedRevoke;
  }
});

test('不支援 WebCodecs 時 exportVideo 直接給出中文降級訊息', async () => {
  const saved = globalThis.VideoEncoder;
  delete globalThis.VideoEncoder;
  try {
    await assert.rejects(
      exportVideo({ V: { dur: 1, w: 2, h: 2 }, fps: 30, format: 'webm', alpha: false, outW: 2, outH: 2, frameFn: async (c) => c }),
      /不支援 WebCodecs/,
    );
  } finally {
    if (saved) globalThis.VideoEncoder = saved;
  }
});
