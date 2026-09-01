#!/usr/bin/env python3
"""Tiny localhost static server for the Three.js viewer.
Browsers won't fetch assembly.glb over file://, so serve it over http.

    python3 serve.py           # port auto-derived from the project dir name (see below)
    python3 serve.py 8765      # explicit port
    python3 serve.py 8765 web  # explicit port + dir

Serves the directory that holds the viewer + assembly.glb. In the full project layout
(scripts in src/, assets in web/) that is web/; in the flat single-part layout it is the
script's own dir.

PORT RULE: never share ports between projects. Three separate projects have burned time
debugging "wrong geometry" that was actually another project's stale serve.py squatting
8765 (the browser cache is per-port, so the viewer silently shows someone else's model).
With no port argument this script derives a stable per-project port from the project dir
name (8100-8799), so two projects can't collide. It also answers /__project__ with the
project root name so shoot.py can verify it is talking to THIS project before rendering.

Binds 0.0.0.0 and prints the LAN URL so the user can open the viewer on a phone on the
same wifi (a standing user preference). shoot.py still targets localhost.
"""
import http.server, socketserver, sys, os, socket, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
# repo root = parent when this lives in a src/scripts/tools subdir, else the script dir
ROOT = os.path.dirname(HERE) if os.path.basename(HERE) in ("src", "scripts", "tools") else HERE
PROJECT = os.path.basename(ROOT)


def project_port(name: str) -> int:
    return 8100 + (zlib.crc32(name.encode()) % 700)


port = int(sys.argv[1]) if len(sys.argv) > 1 else project_port(PROJECT)
web = os.path.join(ROOT, "web")
serve_dir = sys.argv[2] if len(sys.argv) > 2 else (web if os.path.isdir(web) else HERE)
os.chdir(serve_dir)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".glb": "model/gltf-binary"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Project", PROJECT)
        super().end_headers()

    def do_GET(self):
        if self.path == "/__project__":
            body = PROJECT.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))          # no packet sent; just picks the outbound iface
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


socketserver.TCPServer.allow_reuse_address = True   # rebind immediately after a restart (no TIME_WAIT wait)
with socketserver.TCPServer(("0.0.0.0", port), Handler) as httpd:
    print(f"Serving {os.getcwd()} for project '{PROJECT}'\n"
          f"  -> http://localhost:{port}/viewer_glb.html\n"
          f"  -> http://{lan_ip()}:{port}/viewer_glb.html   (phone on same wifi)\n"
          f"Ctrl-C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
