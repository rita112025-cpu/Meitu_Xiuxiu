// 瀏覽器測試執行器：啟動本機 Chrome/Edge（headless），透過 DevTools 協定在真實頁面中執行 page-tests.js。
// 不使用額外 npm 套件；找不到瀏覽器時輸出 CANNOT_VERIFY 並以結束碼 2 結束，不會默默通過。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// PAGE_TESTS 只能指定 tests/browser/ 內的 .js 檔名，不接受路徑或 ../（在啟動瀏覽器前檢查）
const SUITE = process.env.PAGE_TESTS || 'page-tests.js';
const DEBUG = !!process.env.DEBUG; // 設定 DEBUG=1 才輸出頁面的除錯紀錄
if (!/^[A-Za-z0-9_-]+\.js$/.test(SUITE)) {
  console.error('PAGE_TESTS 只允許 tests/browser/ 內的 .js 檔名，收到：' + SUITE);
  process.exit(2);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

const chrome = CANDIDATES.find((p) => p && existsSync(p));
if (!chrome) {
  console.log('CANNOT_VERIFY：找不到 Chrome 或 Edge（可設定 CHROME_PATH）。瀏覽器測試未執行。');
  process.exit(2);
}

// 靜態伺服器：只提供專案根目錄內的檔案
const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = await mkdtemp(path.join(tmpdir(), 'xiuxiu-chrome-'));
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--disable-gpu', ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank',
], { stdio: 'ignore' });

let exitCode = 1;
try {
  let targets;
  for (let i = 0; i < 100 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const page = targets?.find((t) => t.type === 'page');
  if (!page) throw new Error('無法連線到 Chrome DevTools');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (DEBUG && msg.method === 'Runtime.consoleAPICalled') console.log('[page]', msg.params.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: base + '/' });
  for (let i = 0; i < 100; i++) {
    const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (r.result?.result?.value === 'complete') break;
    await new Promise((r2) => setTimeout(r2, 100));
  }

  const only = process.argv[2];
  const src = await readFile(path.join(ROOT, 'tests/browser', SUITE), 'utf8');
  const expr = `(${src})(${JSON.stringify(only || '')}, ${DEBUG})`;
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 600000 });
  if (res.result?.exceptionDetails || res.result?.result?.subtype === 'error') {
    throw new Error('頁面測試執行失敗：' + (res.result?.exceptionDetails?.exception?.description || JSON.stringify(res.result?.result)));
  }
  const results = res.result.result.value;
  for (const r of results) console.log(`${r.status.padEnd(14)} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n共 ${results.length} 項：PASS ${count('PASS')}、FAIL ${count('FAIL')}、CANNOT_VERIFY ${count('CANNOT_VERIFY')}`);
  exitCode = count('FAIL') ? 1 : 0;
  ws.close();
} catch (e) {
  console.error('瀏覽器測試錯誤：', e.message);
} finally {
  proc.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 300));
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(exitCode);
}
