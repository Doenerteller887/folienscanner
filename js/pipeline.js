// Verbindet Erkennung, Folienwechsel-Logik und Entzerrung zu einem Ablauf.
// Wird von der App (Kamera / Video) und vom synthetischen Test gleichermaßen benutzt.
//
// Koordinaten: Alle Vierecke (erkannt, fixiert, angetippt) sind normiert (0..1) bezogen auf
// den sichtbaren Ausschnitt („Ansicht“). Ohne digitalen Zoom ist das das ganze Kamerabild.

import { SlideDetector, QuadTracker } from './detector.js';
import { estimateAspect, resolveAspect, warp, sharpness, enhance, DEFAULT_FOCAL } from './rectify.js';
import { ChangeDetector, makeSignature, SIG_W, SIG_H } from './change.js';

export const FULL_FRAME = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
const ANALYSIS_W = 640;  // Breite des Analysebilds für die Erkennung
const SIG_SRC_MAX = 400; // Folienausschnitt für die Signatur: erst sauber auf ≤ 400 px verkleinern
const FOCUS_TIMEOUT_MS = 4000;

export const PIPELINE_DEFAULTS = {
  sensitivity: 6,
  stableSec: 1.2,
  merge: true,
  skipDuplicates: true,
  filter: 'enhanced',
  aspect: 'auto',
  outWidth: 1600,
};

const centroid = (q) => ({ x: q.reduce((s, p) => s + p.x, 0) / 4, y: q.reduce((s, p) => s + p.y, 0) / 4 });

export class Pipeline {
  constructor(cv, settings = {}) {
    this.cv = cv;
    this.detector = new SlideDetector(cv);
    this.tracker = new QuadTracker();
    this.change = new ChangeDetector();
    this.aCanvas = document.createElement('canvas');
    this.aCtx = this.aCanvas.getContext('2d', { willReadFrequently: true });
    this.sCanvas = document.createElement('canvas');
    this.sCtx = this.sCanvas.getContext('2d', { willReadFrequently: true });
    this.fCanvas = document.createElement('canvas');
    this.fCtx = this.fCanvas.getContext('2d', { willReadFrequently: true });
    // Hochwertiges Verkleinern (sonst Treppeneffekte, die wie „Bewegung“ aussehen)
    for (const ctx of [this.aCtx, this.sCtx]) ctx.imageSmoothingQuality = 'high';
    this.locked = null;
    this.best = null;
    this.lastQuad = null;
    this.lastSig = null;
    this.rotation = 0;   // Lage des Handys (0/90/180/270) oder null = unbekannt
    this.focus = null;   // angetippter Punkt (normiert in der Ansicht)
    this.focusSeen = 0;
    this.digitalZoom = 1;
    this.opticalZoom = 1; // Kamera-Zoom des Geräts (für die erwartete Brennweite)
    this.setSettings(settings);
  }

  setSettings(s) {
    this.settings = { ...PIPELINE_DEFAULTS, ...(this.settings || {}), ...s };
    const st = this.settings;
    this.change.setOptions({
      sensitivity: st.sensitivity,
      stableMs: st.stableSec * 1000,
      merge: st.merge,
      skipDuplicates: st.skipDuplicates,
    });
  }

  reset() {
    this.tracker.reset();
    this.tracker.refScore = 0;
    this.change.reset();
    this._dropBest();
    this.lastQuad = null;
    this.lastSig = null;
    this.focus = null;
  }

  lock(quad) {
    this.locked = quad ? quad.map((p) => ({ x: p.x, y: p.y })) : null;
    if (!quad) this.tracker.reset();
  }

  setRotation(r) {
    if (r === this.rotation) return;
    this.rotation = r;
    this.tracker.reset(); // Ecken-Reihenfolge ändert sich → neu erfassen
  }

  // Nutzer hat auf die Folie getippt: nur noch Kandidaten an dieser Stelle.
  setFocus(pt, now = performance.now()) {
    this.focus = pt ? { x: pt.x, y: pt.y } : null;
    this.focusSeen = now;
    this.tracker.reset();
    this.tracker.refScore = 0;
  }

  // Digitaler Zoom (nur wenn die Kamera selbst nicht zoomen kann): mittiger Ausschnitt.
  setDigitalZoom(z) {
    this.digitalZoom = Math.max(1, z);
  }

  get crop() {
    const s = 1 / this.digitalZoom;
    return { x: (1 - s) / 2, y: (1 - s) / 2, w: s, h: s };
  }

  // Ansicht (normiert) → Pixel im Quellbild
  toSrc(q, w, h) {
    const c = this.crop;
    return q.map((p) => ({ x: (c.x + p.x * c.w) * w, y: (c.y + p.y * c.h) * h }));
  }

  // Umschließendes Rechteck eines Vierecks (Quellpixel) mit etwas Rand
  _bbox(qSrc, w, h, pad = 0.03) {
    const xs = qSrc.map((p) => p.x), ys = qSrc.map((p) => p.y);
    const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - bw * pad));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - bh * pad));
    const x1 = Math.min(w, Math.ceil(Math.max(...xs) + bw * pad));
    const y1 = Math.min(h, Math.ceil(Math.max(...ys) + bh * pad));
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  _dropBest() {
    if (this.best?.bitmap?.close) this.best.bitmap.close();
    this.best = null;
  }

  // Verkleinertes Analysebild der aktuellen Ansicht als OpenCV-Mat (Aufrufer gibt es frei).
  _analysisMat(source, w, h) {
    const c = this.crop;
    const cw = c.w * w, ch = c.h * h;
    const aw = ANALYSIS_W, ah = Math.round((ch * aw) / cw);
    if (this.aCanvas.width !== aw || this.aCanvas.height !== ah) {
      this.aCanvas.width = aw;
      this.aCanvas.height = ah;
      this.aCtx.imageSmoothingQuality = 'high';
    }
    this.aCtx.drawImage(source, c.x * w, c.y * h, cw, ch, 0, 0, aw, ah);
    return this.cv.matFromImageData(this.aCtx.getImageData(0, 0, aw, ah));
  }

  _detect(mat) {
    return this.detector.detect(mat, {
      prior: this.tracker.quad, rotation: this.rotation, focus: this.focus,
      focal: DEFAULT_FOCAL * this.opticalZoom * this.digitalZoom,
    });
  }

  // Ein Analyseschritt. source: Video, Canvas oder Bitmap in Originalgröße w×h.
  async analyze(source, w, h, now, { auto = true } = {}) {
    const mat = this._analysisMat(source, w, h);
    let quad = null, quadState = 'none';
    try {
      if (this.locked) {
        quad = this.locked;
        quadState = 'locked';
      } else {
        const det = this._detect(mat);
        const tr = this.tracker.update(det ? det.quad : null, now, det ? det.score : 0);
        if (tr) {
          quad = tr.quad;
          quadState = tr.held ? 'held' : tr.stable ? 'stable' : 'unstable';
        }
        // Angetippte Folie mitverfolgen; ist sie länger weg, wieder automatisch suchen.
        if (this.focus) {
          if (det && quadState === 'stable') { this.focus = centroid(quad); this.focusSeen = now; }
          else if (now - this.focusSeen > FOCUS_TIMEOUT_MS) this.focus = null;
        }
      }
    } finally {
      mat.delete();
    }
    this.lastQuad = quad;
    this.lastQuadState = quadState;

    if (!quad || quadState === 'unstable') {
      if (auto) this.change.tick(null, now);
      this._dropBest();
      this.lastSig = null;
      return { quad, quadState, status: quad ? 'tracking' : 'search' };
    }

    const qSrc = this.toSrc(quad, w, h);
    const { sig, sharp } = this._signature(source, w, h, qSrc);
    this.lastSig = sig;
    if (this._rebase) {
      this.change.setReference(sig);
      this._rebase = false;
    }
    if (!auto) return { quad, quadState, status: 'paused' };

    const res = this.change.tick(sig, now);
    if (res.restart) this._dropBest();
    if (this.change.state === 'candidate' || res.event) {
      if (!this.best || sharp > this.best.sharp) {
        // Ganzes Bild behalten: Es wird mitgespeichert, damit sich der Ausschnitt später korrigieren lässt.
        const bitmap = await createImageBitmap(source);
        this._dropBest();
        this.best = { sharp, bitmap, qSrc, w, h };
      }
    }
    if (res.event) {
      const b = this.best;
      res.event.image = this._renderRegion(b.bitmap, b.qSrc, b.w, b.h);
      res.event.frame = b.bitmap; // Aufrufer gibt es frei
      res.event.quad = normQuad(b.qSrc, b.w, b.h);
      res.event.zoom = this.opticalZoom;
      res.event.sig = sig;
      this.best = null;
    }
    return { quad, quadState, ...res };
  }

  // Signatur aus dem Folienausschnitt in guter Auflösung (auch bei kleinen, weit entfernten Folien).
  _signature(source, w, h, qSrc) {
    const cv = this.cv;
    const box = this._bbox(qSrc, w, h);
    const s = Math.min(1, SIG_SRC_MAX / Math.max(box.w, box.h));
    const sw = Math.max(1, Math.round(box.w * s)), sh = Math.max(1, Math.round(box.h * s));
    if (this.sCanvas.width !== sw || this.sCanvas.height !== sh) {
      this.sCanvas.width = sw;
      this.sCanvas.height = sh;
      this.sCtx.imageSmoothingQuality = 'high';
    }
    this.sCtx.drawImage(source, box.x, box.y, box.w, box.h, 0, 0, sw, sh);
    const mat = cv.matFromImageData(this.sCtx.getImageData(0, 0, sw, sh));
    // 2 % Rand nach innen: Am äußersten Folienrand würde schon ein Bruchteil eines Pixels
    // Rahmenverschiebung Leinwand ins Bild holen und wie eine Änderung aussehen.
    const c = centroid(qSrc);
    const q = qSrc.map((p) => ({
      x: (c.x + (p.x - c.x) * 0.96 - box.x) * s,
      y: (c.y + (p.y - c.y) * 0.96 - box.y) * s,
    }));
    const small = warp(cv, mat, q, SIG_W * 2, SIG_H * 2);
    const gray = new cv.Mat(), sigMat = new cv.Mat();
    try {
      cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
      const sharp = sharpness(cv, gray);
      cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
      cv.resize(gray, sigMat, new cv.Size(SIG_W, SIG_H), 0, 0, cv.INTER_AREA);
      return { sig: makeSignature(new Uint8Array(sigMat.data)), sharp };
    } finally {
      mat.delete(); small.delete(); gray.delete(); sigMat.delete();
    }
  }

  // Entzerrt einen Folienausschnitt. source: ganzes Bild (w×h), qSrc: Ecken in dessen Pixeln.
  // opts: zoom (Kamera-Zoom bei der Aufnahme), outWidth (für kleine Vorschauen).
  _renderRegion(source, qSrc, w, h, { zoom = this.opticalZoom, outWidth } = {}) {
    const cv = this.cv;
    const st = this.settings;
    const box = this._bbox(qSrc, w, h, 0.01);
    this.fCanvas.width = box.w;
    this.fCanvas.height = box.h;
    this.fCtx.drawImage(source, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    const src = cv.matFromImageData(this.fCtx.getImageData(0, 0, box.w, box.h));
    const q = qSrc.map((p) => ({ x: p.x - box.x, y: p.y - box.y }));
    // Seitenverhältnis aus der Perspektive im ganzen Bild (Bildmitte = optische Achse)
    const aspect = resolveAspect(st.aspect, estimateAspect(qSrc, w, h, DEFAULT_FOCAL * zoom * Math.max(w, h)));
    const long = outWidth || st.outWidth; // lange Seite (auch bei hochkant gedrehten Folien)
    const outW = aspect >= 1 ? long : Math.round(long * aspect);
    const outH = aspect >= 1 ? Math.round(long / aspect) : long;
    const warped = warp(cv, src, q, outW, outH);
    const out = enhance(cv, warped, st.filter);
    const canvas = document.createElement('canvas');
    cv.imshow(canvas, out);
    src.delete(); warped.delete(); out.delete();
    return { canvas, width: outW, height: outH, aspect };
  }

  // Entzerrt direkt aus einem Vollbild (Video/Canvas) mit einem Ansichts-Viereck.
  render(source, w, h, quad) {
    return this._renderRegion(source, this.toSrc(quad, w, h), w, h);
  }

  // Entzerrt aus einem gespeicherten Originalfoto (quad normiert aufs ganze Foto).
  renderFromFrame(img, w, h, quad, opts) {
    return this._renderRegion(img, quad.map((p) => ({ x: p.x * w, y: p.y * h })), w, h, opts);
  }

  // Sucht die Folie in einem einzelnen Standbild (ganzes Bild w×h).
  // Liefert die Ecken normiert aufs ganze Bild und woher sie stammen.
  detectFrame(source, w, h) {
    if (this.locked) return { quad: normQuad(this.toSrc(this.locked, w, h), w, h), how: 'locked' };
    const mat = this._analysisMat(source, w, h);
    let det = null;
    try { det = this._detect(mat); } finally { mat.delete(); }
    const view = det?.quad || this.lastQuad;
    if (!view) return { quad: normQuad(this.toSrc(FULL_FRAME, w, h), w, h), how: 'full' };
    return { quad: normQuad(this.toSrc(view, w, h), w, h), how: det ? 'detected' : 'last' };
  }

  // Folie in einem gespeicherten Foto suchen – unabhängig vom laufenden Scan (kein Zoom-Ausschnitt,
  // kein fixierter Rahmen). Liefert die Ecken normiert aufs Foto oder null.
  detectInImage(img, w, h, zoom = 1) {
    const aw = ANALYSIS_W, ah = Math.round((h * aw) / w);
    const c = document.createElement('canvas');
    c.width = aw;
    c.height = ah;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, aw, ah);
    const mat = this.cv.matFromImageData(ctx.getImageData(0, 0, aw, ah));
    try {
      const det = this.detector.detect(mat, { rotation: null, focal: DEFAULT_FOCAL * zoom });
      return det ? det.quad.map((p) => ({ x: p.x, y: p.y })) : null;
    } finally {
      mat.delete();
    }
  }

  // Manuelle Aufnahme: erst das Foto festhalten, dann darin die Folie suchen und ausschneiden.
  captureStill(source, w, h) {
    const frame = document.createElement('canvas');
    frame.width = w;
    frame.height = h;
    frame.getContext('2d').drawImage(source, 0, 0, w, h);
    const { quad, how } = this.detectFrame(frame, w, h);
    const image = this.renderFromFrame(frame, w, h, quad);
    if (this.lastSig) this.change.setReference(this.lastSig);
    return { image, frame, quad, how, zoom: this.opticalZoom };
  }
}

function normQuad(qSrc, w, h) {
  return qSrc.map((p) => ({ x: p.x / w, y: p.y / h }));
}
