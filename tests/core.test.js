import { describe, it, expect, beforeEach } from 'vitest';

const importFresh = async (name) => import(`${name}?t=${Date.now()}-${Math.random()}`);

describe('core.js', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="stage" style="width: 800px; height: 600px;"></div>
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
      <button id="zoomIn"></button>
      <button id="zoomOut"></button>
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
    `;

    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('clamps values between min and max', async () => {
    const { clamp } = await importFresh('../js/core.js');

    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('counts the redo stack toward the memory cap, dropping the farthest redo first', async () => {
    const mod = await importFresh('../js/core.js');
    const big = () => ({ width: 4096, height: 4096 }); // 64 MiB each
    mod.S.hist = [big(), big()];
    mod.S.redo = [big(), big(), big(), big()]; // 384 MiB total > 256 MiB cap
    const keep = mod.S.redo[3];
    mod.trimHistory();
    const total = [...mod.S.hist, ...mod.S.redo].length * 64 * 1024 * 1024;
    expect(total).toBeLessThanOrEqual(256 * 1024 * 1024);
    expect(mod.S.hist).toHaveLength(0);
    expect(mod.S.redo[mod.S.redo.length - 1]).toBe(keep);
  });

  it('tracks image history across undo and redo', async () => {
    const mod = await importFresh('../js/core.js');
    const original = mod.mk(2, 2);
    const originalCtx = original.getContext('2d');
    originalCtx.fillStyle = '#ff0000';
    originalCtx.fillRect(0, 0, 2, 2);

    mod.setImage(original);
    expect(mod.S.doc).toBe(original);

    const edited = mod.mk(3, 3);
    const editedCtx = edited.getContext('2d');
    editedCtx.fillStyle = '#00ff00';
    editedCtx.fillRect(0, 0, 3, 3);

    mod.commit(edited);
    expect(mod.S.doc).toBe(edited);

    mod.undo();
    expect(mod.S.doc).toBe(original);

    mod.redo();
    expect(mod.S.doc).toBe(edited);
  });
});
