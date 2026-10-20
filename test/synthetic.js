// Synthetischer Ende-zu-Ende-Test: erzeugt künstliche Hörsaal-Szenen
// (perspektivisch projizierte Folien, Rauschen, Flackern, Personen vor der Leinwand)
// und schickt sie durch dieselbe Pipeline wie die App.

import { loadCV } from '../js/cv.js';
import { Pipeline } from '../js/pipeline.js';
import { estimateAspect, resolveAspect, RATIOS } from '../js/rectify.js';
import { makeSignature, compare, SIG_W, SIG_H } from '../js/change.js';
import { buildPdf } from '../js/pdf.js';

const W = 1280, H = 720, F = 1000, STEP = 0.25;
const $ = (id) => document.getElementById(id);
const logLines = [];
const log = (s) => logLines.push(s);
let cv;

// ---------- Geometrie: echtes 3D-Rechteck mit Lochkamera projizieren ----------
function projectRect(ratio, { yaw = 0, pitch = 0, dist = 4, width = 2.6, cx = 0, cy = -0.15 } = {}) {
  const w = width, h = width / ratio;
  const r = (d) => (d * Math.PI) / 180;
  const cyw = Math.cos(r(yaw)), syw = Math.sin(r(yaw)), cp = Math.cos(r(pitch)), sp = Math.sin(r(pitch));
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => {
    const X = x * cyw, Z = -x * syw;
    const Y2 = y * cp - Z * sp, Z2 = y * sp + Z * cp;
    const Zf = Z2 + dist;
    return { x: W / 2 + (F * (X + cx)) / Zf, y: H / 2 + (F * (Y2 + cy)) / Zf };
  });
}

// ---------- Folien zeichnen ----------
function makeSlide({ title, bullets = [], kind = 'text', page, w = 1600, h = 900, black = false }) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  if (black) { x.fillStyle = '#000'; x.fillRect(0, 0, w, h); return c; }
  x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
  x.textBaseline = 'middle';
  if (kind === 'title') {
    x.fillStyle = '#1d3f8f'; x.fillRect(0, h * 0.36, w, h * 0.28);
    x.fillStyle = '#fff'; x.font = 'bold 96px sans-serif'; x.textAlign = 'center';
    x.fillText(title, w / 2, h * 0.5);
    x.fillStyle = '#1b1e26'; x.font = '48px sans-serif';
    x.fillText('Kapitel 3 – Folgen und Reihen', w / 2, h * 0.75);
    x.textAlign = 'left';
  } else {
    x.fillStyle = '#1d3f8f'; x.fillRect(0, 0, w, 130);
    x.fillStyle = '#fff'; x.font = 'bold 64px sans-serif'; x.fillText(title, 70, 68);
    x.fillStyle = '#1b1e26'; x.font = '46px sans-serif';
    bullets.forEach((b, i) => {
      const y = 240 + i * 100;
      x.beginPath(); x.arc(95, y, 11, 0, Math.PI * 2); x.fill();
      x.fillText(b, 130, y);
    });
    if (kind === 'chart') {
      x.strokeStyle = '#1b1e26'; x.lineWidth = 6;
      x.beginPath(); x.moveTo(820, 720); x.lineTo(1500, 720); x.moveTo(840, 740); x.lineTo(840, 230); x.stroke();
      x.strokeStyle = '#d93a3a'; x.lineWidth = 8; x.beginPath();
      for (let i = 0; i <= 60; i++) {
        const px = 840 + i * 11, py = 700 - 420 * (1 - Math.exp(-i / 14));
        i ? x.lineTo(px, py) : x.moveTo(px, py);
      }
      x.stroke();
      x.fillStyle = '#2f6df6';
      [180, 300, 250, 380].forEach((bh, i) => x.fillRect(150 + i * 140, 720 - bh, 90, bh));
    }
    if (kind === 'theorem') {
      x.fillStyle = '#e8f0ff'; x.fillRect(90, 420, w - 180, 300);
      x.strokeStyle = '#2f6df6'; x.lineWidth = 6; x.strokeRect(90, 420, w - 180, 300);
      x.fillStyle = '#1b1e26'; x.font = 'italic 52px serif';
      x.fillText('Σ 1/n² = π²/6   (Basel-Problem)', 150, 520);
      x.fillText('|aₙ − a| < ε  für alle n ≥ N(ε)', 150, 630);
    }
  }
  x.fillStyle = '#6b7280'; x.font = '30px sans-serif';
  x.fillText('Analysis II · WS 2026/27', 70, h - 45);
  x.textAlign = 'right'; x.fillText(String(page), w - 70, h - 45); x.textAlign = 'left';
  return c;
}

function buildSlides(w = 1600, h = 900) {
  const b = ['Eine Folge heißt konvergent, wenn …', 'Grenzwerte sind eindeutig', 'Jede konvergente Folge ist beschränkt'];
  return {
    S1: makeSlide({ title: 'Analysis II', kind: 'title', page: 1, w, h }),
    S2a: makeSlide({ title: 'Konvergenz', bullets: b.slice(0, 1), page: 2, w, h }),
    S2b: makeSlide({ title: 'Konvergenz', bullets: b.slice(0, 2), page: 2, w, h }),
    S2c: makeSlide({ title: 'Konvergenz', bullets: b, page: 2, w, h }),
    S3: makeSlide({ title: 'Beispiel: Wachstum', bullets: ['Messwerte'], kind: 'chart', page: 3, w, h }),
    S4: makeSlide({ title: 'Satz 2.1', bullets: ['Sei (aₙ) eine reelle Folge.'], kind: 'theorem', page: 4, w, h }),
    S5: makeSlide({ title: 'Zusammenfassung', bullets: ['Konvergenz & Grenzwert', 'Beschränktheit', 'Cauchy-Kriterium', 'Nächste Woche: Reihen'], page: 5, w, h }),
    BLACK: makeSlide({ black: true, w, h }),
  };
}

// ---------- Szene rendern ----------
function fillQuad(x, q, color) {
  x.fillStyle = color;
  x.beginPath(); q.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))); x.closePath(); x.fill();
}

// Heller Hörsaal wie auf den echten Fotos: beige Wand, leere weiße Tafel neben der Projektion,
// Fenster, und vorne am Bildrand ein weißes Blatt Papier auf dem Tisch.
function makeBrightHall(screenQuad, boardQuad) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#d9d3c6'); g.addColorStop(0.55, '#b8ab94'); g.addColorStop(1, '#6e4d2c');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.fillStyle = '#e9eef5';
  for (let i = 0; i < 4; i++) x.fillRect(60 + i * 70, 40, 52, 70); // Fenster
  fillQuad(x, boardQuad, '#ebe9e3');   // leere Tafel
  fillQuad(x, screenQuad, '#97938c');  // Leinwand (unbeleuchteter Teil)
  x.fillStyle = '#2a2a2c'; x.fillRect(0, 600, W, 26); // Geländer
  fillQuad(x, [{ x: 960, y: 560 }, { x: W, y: 545 }, { x: W, y: H }, { x: 990, y: H }], '#f6f5f0'); // Papier
  return c;
}

function makeBackground(screenQuad) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#1c1f26'); g.addColorStop(1, '#0d0e12');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // Deckenlichter
  x.fillStyle = '#f2f0e6';
  [[160, 18], [640, 12], [1120, 18]].forEach(([lx, ly]) => { x.beginPath(); x.ellipse(lx, ly, 46, 9, 0, 0, Math.PI * 2); x.fill(); });
  // Leinwand (etwas größer als das projizierte Bild, unbeleuchtet grau)
  x.fillStyle = '#3a3d44';
  x.beginPath(); screenQuad.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))); x.closePath(); x.fill();
  // Sitzreihen
  x.fillStyle = '#08090b';
  for (let i = 0; i < 3; i++) x.fillRect(0, H - 40 - i * 34, W, 14);
  return c;
}

const noiseTab = (() => {
  const t = new Float32Array(65536);
  for (let i = 0; i < t.length; i++) {
    const u = Math.random() || 1e-9, v = Math.random();
    t[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * 4;
  }
  return t;
})();

const tmp = document.createElement('canvas');
const tmp2 = document.createElement('canvas');

// Ein Beamer addiert Licht zur Umgebung: look.mul = Helligkeit der Projektion,
// look.add = Grundhelligkeit der (beleuchteten) Leinwand.
const DARK_HALL = { mul: 'rgb(226,224,214)', add: 'rgb(22,22,24)' };
const BRIGHT_HALL = { mul: 'rgb(150,149,145)', add: 'rgb(150,147,140)' };

function projectorLook(slide, slide2, alpha, look = DARK_HALL) {
  tmp.width = tmp2.width = slide.width;
  tmp.height = tmp2.height = slide.height;
  const a = tmp.getContext('2d');
  a.globalAlpha = 1; a.drawImage(slide, 0, 0);
  if (slide2) { a.globalAlpha = alpha; a.drawImage(slide2, 0, 0); a.globalAlpha = 1; }
  const b = tmp2.getContext('2d');
  b.globalCompositeOperation = 'source-over'; b.drawImage(tmp, 0, 0);
  b.globalCompositeOperation = 'multiply'; b.fillStyle = look.mul; b.fillRect(0, 0, tmp2.width, tmp2.height);
  b.globalCompositeOperation = 'lighter'; b.fillStyle = look.add; b.fillRect(0, 0, tmp2.width, tmp2.height);
  b.globalCompositeOperation = 'source-over';
  return tmp2;
}

function warpInto(scene, src, q) {
  const s = cv.imread(src), d = cv.imread(scene);
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, src.width, 0, src.width, src.height, 0, src.height]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, q.flatMap((p) => [p.x, p.y]));
  const M = cv.getPerspectiveTransform(from, to);
  const warped = new cv.Mat();
  cv.warpPerspective(s, warped, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
  const mask = cv.Mat.zeros(H, W, cv.CV_8UC1);
  const poly = cv.matFromArray(4, 1, cv.CV_32SC2, q.flatMap((p) => [Math.round(p.x), Math.round(p.y)]));
  const vec = new cv.MatVector(); vec.push_back(poly);
  cv.fillPoly(mask, vec, new cv.Scalar(255));
  warped.copyTo(d, mask);
  cv.imshow(scene, d);
  [s, d, from, to, M, warped, mask, poly, vec].forEach((m) => m.delete());
}

function drawPerson(ctx, cx, height = 340) {
  const top = H - height;
  ctx.fillStyle = '#15171c';
  ctx.beginPath(); ctx.arc(cx, top + 46, 44, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.roundRect(cx - 100, top + 98, 200, height, 60); ctx.fill();
}

function renderFrame(scene, bg, slides, st) {
  const ctx = scene.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bg, 0, 0);
  if (st.slide) {
    const jitter = st.quad.map((p) => ({ x: p.x + (Math.random() - 0.5) * 3, y: p.y + (Math.random() - 0.5) * 3 }));
    warpInto(scene, projectorLook(slides[st.slide], st.slide2 && slides[st.slide2], st.alpha || 0, st.look), jitter);
  }
  if (st.person != null) drawPerson(ctx, st.person);
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  const gain = 0.95 + Math.random() * 0.1;
  let o = (Math.random() * 65536) | 0;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i] * gain + noiseTab[(o++) & 65535];
    d[i + 1] = d[i + 1] * gain + noiseTab[(o++) & 65535];
    d[i + 2] = d[i + 2] * gain + noiseTab[(o++) & 65535];
  }
  ctx.putImageData(img, 0, 0);
}

// ---------- Signaturen zum Wiedererkennen der Seiten ----------
function sigOf(canvas) {
  const c = document.createElement('canvas');
  c.width = SIG_W * 2; c.height = SIG_H * 2;
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  const m = cv.imread(c), g = new cv.Mat(), r = new cv.Mat();
  cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(g, g, new cv.Size(3, 3), 0);
  cv.resize(g, r, new cv.Size(SIG_W, SIG_H), 0, 0, cv.INTER_AREA);
  const sig = makeSignature(new Uint8Array(r.data));
  m.delete(); g.delete(); r.delete();
  return sig;
}

function identify(canvas, refs) {
  const s = sigOf(canvas);
  let best = null, bestF = Infinity;
  for (const [name, ref] of Object.entries(refs)) {
    const f = compare(s, ref).changedFrac;
    if (f < bestF) { bestF = f; best = name; }
  }
  return { name: best, frac: bestF };
}

// ---------- Szenario ausführen ----------
// Kurz an den Browser abgeben, ohne die Drosselung von setTimeout in Hintergrund-Tabs.
function yieldToBrowser() {
  return new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
  });
}

async function runScenario({ name, slides, quad, screenQuad, timeline, duration, background, rotate = 0, rotation = 0, look }) {
  const scene = $('scene');
  const bg = background || makeBackground(screenQuad);
  const pipeline = new Pipeline(cv, {});
  pipeline.setRotation(rotation);
  // Handy quer, Anzeige hochkant gesperrt: Kamerabild kommt um 90° gedreht an.
  let frame = scene, fw = W, fh = H;
  if (rotate === 90) {
    frame = document.createElement('canvas');
    frame.width = fw = H; frame.height = fh = W;
  }
  const pages = [];
  const events = [];
  let lastStatus = '';
  for (let t = 0; t < duration; t += STEP) {
    const seg = timeline.find(([a, b]) => t >= a && t < b);
    const spec = seg ? seg[2] : {};
    const st = {
      slide: spec.slide || null,
      slide2: spec.slide2 || null,
      alpha: typeof spec.alpha === 'function' ? spec.alpha(t) : 0,
      person: typeof spec.person === 'function' ? spec.person(t) : null,
      quad,
      look,
    };
    renderFrame(scene, bg, slides, st);
    if (rotate === 90) {
      const fx = frame.getContext('2d');
      fx.setTransform(0, 1, -1, 0, fw, 0); // „oben“ der Welt zeigt im Bild nach rechts
      fx.drawImage(scene, 0, 0);
      fx.setTransform(1, 0, 0, 1, 0, 0);
    }
    const res = await pipeline.analyze(frame, fw, fh, t * 1000, { auto: true });
    const statusKey = `${res.status}/${res.quadState}`;
    if (statusKey !== lastStatus) {
      log(`[${name}] t=${t.toFixed(2).padStart(6)}s  ${st.slide || '—'}${st.person != null ? ' +Person' : ''}  →  ${statusKey}`);
      lastStatus = statusKey;
    }
    if (res.event) {
      const { type, image } = res.event;
      events.push({ t, type, slideShown: st.slide });
      log(`[${name}] t=${t.toFixed(2).padStart(6)}s  AUFNAHME ${type} (${image.width}×${image.height})`);
      if (type === 'replace' && pages.length) pages[pages.length - 1] = image;
      else pages.push(image);
    }
    await yieldToBrowser();
    $('state').textContent = `Läuft… ${name} ${t.toFixed(1)} s`;
  }
  return { pages, events };
}

async function canvasBlob(c) {
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
}

function check(results, label, ok, detail = '') {
  results.push({ label, ok, detail });
}

async function main() {
  cv = await loadCV('../lib/opencv.js');
  $('state').textContent = 'Läuft…';
  const results = [];
  const extraPages = [];
  const t0 = performance.now();

  // 1) Seitenverhältnis-Schätzung direkt prüfen
  const poses = [[0, 0], [15, -5], [30, -10], [-35, 15], [10, 25], [-20, -20]];
  let aspectOk = 0, aspectTotal = 0;
  const aspectRows = [];
  for (const [rn, r] of Object.entries(RATIOS)) {
    for (const [yaw, pitch] of poses) {
      const q = projectRect(r, { yaw, pitch, width: 2.2 });
      const est = estimateAspect(q, W, H);
      const snapped = resolveAspect('auto', est);
      const ok = Math.abs(snapped - r) < 1e-6;
      aspectTotal++; if (ok) aspectOk++;
      aspectRows.push(`${rn} yaw=${yaw} pitch=${pitch}: geschätzt ${est.toFixed(3)} → ${snapped.toFixed(3)} ${ok ? '✓' : '✗'}`);
    }
  }
  aspectRows.forEach((l) => log(`[Seitenverhältnis] ${l}`));
  check(results, 'Seitenverhältnis wird aus der Perspektive richtig erkannt', aspectOk === aspectTotal, `${aspectOk}/${aspectTotal}`);

  // 2) Hauptszenario: eine Vorlesung mit Animationen, Personen, Zurückblättern, schwarzer Folie
  const slides = buildSlides();
  const quadA = projectRect(16 / 9, { yaw: 12, pitch: -8 });
  const screenA = projectRect(16 / 10, { yaw: 12, pitch: -8, width: 2.95 });
  const timeline = [
    [0, 2, {}],
    [2, 8, { slide: 'S1' }],
    [8, 12, { slide: 'S2a' }],
    [12, 16, { slide: 'S2b' }],
    [16, 24, { slide: 'S2c', person: (t) => (t >= 19 && t < 22 ? 150 + ((t - 19) / 3) * 1000 : null) }],
    [24, 24.5, { slide: 'S2c', slide2: 'S3', alpha: (t) => (t - 24) / 0.5 }],
    [24.5, 31, { slide: 'S3' }],
    [31, 37, { slide: 'S4', person: (t) => (t >= 33 && t < 35.5 ? (t < 33.5 ? 1150 - (t - 33) * 500 : 900) : null) }],
    [37, 42, { slide: 'S3' }],
    [42, 48, { slide: 'S5' }],
    [48, 51, { slide: 'BLACK' }],
    [51, 55, { slide: 'S5' }],
  ];
  const A = await runScenario({ name: 'Vorlesung', slides, quad: quadA, screenQuad: screenA, timeline, duration: 55 });
  const refs = Object.fromEntries(['S1', 'S2a', 'S2b', 'S2c', 'S3', 'S4', 'S5'].map((k) => [k, sigOf(slides[k])]));
  const ids = A.pages.map((p) => identify(p.canvas, refs));
  const expected = ['S1', 'S2c', 'S3', 'S4', 'S5'];
  const got = ids.map((i) => i.name);
  check(results, 'Richtige Seiten in richtiger Reihenfolge', JSON.stringify(got) === JSON.stringify(expected),
    `erwartet ${expected.join(', ')} · erhalten ${got.join(', ') || '—'}`);
  check(results, 'Aufbau-Animation zu einer Seite zusammengeführt', A.events.filter((e) => e.type === 'replace').length >= 1 && got[1] === 'S2c',
    `${A.events.filter((e) => e.type === 'replace').length}× ersetzt`);
  check(results, 'Durchlaufende/stehende Person löst keine Aufnahme aus',
    !A.events.some((e) => (e.t >= 19 && e.t < 23) || (e.t >= 33 && e.t < 37)));
  check(results, 'Zurückgeblätterte und schwarze Folie übersprungen', !A.events.some((e) => e.t >= 37 && e.t < 42) && !A.events.some((e) => e.t >= 48));
  check(results, 'Folien im Format 16:9 entzerrt', A.pages.every((p) => p.width === 1600 && p.height === 900),
    A.pages.map((p) => `${p.width}×${p.height}`).join(', '));

  // 3) 4:3-Folie mit starker Perspektive
  const slides43 = buildSlides(1200, 900);
  const B = await runScenario({
    name: '4:3 schräg', slides: slides43,
    quad: projectRect(4 / 3, { yaw: 28, pitch: -10, width: 2.2 }),
    screenQuad: projectRect(4 / 3, { yaw: 28, pitch: -10, width: 2.5 }),
    timeline: [[0, 4, { slide: 'S3' }]], duration: 4,
  });
  check(results, '4:3-Folie bei starker Schräglage erkannt und entzerrt', B.pages.length === 1 && B.pages[0].height === 1200,
    B.pages.map((p) => `${p.width}×${p.height}`).join(', ') || 'keine Aufnahme');

  // 4) Wie auf den echten Fotos: heller Hörsaal, kleine Folie weit weg, Handy quer bei
  //    gesperrter Drehung (Bild gedreht), leere Tafel daneben, Papier vorne am Bildrand.
  const poseC = { yaw: -6, pitch: -4, dist: 7, width: 1.7, cx: 0.5, cy: -0.35 };
  const quadC = projectRect(16 / 9, poseC);
  const screenC = projectRect(16 / 10, { ...poseC, width: 2.0 });
  const boardC = projectRect(4 / 3, { ...poseC, width: 1.5, cx: -1.4 });
  const timelineC = [[0, 3, {}], [3, 9, { slide: 'S1' }], [9, 15, { slide: 'S3' }], [15, 21, { slide: 'S5' }]];
  const expectedC = ['S1', 'S3', 'S5'];
  for (const [label, rotation] of [['Lagesensor', 90], ['ohne Lagesensor', null]]) {
    const C = await runScenario({
      name: `Hörsaal quer (${label})`, slides, quad: quadC, timeline: timelineC, duration: 21,
      background: makeBrightHall(screenC, boardC), rotate: 90, rotation, look: BRIGHT_HALL,
    });
    const gotC = C.pages.map((p) => identify(p.canvas, refs).name);
    check(results, `Kleine Folie, Handy quer, gedrehtes Bild (${label})`,
      JSON.stringify(gotC) === JSON.stringify(expectedC) && C.pages.every((p) => p.width === 1600 && p.height === 900),
      `erwartet ${expectedC.join(', ')} · erhalten ${gotC.join(', ') || '—'} · ${C.pages.map((p) => `${p.width}×${p.height}`).join(', ')}`);
    check(results, `Keine Aufnahme ohne Projektion (Papier/Tafel ignoriert, ${label})`, !C.events.some((e) => e.t < 3));
    if (rotation === 90) extraPages.push(...C.pages);
  }

  // 5) PDF
  const blobs = await Promise.all(A.pages.map(async (p) => ({ blob: await canvasBlob(p.canvas), width: p.width, height: p.height })));
  let pdfInfo = null;
  if (blobs.length) {
    pdfInfo = await buildPdf(blobs, 'Synthetischer Test');
    check(results, 'PDF enthält alle Seiten', pdfInfo.pages === A.pages.length, `${pdfInfo.pages} Seiten, ${(pdfInfo.blob.size / 1024).toFixed(0)} KB`);
  } else {
    check(results, 'PDF enthält alle Seiten', false, 'keine Seiten');
  }

  // ---------- Bericht ----------
  const pass = results.every((r) => r.ok);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  $('state').innerHTML = `<span class="${pass ? 'pass' : 'fail'}">${pass ? 'ALLE TESTS BESTANDEN' : 'TESTS FEHLGESCHLAGEN'}</span> · ${secs} s`;
  $('summary').innerHTML = `<table><tr><th>Prüfung</th><th>Ergebnis</th><th>Details</th></tr>${results.map((r) =>
    `<tr><td>${r.label}</td><td class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'OK' : 'FEHLER'}</td><td>${r.detail}</td></tr>`).join('')}</table>`;
  $('pages').replaceChildren(...A.pages.concat(B.pages, extraPages).map((p, i) => {
    const f = document.createElement('figure');
    const img = document.createElement('img');
    img.src = p.canvas.toDataURL('image/jpeg', 0.8);
    const cap = document.createElement('figcaption');
    const id = i < ids.length ? `${ids[i].name} (Abweichung ${(ids[i].frac * 100).toFixed(1)} %)`
      : i === ids.length ? '4:3-Szenario' : 'Hörsaal quer';
    cap.textContent = `Seite ${i + 1}: ${id} · ${p.width}×${p.height}`;
    f.append(img, cap);
    return f;
  }));
  $('log').textContent = logLines.join('\n');
  window.__testResult = {
    pass, seconds: Number(secs), results,
    pages: got, events: A.events, pdfPages: pdfInfo?.pages ?? 0,
  };
}

if (new URLSearchParams(location.search).has('debug')) {
  // Nur Hilfsfunktionen bereitstellen (für Fehlersuche in der Konsole).
  loadCV('../lib/opencv.js').then((m) => {
    cv = m;
    window.__dbg = { cv, projectRect, buildSlides, makeBackground, makeBrightHall, renderFrame, sigOf, identify, W, H, BRIGHT_HALL };
    $('state').textContent = 'Debug-Modus bereit';
  });
} else main().catch((e) => {
  console.error(e);
  $('state').innerHTML = `<span class="fail">Fehler: ${e.message}</span>`;
  window.__testResult = { pass: false, error: String(e.stack || e) };
});
