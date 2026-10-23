// 共用的畫布與取消工具（不依賴 DOM 結構，可被 core / ai / video 共用）
export function mk(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
// 逐格處理時重複使用的畫布池：同一 key 尺寸不變就回傳同一張畫布（內容由呼叫端覆寫），避免每格配置新畫布
export function canvasPool() {
  const m = new Map();
  return (key, w, h) => {
    let c = m.get(key);
    if (!c || c.width !== Math.max(1, Math.round(w)) || c.height !== Math.max(1, Math.round(h))) m.set(key, (c = mk(w, h)));
    return c;
  };
}
export const abortCheck = (s) => { if (s?.aborted) throw new DOMException('Aborted', 'AbortError'); };
