#!/usr/bin/env python3
"""Tiny localhost receiver for carousel screenshot capture (temporary dev tooling).

POST /save?name=<slug> body=base64 PNG (text/plain) -> writes <SCREENS_DIR>/<slug>.png.
Usage: shot-save-server.py <port> <screens_dir>
"""
import sys, os, re, base64, http.server, socketserver
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
SCREENS_DIR = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else "."
SAFE = re.compile(r'^[a-z0-9][a-z0-9_-]{0,40}$')


class Handler(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_POST(self):
        try:
            from urllib.parse import urlparse, parse_qs
            name = (parse_qs(urlparse(self.path).query).get("name") or [""])[0]
            if not SAFE.match(name):
                self.send_response(400); self._cors(); self.end_headers()
                self.wfile.write(b"bad name"); return
            body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8", "replace")
            if "," in body and body.strip().startswith("data:"):
                body = body.split(",", 1)[1]
            data = base64.b64decode(body)
            path = os.path.join(SCREENS_DIR, name + ".png")
            with open(path, "wb") as f:
                f.write(data)
            self.send_response(200); self._cors(); self.end_headers()
            self.wfile.write(("ok %d bytes" % len(data)).encode())
            print("saved", path, len(data), flush=True)
        except Exception as e:
            self.send_response(500); self._cors(); self.end_headers()
            self.wfile.write(str(e).encode()); print("ERR", e, flush=True)

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print("shot-save-server on %d -> %s" % (PORT, SCREENS_DIR), flush=True)
        httpd.serve_forever()
