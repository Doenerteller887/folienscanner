// Perspektivkorrektur, Seitenverhältnis-Schätzung und Bildverbesserung.

export const RATIOS = { '16:9': 16 / 9, '16:10': 16 / 10, '4:3': 4 / 3 };

function sideRatio(q) {
  const [tl, tr, br, bl] = q;
  const w = (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2;
  const h = (Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y)) / 2;
  return w / h;
}

// Echtes Seitenverhältnis eines perspektivisch verzerrten Rechtecks
// (Zhang & He, „Whiteboard scanning and image enhancement“), Bildmitte als Hauptpunkt.
// qPx: Ecken in Pixeln (tl, tr, br, bl), W/H: Bildgröße in denselben Pixeln.
// fHint: erwartete Brennweite in denselben Pixeln (Handy-Hauptkamera ≈ 0,85 × lange Bildseite,
// bei Zoom entsprechend mehr). Die aus den Ecken geschätzte Brennweite ist bei starker
// Schräglage und ungenauen Ecken instabil – passt sie nicht zur erwarteten, gilt fHint.
// Rückgabe: { aspect, ok } – ok = true, wenn die Ecken selbst eine plausible Perspektive ergeben.
export const DEFAULT_FOCAL = 0.85;
export function aspectInfo(qPx, W, H, fHint = DEFAULT_FOCAL * Math.max(W, H)) {
  const fallback = { aspect: sideRatio(qPx), ok: false };
  const u0 = W / 2, v0 = H / 2;
  const [tl, tr, br, bl] = qPx;
  const m1 = [tl.x - u0, tl.y - v0, 1], m2 = [tr.x - u0, tr.y - v0, 1];
  const m3 = [bl.x - u0, bl.y - v0, 1], m4 = [br.x - u0, br.y - v0, 1];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c14 = cross(m1, m4);
  const k2 = dot(c14, m3) / dot(cross(m2, m4), m3);
  const k3 = dot(c14, m2) / dot(cross(m3, m4), m2);
  if (!isFinite(k2) || !isFinite(k3)) return fallback;
  if (Math.abs(k2 - 1) < 0.01 && Math.abs(k3 - 1) < 0.01) return { aspect: fallback.aspect, ok: true }; // frontal
  const n2 = m2.map((v, i) => k2 * v - m1[i]);
  const n3 = m3.map((v, i) => k3 * v - m1[i]);
  const f2est = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
  const plausible = f2est > 0 && Math.sqrt(f2est) > 0.75 * fHint && Math.sqrt(f2est) < 2.5 * fHint;
  const f2 = plausible ? f2est : fHint * fHint;
  const r = Math.sqrt((n2[0] ** 2 + n2[1] ** 2) / f2 + n2[2] ** 2) /
            Math.sqrt((n3[0] ** 2 + n3[1] ** 2) / f2 + n3[2] ** 2);
  return isFinite(r) && r > 0.25 && r < 4 ? { aspect: r, ok: plausible } : fallback;
}

export function estimateAspect(qPx, W, H, fHint) {
  const { aspect } = aspectInfo(qPx, W, H, fHint);
  return aspect > 0.8 && aspect < 3 ? aspect : sideRatio(qPx);
}

// Einstellung „auto“: Beamer-Bilder haben praktisch immer ein Standardformat → immer auf das
// nächstliegende einrasten (eine verdeckte Kante verfälscht die Schätzung sonst sichtbar).
// Deutlich hochkant (z. B. im Editor gedreht): dasselbe Format hochkant.
export function resolveAspect(setting, estimated) {
  if (estimated < 0.8) return 1 / resolveAspect(setting, 1 / estimated);
  if (RATIOS[setting]) return RATIOS[setting];
  let best = null, bestErr = Infinity;
  for (const r of Object.values(RATIOS)) {
    const err = Math.abs(Math.log(estimated / r));
    if (err < bestErr) { bestErr = err; best = r; }
  }
  return best;
}

export function warp(cv, src, qPx, outW, outH, interp) {
  const [tl, tr, br, bl] = qPx;
  const s = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const d = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
  const M = cv.getPerspectiveTransform(s, d);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), interp ?? cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
  s.delete(); d.delete(); M.delete();
  return dst;
}

export function sharpness(cv, gray) {
  const lap = new cv.Mat(), mean = new cv.Mat(), std = new cv.Mat();
  cv.Laplacian(gray, lap, cv.CV_64F);
  cv.meanStdDev(lap, mean, std);
  const s = std.data64F[0];
  lap.delete(); mean.delete(); std.delete();
  return s * s;
}

function percentile(hist, total, p) {
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return 255;
}

// Tonwertkorrektur + Weißabgleich direkt auf den RGBA-Daten.
function levels(rgba, { whiteBalance }) {
  const data = rgba.data;
  const n = data.length / 4;
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    hist[(data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8]++;
  }
  const lo = percentile(hist, n, 0.005);
  const hi = percentile(hist, n, 0.995);
  if (hi - lo < 40) return; // fast einfarbig – nichts verstärken
  let gains = [1, 1, 1];
  if (whiteBalance) {
    const top = percentile(hist, n, 0.98);
    let r = 0, g = 0, b = 0, c = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (((data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8) >= top) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; c++;
      }
    }
    if (c) {
      r /= c; g /= c; b /= c;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      // Nur korrigieren, wenn das Hellste annähernd neutral ist (Projektor-Farbstich, keine farbige Folie).
      if (mn / mx > 0.75) gains = [mx / r, mx / g, mx / b];
    }
  }
  const scale = Math.min(3, 255 / (hi - lo));
  const luts = gains.map((gain) => {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = (v * gain - lo) * scale;
    return lut;
  });
  const [lr, lg, lb] = luts;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lr[data[i]];
    data[i + 1] = lg[data[i + 1]];
    data[i + 2] = lb[data[i + 2]];
  }
}

function clahe(cv, gray, clip) {
  if (typeof cv.CLAHE !== 'function') return;
  const c = new cv.CLAHE(clip, new cv.Size(8, 8));
  c.apply(gray, gray);
  c.delete();
}

function unsharp(cv, m, amount) {
  const blur = new cv.Mat();
  cv.GaussianBlur(m, blur, new cv.Size(0, 0), 1.2);
  cv.addWeighted(m, 1 + amount, blur, -amount, 0, m);
  blur.delete();
}

// Gibt ein neues RGBA-Mat zurück; `src` bleibt unverändert.
export function enhance(cv, src, mode) {
  const out = src.clone();
  if (mode === 'original') return out;
  if (mode === 'gray') {
    const g = new cv.Mat();
    cv.cvtColor(out, g, cv.COLOR_RGBA2GRAY);
    cv.normalize(g, g, 0, 255, cv.NORM_MINMAX);
    clahe(cv, g, 2.0);
    unsharp(cv, g, 0.6);
    cv.cvtColor(g, out, cv.COLOR_GRAY2RGBA);
    g.delete();
    return out;
  }
  // „Verbessert“
  levels(out, { whiteBalance: true });
  const rgb = new cv.Mat(), lab = new cv.Mat(), ch = new cv.MatVector();
  try {
    cv.cvtColor(out, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    cv.split(lab, ch);
    const L = ch.get(0);
    clahe(cv, L, 1.6);
    ch.set(0, L);
    L.delete();
    cv.merge(ch, lab);
    cv.cvtColor(lab, rgb, cv.COLOR_Lab2RGB);
    unsharp(cv, rgb, 0.5);
    cv.cvtColor(rgb, out, cv.COLOR_RGB2RGBA);
  } finally {
    rgb.delete(); lab.delete(); ch.delete();
  }
  return out;
}
