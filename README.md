# Meitu_Xiuxiu｜輕修：瀏覽器 AI 修圖與影片工具

以繁體中文介面提供日常修圖與影片處理，支援裁切、文字、AI 消除、去背、放大與調色。圖片與影片在使用者的瀏覽器內處理，不上傳伺服器；無需註冊，也不需要架設後端。

專案採用原生 HTML、CSS 與 JavaScript ES Module，無建置步驟。AI 推論使用 ONNX Runtime Web，支援 WebGPU 加速，無 WebGPU 時改用 CPU。

## 功能

| 類別 | 功能 |
|---|---|
| 圖片編輯 | 裁切與尺寸調整、加入文字、調色 |
| AI 圖片處理 | 消除物件、主體去背、超解析度放大 |
| 影片處理 | 多區域去水印、影片去背、2×／4× 放大（輸出上限 4K） |
| 圖片匯出 | PNG、JPG、WebP |
| 影片匯出 | MP4、WebM；透明背景使用 WebM，聲音保留取決於瀏覽器編碼支援 |
| 操作輔助 | 復原／重做、重置、前後對比、畫布縮放與平移、AI 進度與取消 |

## 快速開始（Windows）

1. 安裝 Python 3，確認命令列可執行 `python` 或 `py`。
2. 下載專案 ZIP 並解壓縮，或使用 Git：

   ```bash
   git clone https://github.com/rita112025-cpu/Meitu_Xiuxiu.git
   cd Meitu_Xiuxiu
   ```

3. 雙擊 `Start.bat`，會啟動本機 HTTP Server 並自動開啟瀏覽器（優先 Chrome，其次 Edge，最後才用系統預設瀏覽器）。
4. 建議用支援 WebGPU 與 WebCodecs 的 Chrome／Edge 開啟顯示的網址。
5. 載入圖片或影片，選擇工具完成處理後匯出；關閉伺服器視窗即可停止服務。

## 執行

需要用本機伺服器開啟（ES Module 不能用 file:// 開）：

```bash
python serve.py 8080
```

`serve.py` 只提供網站所需的檔案（`index.html`、`style.css`、`js/`、`assets/`），不會公開 `.git/`、`node_modules/` 等目錄，並送出 COOP/COEP 標頭讓瀏覽器啟用跨來源隔離，AI 在 CPU（WASM）模式可使用最多 4 個執行緒。改用 `python -m http.server` 也能執行，但 CPU 模式只能單執行緒。

然後用最新版 Chrome / Edge 開 http://localhost:8080 。建議有 WebGPU（沒有時自動退回 CPU，會很慢）。

## 選用：用本機 ComfyUI 加速影片放大

有 NVIDIA 顯示卡並已安裝 [ComfyUI](https://github.com/comfyanonymous/ComfyUI) 時，「影片放大」可以改由本機 ComfyUI 處理整段影片（解碼、放大、合成都在 CUDA 上，保留聲音），通常比瀏覽器逐格處理快很多。

1. ComfyUI 安裝 [ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) 節點。
2. 把放大模型（例如 `RealESRGAN_x4plus.pth`）放進 ComfyUI 的 `models/upscale_models/`。
3. 啟動 ComfyUI（預設 `127.0.0.1:8188`），再用 `python serve.py` 開啟本頁。
4. 在「影片放大」的「運算位置」選「本機 ComfyUI」，並選擇放大模型。

- 頁面透過 `serve.py` 的 `/comfy/` 同源代理呼叫 ComfyUI，不需要開 ComfyUI 的 CORS。代理只轉送必要的 API，並拒絕其他網站發出的請求。ComfyUI 不在預設位置時，可用環境變數 `XIUXIU_COMFY` 指定，例如 `http://127.0.0.1:8189`。
- 影片只在本機的瀏覽器與 ComfyUI 之間傳遞，不會上傳到外部；上傳的影片與輸出的結果會留在 ComfyUI 的 `input/`、`output/xiuxiu/` 資料夾，需要時請自行清理。
- 長影片會依輸出尺寸分批處理（VideoHelperSuite Meta Batch），避免一次把所有影格放進記憶體。
- 偵測不到 ComfyUI、缺少 VideoHelperSuite 或沒有放大模型時，該選項會停用並說明原因，影片放大照常使用瀏覽器運算。

## 使用方式

- 從「新增」載入檔案，也可拖曳檔案或貼上圖片。
- 圖片可使用調整、文字、消除圖、摳圖、變清晰與調色工具。
- 影片去水印可框選多個固定位置區域，先預覽目前影格，再處理整段影片。
- 滾輪縮放畫布，按住空白鍵拖曳平移；`Ctrl+Z` 復原，`Ctrl+Y` 重做。
- AI 處理期間可查看進度或取消；輸出影片時請保持分頁在前景。

## 隱私與使用限制

圖片與影片不會上傳，但首次使用 AI 功能仍需連線下載模型，推論函式庫與影片封裝模組也會從外部來源載入。模型會快取於瀏覽器。

- AI 效能取決於裝置、GPU 與瀏覽器支援；CPU 模式可能很慢。
- 影片輸出需要 WebCodecs；來源音訊無法解碼或編碼時，輸出可能沒有聲音。
- 長影片與高解析度輸出仍可能耗用大量 RAM：編碼後的影音會直接寫入封裝器，但完整檔案仍在記憶體中組成後才下載。
- 透明 WebM 使用自製 VP9 Alpha 封裝，其他播放器的相容性尚未完整驗證。

## 本次穩定性修正

- 復原歷史最多保留 20 筆，並依 Canvas 估算容量在約 256 MiB 時淘汰舊紀錄；至少保留一筆，因此單張超大 Canvas 仍可能超過容量門檻。
- 影片去水印將取消訊號傳入每個區域的 AI 處理，預覽進度依區域分配。
- 重新產生影片結果時釋放舊預覽 Blob URL，頁面離開時回收結果與目前影片的 URL。
- `Start.bat` 延遲約 2 秒開啟瀏覽器，並加入連接埠配置失敗與伺服器結束狀態處理。

## 使用的模型（首次使用時從 Hugging Face 下載，並快取在瀏覽器）

| 功能 | 模型 | 大小 |
|---|---|---|
| 消除圖、影片去水印 | MI-GAN | 28 MB |
| 摳圖 | U²-Net | 176 MB |
| 影片摳圖 | Robust Video Matting（RVM，失敗時退回 U²-Net-p） | 8 MB |
| 變清晰 快速 | Real-ESRGAN general-x4v3 | 5 MB |
| 變清晰 Upscayl 標準 | RealESRGAN_x4plus / x2plus | 67 MB |
| 變清晰 Upscayl 數位藝術 | RealESRGAN_x4plus_anime_6B | 18 MB |

## 已知限制（穩定性審查）

- **記憶體（P1）**：編碼後的影音 chunk 會直接寫入封裝器，不再另外保留一份，峰值較以前低；但輸出檔仍完整存在記憶體中（尚未改為邊處理邊寫入磁碟），長影片或高解析度輸出仍會占用大量 RAM。
- **模型退回（P3）**：RVM 影片摳圖無法載入時會改用 U²-Net 輕量模型，畫面會以提示告知；輕量模型的邊緣品質可能較低。
- **音訊判斷（P4）**：來源音訊無法解碼與來源沒有音軌，目前都會顯示「來源沒有可解碼的聲音」，兩者無法區分。
- **模型來源（P2）**：模型網址已固定為 Hugging Face 的 commit SHA，並已確認八個檔案在各自 SHA 下可取得。但沒有 SHA-256 校驗，也不保證上游 repo 永遠可用；repo 被刪除、改名或改為私有時，下載仍會失敗。
- **相容性**：透明 WebM 在其他播放器的相容性尚未完整驗證；GPU 推論與硬體編碼需在實機確認。

## 結構

- `js/core.js` 畫布檢視（滾輪縮放、空白鍵平移）、歷史、生成中/取消、匯出
- `js/ai.js` onnxruntime-web 推論（MI-GAN、U²-Net、Real-ESRGAN 分塊、RVM）
- `js/tools-image.js` 新增 / 調整 / 文字 / 消除圖 / 摳圖 / 變清晰 / 調色
- `js/tools-video.js`、`js/video.js` 影片去水印 / 去背 / 放大（WebCodecs 逐格編碼，保留聲音；透明 WebM 為自製 VP9 alpha 封裝）
- `js/comfy.js` 選用的本機 ComfyUI 後端（偵測、影片放大工作流程、分批排程、取消）
- `js/canvas.js` 共用的畫布建立、逐格重複使用的畫布池與取消檢查
- `serve.py` 本機伺服器（檔案白名單 + 跨來源隔離標頭 + `/comfy/` 同源代理）
