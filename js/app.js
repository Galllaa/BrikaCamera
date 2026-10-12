// Brika Camera: guided panel photos. Setup → camera (level + live plate outline) → corners → straightened result → save.
import {
  toGray, findPanels, cornerDistance, framingAdvice, levelFromGravity,
  warp, estimateAspect, photoQuality, polygonArea,
} from './vision.js';

const $ = id => document.getElementById(id);
const COLORS = { good: '#34d399', warn: '#fbbf24', bad: '#f87171', accent: '#08c5fa' };
const DETECT_SIDE = 320;          // detection works on a small copy of the frame
const MAX_OUTPUT_SIDE = 4000;
const AUTO_HOLD_MS = 900;

// ---------------- settings (kept on this phone only) ----------------
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};
const settings = Object.assign({ cameraId: '', panel: '', mode: 'panel', widthMm: '', heightMm: '', keepOriginal: false, hiRes: false, auto: true, tag: '' },
  store.get('brika-camera-settings', {}));
const saveSettings = () => store.set('brika-camera-settings', settings);
// v3: full-resolution stills are the default (video frames are small and noisy).
if (!settings.v3) { settings.hiRes = true; settings.v3 = true; saveSettings(); }
let photoSource = 'live';          // live = this app's camera, native = phone camera app, gallery = existing photo

// ---------------- screens ----------------
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}
let toastTimer;
function toast(text, ms = 3500) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------- setup ----------------
const form = $('setup-form');
$('panel-name').value = settings.panel;
$('plate-w').value = settings.widthMm;
$('plate-h').value = settings.heightMm;
$('keep-original').checked = settings.keepOriginal;
$('hi-res').checked = settings.hiRes;
form.elements.mode.value = settings.mode;
const syncMode = () => { $('size-field').hidden = form.elements.mode.value !== 'panel'; };
form.addEventListener('change', syncMode);
syncMode();

function readSetup() {
  settings.panel = $('panel-name').value.trim();
  settings.mode = form.elements.mode.value;
  const w = parseFloat($('plate-w').value), h = parseFloat($('plate-h').value);
  settings.widthMm = w > 0 && h > 0 ? w : '';
  settings.heightMm = w > 0 && h > 0 ? h : '';
  settings.keepOriginal = $('keep-original').checked;
  settings.hiRes = $('hi-res').checked;
  saveSettings();
  if (!settings.panel) { $('panel-name').reportValidity?.(); $('panel-name').focus(); return false; }
  $('setup-error').hidden = true;
  return true;
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  if (!readSetup()) return;
  photoSource = 'live';
  try {
    await openCamera();
  } catch (err) {
    $('setup-error').textContent = cameraErrorText(err);
    $('setup-error').hidden = false;
    show('setup');
  }
});

function cameraErrorText(err) {
  if (!window.isSecureContext) return 'The camera only works when the app is opened over https (see README).';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser cannot use the camera. Open the app in Chrome.';
  if (err?.name === 'NotAllowedError') return 'Camera permission was refused. Allow it in Chrome: ⋮ → Settings → Site settings → Camera.';
  if (err?.name === 'NotFoundError') return 'No camera found on this device.';
  return `Could not start the camera (${err?.name || err}).`;
}

// ---------------- camera ----------------
const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const small = document.createElement('canvas');
const sctx = small.getContext('2d', { willReadFrequently: true });

let stream = null, track = null, imageCapture = null, wakeLock = null;
let running = false, lastDetect = 0, busy = false;
let tracked = null, pending = null, candidates = [], preferred = null, misses = 0, movement = 1;
let goodSince = 0, advice = { status: 'bad', tips: [] };
let videoBox = { x: 0, y: 0, w: 1, h: 1 };

let backCameras = [], lowRes = false;

async function openStream() {
  const size = lowRes ? { width: { ideal: 1920 }, height: { ideal: 1080 } } : { width: { ideal: 3840 }, height: { ideal: 2160 } };
  const video_ = settings.cameraId
    ? { deviceId: { exact: settings.cameraId }, ...size }
    : { facingMode: { ideal: 'environment' }, ...size };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: video_ });
  } catch (err) {
    if (!settings.cameraId || err?.name === 'NotAllowedError') throw err;
    settings.cameraId = ''; saveSettings();          // that camera is gone: fall back to the default one
    return openStream();
  }
  track = stream.getVideoTracks()[0];
  video.srcObject = stream;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  $('torch').hidden = !caps.torch;
  $('torch-spacer').hidden = !!caps.torch;
  showTorch(false);
  if (caps.focusMode && caps.focusMode.includes('continuous')) {
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }
  imageCapture = 'ImageCapture' in window ? new ImageCapture(track) : null;
  await listBackCameras();
}

// Phones have several back cameras (main, wide, zoom); only some have the light next to them.
async function listBackCameras() {
  try {
    const all = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const back = all.filter(d => /back|rear|environment/i.test(d.label));
    backCameras = back.length ? back : all;
  } catch { backCameras = []; }
  $('cam-switch').hidden = backCameras.length < 2;
}

async function openCamera() {
  if (!stream) await openStream();
  $('cam-panel').textContent = settings.panel;
  $('cam-tag').hidden = settings.mode !== 'label';
  $('cam-tag').value = settings.tag || '';
  $('auto-toggle').classList.toggle('on', settings.auto);
  $('auto-toggle').setAttribute('aria-pressed', String(settings.auto));
  show('camera');
  await video.play().catch(() => {});
  layoutVideo();
  tracked = null; pending = null; candidates = []; goodSince = 0; busy = false;
  $('shutter').disabled = false;
  running = true;
  requestAnimationFrame(tick);
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not important */ }
}

function stopCamera() {
  running = false;
  stream?.getTracks().forEach(t => t.stop());
  stream = null; track = null; imageCapture = null;
  wakeLock?.release?.().catch(() => {}); wakeLock = null;
}

function layoutVideo() {
  const stage = $('cam-stage').getBoundingClientRect();
  const vw = video.videoWidth || 3, vh = video.videoHeight || 4;
  const s = Math.min(stage.width / vw, stage.height / vh);
  const w = vw * s, h = vh * s;
  videoBox = { x: (stage.width - w) / 2, y: (stage.height - h) / 2, w, h };
  for (const el of [video]) Object.assign(el.style, { left: `${videoBox.x}px`, top: `${videoBox.y}px`, width: `${w}px`, height: `${h}px` });
  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(stage.width * dpr); overlay.height = Math.round(stage.height * dpr);
  Object.assign(overlay.style, { left: '0px', top: '0px', width: `${stage.width}px`, height: `${stage.height}px` });
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
video.addEventListener('loadedmetadata', layoutVideo);
window.addEventListener('resize', () => { if (running) layoutVideo(); if (reviewState) drawReview(); });

$('cam-back').addEventListener('click', () => { stopCamera(); show('setup'); });
$('cam-tag').addEventListener('input', () => { settings.tag = $('cam-tag').value.trim(); saveSettings(); });
$('auto-toggle').addEventListener('click', () => {
  settings.auto = !settings.auto; saveSettings();
  $('auto-toggle').classList.toggle('on', settings.auto);
  $('auto-toggle').setAttribute('aria-pressed', String(settings.auto));
  goodSince = 0;
});
function showTorch(on) {
  $('torch').setAttribute('aria-pressed', String(on));
  $('torch').classList.toggle('on', on);
  $('torch').querySelector('small').textContent = on ? 'on' : 'off';
}

async function trySetTorch(on) {
  // Chrome on some phones only accepts the light after the photo settings were read once.
  if (imageCapture) { try { await imageCapture.getPhotoCapabilities(); } catch { /* ignore */ } }
  for (const c of [{ advanced: [{ torch: on }] }, { torch: on }]) {
    try {
      await track.applyConstraints(c);
      const now = track.getSettings ? track.getSettings().torch : undefined;
      if (now === undefined || now === on) return true;
    } catch { /* try the next form */ }
  }
  return false;
}

$('torch').addEventListener('click', async () => {
  if (!track) return;
  const on = $('torch').getAttribute('aria-pressed') !== 'true';
  if (await trySetTorch(on)) { showTorch(on); return; }
  if (on && !lowRes) {
    // Some phones can only light the torch at Full HD: restart the camera smaller and try again.
    lowRes = true;
    stream.getTracks().forEach(t => t.stop());
    await openStream(); await video.play().catch(() => {}); layoutVideo();
    if (await trySetTorch(true)) { showTorch(true); toast('Light on (camera switched to Full HD for this).'); return; }
    lowRes = false;
    stream.getTracks().forEach(t => t.stop());
    await openStream(); await video.play().catch(() => {}); layoutVideo();
  }
  toast(backCameras.length > 1
    ? 'This camera cannot use the light. Tap the camera button (top right) to try another back camera.'
    : 'Chrome cannot switch the light on for this camera. Use the cabinet light or a lamp.', 5000);
});

$('cam-switch').addEventListener('click', async () => {
  if (backCameras.length < 2) return;
  const current = track?.getSettings ? track.getSettings().deviceId : settings.cameraId;
  const i = backCameras.findIndex(d => d.deviceId === current);
  const next = backCameras[(i + 1) % backCameras.length];
  settings.cameraId = next.deviceId; saveSettings();
  stream?.getTracks().forEach(t => t.stop());
  lowRes = false;
  try {
    await openStream(); await video.play().catch(() => {}); layoutVideo();
    tracked = null; candidates = [];
    toast(`Camera ${backCameras.findIndex(d => d.deviceId === next.deviceId) + 1} of ${backCameras.length}` +
      ($('torch').hidden ? ' (no light)' : ' (has light)'), 2000);
  } catch (err) { toast(cameraErrorText(err)); }
});
$('switch-outline').addEventListener('click', () => {
  if (candidates.length < 2) return;
  const i = candidates.findIndex(c => tracked && cornerDistance(c.corners, tracked.corners) < 0.05);
  const next = candidates[(i + 1) % candidates.length];
  preferred = next.corners;
  tracked = { ...next };
  goodSince = 0;
});
// Tap = focus at that point (where the phone supports it).
$('cam-stage').addEventListener('click', e => {
  if (!track || e.target.closest('button')) return;
  const r = $('cam-stage').getBoundingClientRect();
  const x = (e.clientX - r.left - videoBox.x) / videoBox.w, y = (e.clientY - r.top - videoBox.y) / videoBox.h;
  if (x < 0 || y < 0 || x > 1 || y > 1) return;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  const mode = caps.focusMode?.includes('single-shot') ? 'single-shot' : caps.focusMode?.includes('continuous') ? 'continuous' : null;
  if (!mode) return;
  track.applyConstraints({ advanced: [{ pointsOfInterest: [{ x, y }], focusMode: mode }] }).then(() => toast('Focusing…', 1000)).catch(() => {});
});
$('shutter').addEventListener('click', () => capture());

// ---------------- level from the motion sensor ----------------
let gravity = null, lastMotion = 0, rotationSpeed = 0;
window.addEventListener('devicemotion', e => {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x === null) return;
  const k = 0.25;
  gravity = gravity ? { x: gravity.x + (a.x - gravity.x) * k, y: gravity.y + (a.y - gravity.y) * k, z: gravity.z + (a.z - gravity.z) * k } : { x: a.x, y: a.y, z: a.z };
  const r = e.rotationRate;
  if (r && r.alpha !== null) rotationSpeed = rotationSpeed * 0.7 + 0.3 * Math.hypot(r.alpha, r.beta, r.gamma);
  lastMotion = performance.now();
});
function currentLevel() {
  if (!gravity || performance.now() - lastMotion > 1500) return { available: false };
  const angle = screen.orientation?.angle ?? window.orientation ?? 0;
  return levelFromGravity(gravity.x, gravity.y, gravity.z, angle);
}

// ---------------- live loop ----------------
function tick(now) {
  if (!running) return;
  if (!busy && video.readyState >= 2 && now - lastDetect > 110) {
    lastDetect = now;
    if (settings.mode === 'panel') detect();
  }
  const level = currentLevel();
  if (settings.mode === 'panel') advice = framingAdvice(tracked, level, (video.videoWidth || 3) / (video.videoHeight || 4));
  else advice = labelAdvice(level);
  updateHint(level);
  autoCapture(now, level);
  draw(level);
  requestAnimationFrame(tick);
}

function labelAdvice(level) {
  const tips = [];
  if (level.available && (Math.abs(level.pitch) > 6 || Math.abs(level.roll) > 6))
    tips.push({ level: 'warn', text: 'Hold the phone straight in front of the label' });
  return { status: tips.length ? 'warn' : 'good', tips };
}

function detect() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const s = DETECT_SIDE / Math.max(vw, vh);
  const w = Math.round(vw * s), h = Math.round(vh * s);
  if (small.width !== w || small.height !== h) { small.width = w; small.height = h; }
  sctx.drawImage(video, 0, 0, w, h);
  const rgba = sctx.getImageData(0, 0, w, h).data;
  candidates = findPanels(toGray(rgba, w, h), w, h);
  let choice = candidates[0] || null;
  if (preferred && candidates.length) {
    const near = candidates.map(c => [cornerDistance(c.corners, preferred), c]).sort((a, b) => a[0] - b[0])[0];
    if (near[0] < 0.06) choice = near[1];
  }
  if (!choice) {
    if (++misses > 4) { tracked = null; preferred = null; }
    movement = 1;
    return;
  }
  misses = 0;
  if (tracked && cornerDistance(choice.corners, tracked.corners) < 0.05) {
    const d = cornerDistance(choice.corners, tracked.corners);
    movement = movement * 0.6 + d * 0.4;
    const k = 0.5;
    tracked = { ...choice, corners: tracked.corners.map((p, i) => [p[0] + (choice.corners[i][0] - p[0]) * k, p[1] + (choice.corners[i][1] - p[1]) * k]) };
    pending = null;
  } else if (!tracked) {
    tracked = { ...choice }; movement = 1;
  } else {
    // A different outline: switch only when it is seen a few times in a row (no flicker).
    if (pending && cornerDistance(pending.q.corners, choice.corners) < 0.05) pending.n++;
    else pending = { q: choice, n: 1 };
    if (pending.n >= 3) { tracked = { ...choice }; pending = null; movement = 1; }
  }
  $('switch-outline').hidden = candidates.length < 2;
}

function updateHint(level) {
  const hint = $('hint');
  let text, cls;
  if (advice.tips.length) { text = advice.tips[0].text; cls = advice.tips[0].level; }
  else if (settings.mode === 'label') { text = 'Fill the frame with the label and hold still'; cls = 'good'; }
  else { text = settings.auto ? 'Good – hold still…' : 'Good – take the photo'; cls = 'good'; }
  if (hint.textContent !== text) hint.textContent = text;
  hint.className = `hint ${cls}`;
  const readout = $('level-readout');
  if (level.available) {
    readout.textContent = level.flat ? `Flat · tilt ${level.pitch.toFixed(1)}°` : `Tilt ${Math.abs(level.pitch).toFixed(1)}° · turn ${Math.abs(level.roll).toFixed(1)}°`;
  } else readout.textContent = 'Level sensor not available';
}

function steady(level) {
  const sensorOk = !level.available || rotationSpeed < 8;
  const outlineOk = settings.mode === 'label' || movement < 0.006;
  return sensorOk && outlineOk;
}

function autoCapture(now, level) {
  const ring = $('shutter-progress');
  const ok = settings.auto && advice.status === 'good' && steady(level) && (settings.mode === 'label' ? level.available : true);
  if (!ok || busy) { goodSince = 0; ring.style.strokeDashoffset = 226.2; return; }
  if (!goodSince) goodSince = now;
  const p = Math.min(1, (now - goodSince) / AUTO_HOLD_MS);
  ring.style.strokeDashoffset = String(226.2 * (1 - p));
  if (p >= 1) { goodSince = 0; capture(); }
}

function toScreen([x, y]) { return [videoBox.x + x * videoBox.w, videoBox.y + y * videoBox.h]; }

function draw(level) {
  const W = overlay.clientWidth, H = overlay.clientHeight;
  octx.clearRect(0, 0, W, H);
  const color = COLORS[advice.status] || COLORS.bad;
  if (settings.mode === 'panel' && tracked) {
    const pts = tracked.corners.map(toScreen);
    octx.save();
    octx.beginPath();
    octx.rect(videoBox.x, videoBox.y, videoBox.w, videoBox.h);
    octx.moveTo(...pts[0]); pts.slice(1).forEach(p => octx.lineTo(...p)); octx.closePath();
    octx.fillStyle = 'rgba(0,0,0,.35)';
    octx.fill('evenodd');
    octx.beginPath(); octx.moveTo(...pts[0]); pts.slice(1).forEach(p => octx.lineTo(...p)); octx.closePath();
    octx.lineWidth = 3; octx.strokeStyle = color; octx.stroke();
    for (const p of pts) { octx.beginPath(); octx.arc(p[0], p[1], 7, 0, Math.PI * 2); octx.fillStyle = color; octx.fill(); }
    octx.restore();
  } else if (settings.mode === 'label') {
    const g = labelGuide();
    const pts = g.map(toScreen);
    octx.strokeStyle = color; octx.lineWidth = 4;
    const L = 28;
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % 4], r = pts[(i + 3) % 4];
      const d1 = [(q[0] - p[0]), (q[1] - p[1])], d2 = [(r[0] - p[0]), (r[1] - p[1])];
      const n1 = Math.hypot(...d1), n2 = Math.hypot(...d2);
      octx.beginPath();
      octx.moveTo(p[0] + d1[0] / n1 * L, p[1] + d1[1] / n1 * L); octx.lineTo(...p); octx.lineTo(p[0] + d2[0] / n2 * L, p[1] + d2[1] / n2 * L);
      octx.stroke();
    });
  }
  drawLevel(level, W, H);
}

function labelGuide() { return [[0.1, 0.25], [0.9, 0.25], [0.9, 0.75], [0.1, 0.75]]; }

function drawLevel(level, W, H) {
  const cx = W / 2, cy = H / 2, R = 36;
  octx.save();
  octx.lineWidth = 2;
  if (!level.available) {
    octx.strokeStyle = 'rgba(255,255,255,.35)';
    octx.beginPath(); octx.arc(cx, cy, R, 0, Math.PI * 2); octx.stroke();
    octx.restore();
    return;
  }
  const off = Math.max(Math.abs(level.pitch), Math.abs(level.roll || 0));
  const col = off < 2.5 ? COLORS.good : off < 6 ? COLORS.warn : COLORS.bad;
  octx.strokeStyle = 'rgba(255,255,255,.75)';
  octx.beginPath(); octx.arc(cx, cy, R, 0, Math.PI * 2); octx.stroke();
  octx.beginPath(); octx.arc(cx, cy, 9, 0, Math.PI * 2); octx.stroke();
  if (!level.flat) {
    // Horizon: shows how far the phone is turned.
    const a = -(level.roll || 0) * Math.PI / 180;
    octx.strokeStyle = col; octx.lineWidth = 3;
    octx.beginPath();
    octx.moveTo(cx - Math.cos(a) * (R + 22), cy - Math.sin(a) * (R + 22));
    octx.lineTo(cx - Math.cos(a) * (R + 6), cy - Math.sin(a) * (R + 6));
    octx.moveTo(cx + Math.cos(a) * (R + 6), cy + Math.sin(a) * (R + 6));
    octx.lineTo(cx + Math.cos(a) * (R + 22), cy + Math.sin(a) * (R + 22));
    octx.stroke();
  }
  const scale = 4;
  let bx = level.bubble[0] * scale, by = level.bubble[1] * scale;
  const n = Math.hypot(bx, by);
  if (n > R - 8) { bx *= (R - 8) / n; by *= (R - 8) / n; }
  octx.fillStyle = col;
  octx.beginPath(); octx.arc(cx + bx, cy + by, 8, 0, Math.PI * 2); octx.fill();
  octx.restore();
}

// ---------------- capture ----------------
async function grabPhoto() {
  if (settings.hiRes && imageCapture) {
    try {
      // Ask for the sensor's full still size; the default is often only the preview size.
      let options = {};
      try {
        const caps = await imageCapture.getPhotoCapabilities();
        if (caps?.imageWidth?.max && caps?.imageHeight?.max) options = { imageWidth: caps.imageWidth.max, imageHeight: caps.imageHeight.max };
        if (caps?.fillLightMode?.includes?.('off')) options.fillLightMode = 'off';
      } catch { /* older Chrome: default size */ }
      const blob = await imageCapture.takePhoto(options);
      const bmp = await createImageBitmap(blob);
      const portraitVideo = video.videoHeight > video.videoWidth, portraitPhoto = bmp.height > bmp.width;
      if (portraitVideo === portraitPhoto) return bmp;
      bmp.close();
    } catch { /* fall back to the video frame */ }
  }
  return createImageBitmap(video);
}

async function capture() {
  if (busy || !running) return;
  busy = true;
  $('shutter').disabled = true;
  const flash = $('flash');
  flash.classList.add('on'); setTimeout(() => flash.classList.remove('on'), 60);
  try {
    const live = tracked ? tracked.corners : null;
    const bmp = await grabPhoto();
    running = false;
    reviewPhoto(bmp, live);
  } catch (err) {
    toast(`Could not take the photo (${err?.name || err}).`);
    busy = false;
    $('shutter').disabled = false;
  }
}

// Photo (from this camera, the phone's camera app or the gallery) → find the plate → corners screen.
function reviewPhoto(bmp, live = null) {
  const scale = Math.min(1, 6000 / Math.max(bmp.width, bmp.height));
  const photo = document.createElement('canvas');
  photo.width = Math.round(bmp.width * scale); photo.height = Math.round(bmp.height * scale);
  const pctx = photo.getContext('2d');
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(bmp, 0, 0, photo.width, photo.height);
  bmp.close?.();
  // Find the plate again on the photo itself (it can be framed a little differently from the preview).
  let photoCands = [];
  if (settings.mode === 'panel') {
    const s = DETECT_SIDE / Math.max(photo.width, photo.height);
    const w = Math.round(photo.width * s), h = Math.round(photo.height * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(photo, 0, 0, w, h);
    photoCands = findPanels(toGray(cx.getImageData(0, 0, w, h).data, w, h), w, h);
  }
  let corners;
  if (settings.mode === 'label') corners = photoSource === 'live' ? labelGuide() : [[0.04, 0.04], [0.96, 0.04], [0.96, 0.96], [0.04, 0.96]];
  else if (live && photoCands.length) {
    const near = photoCands.map(c => [cornerDistance(c.corners, live), c]).sort((a, b) => a[0] - b[0])[0];
    corners = near[0] < 0.06 ? near[1].corners : live;
  } else if (live) corners = live;
  else if (photoSource !== 'live') {
    // A photo from the camera app or gallery: use a found plate only if it fills a good part of the
    // photo; a small rectangle is usually one row of devices in an already close-up photo.
    const big = photoCands.find(c => polygonArea(c.corners) >= 0.3);
    corners = big ? big.corners : [[0, 0], [1, 0], [1, 1], [0, 1]];
  } else corners = photoCands[0]?.corners || [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]];
  $('toast').hidden = true;
  openReview(photo, corners.map(p => [...p]), photoCands.map(c => c.corners));
}

// The phone's own camera app (night mode, HDR, noise reduction) or a photo already in the gallery.
async function openPhotoFile(file) {
  if (!file) return;
  $('setup-error').hidden = true;
  toast('Opening the photo…', 2000);
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    stopCamera();
    reviewPhoto(bmp, null);
  } catch (err) {
    $('setup-error').textContent = `Could not open that photo (${err?.name || err}).`;
    $('setup-error').hidden = false;
    show('setup');
  }
}
$('native-camera').addEventListener('click', () => {
  if (!readSetup()) return;
  photoSource = 'native';
  $('native-input').value = '';
  $('native-input').click();
});
$('pick-photo').addEventListener('click', () => {
  if (!readSetup()) return;
  photoSource = 'gallery';
  $('gallery-input').value = '';
  $('gallery-input').click();
});
$('native-input').addEventListener('change', e => openPhotoFile(e.target.files?.[0]));
$('gallery-input').addEventListener('change', e => openPhotoFile(e.target.files?.[0]));

// ---------------- review: corners ----------------
const rcanvas = $('review-canvas');
const rctx = rcanvas.getContext('2d');
const loupe = $('loupe');

const lctx = loupe.getContext('2d');
let reviewState = null;

function openReview(photo, corners, alternatives) {
  reviewState = { photo, corners, alternatives, alt: 0, drag: -1, box: null };
  $('review-next').hidden = alternatives.length < 2;
  show('review');
  requestAnimationFrame(drawReview);
}

function drawReview() {
  if (!reviewState) return;
  const stage = $('review-stage').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  rcanvas.width = Math.round(stage.width * dpr); rcanvas.height = Math.round(stage.height * dpr);
  Object.assign(rcanvas.style, { left: '0px', top: '0px', width: `${stage.width}px`, height: `${stage.height}px` });
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { photo, corners } = reviewState;
  const pad = 22;
  const s = Math.min((stage.width - 2 * pad) / photo.width, (stage.height - 2 * pad) / photo.height);
  const w = photo.width * s, h = photo.height * s;
  const box = reviewState.box = { x: (stage.width - w) / 2, y: (stage.height - h) / 2, w, h };
  rctx.fillStyle = '#000'; rctx.fillRect(0, 0, stage.width, stage.height);
  rctx.drawImage(photo, box.x, box.y, w, h);
  const pts = corners.map(([x, y]) => [box.x + x * w, box.y + y * h]);
  rctx.save();
  rctx.beginPath(); rctx.rect(box.x, box.y, w, h);
  rctx.moveTo(...pts[0]); pts.slice(1).forEach(p => rctx.lineTo(...p)); rctx.closePath();
  rctx.fillStyle = 'rgba(0,0,0,.45)'; rctx.fill('evenodd');
  rctx.beginPath(); rctx.moveTo(...pts[0]); pts.slice(1).forEach(p => rctx.lineTo(...p)); rctx.closePath();
  rctx.strokeStyle = COLORS.accent; rctx.lineWidth = 2.5; rctx.stroke();
  pts.forEach((p, i) => {
    rctx.beginPath(); rctx.arc(p[0], p[1], i === reviewState.drag ? 16 : 13, 0, Math.PI * 2);
    rctx.fillStyle = 'rgba(8,197,250,.25)'; rctx.fill();
    rctx.lineWidth = 3; rctx.strokeStyle = COLORS.accent; rctx.stroke();
  });
  rctx.restore();
}

function reviewPoint(e) {
  const r = rcanvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
rcanvas.addEventListener('pointerdown', e => {
  if (!reviewState?.box) return;
  const [x, y] = reviewPoint(e);
  const { box, corners } = reviewState;
  let best = -1, bestD = 44;
  corners.forEach(([cx, cy], i) => {
    const d = Math.hypot(box.x + cx * box.w - x, box.y + cy * box.h - y);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best < 0) return;
  reviewState.drag = best;
  reviewState.grab = [box.x + corners[best][0] * box.w - x, box.y + corners[best][1] * box.h - y];
  rcanvas.setPointerCapture(e.pointerId);
  moveCorner(e);
});
rcanvas.addEventListener('pointermove', e => { if (reviewState && reviewState.drag >= 0) moveCorner(e); });
const endDrag = () => { if (!reviewState) return; reviewState.drag = -1; loupe.hidden = true; drawReview(); };
rcanvas.addEventListener('pointerup', endDrag);
rcanvas.addEventListener('pointercancel', endDrag);

function moveCorner(e) {
  const [x, y] = reviewPoint(e);
  const { box, corners, drag, grab, photo } = reviewState;
  const nx = Math.min(1.02, Math.max(-0.02, (x + grab[0] - box.x) / box.w));
  const ny = Math.min(1.02, Math.max(-0.02, (y + grab[1] - box.y) / box.h));
  corners[drag] = [nx, ny];
  drawReview();
  // Magnifier away from the finger, so the corner stays visible.
  const stage = $('review-stage').getBoundingClientRect();
  const left = x > stage.width / 2 ? 12 : stage.width - 162;
  Object.assign(loupe.style, { left: `${left}px`, top: '12px' });
  loupe.hidden = false;
  const zoom = 3 * box.w / photo.width;              // 3x the on-screen size
  const srcSize = 150 / zoom;
  lctx.fillStyle = '#000'; lctx.fillRect(0, 0, 150, 150);
  lctx.drawImage(photo, nx * photo.width - srcSize / 2, ny * photo.height - srcSize / 2, srcSize, srcSize, 0, 0, 150, 150);
  lctx.strokeStyle = COLORS.accent; lctx.lineWidth = 1.5;
  lctx.beginPath(); lctx.moveTo(75, 55); lctx.lineTo(75, 95); lctx.moveTo(55, 75); lctx.lineTo(95, 75); lctx.stroke();
}

$('review-retake').addEventListener('click', retake);
$('review-next').addEventListener('click', () => {
  const alts = reviewState.alternatives;
  if (alts.length < 2) return;
  reviewState.alt = (reviewState.alt + 1) % alts.length;
  reviewState.corners = alts[reviewState.alt].map(p => [...p]);
  drawReview();
});
$('review-full').addEventListener('click', () => {
  reviewState.corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  drawReview();
});
$('review-ok').addEventListener('click', () => straighten());

// "Retake" goes back to where the photo came from. Opening the phone's camera app needs the tap itself,
// so after saving a native/gallery photo the app returns to the first screen instead.
function retake() {
  if (photoSource === 'native') { reviewState = null; resultState = null; show('setup'); $('native-input').value = ''; $('native-input').click(); return; }
  if (photoSource === 'gallery') { reviewState = null; resultState = null; show('setup'); $('gallery-input').value = ''; $('gallery-input').click(); return; }
  backToCamera();
}

async function backToCamera() {
  reviewState = null; resultState = null;
  if (photoSource !== 'live') { show('setup'); return; }
  if (stream && stream.active) {
    show('camera'); busy = false; $('shutter').disabled = false; running = true; goodSince = 0;
    layoutVideo(); requestAnimationFrame(tick);
  } else {
    try { await openCamera(); } catch (err) { show('setup'); $('setup-error').textContent = cameraErrorText(err); $('setup-error').hidden = false; }
  }
}

// ---------------- result ----------------
const resCanvas = $('result-canvas');
let resultState = null;

async function straighten() {
  const { photo, corners } = reviewState;
  if (polygonArea(corners) < 0.01) { toast('The outline is too small.'); return; }
  show('result');
  $('busy').hidden = false;
  $('checks').innerHTML = '';
  await new Promise(r => setTimeout(r, 30));      // let the spinner paint
  const W = photo.width, H = photo.height;
  const px = corners.map(([x, y]) => [x * W, y * H]);
  const fromMm = settings.mode === 'panel' && settings.widthMm && settings.heightMm;
  const aspect = fromMm ? settings.widthMm / settings.heightMm : estimateAspect(px, W, H);
  const side = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  let outH = (side(px[0], px[3]) + side(px[1], px[2])) / 2;
  let outW = outH * aspect;
  const shrink = Math.min(1, MAX_OUTPUT_SIDE / Math.max(outW, outH));
  outW = Math.max(8, Math.round(outW * shrink)); outH = Math.max(8, Math.round(outH * shrink));
  const src = photo.getContext('2d').getImageData(0, 0, W, H).data;
  const out = warp(src, W, H, px, outW, outH);
  resCanvas.width = outW; resCanvas.height = outH;
  resCanvas.getContext('2d').putImageData(new ImageData(out, outW, outH), 0, 0);
  // Checks on a smaller copy.
  const qs = Math.min(1, 1000 / Math.max(outW, outH));
  const q = document.createElement('canvas'); q.width = Math.round(outW * qs); q.height = Math.round(outH * qs);
  const qctx = q.getContext('2d', { willReadFrequently: true }); qctx.drawImage(resCanvas, 0, 0, q.width, q.height);
  const quality = photoQuality(qctx.getImageData(0, 0, q.width, q.height).data, q.width, q.height);
  resultState = { outW, outH, quality, fromMm, aspect };
  renderChecks();
  $('file-name').value = suggestName();
  $('result-size').textContent = `${outW} × ${outH} px` + (fromMm ? ` · ${settings.widthMm} × ${settings.heightMm} mm` : '');
  $('result-share').hidden = !(navigator.canShare && navigator.share);
  $('busy').hidden = true;
  requestAnimationFrame(fitResult);             // after the checks list has taken its space
}

function fitResult() {
  if (!resultState) return;
  const stage = resCanvas.parentElement.getBoundingClientRect();
  const s = Math.min((stage.width - 16) / resCanvas.width, (stage.height - 16) / resCanvas.height);
  const w = resCanvas.width * s, h = resCanvas.height * s;
  Object.assign(resCanvas.style, { width: `${w}px`, height: `${h}px`, left: `${(stage.width - w) / 2}px`, top: `${(stage.height - h) / 2}px` });
}
window.addEventListener('resize', () => { if (resultState) fitResult(); });

function renderChecks() {
  const { quality, outW, outH, fromMm } = resultState;
  const v = quality.verdicts;
  const items = [
    { level: v.sharp, title: v.sharp === 'good' ? 'Sharp' : 'Looks blurry', help: v.sharp === 'good' ? '' : 'Hold still, tap the screen to focus, and retake.' },
    { level: v.glare, title: v.glare === 'good' ? 'No glare' : 'Glare spots', help: v.glare === 'good' ? '' : 'Step a little to the side or switch the light off; the angle gets straightened anyway.' },
    { level: v.light, title: v.light === 'good' ? 'Good light' : quality.brightness < 80 ? 'Too dark' : 'Very bright', help: v.light === 'good' ? '' : quality.brightness < 80 ? 'Turn on the light button or the cabinet light.' : 'Avoid direct sun or the torch pointing straight at the plate.' },
  ];
  if (settings.mode === 'panel') {
    const longSide = Math.max(outW, outH);
    items.push({ level: longSide >= 1800 ? 'good' : longSide >= 1200 ? 'warn' : 'bad', title: longSide >= 1800 ? 'Enough detail' : 'Low detail',
      help: longSide >= 1800 ? '' : 'Move closer so the plate fills more of the screen, or use the phone\'s camera app (first screen).' });
    items.push({ level: fromMm ? 'good' : 'warn', title: fromMm ? 'Exact proportions from the plate size' : 'Proportions estimated',
      help: fromMm ? '' : 'Enter the plate size in mm on the first screen for exact proportions.' });
  }
  const ul = $('checks');
  ul.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li'); li.className = it.level;
    const mark = document.createElement('span'); mark.className = 'mark'; mark.textContent = it.level === 'good' ? '✓' : '!';
    const text = document.createElement('span'); text.className = 'text'; text.textContent = it.title;
    if (it.help) { const s = document.createElement('small'); s.textContent = it.help; text.appendChild(s); }
    li.append(mark, text); ul.appendChild(li);
  }
}

// ---------------- file names and saving ----------------
const clean = s => s.replace(/[\\/:*?"<>|#%]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);
function counterKey() { return `${clean(settings.panel)}|${settings.mode}|${settings.mode === 'label' ? clean(settings.tag || 'label') : ''}`; }
function nextNumber() { const all = store.get('brika-camera-counters', {}); return (all[counterKey()] || 0) + 1; }
function bumpNumber() { const all = store.get('brika-camera-counters', {}); all[counterKey()] = nextNumber(); store.set('brika-camera-counters', all); }

function suggestName() {
  const nn = String(nextNumber()).padStart(2, '0');
  const base = clean(settings.panel) || 'Panel';
  if (settings.mode === 'label') return `${base}_${clean(settings.tag || '') || 'label'}_${nn}.jpg`;
  const size = settings.widthMm && settings.heightMm ? `_${settings.widthMm}x${settings.heightMm}mm` : '';
  return `${base}${size}_${nn}.jpg`;
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.95));
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function fileName() {
  let name = clean($('file-name').value || suggestName());
  if (!/\.jpe?g$/i.test(name)) name += '.jpg';
  return name;
}

$('result-save').addEventListener('click', async () => {
  const name = fileName();
  const blob = await canvasBlob(resCanvas);
  download(blob, name);
  if (settings.keepOriginal && reviewState?.photo) {
    download(await canvasBlob(reviewState.photo), name.replace(/\.jpe?g$/i, '_original.jpg'));
  }
  bumpNumber();
  addSaved(name);
  toast(`Saved ${name} – it appears in the Gallery under “Download”.`);
  setTimeout(backToCamera, 700);
});

$('result-share').addEventListener('click', async () => {
  const name = fileName();
  const file = new File([await canvasBlob(resCanvas)], name, { type: 'image/jpeg' });
  if (!navigator.canShare?.({ files: [file] })) { toast('Sharing files is not supported here.'); return; }
  try { await navigator.share({ files: [file], title: name }); bumpNumber(); addSaved(name); } catch { /* cancelled */ }
});
$('result-retake').addEventListener('click', retake);
$('result-back').addEventListener('click', () => { resultState = null; show('review'); requestAnimationFrame(drawReview); });

function addSaved(name) {
  const thumb = document.createElement('canvas');
  const s = 88 / Math.max(resCanvas.width, resCanvas.height);
  thumb.width = Math.max(1, Math.round(resCanvas.width * s)); thumb.height = Math.max(1, Math.round(resCanvas.height * s));
  thumb.getContext('2d').drawImage(resCanvas, 0, 0, thumb.width, thumb.height);
  const li = document.createElement('li');
  const img = document.createElement('img'); img.src = thumb.toDataURL('image/jpeg', 0.7); img.alt = '';
  const span = document.createElement('span'); span.textContent = name;
  li.append(img, span);
  $('saved-list').prepend(li);
  $('saved-card').hidden = false;
}

// ---------------- offline ----------------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && running && !wakeLock) {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ }
  }
});

// For automated tests.
window.__brikaCamera = { settings, get tracked() { return tracked; }, get advice() { return advice; }, capture, review: () => reviewState?.corners };
