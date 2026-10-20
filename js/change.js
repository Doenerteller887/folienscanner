// Erkennt, wann eine neue Folie gezeigt wird.
// Arbeitet auf einer kleinen Graustufen-Signatur der bereits entzerrten Folie
// und kommt ohne OpenCV aus (direkt testbar).

export const SIG_W = 96, SIG_H = 60;
export const GRID_X = 16, GRID_Y = 10; // Zellen à 6×6 Pixel
const CELL_W = SIG_W / GRID_X, CELL_H = SIG_H / GRID_Y;
const CELLS = GRID_X * GRID_Y;

const CELL_T = 0.07;     // ab dieser mittleren Abweichung gilt eine Zelle als geändert …
const STD_T = 0.07;      // … oder wenn sich ihre Textur (Streuung) so stark ändert (neue Textzeile)
const BLANK_RANGE = 14;  // Helligkeitsumfang darunter = leeres/einfarbiges Bild
const DARK_HI = 70;      // nichts heller als das = Projektion aus/schwarz
const EMPTY_STD = 0.05;  // Zelle ohne Inhalt (nur Hintergrund)
const DARK_DROP = -0.35; // Zelle deutlich dunkler geworden (Person vor der Leinwand)

function percentile(hist, n, p) {
  const t = n * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= t) return i; }
  return 255;
}

// gray: Uint8Array mit SIG_W*SIG_H Werten (bereits weichgezeichnet).
// Normiert nur auf das helle Ende (98. Perzentil): gleicht Belichtungsänderungen aus,
// bleibt aber stabil, wenn Inhalt dazukommt oder eine dunkle Person ins Bild tritt.
export function makeSignature(gray) {
  const n = gray.length;
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[gray[i]]++;
  const lo = percentile(hist, n, 0.02), hi = percentile(hist, n, 0.98);
  const scale = Math.max(hi, 60);
  const norm = new Float32Array(n);
  for (let i = 0; i < n; i++) norm[i] = gray[i] / scale;
  const cellMean = new Float32Array(CELLS), cellStd = new Float32Array(CELLS);
  for (let cy = 0; cy < GRID_Y; cy++) {
    for (let cx = 0; cx < GRID_X; cx++) {
      let s = 0, s2 = 0;
      for (let y = cy * CELL_H; y < (cy + 1) * CELL_H; y++) {
        for (let x = cx * CELL_W; x < (cx + 1) * CELL_W; x++) {
          const v = norm[y * SIG_W + x]; s += v; s2 += v * v;
        }
      }
      const k = CELL_W * CELL_H, m = s / k;
      cellMean[cy * GRID_X + cx] = m;
      cellStd[cy * GRID_X + cx] = Math.sqrt(Math.max(0, s2 / k - m * m));
    }
  }
  return { norm, cellMean, cellStd, range: hi - lo, hi };
}

// Pixelweise Differenz mit ±1 Pixel Verschiebungstoleranz (gleicht Wackeln aus),
// in beide Richtungen, damit hinzugefügter und entfernter Inhalt gleich zählt.
function shiftedMin(a, b, x, y) {
  const v = a[y * SIG_W + x];
  let m = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = Math.min(SIG_H - 1, Math.max(0, y + dy));
    for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(SIG_W - 1, Math.max(0, x + dx));
      const d = Math.abs(v - b[yy * SIG_W + xx]);
      if (d < m) m = d;
    }
  }
  return m;
}

export function compare(a, b) {
  const cellDiff = new Float32Array(CELLS);
  for (let y = 0; y < SIG_H; y++) {
    for (let x = 0; x < SIG_W; x++) {
      const d = Math.max(shiftedMin(a.norm, b.norm, x, y), shiftedMin(b.norm, a.norm, x, y));
      cellDiff[Math.floor(y / CELL_H) * GRID_X + Math.floor(x / CELL_W)] += d;
    }
  }
  const raw = new Uint8Array(CELLS);
  for (let c = 0; c < CELLS; c++) {
    cellDiff[c] /= CELL_W * CELL_H;
    if (cellDiff[c] > CELL_T || Math.abs(a.cellStd[c] - b.cellStd[c]) > STD_T) raw[c] = 1;
  }
  // Vereinzelte Zellen ohne geänderten Nachbarn sind meist Rauschen → ignorieren.
  const changed = new Uint8Array(CELLS);
  let count = 0;
  for (let c = 0; c < CELLS; c++) {
    if (raw[c] && neighbours(c).some((n) => raw[n])) { changed[c] = 1; count++; }
  }
  return { changed, count, changedFrac: count / CELLS, cellDiff };
}

function neighbours(c) {
  const cx = c % GRID_X, cy = Math.floor(c / GRID_X), out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if ((dx || dy) && x >= 0 && y >= 0 && x < GRID_X && y < GRID_Y) out.push(y * GRID_X + x);
    }
  }
  return out;
}

// Zusammenhängende Gruppen geänderter Zellen, größte zuerst.
function components(changed) {
  const seen = new Uint8Array(CELLS), comps = [];
  for (let c = 0; c < CELLS; c++) {
    if (!changed[c] || seen[c]) continue;
    const comp = [], stack = [c];
    seen[c] = 1;
    while (stack.length) {
      const k = stack.pop();
      comp.push(k);
      for (const n of neighbours(k)) if (changed[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
    }
    comps.push(comp);
  }
  return comps.sort((a, b) => b.length - a.length);
}

// Hat sich nur bisher leerer Hintergrund mit Inhalt gefüllt? (Aufbau-Animation)
function isAdditive(sig, ref, cmp) {
  if (!cmp.count) return false;
  let add = 0;
  for (let c = 0; c < CELLS; c++) {
    if (cmp.changed[c] && ref.cellStd[c] < EMPTY_STD && sig.cellStd[c] > ref.cellStd[c] + 0.03) add++;
  }
  // Bestehender Inhalt darf sich praktisch nicht ändern (sonst z. B. neuer Titel = neue Folie).
  const other = cmp.count - add;
  return other <= Math.max(2, 0.05 * cmp.count) && cmp.changedFrac <= 0.5;
}

// Dunkle, zusammenhängende Fläche vom Rand her = vermutlich eine Person vor der Leinwand.
function isOcclusion(sig, ref, cmp) {
  if (!cmp.count || cmp.changedFrac > 0.5) return false;
  const big = components(cmp.changed)[0];
  if (big.length < 0.5 * cmp.count) return false;
  let darkish = 0, dark = 0, edge = false;
  for (const c of big) {
    const drop = sig.cellMean[c] - ref.cellMean[c];
    if (drop < -0.05) darkish++;
    if (drop < DARK_DROP) dark++;
    const cx = c % GRID_X, cy = Math.floor(c / GRID_X);
    if (cy === GRID_Y - 1 || cx === 0 || cx === GRID_X - 1) edge = true;
  }
  return edge && darkish >= 0.8 * big.length && dark >= 0.3 * big.length;
}

const OCCLUSION_MAX_MS = 30000; // so lange unverändert „verdeckt“ = wohl doch Folieninhalt

export const CHANGE_DEFAULTS = { sensitivity: 6, stableMs: 1200, merge: true, skipDuplicates: true };

export class ChangeDetector {
  constructor(opts = {}) {
    this.setOptions(opts);
    this.reset();
  }

  setOptions(opts) {
    this.opts = { ...CHANGE_DEFAULTS, ...(this.opts || {}), ...opts };
    // Empfindlichkeit 1..10 → Anteil geänderter Zellen, ab dem eine neue Folie vermutet wird.
    this.T = 0.12 * Math.pow(0.75, this.opts.sensitivity - 1);
  }

  reset() {
    this.state = 'watch';
    this.ref = null;
    this.recent = [];
    this.cand = null;
    this.candSince = 0;
    this.occ = null;
  }

  // Nach manueller Aufnahme: aktuelle Folie als Referenz übernehmen.
  setReference(sig) {
    if (!sig) return;
    this.ref = sig;
    this.recent.push(sig);
    if (this.recent.length > 6) this.recent.shift();
    this.state = 'watch';
    this.cand = null;
  }

  // Ein Analyseschritt. sig = null, wenn gerade keine Folie erkannt ist.
  // Rückgabe: { status, restart, progress?, event? }  event.type = 'add' | 'replace'
  tick(sig, now) {
    if (!sig) {
      if (this.state === 'candidate') { this.state = 'watch'; this.cand = null; }
      return { status: 'search', restart: false };
    }
    if (sig.range < BLANK_RANGE || sig.hi < DARK_HI) {
      if (this.state === 'candidate') { this.state = 'watch'; this.cand = null; }
      return { status: 'blank', restart: false };
    }
    const T = this.T;
    if (this.state === 'occluded') {
      if (compare(sig, this.occ).changedFrac <= T) {
        if (now - this.occSince > OCCLUSION_MAX_MS) return this._decide(sig, { ignoreOcclusion: true });
        return { status: 'occluded', restart: false };
      }
      this.state = 'watch';
      this.occ = null;
    }
    if (this.state === 'watch') {
      if (this.ref && compare(sig, this.ref).changedFrac <= T) return { status: 'watch', restart: false };
      this.state = 'candidate';
      this.cand = sig;
      this.candSince = now;
      return { status: 'candidate', restart: true, progress: 0 };
    }
    // state === 'candidate': warten, bis das neue Bild ruhig steht
    if (compare(sig, this.cand).changedFrac > T * 0.5) {
      this.cand = sig;
      this.candSince = now;
      return { status: 'candidate', restart: true, progress: 0 };
    }
    if (this.ref && compare(sig, this.ref).changedFrac <= T) {
      this.state = 'watch';
      this.cand = null;
      return { status: 'watch', restart: false };
    }
    const elapsed = now - this.candSince;
    if (elapsed < this.opts.stableMs) {
      return { status: 'candidate', restart: false, progress: elapsed / this.opts.stableMs };
    }
    return this._decide(sig, { now });
  }

  _decide(sig, { now = 0, ignoreOcclusion = false } = {}) {
    this.cand = null;
    this.state = 'watch';
    const vsRef = this.ref ? compare(sig, this.ref) : null;
    if (!ignoreOcclusion && vsRef && isOcclusion(sig, this.ref, vsRef)) {
      this.state = 'occluded';
      this.occ = sig;
      this.occSince = now;
      return { status: 'occluded', restart: false };
    }
    if (this.opts.skipDuplicates) {
      for (const r of this.recent) {
        if (r !== this.ref && compare(sig, r).changedFrac <= this.T) {
          this.ref = sig;
          return { status: 'duplicate', restart: false };
        }
      }
    }
    const type = this.opts.merge && vsRef && isAdditive(sig, this.ref, vsRef) ? 'replace' : 'add';
    if (type === 'replace' && this.recent.length) this.recent[this.recent.length - 1] = sig;
    else {
      this.recent.push(sig);
      if (this.recent.length > 6) this.recent.shift();
    }
    this.ref = sig;
    return { status: 'captured', restart: false, event: { type } };
  }
}
