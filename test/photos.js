// Fototest: schickt echte Fotos (Liste in <src>/liste.json) als stillstehendes Kamerabild
// durch dieselbe Pipeline wie die App und baut aus allen Aufnahmen ein PDF.
// Aufruf: test/photos.html?src=http://localhost:8766/   (Server muss CORS erlauben)

import { loadCV } from '../js/cv.js';
import { Pipeline } from '../js/pipeline.js';
import { buildPdf } from '../js/pdf.js';

const $ = (id) => document.getElementById(id);
const base = new URLSearchParams(location.search).get('src') || 'http://localhost:8766/';
const CAM = 1920;       // längste Bildseite wie bei einer 1080p-Handykamera
const SECONDS = 3.5;    // so lange wird das Foto „gefilmt“

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Bild nicht ladbar: ${url}`));
    img.src = url;
  });
}

const yieldToBrowser = () => new Promise((r) => {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => r();
  ch.port2.postMessage(0);
});

// Leichtes Kamerarauschen, damit es nicht 100 % identische Bilder sind
function addNoise(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 6;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

function drawQuad(ctx, q, w, h, color) {
  ctx.beginPath();
  q.forEach((p, i) => (i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)));
  ctx.closePath();
  ctx.lineWidth = Math.max(3, w / 300);
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = '#ff2d2d';
  ctx.beginPath();
  ctx.arc(q[0].x * w, q[0].y * h, Math.max(5, w / 150), 0, Math.PI * 2); // Ecke „oben links“
  ctx.fill();
}

async function testPhoto(cv, item) {
  const img = await loadImage(base + item.file);
  const s = CAM / Math.max(img.naturalWidth, img.naturalHeight);
  const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
  const clean = document.createElement('canvas');
  clean.width = w; clean.height = h;
  clean.getContext('2d').drawImage(img, 0, 0, w, h);
  const frame = document.createElement('canvas');
  frame.width = w; frame.height = h;
  const fctx = frame.getContext('2d', { willReadFrequently: true });

  const pipeline = new Pipeline(cv, {});
  pipeline.setRotation(0);
  const statuses = [];
  let event = null, last = null, ms = 0, n = 0;
  for (let t = 0; t < SECONDS; t += 0.25) {
    fctx.drawImage(clean, 0, 0);
    addNoise(fctx, w, h);
    const t0 = performance.now();
    const res = await pipeline.analyze(frame, w, h, t * 1000, { auto: true });
    ms += performance.now() - t0; n++;
    statuses.push(res.status);
    last = res;
    if (res.event && !event) event = res.event;
    await yieldToBrowser();
  }
  return { img: clean, w, h, event, last, statuses, ms: ms / n, cands: pipeline.detector.lastCandidates || [] };
}

async function main() {
  const cv = await loadCV('../lib/opencv.js');
  const list = await (await fetch(base + 'liste.json')).json();
  const grid = $('grid');
  const rows = [];
  const captured = [];
  for (const [k, item] of list.entries()) {
    $('state').textContent = `Teste Foto ${k + 1} von ${list.length} …`;
    let r;
    try {
      r = await testPhoto(cv, item);
    } catch (e) {
      rows.push({ id: item.id, error: String(e) });
      continue;
    }
    // Übersicht: Foto mit erkanntem Rahmen + entzerrte Aufnahme
    const view = document.createElement('canvas');
    const vs = 520 / Math.max(r.w, r.h);
    view.width = Math.round(r.w * vs); view.height = Math.round(r.h * vs);
    const vctx = view.getContext('2d');
    vctx.drawImage(r.img, 0, 0, view.width, view.height);
    if (r.last?.quad) drawQuad(vctx, r.last.quad, view.width, view.height, r.event ? '#29c46f' : '#f5a524');
    const out = document.createElement('img');
    if (r.event) {
      out.src = r.event.image.canvas.toDataURL('image/jpeg', 0.8);
      captured.push({ id: item.id, image: r.event.image });
    }
    const fig = document.createElement('figure');
    const pair = document.createElement('div');
    pair.className = 'pair';
    pair.append(view, out);
    const cap = document.createElement('figcaption');
    const verdict = r.event ? '<span class="ok">Aufnahme</span>' : r.last?.quad ? '<span class="warn">Rahmen, keine Aufnahme</span>' : '<span class="bad">nichts erkannt</span>';
    const fmt = r.event ? ` · ${r.event.image.width}×${r.event.image.height}` : '';
    cap.innerHTML = `#${item.id} ${verdict}${fmt} · ${r.ms.toFixed(0)} ms/Bild · Status: ${[...new Set(r.statuses)].join(' → ')}`;
    fig.append(pair, cap);
    grid.append(fig);
    rows.push({
      id: item.id, file: item.file, captured: !!r.event, quadState: r.last?.quadState, lastStatus: r.last?.status,
      quad: r.last?.quad?.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3)]) || null,
      out: r.event ? [r.event.image.width, r.event.image.height] : null, ms: Math.round(r.ms),
      cands: r.cands.slice(0, 3).map((c) => ({ s: +c.score.toFixed(3), k: +(c.contrast ?? 0).toFixed(2), i: +(c.content ?? 0).toFixed(2) })),
    });
  }
  // PDF-Export prüfen
  let pdf = null;
  if (captured.length) {
    const slides = await Promise.all(captured.map(async (c) => ({
      blob: await new Promise((res) => c.image.canvas.toBlob(res, 'image/jpeg', 0.85)),
      width: c.image.width, height: c.image.height,
    })));
    const built = await buildPdf(slides, 'Fototest');
    const head = new TextDecoder().decode(new Uint8Array(await built.blob.slice(0, 5).arrayBuffer()));
    pdf = { pages: built.pages, kb: Math.round(built.blob.size / 1024), valid: head === '%PDF-' && built.pages === captured.length };
  }
  const nCap = rows.filter((r) => r.captured).length;
  $('state').innerHTML = `${nCap} von ${rows.length} Fotos aufgenommen · PDF: ${pdf ? `${pdf.pages} Seiten, ${pdf.kb} KB, ${pdf.valid ? '<span class="ok">gültig</span>' : '<span class="bad">fehlerhaft</span>'}` : '—'}`;
  window.__photoResult = { rows, pdf };
}

main().catch((e) => {
  console.error(e);
  $('state').textContent = `Fehler: ${e.message}`;
  window.__photoResult = { error: String(e.stack || e) };
});
