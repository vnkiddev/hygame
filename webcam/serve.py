"""Server tĩnh cho webcam.vnkid.dev.

Giống `python3 -m http.server`, chỉ thêm Cache-Control để trình duyệt và
Cloudflare không giữ trang cũ sau khi deploy:
  - HTML: no-cache (lần nào cũng hỏi lại máy chủ)
  - lib/*: được cache, vì deploy-webcam.sh đã gắn ?v=<mã> vào đường dẫn

Chạy: python3 serve.py <cổng>
"""
import functools
import http.server
import os
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        path = self.path.split("?", 1)[0]
        if path.endswith("/") or path.endswith(".html"):
            self.send_header("Cache-Control", "no-cache")
        elif "?v=" in self.path:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 6010
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(Handler, directory=root)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
