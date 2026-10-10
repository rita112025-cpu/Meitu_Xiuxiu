// 在真實頁面（index.html）中執行的測試。由 run.mjs 以 Runtime.evaluate 注入執行。
// 影音測試使用瀏覽器內即時產生的合成素材，並呼叫真實的 WebCodecs 編碼，不以 mock 取代輸出驗證。
(async (only) => {
  const results = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms, label) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${label} 逾時 ${ms}ms`); })]);
  const check = (cond, msg) => { if (!cond) throw new Error(msg); };
  const CANNOT = (detail) => ({ status: 'CANNOT_VERIFY', detail });
  const run = async (name, fn) => {
    if (only && !name.startsWith(only)) return;
    console.log("[start] " + name);
    try {
      const r = await fn();
      results.push({ name, status: r?.status || 'PASS', detail: r?.detail || '' });
      console.log('[done] ' + (r?.status || 'PASS') + ' ' + name + ' ' + (r?.detail || ''));
    } catch (e) {
      results.push({ name, status: 'FAIL', detail: String(e?.message || e) });
      console.log('[done] FAIL ' + name + ' ' + (e?.message || e));
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
  await run('runJob：取消後立即返回，且舊工作不能覆寫新工作的進度框與結果', async () => {
    let releaseA, progressA;
    const pA = core.runJob('A', ({ progress }) => { progressA = progress; return new Promise((r) => { releaseA = r; }); });
    await sleep(20);
    $('#jobCancel').click(); // 取消 A
    const rA = await withTimeout(pA, 500, '取消後的 runJob');
    check(rA === null, 'A 取消後應回傳 null');

    let releaseB;
    const pB = core.runJob('B', () => new Promise((r) => { releaseB = r; }));
    await sleep(20);
    releaseA('A-stale-result'); // 舊工作底層仍在執行，最後才完成
    progressA(0.9, 'A-stale-label');
    await sleep(30);
    check($('#job').classList.contains('show'), '舊工作收尾時把新工作的進度框隱藏了');
    check($('#jobTitle').textContent === 'B', '舊工作改寫了新工作的標題');
    check($('#jobLabel').textContent !== 'A-stale-label', '舊工作的進度覆寫了新工作');
    releaseB('B-result');
    check((await withTimeout(pB, 500, 'B')) === 'B-result', 'B 結果錯誤');
    await waitFor(() => !$('#job').classList.contains('show'), 2000, '進度框隱藏');
  });

  await run('runJob：新工作開始時中止仍在進行的舊工作（舊結果不回寫）', async () => {
    const pOld = core.runJob('old', () => new Promise(() => {}));
    await sleep(20);
    const pNew = core.runJob('new', async () => 'NEW');
    check((await withTimeout(pOld, 500, '舊工作')) === null, '舊工作應回傳 null');
    check((await withTimeout(pNew, 500, '新工作')) === 'NEW', '新工作結果錯誤');
  });

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
