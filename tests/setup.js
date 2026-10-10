import { beforeEach } from 'vitest';

beforeEach(() => {
  document.body.innerHTML = `
    <div id="stage"></div>
    <canvas id="cv"></canvas>
    <div id="toast"></div>
    <div id="job">
      <div id="jobTitle"></div>
      <div id="jobLabel"></div>
      <div id="jobBar"></div>
      <div id="jobPct"></div>
      <button id="jobCancel"></button>
    </div>
    <button id="btnUndo"></button>
    <button id="btnRedo"></button>
    <button id="btnReset"></button>
    <button id="btnFit"></button>
    <button id="btnHold"></button>
    <button id="btnExport"></button>
    <button id="btnExpMenu"></button>
    <div id="expMenu" hidden></div>
    <select id="expFmt">
      <option value="png">PNG</option>
      <option value="jpg">JPG</option>
      <option value="webp">WebP</option>
    </select>
    <input id="expQ" value="92" />
    <b id="expQv"></b>
    <div id="empty"></div>
    <div id="zoomTxt"></div>
    <div id="sizeTxt"></div>
    <button id="cmpClose" hidden></button>
    <div id="panel"></div>
    <div id="toolbar"></div>
    <div id="timeline" hidden></div>
    <div id="badge"></div>
    <div id="top"></div>
  `;

  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// jsdom 沒有 canvas 2D 實作（getContext 會回傳 null）。這裡提供無動作的替身，
// 只供不讀取像素的測試（例如歷史紀錄的物件身分）使用；需要像素的測試應改用瀏覽器測試。
const noop = () => {};
HTMLCanvasElement.prototype.getContext = function () {
  return {
    fillRect: noop, clearRect: noop, drawImage: noop, putImageData: noop, save: noop, restore: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, rect: noop, clip: noop, fill: noop, stroke: noop,
    fillText: noop, strokeRect: noop, setTransform: noop, translate: noop, scale: noop, rotate: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    measureText: () => ({ width: 0 }),
    createPattern: () => null,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
  };
};
