// Image work for Brika Camera: find the mounting plate, straighten it, judge the photo.
// Plain functions on pixel arrays (no DOM), so they run the same in the page and in tests.
// Corner order everywhere: top-left, top-right, bottom-right, bottom-left.

export function toGray(rgba, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    g[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  return g;
}

function blur(gray, w, h) {
  // Two passes of a 3-tap [1 2 1] filter = a small Gaussian; keeps straight edges, drops sensor noise.
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const a = gray[r + Math.max(0, x - 1)], b = gray[r + x], c = gray[r + Math.min(w - 1, x + 1)];
      tmp[r + x] = (a + 2 * b + c) / 4;
    }
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w, r = y * w, dn = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) out[r + x] = (tmp[up + x] + 2 * tmp[r + x] + tmp[dn + x]) / 4;
  }
  return out;
}

export function gradients(gray, w, h) {
  const s = blur(gray, w, h);
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = s[i - w - 1], t = s[i - w], tr = s[i - w + 1];
      const l = s[i - 1], r = s[i + 1];
      const bl = s[i + w - 1], b = s[i + w], br = s[i + w + 1];
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      gx[i] = dx; gy[i] = dy; mag[i] = Math.hypot(dx, dy);
    }
  }
  return { gx, gy, mag };
}

function percentile(values, p) {
  // Histogram percentile; gradient magnitudes stay below ~1500.
  const bins = new Uint32Array(2048);
  let n = 0;
  for (let i = 0; i < values.length; i += 3) { bins[Math.min(2047, values[i] | 0)]++; n++; }
  let want = n * p, acc = 0;
  for (let b = 0; b < bins.length; b++) { acc += bins[b]; if (acc >= want) return b; }
  return 2047;
}

const DEG = Math.PI / 180;

// Straight lines by a Hough vote limited to each pixel's own edge direction.
// family 'v': lines within ±35° of vertical; 'h': within ±35° of horizontal.
function houghLines(g, w, h, threshold, family, maxLines) {
  const diag = Math.ceil(Math.hypot(w, h));
  const thetas = [];
  for (let t = -35; t <= 35; t++) thetas.push((family === 'v' ? t : 90 + t) * DEG);
  const cos = thetas.map(Math.cos), sin = thetas.map(Math.sin);
  const nT = thetas.length, nR = 2 * diag + 1;
  const acc = new Float32Array(nT * nR);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const m = g.mag[i];
      if (m < threshold) continue;
      let a = Math.atan2(g.gy[i], g.gx[i]);          // gradient = line normal
      if (a < 0) a += Math.PI;                         // 0..180°
      let deg = a / DEG;
      let ti;
      if (family === 'v') { if (deg > 90) deg -= 180; ti = Math.round(deg) + 35; }
      else ti = Math.round(deg) - 55;
      if (ti < -3 || ti > nT + 2) continue;
      const weight = Math.min(2, m / threshold);
      for (let k = Math.max(0, ti - 3); k <= Math.min(nT - 1, ti + 3); k++) {
        const r = Math.round(x * cos[k] + y * sin[k]) + diag;
        acc[k * nR + r] += weight;
      }
    }
  }
  const minVotes = 0.12 * (family === 'v' ? h : w);
  const peaks = [];
  for (let k = 0; k < nT; k++) {
    for (let r = 1; r < nR - 1; r++) {
      const v = acc[k * nR + r];
      if (v < minVotes) continue;
      let isMax = true;
      for (let dk = -2; dk <= 2 && isMax; dk++) {
        const kk = k + dk;
        if (kk < 0 || kk >= nT) continue;
        for (let dr = -3; dr <= 3; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= nR || (dk === 0 && dr === 0)) continue;
          const o = acc[kk * nR + rr];
          if (o > v || (o === v && (dk < 0 || (dk === 0 && dr < 0)))) { isMax = false; break; }
        }
      }
      if (isMax) peaks.push({ theta: thetas[k], rho: r - diag, votes: v });
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);
  const lines = [];
  for (const p of peaks) {
    if (lines.some(l => Math.abs(l.rho - p.rho) < 5 && Math.abs(l.theta - p.theta) < 4 * DEG)) continue;
    lines.push(p);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function intersect(a, b) {
  const c1 = Math.cos(a.theta), s1 = Math.sin(a.theta), c2 = Math.cos(b.theta), s2 = Math.sin(b.theta);
  const det = c1 * s2 - s1 * c2;
  if (Math.abs(det) < 1e-6) return null;
  return [(a.rho * s2 - s1 * b.rho) / det, (c1 * b.rho - a.rho * c2) / det];
}

// Share of points along a side that sit on a matching edge (gradient across the side), overall
// and at both ends: a line that runs on past the real corner has an unsupported end.
function sideSupport(g, w, h, p, q, threshold) {
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const nx = -(q[1] - p[1]) / len, ny = (q[0] - p[0]) / len;
  const samples = 50;
  let inside = 0, hit = 0;
  const ends = [[0, 0], [0, 0]];
  for (let s = 0; s < samples; s++) {
    const t = (s + 0.5) / samples;
    const x = p[0] + (q[0] - p[0]) * t, y = p[1] + (q[1] - p[1]) * t;
    if (x < 2 || y < 2 || x > w - 3 || y > h - 3) continue;
    inside++;
    let ok = false;
    for (let d = -2; d <= 2 && !ok; d++) {
      const xi = Math.round(x + nx * d), yi = Math.round(y + ny * d);
      const i = yi * w + xi;
      const m = g.mag[i];
      if (m < threshold) continue;
      const cosang = Math.abs(g.gx[i] * nx + g.gy[i] * ny) / m;
      if (cosang > 0.93) ok = true;                  // within ~21°
    }
    if (ok) hit++;
    const e = t < 0.2 ? 0 : t > 0.8 ? 1 : -1;
    if (e >= 0) { ends[e][0]++; if (ok) ends[e][1]++; }
  }
  const endShare = ends.map(([n, k]) => n ? k / n : 1);
  return { support: inside ? hit / inside : 0, ends: Math.min(...endShare), visible: inside / samples };
}

// Edge pixels per area inside the outline compared with outside it. A plate that carries on past
// the screen edge leaves busy device clutter outside the outline that was found.
function busyOutside(g, w, h, c, threshold) {
  let inN = 0, inE = 0, outN = 0, outE = 0;
  const inside = (x, y) => {
    for (let k = 0; k < 4; k++) {
      const a = c[k], b = c[(k + 1) % 4];
      if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false;
    }
    return true;
  };
  for (let y = 2; y < h - 2; y += 2) for (let x = 2; x < w - 2; x += 2) {
    const e = g.mag[y * w + x] >= threshold ? 1 : 0;
    if (inside(x, y)) { inN++; inE += e; } else { outN++; outE += e; }
  }
  if (outN < 0.04 * (inN + outN) || !inN || !inE) return 0;
  return (outE / outN) / (inE / inN);
}

export function polygonArea(c) {
  let a = 0;
  for (let i = 0; i < c.length; i++) {
    const p = c[i], q = c[(i + 1) % c.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

function isConvex(c) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4], d = c[(i + 2) % 4];
    const z = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (Math.abs(z) < 1e-9) return false;
    if (sign === 0) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

// Candidate panel outlines in a small grayscale frame, best first.
// Returns corners normalised to 0..1, plus how well the edges were seen and whether a corner is cut off.
export function findPanels(gray, w, h, maxCandidates = 5) {
  const g = gradients(gray, w, h);
  const threshold = Math.max(24, 0.35 * percentile(g.mag, 0.97));
  const vertical = houghLines(g, w, h, threshold, 'v', 10);
  const horizontal = houghLines(g, w, h, threshold, 'h', 10);
  const xAt = (l, y) => (l.rho - y * Math.sin(l.theta)) / Math.cos(l.theta);
  const yAt = (l, x) => (l.rho - x * Math.cos(l.theta)) / Math.sin(l.theta);
  const quads = [];
  const margin = 0.15;
  for (let i = 0; i < vertical.length; i++) for (let j = 0; j < vertical.length; j++) {
    if (i === j) continue;
    let L = vertical[i], R = vertical[j];
    if (xAt(L, h / 2) >= xAt(R, h / 2) - 0.2 * w) continue;
    for (let a = 0; a < horizontal.length; a++) for (let b = 0; b < horizontal.length; b++) {
      if (a === b) continue;
      const T = horizontal[a], B = horizontal[b];
      if (yAt(T, w / 2) >= yAt(B, w / 2) - 0.2 * h) continue;
      const c = [intersect(L, T), intersect(R, T), intersect(R, B), intersect(L, B)];
      if (c.some(p => !p || p[0] < -margin * w || p[1] < -margin * h || p[0] > (1 + margin) * w || p[1] > (1 + margin) * h)) continue;
      if (!isConvex(c)) continue;
      const area = polygonArea(c) / (w * h);
      if (area < 0.06) continue;
      const sides = [0, 1, 2, 3].map(k => sideSupport(g, w, h, c[k], c[(k + 1) % 4], threshold * 0.6));
      const supports = sides.map(s => s.support);
      const minS = Math.min(...supports), meanS = supports.reduce((x, y) => x + y) / 4;
      if (minS < 0.4 || meanS < 0.55) continue;
      const ends = Math.min(...sides.map(s => s.ends));
      const cut = c.some(p => p[0] < 0.005 * w || p[1] < 0.005 * h || p[0] > 0.995 * w || p[1] > 0.995 * h);
      const score = meanS * minS * minS * (0.3 + 0.7 * ends) * Math.pow(area, 0.7);
      quads.push({ corners: c.map(p => [p[0] / w, p[1] / h]), px: c, score, support: meanS, area, cut });
    }
  }
  quads.sort((p, q) => q.score - p.score);
  const picked = [];
  for (const q of quads) {
    if (picked.some(p => cornerDistance(p.corners, q.corners) < 0.035)) continue;
    picked.push(q);
    if (picked.length >= maxCandidates) break;
  }
  for (const q of picked) {
    q.busyOutside = busyOutside(g, w, h, q.px, threshold);
    delete q.px;
  }
  return picked;
}

// Mean distance between matching corners (normalised units).
export function cornerDistance(a, b) {
  let d = 0;
  for (let k = 0; k < 4; k++) d += Math.hypot(a[k][0] - b[k][0], a[k][1] - b[k][1]);
  return d / 4;
}

// ---------- homography and straightening ----------

function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

// 3x3 matrix (row-major, 9 numbers) mapping each from[i] to to[i].
export function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const s = solve(A, b);
  return s ? [...s, 1] : null;
}

export function applyH(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
}

// Straightened plate: output pixel (u,v) samples the source through the quad (bilinear).
export function warp(src, sw, sh, cornersPx, outW, outH) {
  const H = homography([[0, 0], [outW - 1, 0], [outW - 1, outH - 1], [0, outH - 1]], cornersPx);
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let v = 0; v < outH; v++) {
    // Walk along the row with incremental numerators/denominator.
    let nx = H[1] * v + H[2], ny = H[4] * v + H[5], d = H[7] * v + H[8];
    let o = v * outW * 4;
    for (let u = 0; u < outW; u++, o += 4, nx += H[0], ny += H[3], d += H[6]) {
      const x = nx / d, y = ny / d;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) {
        const xc = Math.min(sw - 1, Math.max(0, Math.round(x))), yc = Math.min(sh - 1, Math.max(0, Math.round(y)));
        const i = (yc * sw + xc) * 4;
        out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2]; out[o + 3] = 255;
        continue;
      }
      const fx = x - x0, fy = y - y0;
      const i = (y0 * sw + x0) * 4, j = i + sw * 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      out[o] = src[i] * w00 + src[i + 4] * w10 + src[j] * w01 + src[j + 4] * w11;
      out[o + 1] = src[i + 1] * w00 + src[i + 5] * w10 + src[j + 1] * w01 + src[j + 5] * w11;
      out[o + 2] = src[i + 2] * w00 + src[i + 6] * w10 + src[j + 2] * w01 + src[j + 6] * w11;
      out[o + 3] = 255;
    }
  }
  return out;
}

// Width/height of the real rectangle behind a photographed quad (Zhang & He, whiteboard
// rectification; principal point at the image centre). Falls back to mean side lengths when
// the photo is nearly frontal and the focal length cannot be recovered.
export function estimateAspect(cornersPx, imgW, imgH) {
  const [tl, tr, br, bl] = cornersPx;
  const sides = () => {
    const top = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]), bottom = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
    const left = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]), right = Math.hypot(br[0] - tr[0], br[1] - tr[1]);
    return (top + bottom) / (left + right);
  };
  const u0 = imgW / 2, v0 = imgH / 2;
  const m1 = [tl[0], tl[1], 1], m2 = [tr[0], tr[1], 1], m3 = [bl[0], bl[1], 1], m4 = [br[0], br[1], 1];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = m2.map((v, i) => k2 * v - m1[i]);
  const n3 = m3.map((v, i) => k3 * v - m1[i]);
  const denom = n2[2] * n3[2];
  if (Math.abs(denom) < 1e-9) return sides();
  const f2 = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0) +
               (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)) / denom;
  const maxDim = Math.max(imgW, imgH);
  // Phone cameras: focal length roughly 0.6..2.5 x the long image side.
  if (!(f2 > (0.5 * maxDim) ** 2 && f2 < (3 * maxDim) ** 2)) return sides();
  const q = n => {
    const x = (n[0] - u0 * n[2]), y = (n[1] - v0 * n[2]);
    return (x * x + y * y) / f2 + n[2] * n[2];
  };
  const ratio = Math.sqrt(q(n2) / q(n3));
  return Number.isFinite(ratio) && ratio > 0.05 && ratio < 20 ? ratio : sides();
}

// ---------- photo checks ----------

// Sharpness, glare and exposure of a (downscaled) straightened plate.
export function photoQuality(rgba, w, h) {
  const gray = toGray(rgba, w, h);
  let sum = 0, bright = 0, n = 0;
  for (let i = 0; i < gray.length; i++) { sum += gray[i]; }
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] > 248 && rgba[i + 1] > 248 && rgba[i + 2] > 248) bright++;
    n++;
  }
  const mean = sum / gray.length;
  // Variance of the Laplacian: low = blurred.
  let ls = 0, ls2 = 0, m = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
    ls += l; ls2 += l * l; m++;
  }
  const lapVar = m ? ls2 / m - (ls / m) ** 2 : 0;
  // Glare: blown-out patches, measured as share of the plate.
  const glare = n ? bright / n : 0;
  return {
    brightness: mean,
    sharpness: lapVar,
    glare,
    verdicts: {
      sharp: lapVar >= 60 ? 'good' : lapVar >= 25 ? 'warn' : 'bad',
      glare: glare <= 0.01 ? 'good' : glare <= 0.04 ? 'warn' : 'bad',
      light: mean < 50 ? 'bad' : mean < 80 ? 'warn' : mean > 225 ? 'warn' : 'good',
    },
  };
}

// ---------- framing advice ----------

// What the person should do next, from the outline (normalised corners) and the tilt reading.
export function framingAdvice(quad, level, frameAspect = 1) {
  const tips = [];
  if (level && level.available) {
    if (Math.abs(level.pitch) > 4) {
      tips.push({ level: Math.abs(level.pitch) > 8 ? 'bad' : 'warn',
        text: level.flat ? 'Hold the phone flat over the panel'
          : level.pitch > 0 ? 'Tilt the top of the phone toward you' : 'Tilt the top of the phone away from you' });
    }
  }
  if (!quad) {
    tips.unshift({ level: 'bad', text: 'Point at the panel so all 4 corners of the plate are on screen' });
    return { status: 'bad', tips };
  }
  const c = quad.corners;
  const names = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
  const cut = c.map((p, k) => (p[0] < 0.005 || p[1] < 0.005 || p[0] > 0.995 || p[1] > 0.995) ? names[k] : null).filter(Boolean);
  const edge = (a, b) => Math.hypot((b[0] - a[0]) * frameAspect, b[1] - a[1]);
  const left = edge(c[0], c[3]), right = edge(c[1], c[2]), top = edge(c[0], c[1]), bottom = edge(c[3], c[2]);
  const fill = quad.area;
  const near = c.some(p => p[0] < 0.03 || p[1] < 0.03 || p[0] > 0.97 || p[1] > 0.97);
  if (cut.length) tips.unshift({ level: 'bad', text: `Step back: the ${cut.join(' and ')} corner${cut.length > 1 ? 's are' : ' is'} cut off` });
  else if (near || fill > 0.93) tips.unshift({ level: 'warn', text: 'Step back a little: leave a small border around the plate' });
  else if ((quad.busyOutside || 0) > 0.7) tips.unshift({ level: 'warn', text: 'Is the whole plate on screen? Step back until all 4 plate corners show' });
  else if (fill < 0.45) tips.unshift({ level: fill < 0.3 ? 'bad' : 'warn', text: 'Move closer: the plate should fill most of the screen' });
  const lr = left / right;
  if (lr > 1.06) tips.push({ level: lr > 1.15 ? 'bad' : 'warn', text: 'Move to the right: the left side is closer to you' });
  else if (lr < 1 / 1.06) tips.push({ level: lr < 1 / 1.15 ? 'bad' : 'warn', text: 'Move to the left: the right side is closer to you' });
  if (!(level && level.available)) {
    const tb = top / bottom;
    if (tb > 1.06) tips.push({ level: tb > 1.15 ? 'bad' : 'warn', text: 'Tilt the top of the phone toward you' });
    else if (tb < 1 / 1.06) tips.push({ level: tb < 1 / 1.15 ? 'bad' : 'warn', text: 'Tilt the top of the phone away from you' });
  }
  const status = tips.some(t => t.level === 'bad') ? 'bad' : tips.length ? 'warn' : 'good';
  return { status, tips };
}

// Tilt from the gravity reading (DeviceMotion accelerationIncludingGravity, which points up),
// turned into screen axes. pitch > 0: top of the phone leans away from you.
export function levelFromGravity(x, y, z, screenAngleDeg = 0) {
  const a = screenAngleDeg * DEG;
  const sx = x * Math.cos(a) - y * Math.sin(a);
  const sy = x * Math.sin(a) + y * Math.cos(a);
  const g = Math.hypot(sx, sy, z) || 1;
  const pitch = Math.asin(Math.max(-1, Math.min(1, z / g))) / DEG;
  if (Math.abs(pitch) > 55) {
    // Phone held flat over a panel lying down (or a ceiling): level means x and y are both ~0.
    const tiltX = Math.asin(Math.max(-1, Math.min(1, sx / g))) / DEG;
    const tiltY = Math.asin(Math.max(-1, Math.min(1, sy / g))) / DEG;
    return { available: true, flat: true, pitch: Math.hypot(tiltX, tiltY), roll: 0, bubble: [tiltX, -tiltY] };
  }
  const roll = Math.atan2(-sx, sy) / DEG;   // > 0: phone turned clockwise
  return { available: true, flat: false, pitch, roll, bubble: [roll, -pitch] };
}
