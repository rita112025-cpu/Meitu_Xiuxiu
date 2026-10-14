"""輕修本機伺服器：只提供網站需要的檔案，並送出跨來源隔離標頭（COOP/COEP）。

用法：python serve.py [埠號，預設 8080]
跨來源隔離讓瀏覽器提供 SharedArrayBuffer，AI 在 CPU（WASM）模式可以使用多執行緒。
"""
import os
import posixpath
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
TOP_FILES = {'/index.html', '/style.css'}
DIRS = ('/js/', '/assets/')


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

    def do_GET(self):
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

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    with ThreadingHTTPServer(('127.0.0.1', port), Handler) as server:
        server.serve_forever()
