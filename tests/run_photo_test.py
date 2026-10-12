"""Photo from the phone's camera app or the gallery: python tests/run_photo_test.py
Setup → "Straighten a photo from the gallery" → corners found → straighten → save.
Also checks that a big photo is shrunk smoothly (no grain) and nothing is smeared past the photo edge."""
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from run_tests import ROOT, serve  # noqa: E402

OUT = ROOT / 'tests' / 'out'


def main(scene='from_left'):
    OUT.mkdir(exist_ok=True)
    # A big "phone camera" photo: the synthetic scene enlarged to 12 MP.
    big = OUT / 'phone_photo.jpg'
    Image.open(ROOT / 'tests' / 'scenes' / f'{scene}.png').convert('RGB').resize((4000, 3000), Image.LANCZOS).save(big, quality=95)
    server = serve()
    url = f'http://localhost:{server.server_address[1]}/index.html'
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={'width': 412, 'height': 860}, device_scale_factor=2, is_mobile=True,
                                  has_touch=True, accept_downloads=True)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        page.goto(url)
        page.evaluate('localStorage.clear()')
        page.reload()
        assert page.is_checked('#hi-res'), 'full-resolution photos should be on by default'
        page.fill('#panel-name', 'Photo panel')
        page.fill('#plate-w', '600')
        page.fill('#plate-h', '900')
        with page.expect_file_chooser() as fc:
            page.click('#pick-photo')
        fc.value.set_files(str(big))
        page.wait_for_selector('#review.active', timeout=20000)
        corners = page.evaluate('window.__brikaCamera.review()')
        print('corners found:', corners)
        page.click('#review-ok')
        page.wait_for_selector('#busy', state='hidden', timeout=60000)
        size = page.inner_text('#result-size')
        name = page.input_value('#file-name')
        print('result:', size, '|', name)
        page.screenshot(path=str(OUT / 'photo-result.png'))
        with page.expect_download() as d:
            page.click('#result-save')
        saved = OUT / d.value.suggested_filename
        d.value.save_as(saved)
        page.wait_for_selector('#setup.active', timeout=5000)   # gallery photos go back to the first screen
        # Corner dragged past the edge: the part outside the photo is plain grey, not stripes.
        outside = page.evaluate('''() => {
          const src = new Uint8ClampedArray(40 * 30 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256));
          return import('./js/vision.js').then(v => Array.from(v.warp(src, 40, 30, [[0, 0], [39, 0], [39, 45], [0, 45]], 40, 46).slice(-8)));
        }''')
        browser.close()
    assert not errors, errors
    assert name == 'Photo panel_600x900mm_01.jpg', name
    assert outside[:3] == [30, 30, 30], outside
    img = Image.open(saved)
    print('saved', saved.name, img.size, saved.stat().st_size, 'bytes')
    assert max(img.size) > 1800, img.size
    print('PHOTO TEST PASSED')


if __name__ == '__main__':
    main(*sys.argv[1:])
