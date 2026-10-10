// 真實 AI 推論測試：從固定 SHA 下載模型，以 ONNX Runtime 執行一次。
// 網路或 CDN 無法連線時標為 CANNOT_VERIFY；推論或輸出錯誤則為 FAIL。
(async (only) => {
  const results = [];
  const check = (c, m) => { if (!c) throw new Error(m); };
  const isNet = (e) => /Failed to fetch|NetworkError|模型下載失敗|無法載入|net::|ERR_/i.test(String(e?.message || e));
  const run = async (name, fn) => {
    if (only && !name.startsWith(only)) return;
    try {
      const r = await fn();
      results.push({ name, status: r?.status || 'PASS', detail: r?.detail || '' });
    } catch (e) {
      if (isNet(e)) results.push({ name, status: 'CANNOT_VERIFY', detail: '網路或 CDN 無法連線：' + e.message });
      else results.push({ name, status: 'FAIL', detail: String(e?.message || e) });
    }
  };
  const ai = await import('/js/ai.js');
  const canvas = (w, h, fn) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), id = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, gg, b] = fn(x, y); const i = (y * w + x) * 4; id.data[i] = r; id.data[i + 1] = gg; id.data[i + 2] = b; id.data[i + 3] = 255; }
    g.putImageData(id, 0, 0); return c;
  };
  const spread = (arr) => { let mn = Infinity, mx = -Infinity; for (const v of arr) { if (v < mn) mn = v; if (v > mx) mx = v; } return mx - mn; };

  await run('AI：MI-GAN 消除（固定 SHA）', async () => {
    const W = 256, H = 256;
    const src = canvas(W, H, (x, y) => [x, y, 128]);
    const mask = document.createElement('canvas'); mask.width = W; mask.height = H;
    const mg = mask.getContext('2d'); mg.fillStyle = '#fff'; mg.fillRect(100, 100, 40, 40);
    const out = await ai.inpaint(src, mask, {});
    check(out && out.width === W && out.height === H, '輸出尺寸錯誤');
    const a = src.getContext('2d').getImageData(105, 105, 30, 30).data, b = out.getContext('2d').getImageData(105, 105, 30, 30).data;
    let diff = 0; for (let i = 0; i < a.length; i += 4) diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]);
    check(diff > 0, '遮罩區域沒有被修改');
    return { detail: `遮罩內像素差總和 ${diff}` };
  });

  await run('AI：U²-Net 摳圖（固定 SHA）', async () => {
    const W = 256, H = 256;
    const src = canvas(W, H, (x, y) => ((x - 128) ** 2 + (y - 128) ** 2 < 60 * 60 ? [220, 60, 60] : [30, 90, 200]));
    const r = await ai.matteImage(src, { model: 'u2net' });
    check(r.alpha.length === W * H, 'alpha 長度錯誤');
    const s = spread(r.alpha);
    check(s > 0.5, `alpha 幾乎沒有變化（範圍 ${s.toFixed(2)}）`);
    return { detail: `alpha 範圍 ${s.toFixed(2)}` };
  });

  await run('AI：Real-ESRGAN 快速 ×4 放大（固定 SHA）', async () => {
    const src = canvas(64, 64, (x, y) => [(x * 4) % 256, (y * 4) % 256, 100]);
    const out = await ai.upscale(src, { model: 'fast', scale: 4 });
    check(out.width === 256 && out.height === 256, `輸出尺寸 ${out.width}×${out.height}`);
    const px = out.getContext('2d').getImageData(0, 0, 256, 256).data;
    const r = []; for (let i = 0; i < px.length; i += 4) r.push(px[i]);
    check(spread(r) > 20, '輸出幾乎是單色，推論可能未生效');
    return { detail: `R 通道範圍 ${spread(r)}` };
  });

  return results;
})
