// 共用的畫布與取消工具（不依賴 DOM 結構，可被 core / ai / video 共用）
export function mk(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
export const abortCheck = (s) => { if (s?.aborted) throw new DOMException('Aborted', 'AbortError'); };
