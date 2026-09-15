#!/usr/bin/env python3
"""Static server for the preview harness that refuses to be cached.

python3 -m http.server sends no cache headers, so Chrome holds on to ES modules between
edits. The symptom is nasty: the page runs a mix of old and new code, so a change looks
like it silently did nothing and you go hunting in the wrong place.
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8731


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *args):
        pass  # Quiet; the useful output is in the browser.


if __name__ == "__main__":
    handler = partial(NoCacheHandler, directory=".")
    print(f"preview: http://127.0.0.1:{PORT}/tools/preview.html")
    print("every response is sent no-store, so edits take effect on reload")
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), handler).serve_forever()
    except KeyboardInterrupt:
        pass
