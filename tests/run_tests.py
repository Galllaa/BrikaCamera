"""Run the browser tests headless: python tests/run_tests.py
Needs: pip install playwright opencv-python pillow numpy (and `playwright install chromium` once)."""
import functools
import http.server
import subprocess
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    handler = functools.partial(Quiet, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main():
    subprocess.run([sys.executable, str(ROOT / 'tests' / 'make_scenes.py'), str(ROOT / 'tests' / 'scenes')], check=True)
    server = serve()
    url = f'http://127.0.0.1:{server.server_address[1]}/tests/vision.test.html'
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.on('console', lambda m: m.type == 'error' and print('console:', m.text))
        page.on('pageerror', lambda e: print('page error:', e))
        page.goto(url)
        page.wait_for_function('window.testResults !== undefined', timeout=60000)
        results = page.evaluate('window.testResults')
        browser.close()
    failed = 0
    for r in results:
        print(('PASS ' if r['ok'] else 'FAIL ') + r['name'] + '  ' + r['detail'])
        failed += not r['ok']
    print(f'{len(results) - failed}/{len(results)} passed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
