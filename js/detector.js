import { aspectInfo } from './rectify.js';

// Folienerkennung: findet das projizierte Folien-Viereck im Kamerabild.
// Alle Vierecke werden normiert (0..1) und in der Reihenfolge
// oben links, oben rechts, unten rechts, unten links zurückgegeben.

export function orderCorners(pts) {
  let tl = pts[0], tr = pts[0], br = pts[0], bl = pts[0];
  for (const p of pts) {
    if (p.x + p.y < tl.x + tl.y) tl = p;
    if (p.x + p.y > br.x + br.y) br = p;
    if (p.x - p.y > tr.x - tr.y) tr = p;
    if (p.x - p.y < bl.x - bl.y) bl = p;
  }
  return [tl, tr, br, bl].map((p) => ({ x: p.x, y: p.y }));
}

export function polyArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i], n = q[(i + 1) % q.length];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

// Mittlerer Eckenabstand zweier normierter Vierecke.
export function quadDist(a, b) {
  let d = 0;
  for (let i = 0; i < 4; i++) d += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
  return d / 4;
}

export function scaleQuad(q, w, h) {
  return q.map((p) => ({ x: p.x * w, y: p.y * h }));
}

function interiorAnglesOk(q) {
  for (let i = 0; i < 4; i++) {
    const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
    const v1x = p.x - c.x, v1y = p.y - c.y, v2x = n.x - c.x, v2y = n.y - c.y;
    const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) + 1e-9);
    const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (deg < 50 || deg > 130) return false;
  }
  return true;
}

function matToPts(m) {
  const d = m.data32S, pts = [];
  for (let i = 0; i < m.rows; i++) pts.push({ x: d[i * 2], y: d[i * 2 + 1] });
  return pts;
}

// Ecken-Reihenfolge an die Lage des Handys anpassen. rotation = Winkel (0/90/180/270),
// um den das Bild gegenüber der Welt gedreht ist (z. B. 90: Handy quer, Anzeige hochkant
// gesperrt → „oben“ der Folie liegt im Bild rechts).
export function rotateCorners(q, rotation) {
  const k = ((Math.round((rotation || 0) / 90) % 4) + 4) % 4;
  return [0, 1, 2, 3].map((i) => q[(i + k) % 4]);
}

function quadSides(q) {
  const w = (Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / 2;
  const h = (Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y) + Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y)) / 2;
  return { w, h };
}

export function pointInQuad(q, p) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const c = Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    if (c === 0) continue;
    if (sign && c !== sign) return false;
    sign = c;
  }
  return true;
}

// Winkel in Grad zwischen den Strecken a1→a2 und b1→b2 (ohne Richtung).
function angleBetween(a1, a2, b1, b2) {
  const d = Math.abs(Math.atan2(a2.y - a1.y, a2.x - a1.x) - Math.atan2(b2.y - b1.y, b2.x - b1.x)) % Math.PI;
  return (Math.min(d, Math.PI - d) * 180) / Math.PI;
}

function scaleAround(q, f) {
  const cx = q.reduce((s, p) => s + p.x, 0) / 4, cy = q.reduce((s, p) => s + p.y, 0) / 4;
  return q.map((p) => ({ x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f }));
}

export class SlideDetector {
  constructor(cv) {
    this.cv = cv;
    this.minArea = 0.008;
  }

  // rgba: cv.Mat (CV_8UC4) des verkleinerten Analysebilds.
  // opts.prior:    zuletzt verfolgtes Viereck (normiert) – ähnliche Kandidaten werden bevorzugt
  // opts.rotation: Lage des Handys (0/90/180/270) oder null = unbekannt (dann nach Form raten)
  // opts.focus:    vom Nutzer angetippter Punkt (normiert) – nur Kandidaten, die ihn enthalten
  // opts.focal:    erwartete Brennweite relativ zur langen Bildseite (Zoom eingerechnet)
  detect(rgba, { prior = null, rotation = 0, focus = null, focal = 0.85 } = {}) {
    const cv = this.cv;
    const W = rgba.cols, H = rgba.rows;
    const gray = new cv.Mat(), blur = new cv.Mat(), bin = new cv.Mat(), edges = new cv.Mat(), canny = new cv.Mat();
    const cands = [];
    // Kleine Mindestgröße, damit auch weit entfernte Folien gefunden werden;
    // Fehltreffer fängt die Bewertung (Kontrast, Inhalt, Bildrand) ab.
    this.minArea = focus ? 0.003 : 0.008;
    try {
      // Hellster Farbkanal statt Graustufen: projizierte Farbflächen (z. B. ein dunkelblauer
      // Titelbalken) heben sich so klar von der neutral grauen Leinwand ab.
      const ch = new cv.MatVector();
      cv.split(rgba, ch);
      const r = ch.get(0), g = ch.get(1), b = ch.get(2);
      cv.max(r, g, gray);
      cv.max(gray, b, gray);
      r.delete(); g.delete(); b.delete(); ch.delete();
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

      // Weg A: die Projektion ist meist die hellste Fläche im Raum.
      cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      const k = Math.max(5, Math.round(Math.min(W, H) / 40)) | 1;
      const kClose = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k));
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kClose);
      kClose.delete();
      const ctx = { W, H, rotation, f: focal * Math.max(W, H) };
      this._collect(bin, cv.RETR_EXTERNAL, ctx, 'hell', cands);

      // Weg B: Kanten (für helle Räume und dunkle Folien).
      cv.Canny(blur, canny, 30, 90);
      const kDil = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      cv.dilate(canny, edges, kDil);
      kDil.delete();
      this._collect(edges, cv.RETR_LIST, ctx, 'kante', cands);

      let pool = cands;
      if (focus) {
        const fp = { x: focus.x * W, y: focus.y * H };
        pool = cands.filter((c) => pointInQuad(c.img, fp));
      }
      if (!pool.length) { this.lastCandidates = []; return null; }
      pool.sort((a, b) => b.score - a.score);
      const top = pool.slice(0, 6);
      for (const c of top) {
        c.contrast = this._contrastFactor(gray, c.img);
        c.content = this._contentFactor(canny, gray, c.img);
        c.score *= c.contrast * c.content;
        if (prior && quadDist(c.px.map((p) => ({ x: p.x / W, y: p.y / H })), prior) < 0.03) c.score *= 1.3;
      }
      // Mindestanforderungen: deutliche Kante (Beamer fügt Licht hinzu) und fast quadratische
      // Flächen (Wandpaneele, Türen) nur bei sehr klarer Kante.
      const valid = top
        .filter((c) => c.score > 0 && c.contrast >= 0.2 && (c.trueAspect >= 1.15 || c.contrast >= 0.5))
        .sort((a, b) => b.score - a.score);
      this.lastCandidates = valid; // für Fehlersuche
      if (!valid.length) return null;
      const best = valid[0];
      return {
        quad: best.px.map((p) => ({ x: p.x / W, y: p.y / H })),
        score: best.score,
        source: best.source,
      };
    } finally {
      gray.delete(); blur.delete(); bin.delete(); edges.delete(); canny.delete();
    }
  }

  _collect(binary, mode, ctx, source, out) {
    const cv = this.cv;
    const contours = new cv.MatVector(), hier = new cv.Mat();
    const frameArea = ctx.W * ctx.H;
    try {
      cv.findContours(binary, contours, hier, mode, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const area = cv.contourArea(c);
        if (area >= this.minArea * frameArea) {
          const cand = this._quadFromContour(c, area, ctx);
          if (cand) out.push({ ...cand, source });
        }
        c.delete();
      }
    } finally {
      contours.delete(); hier.delete();
    }
  }

  _quadFromContour(c, area, { W, H, rotation, f }) {
    const cv = this.cv;
    const hull = new cv.Mat();
    let pts = null, hullArea = 0;
    try {
      cv.convexHull(c, hull, false, true);
      hullArea = cv.contourArea(hull);
      const peri = cv.arcLength(hull, true);
      for (const eps of [0.02, 0.035, 0.05]) {
        const approx = new cv.Mat();
        cv.approxPolyDP(hull, approx, eps * peri, true);
        if (approx.rows === 4) pts = matToPts(approx);
        approx.delete();
        if (pts) break;
      }
      // Ersatz: Extrempunkte der Hülle (robust, wenn z. B. eine Person eine Ecke verdeckt).
      if (!pts) pts = matToPts(hull);
    } finally {
      hull.delete();
    }
    const img = orderCorners(pts); // Reihenfolge im Bild
    if (!isConvex(img) || !interiorAnglesOk(img)) return this._reject('winkel', img);
    const qArea = polyArea(img);
    const areaFrac = qArea / (W * H);
    if (areaFrac < this.minArea || areaFrac > 0.985) return this._reject('fläche', img);
    const fit = hullArea / qArea;
    if (fit < 0.8 || fit > 1.2) return this._reject('fit', img);
    const fill = area / qArea;
    if (fill < 0.55) return this._reject('füllung', img);
    // Eine Folie, die über den Bildrand ragt, ist nicht vollständig im Bild → verwerfen.
    const m = 0.012 * Math.max(W, H);
    const onBorder = img.filter((p) => p.x < m || p.y < m || p.x > W - 1 - m || p.y > H - 1 - m).length;
    if (onBorder >= 2) return this._reject('rand', img);
    // Lage berücksichtigen: Folien sind immer quer. Bei unbekannter Lage die Deutung nehmen,
    // bei der das (perspektivisch korrigierte) Format breiter ist.
    let rot = rotation;
    if (rot == null) {
      const a0 = aspectInfo(rotateCorners(img, 0), W, H, f).aspect;
      const a90 = aspectInfo(rotateCorners(img, 90), W, H, f).aspect;
      rot = a90 > a0 ? 90 : 0;
    }
    const q = rotateCorners(img, rot);
    // Format: Von der Seite gesehen wirkt eine Folie schmal (scheinbares Verhältnis klein),
    // entscheidend ist das echte Verhältnis nach Herausrechnen der Perspektive.
    const { w, h } = quadSides(q);
    if (w / h < 0.3 || w / h > 3.5) return this._reject('format', img);
    const info = aspectInfo(q, W, H, f);
    if (info.aspect < 0.85 || info.aspect > 2.8) return this._reject('format', img);
    // Gegenüberliegende Kanten: stark schief nur, wenn es eine plausible Perspektive ist.
    const skew = Math.max(
      angleBetween(img[0], img[1], img[3], img[2]),
      angleBetween(img[0], img[3], img[1], img[2]),
    );
    if (skew > (info.ok ? 55 : 30)) return this._reject('schief', img);
    // Gegenüberliegende Kanten dürfen perspektivisch verkürzt sein, aber nicht extrem
    // (Verhältnis < 0,45 entspräche einem Blick fast genau von der Seite).
    const len = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const ratioLR = Math.min(len(img[0], img[3]), len(img[1], img[2])) / Math.max(len(img[0], img[3]), len(img[1], img[2]));
    const ratioTB = Math.min(len(img[0], img[1]), len(img[3], img[2])) / Math.max(len(img[0], img[1]), len(img[3], img[2]));
    if (Math.min(ratioLR, ratioTB) < 0.45) return this._reject('verkürzt', img);
    let score = Math.pow(areaFrac, 0.35) * Math.min(fit, 1 / fit) * Math.min(fill, 1);
    if (!info.ok && skew > 15) score *= Math.max(0.2, 1 - (skew - 15) / 25);
    if (onBorder === 1) score *= 0.6;
    // Beamer-Bilder sind fast immer 4:3, 16:10 oder 16:9 → nahe Formate bevorzugen.
    const err = Math.min(...[4 / 3, 16 / 10, 16 / 9].map((r) => Math.abs(Math.log(info.aspect / r))));
    if (err > 0.08) score *= Math.max(0.6, 1 - (err - 0.08) * 1.8);
    return { px: q, img, score, trueAspect: info.aspect };
  }

  // Bevorzugt Vierecke mit deutlichem Hell-Dunkel-Sprung genau an ihrer Kante:
  // innen am Rand hell (Projektion), außen dunkler (Leinwand/Raum). So gewinnt das
  // projizierte Bild gegen eine größere, nur grau beleuchtete Leinwand.
  _contrastFactor(gray, q) {
    const cv = this.cv;
    const { sub, rect } = this._roi(gray, scaleAround(q, 1.07));
    const loc = (poly) => poly.map((p) => ({ x: p.x - rect.x, y: p.y - rect.y }));
    const mQ = this._mask(sub, loc(q)), mIn = this._mask(sub, loc(scaleAround(q, 0.93)));
    const mOut = this._mask(sub, loc(scaleAround(q, 1.07)));
    const ringIn = new cv.Mat(), ringOut = new cv.Mat();
    try {
      cv.subtract(mQ, mIn, ringIn);
      cv.subtract(mOut, mQ, ringOut);
      const inner = cv.mean(sub, ringIn)[0];
      const outer = cv.countNonZero(ringOut) > 20 ? cv.mean(sub, ringOut)[0] : inner;
      return Math.min(2, Math.max(0.05, (inner - outer) / 60));
    } finally {
      sub.delete(); mQ.delete(); mIn.delete(); mOut.delete(); ringIn.delete(); ringOut.delete();
    }
  }

  // Folien haben Inhalt (Text, Formeln, Grafiken). Leere helle Flächen – ein Blatt Papier,
  // eine weiße Wand, eine leere Tafel – haben kaum Kanten im Inneren und fallen heraus.
  // Kleiner Fließtext erzeugt in der Analyseauflösung kaum Kanten, aber Helligkeitsschwankung –
  // deshalb zählt beides.
  _contentFactor(canny, gray, q) {
    const cv = this.cv;
    const inner = scaleAround(q, 0.85);
    const { sub, rect } = this._roi(canny, inner);
    const gsub = gray.roi(rect);
    const mask = this._mask(sub, inner.map((p) => ({ x: p.x - rect.x, y: p.y - rect.y })));
    const inside = new cv.Mat(), mean = new cv.Mat(), std = new cv.Mat();
    try {
      const n = cv.countNonZero(mask);
      if (!n) return 0;
      cv.bitwise_and(sub, mask, inside);
      const density = cv.countNonZero(inside) / n;
      if (density >= 0.0025) return Math.min(1.25, Math.max(0.25, 0.25 + density / 0.015));
      cv.meanStdDev(gsub, mean, std, mask);
      return std.data64F[0] >= 8 ? 0.6 : 0; // sonst völlig leer → keine Folie
    } finally {
      sub.delete(); gsub.delete(); mask.delete(); inside.delete(); mean.delete(); std.delete();
    }
  }

  // Nur den Bildausschnitt rund um ein Viereck betrachten (schneller als ganze Masken).
  _roi(mat, poly) {
    const cv = this.cv;
    const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1), y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1);
    const x1 = Math.min(mat.cols, Math.ceil(Math.max(...xs)) + 2), y1 = Math.min(mat.rows, Math.ceil(Math.max(...ys)) + 2);
    const rect = new cv.Rect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    return { sub: mat.roi(rect), rect };
  }

  _reject(why, img) {
    if (this.debug) this.debug.push({ why, img });
    return null;
  }

  _mask(ref, poly) {
    const cv = this.cv;
    const m = cv.Mat.zeros(ref.rows, ref.cols, cv.CV_8UC1);
    const pts = cv.matFromArray(4, 1, cv.CV_32SC2, poly.flatMap((p) => [Math.round(p.x), Math.round(p.y)]));
    const vec = new cv.MatVector();
    vec.push_back(pts);
    cv.fillPoly(m, vec, new cv.Scalar(255));
    pts.delete(); vec.delete();
    return m;
  }
}

// Glättet die erkannten Ecken über die Zeit und hält den Rahmen kurz,
// wenn die Erkennung aussetzt (z. B. Dozent läuft vor der Leinwand).
export class QuadTracker {
  constructor({ holdMs = 2000, alpha = 0.35, jump = 0.04 } = {}) {
    this.holdMs = holdMs;
    this.alpha = alpha;
    this.jump = jump;
    this.refScore = 0; // übliche Erkennungsqualität, bleibt über reset() hinweg erhalten
    this.reset();
  }

  reset() {
    this.quad = null;
    this.lastSeen = 0;
    this.stableCount = 0;
    this.pending = null;
    this.pendingCount = 0;
  }

  // score: Bewertung der Erkennung. Deutlich schwächere Kandidaten als üblich werden
  // ignoriert (z. B. die leere Leinwand, wenn der Beamer kurz schwarz zeigt).
  update(q, now, score = 1) {
    if (q && this.refScore && score < this.refScore * 0.45) q = null;
    if (!q) this.refScore *= 0.999;
    if (!q) {
      if (this.quad && now - this.lastSeen < this.holdMs) {
        return { quad: this.quad, stable: this.stableCount >= 3, held: true };
      }
      this.reset();
      return null;
    }
    this.lastSeen = now;
    if (!this.quad) {
      this.quad = q;
      this.stableCount = 1;
      return { quad: this.quad, stable: false, held: false };
    }
    const dists = q.map((p, i) => Math.hypot(p.x - this.quad[i].x, p.y - this.quad[i].y));
    const moved = dists.filter((d) => d > this.jump).length;
    const still = dists.filter((d) => d < this.jump * 0.4).length;
    if (quadDist(q, this.quad) < this.jump) {
      const a = this.alpha;
      this.quad = this.quad.map((p, i) => ({ x: p.x + (q[i].x - p.x) * a, y: p.y + (q[i].y - p.y) * a }));
      this.stableCount++;
      if (this.stableCount >= 3) this.refScore = this.refScore ? this.refScore * 0.9 + score * 0.1 : score;
      this.pending = null;
      this.pendingCount = 0;
    } else if (this.stableCount >= 6 && moved <= 2 && still >= 2) {
      // Nur einzelne Ecken springen, der Rest bleibt: eher jemand vor der Leinwand
      // als eine Handybewegung → alten Rahmen behalten.
      return { quad: this.quad, stable: true, held: true };
    } else {
      // Großer Sprung: erst übernehmen, wenn er sich bestätigt.
      if (this.pending && quadDist(q, this.pending) < this.jump) this.pendingCount++;
      else { this.pending = q; this.pendingCount = 1; }
      if (this.pendingCount >= 2) {
        this.quad = q;
        this.stableCount = 1;
        this.pending = null;
        this.pendingCount = 0;
      }
    }
    return { quad: this.quad, stable: this.stableCount >= 3, held: false };
  }
}
