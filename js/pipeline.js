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

  // Ein Analyseschritt. source: Video, Canvas oder Bitmap in Originalgröße w×h.
  async analyze(source, w, h, now, { auto = true } = {}) {
    const cv = this.cv;
    const c = this.crop;
    const cw = c.w * w, ch = c.h * h;
    const aw = ANALYSIS_W, ah = Math.round((ch * aw) / cw);
    if (this.aCanvas.width !== aw || this.aCanvas.height !== ah) {
      this.aCanvas.width = aw;
      this.aCanvas.height = ah;
      this.aCtx.imageSmoothingQuality = 'high';
    }
    this.aCtx.drawImage(source, c.x * w, c.y * h, cw, ch, 0, 0, aw, ah);
    const mat = cv.matFromImageData(this.aCtx.getImageData(0, 0, aw, ah));
    let quad = null, quadState = 'none';
    try {
      if (this.locked) {
        quad = this.locked;
        quadState = 'locked';
      } else {
        const det = this.detector.detect(mat, {
          prior: this.tracker.quad, rotation: this.rotation, focus: this.focus,
          focal: DEFAULT_FOCAL * this.opticalZoom * this.digitalZoom,
        });
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
        const box = this._bbox(qSrc, w, h);
        const bitmap = await createImageBitmap(source, box.x, box.y, box.w, box.h);
        this._dropBest();
        this.best = { sharp, bitmap, box, qSrc, w, h };
      }
    }
    if (res.event) {
      const b = this.best;
      res.event.image = this._renderRegion(b.bitmap, b.box, b.qSrc, b.w, b.h);
      res.event.sig = sig;
      this._dropBest();
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

  // Entzerrt den Folienausschnitt (region = Bild des Rechtecks `box` aus dem Quellbild).
  _renderRegion(region, box, qSrc, w, h) {
    const cv = this.cv;
    const st = this.settings;
    this.fCanvas.width = box.w;
    this.fCanvas.height = box.h;
    this.fCtx.drawImage(region, 0, 0, box.w, box.h);
    const src = cv.matFromImageData(this.fCtx.getImageData(0, 0, box.w, box.h));
    const q = qSrc.map((p) => ({ x: p.x - box.x, y: p.y - box.y }));
    // Seitenverhältnis aus der Perspektive im ganzen Bild (Bildmitte = optische Achse)
    const aspect = resolveAspect(st.aspect, estimateAspect(qSrc, w, h, DEFAULT_FOCAL * this.opticalZoom * Math.max(w, h)));
    const outW = st.outWidth, outH = Math.round(outW / aspect);
    const warped = warp(cv, src, q, outW, outH);
    const out = enhance(cv, warped, st.filter);
    const canvas = document.createElement('canvas');
    cv.imshow(canvas, out);
    src.delete(); warped.delete(); out.delete();
    return { canvas, width: outW, height: outH, aspect };
  }

  // Entzerrt direkt aus einem Vollbild (Video/Canvas) mit einem Ansichts-Viereck.
  render(source, w, h, quad) {
    const qSrc = this.toSrc(quad, w, h);
    const box = this._bbox(qSrc, w, h, 0.01);
    this.sCanvas.width = box.w;
    this.sCanvas.height = box.h;
    this.sCtx.drawImage(source, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    return this._renderRegion(this.sCanvas, box, qSrc, w, h);
  }

  // Manuelle Aufnahme mit dem aktuellen Rahmen (oder der ganzen Ansicht).
  captureNow(source, w, h) {
    const quad = this.locked || this.lastQuad || FULL_FRAME;
    const image = this.render(source, w, h, quad);
    image.fullFrame = !this.locked && !this.lastQuad;
    if (this.lastSig) this.change.setReference(this.lastSig);
    return image;
  }
}
