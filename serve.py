"""輕修本機伺服器：只提供網站需要的檔案，並送出跨來源隔離標頭（COOP/COEP）。

用法：python serve.py [埠號，預設 8080]
跨來源隔離讓瀏覽器提供 SharedArrayBuffer，AI 在 CPU（WASM）模式可以使用多執行緒。

選用：/comfy/ 會轉送到本機 ComfyUI（預設 http://127.0.0.1:8188，可用環境變數 XIUXIU_COMFY 改），
讓頁面以同源方式使用 ComfyUI 處理影片。只轉送白名單內的 API，並拒絕其他網站發出的請求。
"""
import os
import posixpath
import re
import shutil
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
TOP_FILES = {'/index.html', '/style.css'}
DIRS = ('/js/', '/assets/')

COMFY = os.environ.get('XIUXIU_COMFY', 'http://127.0.0.1:8188').rstrip('/')
COMFY_PREFIX = '/comfy'
COMFY_ROUTES = {
    'GET': re.compile(r'^/(system_stats|object_info/\w+|history|history/[\w-]+|queue|view)$'),
    'POST': re.compile(r'^/(prompt|upload/image|interrupt|queue)$'),
}
# 轉送時不帶上的標頭：Host 由 urllib 依目標重設；Origin/Referer 已在本機驗證過，帶過去會被 ComfyUI 的來源檢查擋下
DROP_HEADERS = {'host', 'origin', 'referer', 'connection', 'keep-alive', 'transfer-encoding', 'accept-encoding'}
DROP_HEADERS_PREFIX = 'sec-fetch-'
PASS_RESPONSE_HEADERS = ('Content-Type', 'Content-Length', 'Content-Disposition')


def comfy_target(method, raw_path):
    """回傳要轉送的 ComfyUI 網址；不在白名單時回傳 None。"""
    parts = urlsplit(raw_path)
    if not parts.path.startswith(COMFY_PREFIX + '/'):
        return None
    sub = posixpath.normpath(unquote(parts.path[len(COMFY_PREFIX):]))
    route = COMFY_ROUTES.get(method)
    if not route or not route.match(sub):
        return None
    return COMFY + sub + ('?' + parts.query if parts.query else '')


def same_origin(headers):
    """只接受本頁面（同源）發出的請求，避免其他網站透過本伺服器操作 ComfyUI。"""
    site = headers.get('Sec-Fetch-Site')
    if site is not None and site not in ('same-origin', 'none'):
        return False
    origin, host = headers.get('Origin'), headers.get('Host')
    if origin is not None and (not host or urlsplit(origin).netloc.lower() != host.lower()):
        return False
    return True


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
        '.woff2': 'font/woff2', '.wasm': 'application/wasm',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _allowed(self):
        path = posixpath.normpath(unquote(urlsplit(self.path).path))
        if path == '/':
            path = '/index.html'
        if path in TOP_FILES:
            return True
        return path.startswith(DIRS) and os.path.isfile(os.path.join(ROOT, *path.lstrip('/').split('/')))

    def _is_comfy(self):
        return urlsplit(self.path).path.startswith(COMFY_PREFIX + '/')

    def _proxy(self, method):
        target = comfy_target(method, self.path)
        if target is None:
            return self.send_error(404)
        if not same_origin(self.headers):
            return self.send_error(403)
        body = None
        if method == 'POST':
            length = int(self.headers.get('Content-Length') or 0)
            body = self.rfile.read(length) if length else b''
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in DROP_HEADERS and not k.lower().startswith(DROP_HEADERS_PREFIX)}
        req = urllib.request.Request(target, data=body, headers=headers, method=method)
        try:
            resp = urllib.request.urlopen(req, timeout=60)
        except urllib.error.HTTPError as e:
            resp = e
        except (urllib.error.URLError, OSError) as e:
            msg = ('{"error":"ComfyUI 無法連線：%s"}' % str(getattr(e, 'reason', e)).replace('"', "'")).encode('utf-8')
            self.send_response(502)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return
        with resp:
            self.send_response(resp.status)
            for k in PASS_RESPONSE_HEADERS:
                if resp.headers.get(k):
                    self.send_header(k, resp.headers[k])
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            shutil.copyfileobj(resp, self.wfile, 1024 * 1024)

    def do_GET(self):
        if self._is_comfy():
            return self._proxy('GET')
        if self._allowed():
            if urlsplit(self.path).path == '/':
                self.path = '/index.html'
            super().do_GET()
        else:
            self.send_error(404)

    def do_HEAD(self):
        if self._allowed():
            super().do_HEAD()
        else:
            self.send_error(404)

    def do_POST(self):
        if self._is_comfy():
            return self._proxy('POST')
        self.send_error(405)

    def end_headers(self):
        # 每次載入都向伺服器確認（未變更時回 304），避免更新程式後瀏覽器混用新舊版本的 ES Module
        if not self._is_comfy():
            self.send_header('Cache-Control', 'no-cache')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    with ThreadingHTTPServer(('127.0.0.1', port), Handler) as server:
        server.serve_forever()
