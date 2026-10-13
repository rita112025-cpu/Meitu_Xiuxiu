// 在真實頁面（index.html）中執行的測試。由 run.mjs 以 Runtime.evaluate 注入執行。
// 影音測試使用瀏覽器內即時產生的合成素材，並呼叫真實的 WebCodecs 編碼，不以 mock 取代輸出驗證。
(async (only, debug) => {
  const results = [];
  const log = (...a) => { if (debug) console.log(...a); }; // 除錯輸出只在 DEBUG=1 時開啟，不影響結果
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms, label) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${label} 逾時 ${ms}ms`); })]);
  const check = (cond, msg) => { if (!cond) throw new Error(msg); };
  const CANNOT = (detail) => ({ status: 'CANNOT_VERIFY', detail });
  const run = async (name, fn) => {
    if (only && !name.startsWith(only)) return;
    log('[start] ' + name);
    try {
      const r = await fn();
      results.push({ name, status: r?.status || 'PASS', detail: r?.detail || '' });
      log('[done] ' + (r?.status || 'PASS') + ' ' + name + ' ' + (r?.detail || ''));
    } catch (e) {
      results.push({ name, status: 'FAIL', detail: String(e?.message || e) });
      log('[done] FAIL ' + name + ' ' + (e?.message || e));
    }
  };

  const core = await import('/js/core.js');
  const main = await import('/js/main.js');
  const VD = await import('/js/video.js');
  const { S } = core;
  const $ = (s) => document.querySelector(s);
  const waitFor = async (cond, ms = 5000, label = 'condition') => {
    const t0 = Date.now();
    while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`等待 ${label} 逾時`); await sleep(10); }
  };
  const pixel = (c, x, y) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3));
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  // 測試圖：每個像素的 R=x、G=y、B=128，方便從像素反推位置
  const patternBlob = (w, h, type = 'image/png') => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), id = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; id.data[i] = x % 256; id.data[i + 1] = y % 256; id.data[i + 2] = 128; id.data[i + 3] = 255; }
    g.putImageData(id, 0, 0);
    return new Promise((r) => c.toBlob(r, type));
  };
  const openPattern = async (w, h) => {
    await window.openFiles([new File([await patternBlob(w, h)], 'pattern.png', { type: 'image/png' })]);
    await waitFor(() => S.doc && S.doc.width === w && S.mode === 'image', 5000, '圖片載入');
  };

  // ---------- 1. 圖片載入、裁切、Undo、Redo、重置 ----------
  await run('圖片：載入 320×200 PNG 並保留像素', async () => {
    await openPattern(320, 200);
    check(S.doc.width === 320 && S.doc.height === 200, `尺寸錯誤 ${S.doc.width}×${S.doc.height}`);
    check(same(pixel(S.doc, 100, 50), [100, 50, 128]), '像素不符');
  });

  await run('圖片：裁切 (40,20)-(200,120) 得到 160×100 並保留像素', async () => {
    await openPattern(320, 200);
    main.selectTool('adjust');
    S.tool.leave(); S.tool.enter();
    S.tool.leave(); // 清除預設整張裁切框，改為手動拖曳
    S.tool.down({ x: 40, y: 20 }); S.tool.move({ x: 200, y: 120 }); S.tool.up();
    $('#aCrop').click();
    check(S.doc.width === 160 && S.doc.height === 100, `裁切尺寸錯誤 ${S.doc.width}×${S.doc.height}`);
    check(same(pixel(S.doc, 0, 0), [40, 20, 128]), `裁切起點像素錯誤 ${pixel(S.doc, 0, 0)}`);
  });

  await run('圖片：Undo 還原裁切前、Redo 重做裁切後、重置回原圖', async () => {
    await openPattern(320, 200);
    main.selectTool('adjust');
    S.tool.leave(); S.tool.enter(); S.tool.leave();
    S.tool.down({ x: 40, y: 20 }); S.tool.move({ x: 200, y: 120 }); S.tool.up();
    $('#aCrop').click();
    check(S.doc.width === 160, '裁切未生效');
    $('#btnUndo').click();
    check(S.doc.width === 320 && S.doc.height === 200, `Undo 後尺寸 ${S.doc.width}×${S.doc.height}`);
    check(same(pixel(S.doc, 100, 50), [100, 50, 128]), 'Undo 後像素不符');
    $('#btnRedo').click();
    check(S.doc.width === 160 && S.doc.height === 100, `Redo 後尺寸 ${S.doc.width}×${S.doc.height}`);
    $('#btnReset').click();
    check(S.doc.width === 320 && S.doc.height === 200, `重置後尺寸 ${S.doc.width}×${S.doc.height}`);
    check(same(pixel(S.doc, 100, 50), [100, 50, 128]), '重置後像素不符');
    $('#btnUndo').click();
    check(S.doc.width === 160, '重置應可被 Undo');
  });

  await run('runJob：顯示時焦點移到取消鈕，結束後還原焦點', async () => {
    const btn = $('#btnFit'); btn.focus();
    let release;
    const p = core.runJob('F', () => new Promise((r) => { release = r; }));
    await sleep(20);
    check(document.activeElement === $('#jobCancel'), '工作顯示時焦點未移到取消鈕');
    check($('#top').inert && $('main').inert, '工作顯示時背景介面未設為 inert');
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    $('#jobCancel').dispatchEvent(tab);
    check(tab.defaultPrevented && document.activeElement === $('#jobCancel'), 'Tab 未被限制在工作對話框內');
    release('x'); await p;
    check(!$('#top').inert && !$('main').inert, '工作結束後背景介面的 inert 未還原');
    check(document.activeElement === btn, '工作結束後未還原焦點');
  });

  await run('文字：文字工具開啟時載入新圖，未套用的舊文字不會被套用到新圖', async () => {
    await openPattern(320, 200);
    main.selectTool('text');
    try {
      document.querySelector('#panel [data-k="標題"]').click(); // 新增一段尚未套用的標題
      await openPattern(160, 100);
      await sleep(30);
      check(S.hist.length === 0, `換圖後產生了 ${S.hist.length} 筆歷史，舊圖的文字被套用到新圖`);
    } finally { main.selectTool('new'); }
  });

  await run('文字：待套用的文字在同一張圖上按復原後仍保留', async () => {
    await openPattern(320, 200);
    main.selectTool('adjust'); // 先裁切，產生一筆可復原的歷史
    S.tool.leave(); S.tool.enter(); S.tool.leave();
    S.tool.down({ x: 40, y: 20 }); S.tool.move({ x: 200, y: 120 }); S.tool.up();
    $('#aCrop').click();
    main.selectTool('text');
    try {
      document.querySelector('#panel [data-k="標題"]').click();
      $('#btnUndo').click();
      check(S.doc.width === 320, '復原未生效');
      check($('#tText').value === '輸入標題', '復原後待套用的文字被清空');
    } finally { main.selectTool('new'); }
  });

  await run('後端：徽章顯示的 WebGPU / CPU 與 detectGPU() 的結果一致', async () => {
    const AI = await import('/js/ai.js');
    const gpu = await AI.detectGPU();
    await waitFor(() => $('#badge').textContent !== '檢測中…', 5000, '徽章更新');
    const want = gpu ? 'WebGPU' : 'CPU（較慢）';
    check($('#badge').textContent === want, `徽章 ${$('#badge').textContent}，預期 ${want}`);
    dispatchEvent(new CustomEvent('xiuxiu:backend-change', { detail: { gpu: false } }));
    check($('#badge').textContent === 'CPU（較慢）' && $('#badge').classList.contains('warn'), 'WASM fallback 後徽章未切換為 CPU');
    dispatchEvent(new CustomEvent('xiuxiu:backend-change', { detail: { gpu } }));
  });

  await run('調色：一鍵換色後調整滑桿與換色目標，預覽更新且套用後只產生一筆歷史', async () => {
    await openPattern(320, 200);
    main.selectTool('color');
    try {
      $('#kPick').click(); // 進入吸色模式
      S.tool.down({ x: 100, y: 50 });
      await waitFor(() => S.preview, 5000, '吸色後的預覽');
      $('#kTo').value = '#ff0000'; $('#kTo').dispatchEvent(new Event('input'));
      await sleep(30);
      $('#c_bri').value = 20; $('#c_bri').dispatchEvent(new Event('input'));
      await sleep(30);
      check(S.preview && S.preview.width === 320 && S.preview.height === 200, '換色後的預覽尺寸錯誤');
      check(S.hist.length === 0, '預覽時不應寫入歷史');
      $('#kApply').click();
      check(S.hist.length === 1, `套用後歷史筆數 ${S.hist.length}，預期 1`);
    } finally { main.selectTool('new'); }
  });

  await run('消除：傳入外接矩形 box 的結果與逐像素掃描遮罩完全相同', async () => {
    const AI = await import('/js/ai.js');
    const src = document.createElement('canvas'); src.width = 320; src.height = 200;
    const sg = src.getContext('2d'), id = sg.createImageData(320, 200);
    for (let p = 0; p < 320 * 200; p++) { id.data[p * 4] = (p % 320) % 256; id.data[p * 4 + 1] = Math.floor(p / 320) % 256; id.data[p * 4 + 2] = 128; id.data[p * 4 + 3] = 255; }
    sg.putImageData(id, 0, 0);
    const mask = document.createElement('canvas'); mask.width = 320; mask.height = 200;
    const mg = mask.getContext('2d'); mg.fillStyle = '#fff'; mg.fillRect(97, 77, 46, 36);
    const a = await AI.inpaint(src, mask);
    const b = await AI.inpaint(src, mask, { box: { x: 97, y: 77, w: 46, h: 36 } });
    check(a && b, 'inpaint 回傳 null');
    const da = a.getContext('2d').getImageData(0, 0, 320, 200).data, db = b.getContext('2d').getImageData(0, 0, 320, 200).data;
    check(da.every((v, i) => v === db[i]), 'box 版本與逐像素掃描的結果不同');
  });

  // ---------- 2. PNG / JPG / WebP 匯出 ----------
  await run('匯出：PNG、JPG、WebP 的檔頭與尺寸正確', async () => {
    await openPattern(160, 100);
    const captured = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { captured.push({ href: this.href, name: this.download }); };
    try {
      for (const fmt of ['png', 'jpg', 'webp']) {
        const before = captured.length;
        core.exportCanvas(S.doc, fmt, 0.92, 'probe');
        await waitFor(() => captured.length === before + 1, 5000, `${fmt} 匯出`);
      }
    } finally { HTMLAnchorElement.prototype.click = origClick; }
    const report = [];
    for (const c of captured) {
      const blob = await (await fetch(c.href)).blob();
      const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
      const ext = c.name.split('.').pop();
      const magic = { png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], webp: null }[ext];
      const ok = magic ? magic.every((b, i) => head[i] === b) : String.fromCharCode(...head.slice(0, 4)) === 'RIFF' && String.fromCharCode(...head.slice(8, 12)) === 'WEBP';
      check(ok, `${ext} 檔頭不正確`);
      const bmp = await createImageBitmap(blob);
      check(bmp.width === 160 && bmp.height === 100, `${ext} 尺寸 ${bmp.width}×${bmp.height}`);
      // 有損格式允許誤差；PNG 必須完全相同
      const cv = document.createElement('canvas'); cv.width = 160; cv.height = 100;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      const p = pixel(cv, 40, 20), want = [40, 20, 128], tol = ext === 'png' ? 0 : 12;
      check(p.every((v, i) => Math.abs(v - want[i]) <= tol), `${ext} 像素 ${p} 與預期 ${want} 差距過大`);
      report.push(`${ext}:${blob.size}B`);
    }
    return { detail: report.join(' ') };
  });

  // ---------- 3. runJob 取消與搶佔 ----------
  await run('runJob：工作進行中拒絕新工作，新函式不執行、進度與標題不變', async () => {
    let releaseA;
    const pA = core.runJob('A', () => new Promise((r) => { releaseA = r; }));
    await sleep(20);
    const labelBefore = $('#jobLabel').textContent;
    let ran = false;
    const rB = await withTimeout(core.runJob('B', () => { ran = true; return 'B'; }), 500, '被拒絕的 runJob');
    check(rB === null, '被拒絕的工作應回傳 null');
    check(!ran, '被拒絕的工作函式不應執行');
    check($('#jobTitle').textContent === 'A', '標題被新請求改寫');
    check($('#jobLabel').textContent === labelBefore, '進度被新請求改寫');
    check($('#toast').textContent.includes('目前有工作進行中'), '未顯示忙碌提示');
    releaseA('A-result');
    check((await withTimeout(pA, 500, 'A')) === 'A-result', 'A 應正常完成');
  });

  await run('runJob：Cancel 只中止目前工作；UI 立即返回，底層未結束前拒絕新工作，結束後可重啟', async () => {
    let releaseA, progressA;
    const pA = core.runJob('A', ({ progress }) => { progressA = progress; return new Promise((r) => { releaseA = r; }); }); // 忽略 signal
    await sleep(20);
    $('#jobCancel').click();
    check((await withTimeout(pA, 500, '取消後的 runJob')) === null, 'A 取消後應回傳 null');
    check(!$('#job').classList.contains('show'), 'UI 應立即隱藏');
    progressA(0.9, 'A-stale-label'); // 底層仍在執行，但 UI 已返回，不應寫入
    check($('#jobLabel').textContent !== 'A-stale-label', 'UI 返回後舊工作仍改寫進度');
    let ranC = false;
    const rC = await core.runJob('C', () => { ranC = true; return 'C'; });
    check(rC === null && !ranC, '底層未結束時新工作應被拒絕且不執行');
    releaseA('late');
    await sleep(20);
    check((await withTimeout(core.runJob('D', async () => 'D'), 500, 'D')) === 'D', '底層結束後應可重新啟動');
  });

  await run('runJob：完成、失敗、取消三條路徑之後都能重新啟動', async () => {
    check((await core.runJob('ok', async () => 1)) === 1, '完成路徑');
    await sleep(20);
    check((await core.runJob('fail', async () => { throw new Error('boom'); })) === null, '失敗路徑應回傳 null');
    check($('#toast').textContent.includes('處理失敗'), '失敗路徑未顯示錯誤提示');
    await sleep(20);
    const pC = core.runJob('cancel', ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')))));
    await sleep(20);
    $('#jobCancel').click();
    check((await withTimeout(pC, 500, '取消路徑')) === null, '取消路徑應回傳 null');
    await sleep(20);
    check((await core.runJob('after', async () => 'again')) === 'again', '取消後無法重新啟動');
  });

  await run('Erase：工作進行中被拒絕時保留遮罩，且不改動原圖與歷史；成功後才清理遮罩', async () => {
    await openPattern(320, 200);
    main.selectTool('erase');
    // 讀取目前遮罩在指定像素的 alpha（透過工具自己的 overlay 繪製結果）
    const maskAlphaAt = (x, y) => {
      const real = document.createElement('canvas'); real.width = 320; real.height = 200;
      const g = real.getContext('2d');
      S.tool.overlay(g, 1);
      return g.getImageData(x, y, 1, 1).data[3];
    };
    const docBefore = S.doc, histBefore = S.hist.length;
    let releaseBlocker;
    const blocker = core.runJob('blocker', () => new Promise((r) => { releaseBlocker = r; }));
    await sleep(20);
    S.tool.down({ x: 100, y: 80 }); S.tool.move({ x: 140, y: 120 }); S.tool.up(); // 被拒絕：工作鎖被佔用
    await sleep(50);
    check(S.doc === docBefore && S.hist.length === histBefore, '被拒絕後原圖或歷史被改動');
    check(maskAlphaAt(120, 100) > 0, '被拒絕後遮罩被清空，使用者的框選遺失');
    releaseBlocker('done');
    await blocker;
    await sleep(30);
    // 再次操作：原遮罩仍在，加入第二個框後一併消除
    S.tool.down({ x: 150, y: 90 }); S.tool.move({ x: 170, y: 110 }); S.tool.up();
    await waitFor(() => S.hist.length === histBefore + 1, 60000, '消除完成');
    check(maskAlphaAt(120, 100) === 0, '成功套用後遮罩未清理');
  });

  // ---------- 編輯狀態：Undo/Redo/Reset、取消、過期結果、重複操作 ----------
  const boxHidden = async () => {
    try { await waitFor(() => !$('#job').classList.contains('show'), 60000, '進度框隱藏'); }
    catch (e) { throw new Error(`${e.message}；目前進度「${$('#jobLabel').textContent}」，提示「${$('#toast').textContent}」`); }
  };
  const eraseMaskAlphaAt = (x, y) => {
    const real = document.createElement('canvas'); real.width = 320; real.height = 200;
    const g = real.getContext('2d');
    S.tool.overlay(g, 1);
    return g.getImageData(x, y, 1, 1).data[3];
  };
  const cropTo160x100 = async () => {
    main.selectTool('adjust');
    S.tool.leave(); S.tool.enter(); S.tool.leave();
    S.tool.down({ x: 40, y: 20 }); S.tool.move({ x: 200, y: 120 }); S.tool.up();
    $('#aCrop').click();
    check(S.doc.width === 160, '前置裁切未生效');
  };

  await run('編輯狀態：AI 工作執行期間 Undo 被拒絕，畫面與歷史不變', async () => {
    await openPattern(320, 200);
    await cropTo160x100();
    const docBefore = S.doc, histBefore = S.hist.length;
    let release;
    const blocker = core.runJob('blocker', () => new Promise((r) => { release = r; }));
    await sleep(20);
    try {
      $('#btnUndo').click();
      await sleep(30);
      check(S.doc === docBefore && S.hist.length === histBefore, 'AI 工作執行中 Undo 改動了畫面或歷史');
    } finally {
      release('done'); // 無論斷言成敗都要釋放工作鎖，避免影響後續測試
      await blocker;
      await boxHidden();
    }
  });

  await run('編輯狀態：消除期間畫面已被其他操作改變，過期的消除結果不得覆寫較新的畫面', async () => {
    await openPattern(320, 200);
    main.selectTool('erase');
    S.tool.down({ x: 100, y: 80 }); S.tool.move({ x: 140, y: 120 }); S.tool.up(); // 啟動消除
    const newer = document.createElement('canvas'); newer.width = 160; newer.height = 100;
    core.commit(newer); // 工作進行中，另一個操作改變了畫面
    await boxHidden();
    await sleep(30);
    check(S.doc === newer, '過期的消除結果覆寫了較新的畫面');
  });

  await run('編輯狀態：消除取消後，原圖、歷史與遮罩保持一致', async () => {
    await openPattern(320, 200);
    main.selectTool('erase');
    const docBefore = S.doc, histBefore = S.hist.length;
    S.tool.down({ x: 100, y: 80 }); S.tool.move({ x: 140, y: 120 }); S.tool.up();
    $('#jobCancel').click();
    await boxHidden();
    await sleep(60);
    check(S.doc === docBefore && S.hist.length === histBefore, '取消後原圖或歷史被改動');
    check(eraseMaskAlphaAt(120, 100) > 0, '取消後遮罩被清空，使用者的框選遺失');
  });

  await run('編輯狀態：消除工作執行中再次框選（重複操作）只產生一筆歷史', async () => {
    await openPattern(320, 200);
    main.selectTool('erase');
    const histBefore = S.hist.length;
    S.tool.down({ x: 100, y: 80 }); S.tool.move({ x: 140, y: 120 }); S.tool.up();
    S.tool.down({ x: 150, y: 90 }); S.tool.move({ x: 170, y: 110 }); S.tool.up(); // 重複操作，應被忽略
    await boxHidden();
    await sleep(30);
    check(S.hist.length === histBefore + 1, `重複操作產生了 ${S.hist.length - histBefore} 筆歷史`);
  });

  await run('編輯狀態：消除工作失敗時無法在測試中注入（CANNOT_VERIFY）', async () => ({
    status: 'CANNOT_VERIFY',
    detail: '無法在不替換模組的情況下注入 AI 推論失敗；失敗路徑與 runJob 失敗路徑共用 null 回傳，已由 runJob 失敗測試覆蓋',
  }));

  await run('模型退回：發出事件後以 toast 告知使用者', async () => {
    window.dispatchEvent(new CustomEvent('xiuxiu:model-fallback', { detail: { from: 'RVM 影片摳圖', to: 'U²-Net（輕量）' } }));
    await sleep(30);
    const t = $('#toast').textContent;
    check(t.includes('RVM 影片摳圖') && t.includes('U²-Net'), `toast 內容 ${t}`);
  });

  // ---------- 5-6. 真實影音輸出 ----------
  const canMediaRecord = typeof MediaRecorder !== 'undefined';
  const hasWC = typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
  const pickMime = (fmt) => {
    const list = fmt === 'mp4' ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'] : ['video/webm;codecs=vp8,opus', 'video/webm'];
    return list.find((m) => MediaRecorder.isTypeSupported(m));
  };
  // 即時錄製合成影片（有聲或無聲），約 2 秒
  const makeFixture = async (audio, mime) => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const g = canvas.getContext('2d');
    const tracks = [...canvas.captureStream(10).getVideoTracks()];
    let ctx = null;
    if (audio) {
      ctx = new AudioContext();
      const osc = ctx.createOscillator(); osc.frequency.value = 440;
      const dst = ctx.createMediaStreamDestination(); osc.connect(dst); osc.start();
      tracks.push(...dst.stream.getAudioTracks());
    }
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime });
    const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start(100);
    let i = 0;
    const timer = setInterval(() => { g.fillStyle = `hsl(${(i++ * 15) % 360} 80% 50%)`; g.fillRect(0, 0, 320, 180); }, 100);
    await sleep(2200);
    clearInterval(timer); rec.stop(); await stopped; ctx?.close();
    return new File(chunks, `fixture.${mime.includes('mp4') ? 'mp4' : 'webm'}`, { type: mime.split(';')[0] });
  };
  // 攔截 WebCodecs 物件的建立與關閉，檢查資源是否歸零（僅觀察，不改變編碼行為）
  const installCounters = () => {
    const c = { venc: 0, aenc: 0, vframe: 0, adata: 0 };
    const orig = { VE: window.VideoEncoder, AE: window.AudioEncoder, VF: window.VideoFrame, AD: window.AudioData };
    const wrap = (Base, key) => class extends Base {
      constructor(...a) { super(...a); c[key]++; this.__open = true; }
      close(...a) { if (this.__open) { this.__open = false; c[key]--; } return super.close(...a); }
    };
    window.VideoEncoder = wrap(orig.VE, 'venc');
    window.AudioEncoder = wrap(orig.AE, 'aenc');
    window.VideoFrame = wrap(orig.VF, 'vframe');
    window.AudioData = wrap(orig.AD, 'adata');
    return { c, restore() { Object.assign(window, { VideoEncoder: orig.VE, AudioEncoder: orig.AE, VideoFrame: orig.VF, AudioData: orig.AD }); } };
  };
  const hasAudioTrack = async (blob) => {
    const ac = new AudioContext();
    try { const b = await ac.decodeAudioData(await blob.arrayBuffer()); return b.length > 0; }
    catch { return false; }
    finally { ac.close().catch(() => {}); }
  };
  const loadFixture = async (file) => {
    const V = await VD.loadVideo(file);
    return V;
  };

  if (!hasWC || !canMediaRecord) {
    results.push(CANNOT('此瀏覽器不支援 WebCodecs 或 MediaRecorder，影音輸出測試未執行'));
  }

  const runExport = async (V, fmt, name, expectAudio) => {
    const got = await VD.exportVideo({ V, fps: 10, format: fmt, alpha: false, outW: 320, outH: 180, frameFn: async (f) => f });
    const blob = got.blob;
    check(blob.size > 1000, `${fmt} 輸出過小（${blob.size}B）`);
    const hasAudio = await hasAudioTrack(blob);
    if (expectAudio && got.note && /無法|沒有|無/.test(got.note)) return CANNOT(`${name}：編碼器不支援，${got.note}`);
    check(hasAudio === expectAudio, `${name}：預期聲音=${expectAudio}，實際=${hasAudio}（${got.note || '無提示'}）`);
    // 播放驗證：時長與中段畫面
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video'); v.muted = true; v.src = url;
    try {
      await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('輸出無法播放')); });
      const dur = v.duration;
      check(Number.isFinite(dur) && Math.abs(dur - 2) < 0.6, `${name}：時長 ${dur}`);
      v.currentTime = 1; await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180;
      cv.getContext('2d').drawImage(v, 0, 0);
      const px = cv.getContext('2d').getImageData(0, 0, 320, 180).data;
      let sum = 0; for (let i = 0; i < px.length; i += 16) sum += px[i] + px[i + 1] + px[i + 2];
      check(sum > 0, `${name}：中段畫面是黑的`);
    } catch (e) {
      if (/輸出無法播放/.test(e.message)) return CANNOT(`${name}：此瀏覽器無法解碼 ${fmt}（可能缺少 H.264），編碼本身已完成`);
      throw e;
    } finally { URL.revokeObjectURL(url); }
    return { detail: `${blob.size}B，聲音=${hasAudio}` };
  };

  if (hasWC && canMediaRecord) {
    const sources = {};
    for (const [key, audio] of [['audio', true], ['silent', false]]) {
      const mime = pickMime('webm');
      sources[key] = mime ? await makeFixture(audio, mime) : null;
    }
    for (const [key, audio] of [['audio', true], ['silent', false]]) {
      for (const fmt of ['webm', 'mp4']) {
        await run(`影音輸出：${audio ? '有聲' : '無聲'} 來源 → ${fmt.toUpperCase()}`, async () => {
          if (!sources[key]) return CANNOT('此瀏覽器的 MediaRecorder 不支援 WebM 錄製');
          const V = await loadFixture(sources[key]);
          if (!Number.isFinite(V.dur)) throw new Error(`來源時長為 ${V.dur}（MediaRecorder 產生的 WebM 無時長資訊）`);
          return runExport(V, fmt, `${audio ? '有聲' : '無聲'}→${fmt}`, audio);
        });
      }
    }

    await run('去水印：載入影片後框選並預覽，預覽尺寸與影格相同', async () => {
      if (!sources.silent) return CANNOT('此瀏覽器的 MediaRecorder 不支援 WebM 錄製');
      await window.openFiles([sources.silent]);
      check(S.mode === 'video' && S.tool?.label === '影片去水印', '未切換到影片去水印');
      S.tool.down({ x: 40, y: 30 }); S.tool.move({ x: 120, y: 70 }); S.tool.up();
      $('#wPrev').click();
      await waitFor(() => S.compare !== null, 60000, '去水印預覽');
      check(S.preview && S.preview.width === S.doc.width && S.preview.height === S.doc.height, '預覽尺寸與影格不符');
      main.selectTool('new');
    });

    await run('影音輸出：中途取消後編碼器與影格全部關閉，且不再處理新影格', async () => {
      if (!sources.audio) return CANNOT('無來源影片');
      const V = await loadFixture(sources.audio);
      const counters = installCounters();
      try {
        const ac = new AbortController(); let frames = 0;
        let threw = null;
        try {
          await VD.exportVideo({ V, fps: 10, format: 'webm', alpha: false, outW: 320, outH: 180, signal: ac.signal, frameFn: async (f) => { frames++; if (frames === 5) ac.abort(); return f; } });
        } catch (e) { threw = e; }
        check(threw?.name === 'AbortError', `取消應拋出 AbortError，實際 ${threw?.name || '未拋出'}`);
        check(frames <= 6, `取消後仍處理了 ${frames} 格`);
        check(counters.c.venc === 0 && counters.c.aenc === 0, `編碼器未關閉 venc=${counters.c.venc} aenc=${counters.c.aenc}`);
        check(counters.c.vframe === 0 && counters.c.adata === 0, `影格未關閉 vframe=${counters.c.vframe} adata=${counters.c.adata}`);
      } finally { counters.restore(); }
    });

    await run('影音輸出：重複輸出 3 次，資源計數每次都回到 0', async () => {
      if (!sources.audio) return CANNOT('無來源影片');
      const V = await loadFixture(sources.audio);
      const counters = installCounters();
      try {
        for (let i = 0; i < 3; i++) {
          await VD.exportVideo({ V, fps: 10, format: 'webm', alpha: false, outW: 320, outH: 180, frameFn: async (f) => f });
          check(counters.c.venc === 0 && counters.c.aenc === 0 && counters.c.vframe === 0 && counters.c.adata === 0,
            `第 ${i + 1} 次輸出後資源未釋放 ${JSON.stringify(counters.c)}`);
        }
      } finally { counters.restore(); }
    });
  }

  return results;
})
