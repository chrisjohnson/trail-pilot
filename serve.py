import http.server, socketserver, sys, os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
DIR = os.path.dirname(os.path.abspath(__file__))

class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # keep .gpx from being served with a weird mime; not needed but explicit
        return super().do_GET()
    def log_message(self, *a): pass

with socketserver.TCPServer(("127.0.0.1", PORT), H) as httpd:
    print(f"Serving {DIR} at http://127.0.0.1:{PORT}")
    httpd.serve_forever()
