"""Synthetic panel photos for the tests: a cabinet with a mounting plate full of devices,
seen from a few angles, plus the true plate corners.

    python tests/make_scenes.py tests/scenes
"""
import json
import random
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


def plate_image(width=600, height=900, seed=1):
    rnd = random.Random(seed)
    im = Image.new('RGB', (width, height), (214, 216, 212))          # galvanised plate
    d = ImageDraw.Draw(im)
    duct = (150, 152, 156)
    rows = [0.05, 0.36, 0.67, 0.95]
    for y in rows:                                                    # horizontal ducts
        d.rectangle([20, int(y * height) - 18, width - 20, int(y * height) + 18], fill=duct, outline=(110, 110, 115))
    d.rectangle([20, 20, 56, height - 20], fill=duct, outline=(110, 110, 115))
    d.rectangle([width - 56, 20, width - 20, height - 20], fill=duct, outline=(110, 110, 115))
    for a, b in zip(rows, rows[1:]):                                  # rails with devices
        y = int((a + b) / 2 * height)
        d.rectangle([60, y - 8, width - 60, y + 8], fill=(190, 190, 185))
        x = 70
        while x < width - 110:
            w = rnd.choice([18, 18, 36, 54, 72])
            h = rnd.choice([70, 80, 95])
            col = rnd.choice([(235, 235, 230), (60, 62, 66), (90, 90, 95), (230, 120, 40)])
            d.rectangle([x, y - h // 2, x + w, y + h // 2], fill=col, outline=(30, 30, 30))
            d.rectangle([x + 3, y - h // 2 + 5, x + w - 3, y - h // 2 + 12], fill=(250, 250, 250))
            x += w + rnd.choice([0, 0, 4, 12])
    return np.array(im)


def scene(plate, corners, size=(960, 1280), seed=1, glare=False, blur=0):
    rnd = np.random.default_rng(seed)
    w, h = size
    bg = np.full((h, w, 3), (120, 124, 128), np.uint8)                # cabinet inside
    cv2.rectangle(bg, (0, 0), (w - 1, h - 1), (95, 98, 100), 40)
    bg = (bg + rnd.normal(0, 4, bg.shape)).clip(0, 255).astype(np.uint8)
    ph, pw = plate.shape[:2]
    H = cv2.getPerspectiveTransform(np.float32([[0, 0], [pw, 0], [pw, ph], [0, ph]]), np.float32(corners))
    warped = cv2.warpPerspective(plate, H, (w, h))
    mask = cv2.warpPerspective(np.full((ph, pw), 255, np.uint8), H, (w, h))
    out = np.where(mask[..., None] > 127, warped, bg)
    if glare:
        cv2.circle(out, (int(w * 0.55), int(h * 0.4)), int(h * 0.12), (255, 255, 255), -1)
    if blur:
        out = cv2.GaussianBlur(out, (0, 0), blur)
    out = (out + rnd.normal(0, 3, out.shape)).clip(0, 255).astype(np.uint8)
    return out


def camera_corners(yaw=0, pitch=0, roll=0, distance=1.6, shift=(0, 0), plate=(0.6, 0.9), size=(960, 1280), focal=1000):
    """Plate corners as a real phone camera (square pixels, centred lens) would see them."""
    w, h = plate
    pts = np.array([[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0]], float)
    pts[:, 0] += shift[0]; pts[:, 1] += shift[1]
    a, b, c = np.radians([yaw, pitch, roll])
    Ry = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    Rx = np.array([[1, 0, 0], [0, np.cos(b), -np.sin(b)], [0, np.sin(b), np.cos(b)]])
    Rz = np.array([[np.cos(c), -np.sin(c), 0], [np.sin(c), np.cos(c), 0], [0, 0, 1]])
    cam = pts @ (Rz @ Rx @ Ry).T + [0, 0, distance]
    return [[float(size[0] / 2 + focal * x / z), float(size[1] / 2 + focal * y / z)] for x, y, z in cam]


SCENES = {
    'frontal': dict(corners=[[130, 115], [830, 115], [830, 1165], [130, 1165]]),
    'from_left': dict(corners=camera_corners(yaw=-18, distance=1.0)),
    'tilted': dict(corners=camera_corners(pitch=10, roll=3, yaw=5, distance=0.95)),
    'too_close': dict(corners=[[-80, -60], [1040, -50], [1050, 1340], [-90, 1330]]),
    'glare_blur': dict(corners=[[130, 115], [830, 115], [830, 1165], [130, 1165]], glare=True, blur=3.5),
}


def main(out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    plate = plate_image()
    truth = {}
    for name, spec in SCENES.items():
        img = scene(plate, spec['corners'], glare=spec.get('glare', False), blur=spec.get('blur', 0))
        Image.fromarray(img).save(out / f'{name}.png')
        truth[name] = dict(corners=spec['corners'], size=[960, 1280], plate_aspect=600 / 900)
    (out / 'truth.json').write_text(json.dumps(truth, indent=1))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'tests/scenes')
