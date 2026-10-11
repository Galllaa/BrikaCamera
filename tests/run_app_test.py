"""End-to-end test with a fake camera showing a synthetic panel: python tests/run_app_test.py [scene]
Setup → camera finds the plate → auto-capture → corners → straighten → save. Screenshots go to tests/out/."""
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from run_tests import ROOT, serve  # noqa: E402

OUT = ROOT / 'tests' / 'out'


def main(scene='from_left'):
    subprocess.run([sys.executable, str(ROOT / 'tests' / 'make_scenes.py'), str(ROOT / 'tests' / 'scenes')], check=True)
    OUT.mkdir(exist_ok=True)
    y4m = OUT / f'{scene}.y4m'
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-loop', '1', '-i', str(ROOT / 'tests' / 'scenes' / f'{scene}.png'),
                    '-t', '2', '-r', '10', '-pix_fmt', 'yuv420p', str(y4m)], check=True)
    server = serve()
    url = f'http://localhost:{server.server_address[1]}/index.html'
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
                                          f'--use-file-for-fake-video-capture={y4m}'])
        ctx = browser.new_context(viewport={'width': 412, 'height': 860}, device_scale_factor=2, is_mobile=True,
                                  has_touch=True, accept_downloads=True, permissions=['camera'])
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        page.goto(url)
        page.evaluate('localStorage.clear()')
        page.reload()
        page.screenshot(path=str(OUT / '1-setup.png'))
        page.fill('#panel-name', 'Test panel')
        page.fill('#plate-w', '600')
        page.fill('#plate-h', '900')
        page.click('button[type=submit]')
        page.wait_for_selector('#camera.active')
        # Phone held upright and still.
        page.evaluate("""setInterval(() => window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
            accelerationIncludingGravity: {x: 0, y: 9.81, z: 0.3}, rotationRate: {alpha: 0, beta: 0, gamma: 0}})), 50)""")
        page.wait_for_function('window.__brikaCamera.tracked !== null', timeout=15000)
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / '2-camera.png'))
        hint = page.inner_text('#hint')
        print('camera hint:', hint, '| level:', page.inner_text('#level-readout'))
        if 'right' in hint or 'closer' in hint or 'Step' in hint:
            # Auto-capture waits for good framing; take it by hand for angled scenes.
            page.click('#shutter')
        page.wait_for_selector('#review.active', timeout=15000)
        page.wait_for_timeout(300)
        page.screenshot(path=str(OUT / '3-review.png'))
        # Drag one corner a little and back, to exercise the magnifier.
        box = page.locator('#review-canvas').bounding_box()
        page.click('#review-ok')
        page.wait_for_selector('#busy', state='hidden', timeout=20000)
        page.wait_for_timeout(200)
        page.screenshot(path=str(OUT / '4-result.png'))
        checks = page.inner_text('#checks')
        size = page.inner_text('#result-size')
        name = page.input_value('#file-name')
        print('result:', size, '|', name)
        print(checks)
        with page.expect_download() as d:
            page.click('#result-save')
        download = d.value
        saved = OUT / download.suggested_filename
        download.save_as(saved)
        print('downloaded:', download.suggested_filename, saved.stat().st_size, 'bytes')
        page.wait_for_selector('#camera.active', timeout=5000)
        page.click('#cam-back')
        page.screenshot(path=str(OUT / '5-setup-after.png'), full_page=True)
        browser.close()
    assert not errors, errors
    assert name == 'Test panel_600x900mm_01.jpg', name
    assert 'Sharp' in checks, checks
    print('APP TEST PASSED', box)


if __name__ == '__main__':
    main(*sys.argv[1:])
