// 圖片工具：新增 / 調整 / 文字 / 消除圖 / 摳圖 / 變清晰 / 調色
import { S, $, $$, mk, clone, clamp, toast, runJob, render, commit, setCompare, setImage, fileToCanvas, downloadBlob, fit, refreshHist } from './core.js';
import * as AI from './ai.js';

export const sl = (id, label, min, max, val, step = 1) =>
  `<label class="row"><span>${label}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><output>${val}</output></label>`;
const setSl = (id, v) => { const e = $('#' + id); if (!e) return; e.value = v; e.nextElementSibling.textContent = v; };
const val = (id) => +$('#' + id).value;
const chips = (arr, attr) => arr.map((a, i) => `<button class="chip" ${attr}="${i}">${a.name || a}</button>`).join('');
const raf = (fn) => { let r = 0; return () => { if (!r) r = requestAnimationFrame(() => { r = 0; fn(); }); }; };

export const tools = {};

// ============ 1. 新增 ============
tools.new = {
  label: '新增', icon: 'plus', noDoc: true,
  html: () => `
    <button class="btn primary big" id="nUp">上傳圖片或影片</button>
    <input type="file" id="nFile" accept="image/*,video/mp4,video/webm" hidden>
    <button class="btn" id="nPaste">從剪貼簿貼上圖片</button>
    <p class="hint">也可以直接把圖片或影片<b>拖曳</b>到畫面，或按 <kbd>Ctrl</kbd>+<kbd>V</kbd> 貼上。</p>
    <p class="hint">🔒 圖片與影片只在你的瀏覽器裡處理，不會上傳到伺服器。AI 模型權重首次使用時會下載並快取在本機。</p>`,
  bind() {
    $('#nUp').onclick = () => $('#nFile').click();
    $('#nFile').onchange = (e) => { window.openFiles([...e.target.files]); e.target.value = ''; };
    $('#nPaste').onclick = async () => {
      try {
        for (const it of await navigator.clipboard.read()) {
          const t = it.types.find((x) => x.startsWith('image/'));
          if (t) return window.openFiles([new File([await it.getType(t)], 'paste.png', { type: t })]);
        }
        toast('剪貼簿裡沒有圖片', true);
      } catch { toast('無法讀取剪貼簿，請改用 Ctrl+V', true); }
    };
  },
};

// ============ 2. 調整 ============
const SIZES = [
  ['Instagram 貼文', 1080, 1080], ['Instagram 直式', 1080, 1350], ['限時動態/Reels', 1080, 1920],
  ['YouTube 縮圖', 1280, 720], ['Full HD 橫式', 1920, 1080], ['Facebook 封面', 820, 312],
  ['1 吋證件照', 295, 413], ['2 吋證件照', 413, 531], ['頭像 640', 640, 640],
];
const RATIOS = [['自由', 0], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16], ['3:2', 3 / 2], ['2:3', 2 / 3]];
const SHAPES = [['圓形', 'circle'], ['圓角', 'round'], ['愛心', 'heart'], ['星形', 'star'], ['三角形', 'tri'], ['六邊形', 'hex'], ['菱形', 'diamond']];
function shapePath(g, t, x, y, w, h) {
  const px = (u) => x + u * w, py = (v) => y + v * h;
  g.beginPath();
  if (t === 'circle') g.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 7);
  else if (t === 'round') g.roundRect(x, y, w, h, Math.min(w, h) * 0.18);
  else if (t === 'heart') { g.moveTo(px(.5), py(.94)); g.bezierCurveTo(px(-.12), py(.55), px(.08), py(.02), px(.5), py(.3)); g.bezierCurveTo(px(.92), py(.02), px(1.12), py(.55), px(.5), py(.94)); }
  else if (t === 'star') for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.22 : 0.5; g[i ? 'lineTo' : 'moveTo'](px(.5 + r * Math.cos(a)), py(.5 + r * Math.sin(a))); }
  else if (t === 'tri') { g.moveTo(px(.5), py(.04)); g.lineTo(px(.97), py(.92)); g.lineTo(px(.03), py(.92)); }
  else if (t === 'hex') for (let i = 0; i < 6; i++) { const a = (i * Math.PI) / 3; g[i ? 'lineTo' : 'moveTo'](px(.5 + .5 * Math.cos(a)), py(.5 + .5 * Math.sin(a))); }
  else if (t === 'diamond') { g.moveTo(px(.5), py(0)); g.lineTo(px(1), py(.5)); g.lineTo(px(.5), py(1)); g.lineTo(px(0), py(.5)); }
  g.closePath();
}
tools.adjust = (() => {
  let crop = null, ratio = 0, drag = null;
  const imgRect = () => ({ x: 0, y: 0, w: S.doc.width, h: S.doc.height });
  const hs = (s) => 11 / s;
  const handles = () => {
    const { x, y, w, h } = crop;
    return { nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + h / 2], se: [x + w, y + h], s: [x + w / 2, y + h], sw: [x, y + h], w: [x, y + h / 2] };
  };
  function setRatio(r) {
    ratio = r; if (!S.doc) return;
    const W = S.doc.width, H = S.doc.height;
    if (!r) { crop = imgRect(); return render(); }
    let w = W, h = W / r; if (h > H) { h = H; w = H * r; }
    crop = { x: (W - w) / 2, y: (H - h) / 2, w, h }; render();
  }
  function fixCrop() {
    const W = S.doc.width, H = S.doc.height;
    crop.w = clamp(crop.w, 8, W); crop.h = clamp(crop.h, 8, H);
    crop.x = clamp(crop.x, 0, W - crop.w); crop.y = clamp(crop.y, 0, H - crop.h);
  }
  const dst = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  return {
    label: '調整', icon: 'crop',
    html: () => `
      <h3>裁剪</h3>
      <div class="chips" id="aRatio">${RATIOS.map((r, i) => `<button class="chip${i === 0 ? ' on' : ''}" data-i="${i}">${r[0]}</button>`).join('')}</div>
      <p class="hint">在畫面上拖曳畫出裁剪框，可拖動邊角調整。</p>
      <button class="btn primary" id="aCrop">套用裁剪</button>
      <h3>常用尺寸</h3>
      <div class="chips col" id="aSizes">${SIZES.map((s, i) => `<button class="chip" data-i="${i}">${s[0]} <small>${s[1]}×${s[2]}</small></button>`).join('')}</div>
      <p class="hint">點選後會「填滿並置中裁切」成該尺寸。</p>
      <div class="row2"><label>寬 <input type="number" id="aW" min="1" max="8192"></label><label>高 <input type="number" id="aH" min="1" max="8192"></label></div>
      <label class="chk"><input type="checkbox" id="aLock" checked> 鎖定比例</label>
      <button class="btn" id="aResize">縮放到此尺寸</button>
      <h3>形狀蒙版</h3>
      <div class="chips" id="aShapes">${SHAPES.map((s, i) => `<button class="chip" data-i="${i}">${s[0]}</button>`).join('')}</div>
      <label class="chk"><input type="checkbox" id="aSq" checked> 先裁成正方形（圓形、愛心等較好看）</label>
      <h3>旋轉與翻轉</h3>
      <div class="chips"><button class="chip" id="aL">⟲ 左轉 90°</button><button class="chip" id="aR">⟳ 右轉 90°</button><button class="chip" id="aFH">⇆ 水平翻轉</button><button class="chip" id="aFV">⇅ 垂直翻轉</button></div>
      ${sl('aAng', '任意角度', -45, 45, 0)}
      <button class="btn" id="aRot">套用角度旋轉</button>`,
    bind() {
      const sync = () => { $('#aW').value = S.doc.width; $('#aH').value = S.doc.height; };
      this.sync = sync; sync();
      $('#aRatio').onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return; $$('#aRatio .chip').forEach((x) => x.classList.toggle('on', x === b)); setRatio(RATIOS[+b.dataset.i][1]); };
      $('#aCrop').onclick = () => {
        if (!crop) return;
        const x = Math.round(crop.x), y = Math.round(crop.y), w = Math.max(1, Math.round(crop.w)), h = Math.max(1, Math.round(crop.h));
        const c = mk(w, h); c.getContext('2d').drawImage(S.doc, x, y, w, h, 0, 0, w, h); commit(c);
      };
      $('#aSizes').onclick = (e) => {
        const b = e.target.closest('.chip'); if (!b) return;
        const [, tw, th] = SIZES[+b.dataset.i], W = S.doc.width, H = S.doc.height, k = Math.max(tw / W, th / H);
        const c = mk(tw, th), g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
        g.drawImage(S.doc, (tw - W * k) / 2, (th - H * k) / 2, W * k, H * k); commit(c);
      };
      const ar = () => S.doc.width / S.doc.height;
      $('#aW').oninput = () => { if ($('#aLock').checked) $('#aH').value = Math.round($('#aW').value / ar()); };
      $('#aH').oninput = () => { if ($('#aLock').checked) $('#aW').value = Math.round($('#aH').value * ar()); };
      $('#aResize').onclick = () => {
        const w = clamp(+$('#aW').value | 0, 1, 8192), h = clamp(+$('#aH').value | 0, 1, 8192);
        const c = mk(w, h), g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(S.doc, 0, 0, w, h); commit(c);
      };
      $('#aShapes').onclick = (e) => {
        const b = e.target.closest('.chip'); if (!b) return;
        const t = SHAPES[+b.dataset.i][1]; let src = S.doc;
        if ($('#aSq').checked && t !== 'round') {
          const m = Math.min(src.width, src.height), sq = mk(m, m);
          sq.getContext('2d').drawImage(src, (src.width - m) / 2, (src.height - m) / 2, m, m, 0, 0, m, m); src = sq;
        }
        const c = mk(src.width, src.height), g = c.getContext('2d');
        shapePath(g, t, 0, 0, c.width, c.height); g.clip(); g.drawImage(src, 0, 0); commit(c);
      };
      const rot = (deg, fh, fv) => {
        const rad = (deg * Math.PI) / 180, W = S.doc.width, H = S.doc.height;
        const nw = Math.ceil(Math.abs(W * Math.cos(rad)) + Math.abs(H * Math.sin(rad)) - 1e-6), nh = Math.ceil(Math.abs(W * Math.sin(rad)) + Math.abs(H * Math.cos(rad)) - 1e-6);
        const c = mk(nw, nh), g = c.getContext('2d'); g.translate(nw / 2, nh / 2); g.rotate(rad); g.scale(fh ? -1 : 1, fv ? -1 : 1);
        g.imageSmoothingQuality = 'high'; g.drawImage(S.doc, -W / 2, -H / 2); commit(c);
      };
      $('#aL').onclick = () => rot(-90); $('#aR').onclick = () => rot(90);
      $('#aFH').onclick = () => rot(0, 1, 0); $('#aFV').onclick = () => rot(0, 0, 1);
      $('#aRot').onclick = () => { const a = val('aAng'); if (a) { rot(a); setSl('aAng', 0); } };
    },
    enter() { crop = imgRect(); ratio = 0; render(); },
    leave() { crop = null; drag = null; },
    onDocChange() { if (S.tool === this) { crop = imgRect(); ratio = 0; $$('#aRatio .chip').forEach((x, i) => x.classList.toggle('on', i === 0)); this.sync?.(); } },
    down(p) {
      const s = S.view.s;
      if (crop) {
        const hh = handles();
        for (const k in hh) if (dst([p.x, p.y], hh[k]) < hs(s)) { drag = { m: 'resize', k, st: { ...crop } }; return; }
        if (p.x > crop.x && p.x < crop.x + crop.w && p.y > crop.y && p.y < crop.y + crop.h) { drag = { m: 'move', ox: p.x - crop.x, oy: p.y - crop.y }; return; }
      }
      drag = { m: 'new', x0: clamp(p.x, 0, S.doc.width), y0: clamp(p.y, 0, S.doc.height) };
      crop = { x: drag.x0, y: drag.y0, w: 1, h: 1 };
    },
    move(p) {
      if (!drag) return;
      const W = S.doc.width, H = S.doc.height;
      if (drag.m === 'move') { crop.x = clamp(p.x - drag.ox, 0, W - crop.w); crop.y = clamp(p.y - drag.oy, 0, H - crop.h); }
      else if (drag.m === 'new') {
        let x = clamp(p.x, 0, W), y = clamp(p.y, 0, H), w = x - drag.x0, h = y - drag.y0;
        if (ratio) { const sh = Math.sign(h) || 1; h = (Math.abs(w) / ratio) * sh; }
        crop = { x: Math.min(drag.x0, drag.x0 + w), y: Math.min(drag.y0, drag.y0 + h), w: Math.abs(w), h: Math.abs(h) };
        if (crop.y < 0 || crop.y + crop.h > H) { const k = crop.y < 0 ? 1 : 0; crop.h = k ? crop.h + crop.y : H - crop.y; crop.y = Math.max(0, crop.y); if (ratio) crop.w = crop.h * ratio; }
      } else {
        const st = drag.st, k = drag.k; let l = st.x, t = st.y, r = st.x + st.w, b = st.y + st.h;
        const px = clamp(p.x, 0, W), py = clamp(p.y, 0, H);
        if (k.includes('w')) l = Math.min(px, r - 8); if (k.includes('e')) r = Math.max(px, l + 8);
        if (k.includes('n')) t = Math.min(py, b - 8); if (k.includes('s')) b = Math.max(py, t + 8);
        if (ratio) {
          if (k.length === 2) { const w = r - l; const h = w / ratio; if (k.includes('n')) t = b - h; else b = t + h; }
          else if (k === 'e' || k === 'w') { const h = (r - l) / ratio, cy = (st.y + st.y + st.h) / 2; t = cy - h / 2; b = cy + h / 2; }
          else { const w = (b - t) * ratio, cx = st.x + st.w / 2; l = cx - w / 2; r = cx + w / 2; }
        }
        crop = { x: l, y: t, w: r - l, h: b - t };
        if (crop.x < 0 || crop.y < 0 || crop.x + crop.w > W || crop.y + crop.h > H) { crop = { ...drag.st }; }
      }
      render();
    },
    up() { if (crop && (crop.w < 4 || crop.h < 4)) crop = imgRect(); drag = null; render(); },
    overlay(g, s) {
      if (!crop) return;
      const W = S.doc.width, H = S.doc.height, { x, y, w, h } = crop;
      g.fillStyle = 'rgba(0,0,0,.55)';
      g.fillRect(0, 0, W, y); g.fillRect(0, y + h, W, H - y - h); g.fillRect(0, y, x, h); g.fillRect(x + w, y, W - x - w, h);
      g.lineWidth = 1.5 / s; g.strokeStyle = '#fff'; g.strokeRect(x, y, w, h);
      g.lineWidth = 1 / s; g.strokeStyle = 'rgba(255,255,255,.4)';
      g.beginPath(); for (let i = 1; i < 3; i++) { g.moveTo(x + (w * i) / 3, y); g.lineTo(x + (w * i) / 3, y + h); g.moveTo(x, y + (h * i) / 3); g.lineTo(x + w, y + (h * i) / 3); } g.stroke();
      g.fillStyle = '#fff'; g.strokeStyle = '#2f6fed'; const q = 11 / s;
      for (const [hx, hy] of Object.values(handles())) { g.beginPath(); g.rect(hx - q / 2, hy - q / 2, q, q); g.fill(); g.stroke(); }
      g.font = `${13 / s}px sans-serif`; g.fillStyle = '#fff'; g.fillText(`${Math.round(w)} × ${Math.round(h)}`, x + 6 / s, y + 18 / s);
    },
  };
})();

// ============ 3. 文字 ============
const FONTS = [['黑體（預設）', '"Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif'], ['明體', '"PMingLiU","Noto Serif TC","Songti TC",serif'], ['楷體', '"DFKai-SB","KaiTi","BiauKai",cursive'], ['圓體', '"Microsoft JhengHei UI","Arial Rounded MT Bold",sans-serif'], ['等寬', 'Consolas,monospace'], ['手寫感', '"Segoe Script","Comic Sans MS",cursive']];
const TSTYLES = [
  { id: 'plain', name: '一般', c: '#ffffff', c2: '#000000' }, { id: 'outline', name: '描邊', c: '#ffffff', c2: '#e11d48' },
  { id: 'shadow', name: '陰影', c: '#ffffff', c2: '#000000' }, { id: 'gold', name: '金屬金', c: '#f7c948', c2: '#5a3a00' },
  { id: 'neon', name: '霓虹', c: '#ffffff', c2: '#ff2bd6' }, { id: '3d', name: '立體', c: '#ffd23f', c2: '#c2410c' },
  { id: 'sticker', name: '貼紙', c: '#111111', c2: '#ffffff' }, { id: 'retro', name: '復古', c: '#ff6b35', c2: '#1d3557' },
];
function drawText(g, it) {
  g.save();
  g.font = `${it.bold ? 700 : 400} ${it.size}px ${it.font}`; g.textBaseline = 'top'; g.textAlign = 'left'; g.lineJoin = 'round'; g.miterLimit = 2;
  const lines = it.text.split('\n'), lh = it.size * 1.25;
  const fillAll = (dx = 0, dy = 0) => lines.forEach((l, i) => g.fillText(l, it.x + dx, it.y + i * lh + dy));
  const strokeAll = (dx = 0, dy = 0) => lines.forEach((l, i) => g.strokeText(l, it.x + dx, it.y + i * lh + dy));
  const sz = it.size, st = it.style;
  g.fillStyle = it.color; g.strokeStyle = it.color2;
  if (st === 'plain') fillAll();
  else if (st === 'outline') { g.lineWidth = sz * 0.14; strokeAll(); fillAll(); }
  else if (st === 'shadow') { g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = sz * 0.14; g.shadowOffsetX = g.shadowOffsetY = sz * 0.06; fillAll(); }
  else if (st === 'gold') {
    const gr = g.createLinearGradient(0, it.y, 0, it.y + lines.length * lh); gr.addColorStop(0, '#fff7cf'); gr.addColorStop(0.45, it.color); gr.addColorStop(0.55, '#b8860b'); gr.addColorStop(1, it.color);
    g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = sz * 0.08; g.shadowOffsetY = sz * 0.04; g.lineWidth = sz * 0.1; strokeAll(); g.shadowColor = 'transparent'; g.fillStyle = gr; fillAll();
  } else if (st === 'neon') { g.shadowColor = it.color2; for (const b of [0.5, 0.25, 0.1]) { g.shadowBlur = sz * b; fillAll(); } g.lineWidth = sz * 0.02; g.strokeStyle = it.color2; strokeAll(); }
  else if (st === '3d') { g.fillStyle = it.color2; const d = Math.max(2, Math.round(sz * 0.09)); for (let i = d; i > 0; i--) fillAll(i, i); g.fillStyle = it.color; fillAll(); }
  else if (st === 'sticker') { g.shadowColor = 'rgba(0,0,0,.4)'; g.shadowBlur = sz * 0.12; g.shadowOffsetY = sz * 0.05; g.lineWidth = sz * 0.3; g.strokeStyle = it.color2; strokeAll(); g.shadowColor = 'transparent'; fillAll(); }
  else if (st === 'retro') { g.fillStyle = it.color2; fillAll(sz * 0.07, sz * 0.07); g.lineWidth = sz * 0.07; g.strokeStyle = '#fff7e6'; strokeAll(); g.fillStyle = it.color; fillAll(); }
  g.restore();
}
function textBox(it) {
  const g = mk(1, 1).getContext('2d'); g.font = `${it.bold ? 700 : 400} ${it.size}px ${it.font}`;
  const lines = it.text.split('\n');
  return { x: it.x, y: it.y, w: Math.max(...lines.map((l) => g.measureText(l).width), it.size * 0.5), h: lines.length * it.size * 1.25 };
}
tools.text = (() => {
  let items = [], sel = -1, drag = null;
  const cur = () => items[sel];
  function add(kind) {
    const W = S.doc.width, H = S.doc.height;
    const conf = { 標題: [W / 9, true, '輸入標題'], 副標題: [W / 16, false, '輸入副標題'], 正文: [W / 28, false, '在這裡輸入正文內容'] }[kind];
    const st = kind === '標題' ? TSTYLES[1] : TSTYLES[0];
    items.push({ text: conf[2], x: W * 0.1, y: H * (0.12 + 0.12 * items.length), size: Math.round(conf[0]), bold: conf[1], font: FONTS[0][1], style: st.id, color: st.c, color2: st.c2 });
    sel = items.length - 1; sync(); render();
  }
  function sync() {
    const it = cur(), dis = !it;
    $$('#tEdit input,#tEdit textarea,#tEdit select,#tEdit button').forEach((e) => (e.disabled = dis));
    if (!it) return;
    $('#tText').value = it.text; $('#tFont').value = it.font; setSl('tSize', it.size); $('#tSize').max = Math.max(200, Math.round(S.doc.width / 2));
    $('#tColor').value = it.color; $('#tColor2').value = it.color2; $('#tBold').checked = it.bold;
    $$('#tStyles .chip').forEach((b, i) => b.classList.toggle('on', TSTYLES[i].id === it.style));
  }
  const bake = () => {
    if (!items.length) return;
    const c = clone(S.doc), g = c.getContext('2d'); items.forEach((it) => drawText(g, it));
    items = []; sel = -1; commit(c);
  };
  return {
    label: '文字', icon: 'type',
    html: () => `
      <div class="chips"><button class="chip" data-k="標題"><b>＋ 標題</b></button><button class="chip" data-k="副標題">＋ 副標題</button><button class="chip" data-k="正文">＋ 正文</button></div>
      <div id="tEdit">
        <textarea id="tText" rows="3" placeholder="選取畫面上的文字或先新增一個"></textarea>
        <label class="row"><span>字型</span><select id="tFont">${FONTS.map((f) => `<option value='${f[1]}'>${f[0]}</option>`).join('')}</select></label>
        ${sl('tSize', '大小', 10, 400, 60)}
        <div class="row2"><label>主色 <input type="color" id="tColor" value="#ffffff"></label><label>副色 <input type="color" id="tColor2" value="#000000"></label><label class="chk"><input type="checkbox" id="tBold"> 粗體</label></div>
        <h3>花字樣式</h3>
        <div class="chips" id="tStyles">${TSTYLES.map((s) => `<button class="chip" style="color:${s.c};background:#444">${s.name}</button>`).join('')}</div>
        <div class="row2"><button class="btn" id="tDel">刪除此文字</button></div>
      </div>
      <button class="btn primary" id="tApply">套用文字到圖片</button>
      <p class="hint">拖曳畫面上的文字可移動位置。</p>`,
    bind(root) {
      root.querySelector('.chips').onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) add(b.dataset.k); };
      const upd = (k, fn) => ($('#' + k).oninput = () => { if (cur()) { fn(cur()); render(); } });
      upd('tText', (it) => (it.text = $('#tText').value || ' '));
      upd('tFont', (it) => (it.font = $('#tFont').value));
      upd('tSize', (it) => (it.size = val('tSize')));
      upd('tColor', (it) => (it.color = $('#tColor').value));
      upd('tColor2', (it) => (it.color2 = $('#tColor2').value));
      upd('tBold', (it) => (it.bold = $('#tBold').checked));
      $('#tBold').onchange = () => { if (cur()) { cur().bold = $('#tBold').checked; render(); } };
      $('#tStyles').onclick = (e) => {
        const b = e.target.closest('.chip'); if (!b || !cur()) return;
        const st = TSTYLES[[...b.parentNode.children].indexOf(b)];
        Object.assign(cur(), { style: st.id, color: st.c, color2: st.c2 }); sync(); render();
      };
      $('#tDel').onclick = () => { items.splice(sel, 1); sel = items.length - 1; sync(); render(); };
      $('#tApply').onclick = bake;
      sync();
    },
    enter() { sync(); },
    leave() { bake(); },
    onDocChange() { if (!S.doc) return; sync(); },
    down(p) {
      sel = -1;
      for (let i = items.length - 1; i >= 0; i--) { const b = textBox(items[i]); if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) { sel = i; drag = { ox: p.x - items[i].x, oy: p.y - items[i].y }; break; } }
      sync(); render();
    },
    move(p) { if (drag && cur()) { cur().x = p.x - drag.ox; cur().y = p.y - drag.oy; render(); } },
    up() { drag = null; },
    overlay(g, s) {
      items.forEach((it, i) => {
        drawText(g, it);
        if (i === sel) { const b = textBox(it); g.save(); g.setLineDash([6 / s, 4 / s]); g.lineWidth = 1.5 / s; g.strokeStyle = '#2f6fed'; g.strokeRect(b.x - 4 / s, b.y - 2 / s, b.w + 8 / s, b.h + 4 / s); g.restore(); }
      });
    },
  };
})();

// ============ 4. 消除圖 ============
tools.erase = (() => {
  let mode = 'rect', mask = null, drawing = false, last = null, rect = null, cursor = null, busy = false;
  const ensure = () => { if (!mask || mask.width !== S.doc.width || mask.height !== S.doc.height) mask = mk(S.doc.width, S.doc.height); };
  async function go() {
    if (busy) return; busy = true;
    // 不先清空遮罩：工作被拒絕、取消或失敗時，使用者的框選必須保留，才能再次操作
    const m = mask, before = S.doc; render();
    const res = await runJob('生成中', async ({ signal, progress }) => AI.inpaint(before, m, { signal, onProgress: progress }));
    busy = false;
    // 只有結果正式套用後才清理遮罩；原圖與歷史紀錄由 commit 負責，這裡不另外修改
    if (res) { mask = null; rect = null; commit(res); setCompare(before); }
    render();
  }
  return {
    label: '消除圖', icon: 'eraser',
    html: () => `
      <div class="seg" id="eMode"><button class="on" data-m="rect">框選水印</button><button data-m="brush">塗抹消除</button></div>
      <p class="hint" id="eHint">在水印、文字或不要的物件上拖曳框選，放開後會自動用 MI-GAN 移除。</p>
      <div id="eBrushRow" hidden>${sl('eSize', '筆刷大小', 4, 200, 40)}</div>
      <p class="hint">首次使用需下載約 28 MB 的 MI-GAN 模型，之後會快取。<br>運算後可拖曳畫面上的對比線檢視前後差異；不滿意可按復原。</p>`,
    bind() {
      $('#eMode').onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return; mode = b.dataset.m;
        $$('#eMode button').forEach((x) => x.classList.toggle('on', x === b));
        $('#eBrushRow').hidden = mode !== 'brush';
        $('#eHint').textContent = mode === 'rect' ? '在水印、文字或不要的物件上拖曳框選，放開後會自動用 MI-GAN 移除。' : '用筆刷塗過想消除的地方，放開滑鼠就會自動消除。';
      };
    },
    enter() { ensure(); S.compare = null; },
    leave() { mask = null; rect = null; },
    onDocChange() { mask = null; rect = null; },
    down(p) {
      if (busy) return; ensure(); drawing = true; last = p;
      if (mode === 'rect') rect = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      else this.stroke(p, p);
    },
    stroke(a, b) {
      const g = mask.getContext('2d'); g.strokeStyle = g.fillStyle = '#ff3b3b'; g.lineCap = g.lineJoin = 'round'; g.lineWidth = val('eSize');
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); if (a === b) { g.beginPath(); g.arc(a.x, a.y, g.lineWidth / 2, 0, 7); g.fill(); } render();
    },
    move(p) {
      cursor = p;
      if (drawing) { if (mode === 'rect') rect.x1 = p.x, rect.y1 = p.y; else { this.stroke(last, p); last = p; } }
      render();
    },
    up() {
      if (!drawing) return; drawing = false;
      if (mode === 'rect') {
        const x = Math.min(rect.x0, rect.x1), y = Math.min(rect.y0, rect.y1), w = Math.abs(rect.x1 - rect.x0), h = Math.abs(rect.y1 - rect.y0);
        if (w < 3 || h < 3) { rect = null; return render(); }
        const g = mask.getContext('2d'); g.fillStyle = '#ff3b3b'; g.fillRect(x, y, w, h);
        rect = null; // 框選已寫入遮罩，之後以遮罩為準
      }
      go();
    },
    overlay(g, s) {
      if (mask) { g.globalAlpha = 0.55; g.drawImage(mask, 0, 0); g.globalAlpha = 1; }
      if (rect) { g.setLineDash([6 / s, 4 / s]); g.lineWidth = 2 / s; g.strokeStyle = '#ff3b3b'; g.fillStyle = 'rgba(255,59,59,.25)'; const x = Math.min(rect.x0, rect.x1), y = Math.min(rect.y0, rect.y1); g.fillRect(x, y, Math.abs(rect.x1 - rect.x0), Math.abs(rect.y1 - rect.y0)); g.strokeRect(x, y, Math.abs(rect.x1 - rect.x0), Math.abs(rect.y1 - rect.y0)); g.setLineDash([]); }
      if (mode === 'brush' && cursor && !busy) { g.lineWidth = 1.5 / s; g.strokeStyle = '#fff'; g.beginPath(); g.arc(cursor.x, cursor.y, val('eSize') / 2, 0, 7); g.stroke(); }
    },
  };
})();

// ============ 5. 摳圖 ============
tools.cutout = (() => {
  let raw = null, edit = null, srcPix = null, cut = null, cutCtx = null, outId = null, bgImg = null, painting = false, cursor = null;
  const reset = () => { raw = edit = srcPix = cut = outId = null; S.preview = null; };
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  function finalAlpha() { // 供下載/套用使用
    const keep = val('cKeep'), th = 0.9 - (0.8 * keep) / 100;
    const n = raw.length, out = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) out[i] = edit[i] > 0 ? 255 : edit[i] < 0 ? 0 : smooth(th - 0.08, th + 0.08, raw[i]) * 255;
    return out;
  }
  const rebuild = raf(() => {
    if (!raw) return;
    const W = S.doc.width, H = S.doc.height, a = finalAlpha(), sp = srcPix.data, od = outId.data;
    for (let i = 0, n = W * H; i < n; i++) { od[i * 4] = sp[i * 4]; od[i * 4 + 1] = sp[i * 4 + 1]; od[i * 4 + 2] = sp[i * 4 + 2]; od[i * 4 + 3] = (sp[i * 4 + 3] * a[i]) / 255; }
    cutCtx.putImageData(outId, 0, 0);
    S.preview = composite(); if (S.compare) { S.compare = null; refreshHist(); } render();
  });
  function composite() {
    const bg = $('#cBg').value, W = S.doc.width, H = S.doc.height;
    if (bg === 'none') return cut;
    const c = mk(W, H), g = c.getContext('2d');
    if (bg === 'color') { g.fillStyle = $('#cColor').value; g.fillRect(0, 0, W, H); }
    else if (bg === 'blur') { const m = Math.max(W, H); g.filter = `blur(${m / 70}px)`; g.drawImage(S.doc, -m * 0.03, -m * 0.03, W + m * 0.06, H + m * 0.06); g.filter = 'none'; }
    else if (bg === 'image' && bgImg) { const k = Math.max(W / bgImg.width, H / bgImg.height); g.drawImage(bgImg, (W - bgImg.width * k) / 2, (H - bgImg.height * k) / 2, bgImg.width * k, bgImg.height * k); }
    g.drawImage(cut, 0, 0); return c;
  }
  const enableUI = () => $$('.cAfter').forEach((e) => (e.disabled = !raw));
  return {
    label: '摳圖', icon: 'scissors',
    html: () => `
      <button class="btn primary big" id="cRun">✨ AI 一鍵摳圖</button>
      <p class="hint">使用 U²-Net 辨識主體（首次需下載約 176 MB 模型，之後會快取）。</p>
      ${sl('cKeep', '主體保留', 0, 100, 50)}
      <p class="hint">往右＝保留更多（含半透明邊緣）；往左＝只留最確定的主體。</p>
      <h3>筆刷修補</h3>
      <div class="seg" id="cBrushMode"><button class="cAfter on" data-m="1">＋ 補回主體</button><button class="cAfter" data-m="-1">－ 擦除背景</button></div>
      ${sl('cSize', '筆刷大小', 4, 200, 40)}
      <h3>換背景</h3>
      <select id="cBg" class="cAfter"><option value="none">透明</option><option value="color">純色</option><option value="blur">模糊原圖</option><option value="image">自選圖片…</option></select>
      <div class="row2"><label>顏色 <input type="color" id="cColor" value="#ffffff" class="cAfter"></label><input type="file" id="cBgFile" accept="image/*" hidden></div>
      <div class="row2"><button class="btn cAfter" id="cDl">下載透明 PNG</button><button class="btn primary cAfter" id="cApply">套用到圖片</button></div>`,
    bind() {
      enableUI();
      $('#cRun').onclick = async () => {
        const src = S.doc;
        const r = await runJob('生成中', ({ signal, progress }) => AI.matteImage(src, { signal, onProgress: progress }));
        if (!r) return;
        raw = r.alpha; edit = new Int8Array(raw.length); const W = src.width, H = src.height;
        srcPix = src.getContext('2d').getImageData(0, 0, W, H); outId = new ImageData(W, H);
        cut = mk(W, H); cutCtx = cut.getContext('2d'); enableUI(); rebuild();
      };
      $('#cKeep').oninput = rebuild;
      $('#cBrushMode').onclick = (e) => { const b = e.target.closest('button'); if (b) $$('#cBrushMode button').forEach((x) => x.classList.toggle('on', x === b)); };
      $('#cBg').onchange = () => { if ($('#cBg').value === 'image') $('#cBgFile').click(); rebuild(); };
      $('#cColor').oninput = () => { $('#cBg').value = 'color'; rebuild(); };
      $('#cBgFile').onchange = async (e) => { const f = e.target.files[0]; if (f) { bgImg = await fileToCanvas(f); rebuild(); } };
      $('#cDl').onclick = () => { cut.toBlob((b) => downloadBlob(b, 'xiuxiu-cutout.png'), 'image/png'); };
      $('#cApply').onclick = () => { const c = clone(S.preview || cut); reset(); commit(c); };
    },
    leave() { reset(); },
    onDocChange() { reset(); enableUI(); },
    paint(p) {
      const m = +$('#cBrushMode .on').dataset.m, r = val('cSize') / 2, W = S.doc.width, H = S.doc.height;
      const x0 = Math.max(0, Math.floor(p.x - r)), x1 = Math.min(W - 1, Math.ceil(p.x + r)), y0 = Math.max(0, Math.floor(p.y - r)), y1 = Math.min(H - 1, Math.ceil(p.y + r));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x - p.x) ** 2 + (y - p.y) ** 2 <= r * r) edit[y * W + x] = m;
    },
    down(p) { if (!raw) return; painting = true; this.paint(p); rebuild(); },
    move(p) { cursor = p; if (painting) { this.paint(p); rebuild(); } else if (raw) render(); },
    up() { painting = false; },
    overlay(g, s) { if (raw && cursor) { g.lineWidth = 1.5 / s; g.strokeStyle = '#fff'; g.beginPath(); g.arc(cursor.x, cursor.y, val('cSize') / 2, 0, 7); g.stroke(); } },
  };
})();

// ============ 6. 變清晰 ============
tools.enhance = (() => {
  const LIM = 8192;
  const modelKey = (m, sc) => (m === 'std' ? (sc === 2 ? 'std2' : 'std4') : m);
  const info = () => {
    const sc = +$('#hScale .on').dataset.v, W = S.doc.width * sc, H = S.doc.height * sc, bad = Math.max(W, H) > LIM || W * H > 1.2e8;
    $('#hInfo').innerHTML = `輸出尺寸：<b>${W} × ${H}</b>${bad ? '<br><span class="warn">超過瀏覽器上限（單邊 8192 px），請先縮小圖片或改選 2 倍。</span>' : ''}`;
    $('#hRun').disabled = bad;
  };
  return {
    label: '變清晰', icon: 'sparkle',
    html: () => `
      <h3>放大倍率</h3>
      <div class="seg" id="hScale"><button data-v="2">2 倍</button><button class="on" data-v="4">4 倍</button></div>
      <h3>AI 模型</h3>
      <label class="radio"><input type="radio" name="hm" value="fast" checked> <b>Real-ESRGAN 快速</b><small>通用照片，速度最快（約 5 MB）</small></label>
      <label class="radio"><input type="radio" name="hm" value="std"> <b>Upscayl 標準</b><small>照片細節最豐富，較慢（約 67 MB）</small></label>
      <label class="radio"><input type="radio" name="hm" value="art"> <b>Upscayl 數位藝術</b><small>插畫、動漫、截圖（約 18 MB）</small></label>
      <p class="hint" id="hInfo"></p>
      <button class="btn primary big" id="hRun">開始變清晰</button>
      <p class="hint">完成後可拖曳畫面中的對比線檢視前後差異。</p>`,
    bind() {
      $('#hScale').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $$('#hScale button').forEach((x) => x.classList.toggle('on', x === b)); info(); };
      info();
      $('#hRun').onclick = async () => {
        const sc = +$('#hScale .on').dataset.v, key = modelKey($('input[name=hm]:checked').value, sc), before = S.doc;
        const res = await runJob('生成中', ({ signal, progress }) => AI.upscale(before, { model: key, scale: sc, signal, onProgress: progress }));
        if (res) { commit(res); setCompare(before); }
      };
    },
    onDocChange() { if ($('#hScale')) info(); },
  };
})();

// ============ 7. 調色 ============
const PRESETS = [
  { name: '原圖', v: {} }, { name: '鮮豔', v: { sat: 35, con: 12 } }, { name: '清新', v: { bri: 8, sat: 15, temp: -15, fade: 10 } },
  { name: '暖陽', v: { temp: 45, sat: 12, bri: 5 } }, { name: '冷調', v: { temp: -45, con: 8 } }, { name: '黑白', v: { sat: -100, con: 15 } },
  { name: '復古', v: { sat: -25, temp: 30, fade: 30, vig: 30 } }, { name: '電影感', v: { con: 25, sat: -10, temp: -10, vig: 45 } }, { name: '柔霧', v: { bri: 10, con: -15, fade: 25, blur: 1 } },
];
const FILTERS = [
  { name: '無', css: '' }, { name: '懷舊棕', css: 'sepia(.7)' }, { name: '單色', css: 'grayscale(1) contrast(1.1)' }, { name: '負片', css: 'invert(1)' },
  { name: '冷藍', css: 'hue-rotate(-20deg) saturate(1.2)' }, { name: '粉嫩', css: 'hue-rotate(-30deg) saturate(1.1) brightness(1.08)' }, { name: '高反差', css: 'contrast(1.45) saturate(1.1)' }, { name: '夢幻', css: 'brightness(1.1) saturate(1.3) blur(.6px)' },
];
tools.color = (() => {
  const D = { bri: 0, con: 0, sat: 0, hue: 0, temp: 0, fade: 0, vig: 0, blur: 0 };
  let adj = { ...D }, fcss = '', rc = { h0: null, s0: 0, v0: 0, to: '#ff3b3b', tol: 30, on: false }, picking = false, repl = null;
  const SL = [['bri', '亮度', -100, 100], ['con', '對比', -100, 100], ['sat', '飽和度', -100, 100], ['hue', '色相', -180, 180], ['temp', '色溫（冷↔暖）', -100, 100], ['fade', '褪色', 0, 100], ['vig', '暗角', 0, 100], ['blur', '模糊', 0, 10]];
  const rgb2hsv = (r, g, b) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0; if (d) { if (mx === r) h = ((g - b) / d + 6) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; } return [h, mx ? d / mx : 0, mx]; };
  const hsv2rgb = (h, s, v) => { const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c; const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]; return [(r + m) * 255, (g + m) * 255, (b + m) * 255]; };
  const hex2rgb = (x) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16));
  function replaceColor(src) {
    const W = src.width, H = src.height, c = clone(src), g = c.getContext('2d'), id = g.getImageData(0, 0, W, H), d = id.data;
    const [h1, s1, v1] = rgb2hsv(...hex2rgb(rc.to)), { h0, s0, v0, tol } = rc, sr = clamp(s1 / Math.max(s0, 0.1), 0, 2), vr = clamp(v1 / Math.max(v0, 0.1), 0.3, 1.7);
    for (let i = 0; i < d.length; i += 4) {
      const [h, s, v] = rgb2hsv(d[i], d[i + 1], d[i + 2]); if (s < 0.1) continue;
      let df = Math.abs(h - h0); df = Math.min(df, 360 - df); if (df > tol) continue;
      const w = 1 - clamp((df - tol * 0.6) / (tol * 0.4), 0, 1), nh = (h + (h1 - h0) * w + 360) % 360;
      const [r, gg, b] = hsv2rgb(nh, clamp(s * (1 + (sr - 1) * w), 0, 1), clamp(v * (1 + (vr - 1) * w * 0.6), 0, 1));
      d[i] = r; d[i + 1] = gg; d[i + 2] = b;
    }
    g.putImageData(id, 0, 0); return c;
  }
  function colorize(src) {
    const W = src.width, H = src.height, c = mk(W, H), g = c.getContext('2d');
    g.filter = `${fcss} brightness(${1 + adj.bri / 100}) contrast(${1 + adj.con / 100}) saturate(${1 + adj.sat / 100}) hue-rotate(${adj.hue}deg) blur(${(adj.blur * Math.max(W, H)) / 1500}px)`.trim();
    g.drawImage(src, 0, 0); g.filter = 'none'; g.globalCompositeOperation = 'source-atop';
    if (adj.temp) { g.fillStyle = adj.temp > 0 ? `rgba(255,140,40,${adj.temp * 0.003})` : `rgba(40,120,255,${-adj.temp * 0.003})`; g.fillRect(0, 0, W, H); }
    if (adj.fade) { g.fillStyle = `rgba(255,255,255,${adj.fade * 0.0035})`; g.fillRect(0, 0, W, H); }
    if (adj.vig) { const gr = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.hypot(W, H) / 2); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${adj.vig * 0.008})`); g.fillStyle = gr; g.fillRect(0, 0, W, H); }
    return c;
  }
  const changed = () => JSON.stringify(adj) !== JSON.stringify(D) || fcss || (rc.on && rc.h0 != null);
  const update = raf(() => {
    if (!S.doc) return;
    if (!changed()) { S.preview = null; return render(); }
    let base = S.doc;
    if (rc.on && rc.h0 != null) base = replaceColor(base);
    S.preview = colorize(base); if (S.compare) { S.compare = null; refreshHist(); } render();
  });
  const syncUI = () => SL.forEach(([k]) => setSl('c_' + k, adj[k]));
  return {
    label: '調色', icon: 'sliders',
    html: () => `
      <h3>預設</h3><div class="chips" id="kPre">${chips(PRESETS, 'data-i')}</div>
      <h3>滑桿</h3>${SL.map(([k, n, a, b]) => sl('c_' + k, n, a, b, 0)).join('')}
      <h3>濾鏡</h3><div class="chips" id="kFil">${chips(FILTERS, 'data-i')}</div>
      <h3>一鍵換色</h3>
      <div class="row2"><button class="btn" id="kPick">🎯 吸取要換的顏色</button><span id="kSw" class="sw"></span></div>
      ${sl('kTol', '範圍', 8, 90, 30)}
      <div class="row2"><label>換成 <input type="color" id="kTo" value="#ff3b3b"></label></div>
      <div class="row2"><button class="btn" id="kCancel">還原</button><button class="btn primary" id="kApply">套用調色</button></div>`,
    bind() {
      $('#kPre').onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return; adj = { ...D, ...PRESETS[+b.dataset.i].v }; syncUI(); update(); };
      $('#kFil').onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return; fcss = FILTERS[+b.dataset.i].css; update(); };
      SL.forEach(([k]) => ($('#c_' + k).oninput = () => { adj[k] = val('c_' + k); update(); }));
      $('#kPick').onclick = () => { picking = true; toast('請在畫面上點選要換色的位置'); };
      $('#kTol').oninput = () => { rc.tol = val('kTol'); update(); };
      $('#kTo').oninput = () => { rc.to = $('#kTo').value; rc.on = true; update(); };
      $('#kCancel').onclick = () => { this.clear(); update(); };
      $('#kApply').onclick = () => { if (S.preview) { const c = S.preview; this.clear(); commit(c); } };
    },
    clear() { adj = { ...D }; fcss = ''; rc.h0 = null; rc.on = false; if ($('#c_bri')) { syncUI(); $('#kSw').style.background = ''; } },
    leave() { this.clear(); S.preview = null; },
    onDocChange() { this.clear(); },
    down(p) {
      if (!picking) return; picking = false;
      const x = clamp(Math.floor(p.x), 0, S.doc.width - 1), y = clamp(Math.floor(p.y), 0, S.doc.height - 1), d = S.doc.getContext('2d').getImageData(x, y, 1, 1).data;
      [rc.h0, rc.s0, rc.v0] = rgb2hsv(d[0], d[1], d[2]); rc.on = true; $('#kSw').style.background = `rgb(${d[0]},${d[1]},${d[2]})`; update();
    },
  };
})();
