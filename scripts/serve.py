#encoding: utf-8
"""Local static server + LLM/TTS proxy.

Browser pages cannot directly call Aliyun/Xiaomi/OpenRouter APIs due to CORS.
POST /_proxy?u=<https url> forwards the JSON body and Authorization header.
Supports both loopback (127.0.0.1) and LAN (0.0.0.0) access.

  python scripts/serve.py
  # http://127.0.0.1:8765/
  # http://<lan-ip>:8765/
"""
from __future__ import annotations

import ipaddress
import json
import mimetypes
import os
import re
import socket
import sys
import urllib.parse
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
PROVIDERS = ROOT / "config" / "providers.json"
# 8765 is the documented dev port; RYZA_PORT exists so a test can bind a free
# one instead of fighting a dev server that is already running.
PORT = int(os.environ.get("RYZA_PORT") or 8765)
# Cloudflare (opencode.ai etc.) returns 1010 for the default Python-urllib UA.
UA = "RyzaChat/1.2.20"


def is_loopback_host(host: str) -> bool:
    """True for 127.0.0.0/8, ::1 and `localhost` — and nothing else."""
    h = (host or "").strip().strip("[]").lower()
    if not h:
        return False
    if h == "localhost":
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


def proxy_target_allowed(target: str) -> bool:
    """https anywhere, http only on loopback.

    The https rule exists so an API key never crosses the network in clear.
    A loopback target never crosses the network: the operator is running the
    model on their own machine (Ollama on 127.0.0.1:11434, LM Studio,
    llama.cpp), so refusing it only broke the local-first setup this client is
    built around. Everything that is not loopback still has to be https.
    desktop/main.js and android/.../AssetServer.java carry the same rule.
    """
    parts = urlparse(target)
    if parts.scheme == "https":
        return True
    return parts.scheme == "http" and is_loopback_host(parts.hostname)

# Ensure all critical web/game assets have correct MIME types across platforms
EXTRA_MIME = {
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".json": "application/json; charset=utf-8",
    ".atlas": "text/plain; charset=utf-8",
    ".skel": "application/octet-stream",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".html": "text/html; charset=utf-8",
}
for ext, mt in EXTRA_MIME.items():
    mimetypes.add_type(mt, ext)


class RangeWrapper:
    """Wraps a file object to stream only [start, end] bytes for HTTP 206 Partial Content."""
    def __init__(self, file_obj, length: int):
        self.file_obj = file_obj
        self.remaining = length

    def read(self, size: int = -1) -> bytes:
        if self.remaining <= 0:
            return b""
        if size < 0 or size > self.remaining:
            size = self.remaining
        chunk = self.file_obj.read(size)
        if not chunk:
            return b""
        self.remaining -= len(chunk)
        return chunk

    def close(self):
        self.file_obj.close()


class Server(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self):
        # Guarantee CORS & byte-range capabilities across all responses
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, api-key, Range")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/_proxy":
            self._proxy_get(parsed)
            return
        if path == "/config/providers.json" and PROVIDERS.is_file():
            raw = PROVIDERS.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)
            return
        return SimpleHTTPRequestHandler.do_GET(self)

    def send_head(self):
        """Common code for GET and HEAD commands with Range support (vital for iOS/Android media playback)."""
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            parts = urlparse(self.path)
            if not parts.path.endswith('/'):
                self.send_response(301)
                new_parts = (parts[0], parts[1], parts[2] + '/', parts[3], parts[4], parts[5])
                new_url = urllib.parse.urlunparse(new_parts)
                self.send_header("Location", new_url)
                self.end_headers()
                return None
            for index in "index.html", "index.htm":
                index = os.path.join(path, index)
                if os.path.exists(index):
                    path = index
                    break
            else:
                return self.list_directory(path)

        ctype = self.guess_type(path)
        try:
            f = open(path, 'rb')
        except OSError:
            self.send_error(404, "File not found")
            return None

        try:
            fs = os.fstat(f.fileno())
            total = fs.st_size
            range_header = self.headers.get('Range')
            if range_header and range_header.startswith('bytes='):
                m = re.match(r'bytes=(\d*)-(\d*)', range_header)
                if m:
                    raw_start, raw_end = m.groups()
                    if raw_start == "" and raw_end == "":
                        start = 0
                        end = total - 1
                    elif raw_start == "":
                        length = int(raw_end)
                        start = max(0, total - length)
                        end = total - 1
                    else:
                        start = int(raw_start)
                        end = int(raw_end) if raw_end != "" else total - 1

                    if start < total and start <= end:
                        end = min(end, total - 1)
                        content_len = end - start + 1
                        self.send_response(206)
                        self.send_header("Content-Type", ctype)
                        self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
                        self.send_header("Content-Length", str(content_len))
                        self.send_header("Last-Modified", self.date_time_string(fs.st_mtime))
                        self.end_headers()
                        f.seek(start)
                        return RangeWrapper(f, content_len)

            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(total))
            self.send_header("Last-Modified", self.date_time_string(fs.st_mtime))
            self.end_headers()
            return f
        except Exception:
            f.close()
            raise

    def _proxy_get(self, parsed):
        """GET /_proxy?u=<https url> — forwards a GET (Qwen TTS returns
        time-limited OSS audio URLs; the page pulls them through here so
        the blob is same-origin for the lip-sync analyser)."""
        target = (parse_qs(parsed.query).get("u") or [""])[0]
        if not proxy_target_allowed(target):
            self.send_error(400, "proxy target must be https (or http on loopback)")
            return
        try:
            headers = {"User-Agent": UA}
            auth = self.headers.get("Authorization")
            if auth:
                headers["Authorization"] = auth
            apikey = self.headers.get("api-key") or self.headers.get("Api-Key")
            if apikey:
                headers["api-key"] = apikey
            req = Request(target, headers=headers, method="GET")
            with urlopen(req, timeout=120) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", resp.headers.get("Content-Type") or "application/octet-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except HTTPError as e:
            data = e.read() if e.fp else str(e).encode("utf-8")
            self.send_response(e.code)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (URLError, TimeoutError, OSError) as e:
            msg = json.dumps({"error": {"message": str(e)}}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, api-key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/_proxy":
            self.send_error(404, "use POST /_proxy")
            return
        target = (parse_qs(parsed.query).get("u") or [""])[0]
        if not proxy_target_allowed(target):
            self.send_error(400, "proxy target must be https (or http on loopback)")
            return
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        headers = {
            "Content-Type": self.headers.get("Content-Type") or "application/json",
            "User-Agent": UA,
        }
        auth = self.headers.get("Authorization")
        if auth:
            headers["Authorization"] = auth
        apikey = self.headers.get("api-key") or self.headers.get("Api-Key")
        if apikey:
            headers["api-key"] = apikey
        req = Request(target, data=body, headers=headers, method="POST")
        try:
            with urlopen(req, timeout=180) as resp:
                data = resp.read()
                self.send_response(resp.status)
                ctype = resp.headers.get("Content-Type") or "application/json"
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except HTTPError as e:
            data = e.read() if e.fp else (str(e).encode("utf-8"))
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type") or "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (URLError, TimeoutError, OSError) as e:
            msg = json.dumps({"error": {"message": str(e)}}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)


def get_lan_ips() -> list[str]:
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.2)
        s.connect(("8.8.8.8", 80))
        primary = s.getsockname()[0]
        s.close()
        if primary and not primary.startswith("127."):
            ips.append(primary)
    except Exception:
        pass

    try:
        host = socket.gethostname()
        for info in socket.getaddrinfo(host, None):
            ip = info[4][0]
            if ":" not in ip and not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    return ips


def main():
    os.chdir(WEB)
    # Listen on 0.0.0.0 to enable both localhost and LAN devices (phones, tablets, PCs)
    httpd = Server(("0.0.0.0", PORT), partial(Handler, directory=str(WEB)))
    print("Ryza chat server started (static + LLM proxy):", flush=True)
    print("  Local:   http://127.0.0.1:%d/" % PORT, flush=True)
    lan_ips = get_lan_ips()
    for ip in lan_ips:
        print("  Network: http://%s:%d/" % (ip, PORT), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
        httpd.shutdown()


if __name__ == "__main__":
    main()
