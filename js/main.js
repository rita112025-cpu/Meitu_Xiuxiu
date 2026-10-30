import { S, $, $$, toast, fit, render, setImage, fileToCanvas, refreshHist } from './core.js';
import { tools } from './tools-image.js';
import { vtools, loadVideoFile, hasVideo, stopPlay } from './tools-video.js';
import { detectGPU } from './ai.js';

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>', crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  type: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>', eraser: '<path d="m7 21-4-4a2 2 0 0 1 0-3L14 3a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3L11 21zM9 9l6 6M13 21h8"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  video: '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="m22 8-6 4 6 4z"/>', drop: '<path d="M12 3s7 7 7 12a7 7 0 0 1-14 0c0-5 7-12 7-12z"/>',
};
const ALL = { ...tools, ...vtools };
const ORDER = { image: ['new', 'adjust', 'text', 'erase', 'cutout', 'enhance', 'color', 'vmatteLink'], video: ['new', 'vwm', 'vmatte', 'vup'] };
const store = {};

const setBackendBadge = (gpu) => {
  $('#badge').textContent = gpu ? 'WebGPU' : 'CPU（較慢）';
  $('#badge').classList.toggle('warn', !gpu);
};
$('#badge').textContent = '檢測中…';
addEventListener('xiuxiu:backend-change', (e) => setBackendBadge(!!e.detail?.gpu));
detectGPU().then((gpu) => {
  setBackendBadge(gpu);
  if (!gpu) setTimeout(() => toast('未偵測到 WebGPU，AI 會改用 CPU 執行，速度較慢。建議使用最新版 Chrome / Edge。', true), 800);
});

function buildToolbar() {
  $('#toolbar').innerHTML = ORDER[S.mode].map((id) => {
    const t = id === 'vmatteLink' ? { label: '影片摳圖', icon: 'video' } : ALL[id];
    return `<button data-t="${id}" title="${t.label}" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[t.icon]}</svg><span>${t.label}</span></button>`;
  }).join('');
}
$('#toolbar').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.t === 'vmatteLink') { setMode('video'); selectTool('vmatte'); } else selectTool(b.dataset.t);
};

export function selectTool(id) {
  S.tool?.leave?.();
  const t = ALL[id]; S.tool = t; S.toolId = id; S.preview = null;
  $$('#toolbar button').forEach((b) => {
    const active = b.dataset.t === id;
    b.classList.toggle('on', active);
    b.setAttribute('aria-pressed', String(active));
  });
  const p = $('#panel');
  if (!S.doc && !t.noDoc && S.mode === 'image') p.innerHTML = `<h2>${t.label}</h2><p class="hint">請先新增一張圖片。</p><button class="btn primary" id="goNew">前往「新增」</button>`, ($('#goNew').onclick = () => selectTool('new'));
  else { p.innerHTML = `<h2>${t.label}</h2>` + t.html(); t.bind?.(p); t.enter?.(); }
  $('#stage').classList.toggle('draw', !!t.down);
  render();
}

function setMode(m) {
  if (S.mode === m) return;
  stopPlay();
  S.tool?.leave?.(); S.tool = null;
  store[S.mode] = { doc: S.doc, orig: S.orig, hist: S.hist, redo: S.redo, view: S.view };
  Object.assign(S, store[m] || { doc: null, orig: null, hist: [], redo: [], view: { s: 1, x: 0, y: 0 } }, { compare: null, preview: null, mode: m });
  document.body.className = 'mode-' + m;
  $$('.modes button').forEach((b) => {
    const active = b.dataset.mode === m;
    b.classList.toggle('on', active);
    b.setAttribute('aria-pressed', String(active));
  });
  $('#timeline').hidden = !(m === 'video' && hasVideo());
  $('#empty').hidden = !!S.doc;
  buildToolbar(); refreshHist(); fit();
  selectTool(m === 'video' ? 'vwm' : 'new');
}
$$('.modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

window.openFiles = async function (files) {
  const f = files.find((x) => x.type.startsWith('video/')) || files.find((x) => x.type.startsWith('image/'));
  if (!f) return toast('不支援的檔案格式', true);
  try {
    if (f.type.startsWith('video/')) {
      setMode('video');
      await loadVideoFile(f); $('#empty').hidden = true;
      selectTool('vwm');
    } else {
      setMode('image');
      setImage(await fileToCanvas(f));
      selectTool(S.toolId === 'new' || !S.toolId ? 'adjust' : S.toolId);
    }
  } catch (e) { console.error(e); toast('開啟失敗：' + e.message, true); }
};

$('#emptyBtn').onclick = () => $('#mainFile').click();
$('#mainFile').onchange = (e) => { window.openFiles([...e.target.files]); e.target.value = ''; };
addEventListener('dragover', (e) => { e.preventDefault(); $('#stage').classList.add('over'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('#stage').classList.remove('over'); });
addEventListener('drop', (e) => { e.preventDefault(); $('#stage').classList.remove('over'); if (e.dataTransfer.files.length) window.openFiles([...e.dataTransfer.files]); });
addEventListener('paste', (e) => {
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); window.openFiles(fs); }
});
$('#panel').addEventListener('input', (e) => {
  if (e.target.type === 'range') { const o = e.target.nextElementSibling; if (o?.tagName === 'OUTPUT') o.textContent = e.target.value; }
});

buildToolbar(); selectTool('new');

