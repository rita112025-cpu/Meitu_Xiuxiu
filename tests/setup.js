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
