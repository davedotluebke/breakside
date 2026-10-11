#!/usr/bin/env python3
"""Static file server for local development and the e2e suite.

Why not `python3 -m http.server`: it speaks HTTP/1.0 (no keep-alive, so the
browser opens a fresh connection for each of the ~135 files the app loads at
boot) behind a listen backlog of 5. Where the OS queues the overflow the app
loads fine; where it resets it (macOS 27, seen 2026-10-11) a dozen stylesheets
and modules fail at random with ERR_CONNECTION_RESET and the app never reaches
its first screen, which showed up as 8 of 10 e2e boots failing. HTTP/1.1
keep-alive and a real backlog make the burst a non-event.

Also, as the dev server always did: Cache-Control: no-cache so an edit shows on
the next reload, and the app's short links (/join/<code>, /view/<hash>) served
as index.html, as the CDN does in production.

Usage: python3 scripts/serve-static.py PORT [DIRECTORY]
       DIRECTORY defaults to the repository root (this script's parent's parent).
"""
import os
import re
import socket
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

SHORT_LINK_RE = re.compile(r"^/(join|view)/[A-Za-z0-9]+/?$")


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def translate_path(self, path):
        if SHORT_LINK_RE.match(path.split("?", 1)[0]):
            return super().translate_path("/index.html")
        return super().translate_path(path)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128


class DualStackServer(Server):
    """Serve ::1 and 127.0.0.1 from one socket: Chromium tries ::1 first."""
    address_family = socket.AF_INET6

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (OSError, AttributeError):
            pass
        super().server_bind()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
    directory = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))
    handler = partial(Handler, directory=directory)
    try:
        server = DualStackServer(("::", port), handler)
    except OSError:
        server = Server(("", port), handler)   # no IPv6 here
    with server:
        print(f"Serving {directory} on http://localhost:{port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
