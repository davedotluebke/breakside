#!/usr/bin/env python3
"""
No-cache static file server for local Breakside dev in the Claude preview.

`python -m http.server` serves cacheable responses (and answers
If-Modified-Since with 304), so the preview browser holds stale JS/CSS across
edits — every source change appears not to take effect until a manual cache
clear. This server forces every response fresh:

  - sends Cache-Control: no-store on every response
  - strips the client's If-Modified-Since so it never returns 304

Usage: nocache-server.py [port] [directory]

This file lives under .claude/ (local tooling, not part of any feature branch).
"""
import sys
import http.server
import socketserver

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3002
DIRECTORY = sys.argv[2] if len(sys.argv) > 2 else "."


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def send_head(self):
        # Never let the browser get a 304 — always serve full fresh content.
        if "If-Modified-Since" in self.headers:
            del self.headers["If-Modified-Since"]
        if "If-None-Match" in self.headers:
            del self.headers["If-None-Match"]
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("", PORT), NoCacheHandler) as httpd:
        print(f"no-cache server on http://localhost:{PORT} serving {DIRECTORY}", flush=True)
        httpd.serve_forever()
