// Folienscanner – Oberfläche und Ablaufsteuerung.

import { loadCV } from './cv.js';
import { Pipeline, FULL_FRAME } from './pipeline.js';
import {
  startCamera, stopCamera, cameraAlive, exposureControl, zoomControl, focusAt, loadVideoFile, seekTo, keepAwake,
} from './camera.js';
import * as store from './storage.js';
import { pdfFileName, shareOrDownload, downloadBlob } from './pdf.js';
import { registerOutput, PdfOutput, emitLectureStart, emitSlideAdded, emitSlideReplaced, emitSlideDeleted } from './outputs.js';

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'), overlay: $('overlay'), flash: $('flash'), status: $('status'), statusText: $('statusText'),
  toast: $('toast'), videoProgress: $('videoProgress'), videoProgressBar: $('videoProgressBar'),
  lastThumb: $('lastThumb'), slideCount: $('slideCount'), btnGallery: $('btnGallery'),
  btnPause: $('btnPause'), btnShutter: $('btnShutter'), btnLock: $('btnLock'), btnPdf: $('btnPdf'),
  btnBack: $('btnBack'), btnSettings: $('btnSettings'), btnZoom: $('btnZoom'), scanHint: $('scanHint'),
  lectureList: $('lectureList'), emptyLectures: $('emptyLectures'), lectureName: $('lectureName'),
  resumeCard: $('resumeCard'), resumeName: $('resumeName'), resumeMeta: $('resumeMeta'),
  cropper: $('cropper'), cropCanvas: $('cropCanvas'), cropPreview: $('cropPreview'), cropInfo: $('cropInfo'),
  viewerCrop: $('viewerCrop'),
  galTitle: $('galTitle'), galMeta: $('galMeta'), galGrid: $('galGrid'), galEmpty: $('galEmpty'),
  viewer: $('viewer'), viewerImg: $('viewerImg'), viewerInfo: $('viewerInfo'),
  settings: $('settings'), settingsForm: $('settingsForm'), exposureRow: $('exposureRow'),
  loading: $('loading'), loadingText: $('loadingText'),
};

// ---------- Einstellungen (pro Gerät, im Browser gespeichert) ----------
const SETTINGS_KEY = 'folienscanner.settings.v1';
const SETTINGS_REV = 2; // 2: Automatik standardmäßig aus
const DEFAULT_SETTINGS = {
  auto: false, sensitivity: 6, stableSec: 1.2, merge: true, skipDuplicates: true, vibrate: true,
  filter: 'enhanced', aspect: 'auto', videoStep: 0.5, forceLandscape: true, zoom: 1, rev: SETTINGS_REV,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (saved.rev !== SETTINGS_REV) { delete saved.auto; saved.rev = SETTINGS_REV; } // alter Standard „an“
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* privat/blockiert */ }
}

const state = {
  settings: loadSettings(),
  screen: 'home',
  cv: null,
  pipeline: null,
  lecture: null,
  lastSlideId: null,
  lastSlideNo: 0,
  mode: null,          // 'camera' | 'video'
  scanning: false,
  paused: false,
  quad: null,
  quadState: 'none',
  status: 'search',
  progress: 0,
  videoTime: 0,
  videoDone: false,
  loopTimer: null,
  stepPromise: null,
  galleryLecture: null,
  viewerSlide: null,
  urls: [],
  drag: null,
  zoom: 1,
  zoomHw: null,        // Kamera-Zoom des Geräts oder null (dann digital)
  searchSince: 0,
  tapMark: null,       // angetippter Punkt (Anzeige)
};

function pipelineSettings() {
  const s = state.settings;
  return {
    sensitivity: Number(s.sensitivity), stableSec: Number(s.stableSec), merge: !!s.merge,
    skipDuplicates: !!s.skipDuplicates, filter: s.filter, aspect: s.aspect,
  };
}

const pdfOut = new PdfOutput();
registerOutput(pdfOut);
// Hier kann später eine OneNote-Ausgabe registriert werden: registerOutput(new OneNoteOutput(...))

const cvPromise = loadCV();
cvPromise.catch(() => {});

// ---------- Hilfsfunktionen ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDate = (t) => new Date(t).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const plural = (n) => `${n} ${n === 1 ? 'Folie' : 'Folien'}`;

function trackUrl(blob) {
  const u = URL.createObjectURL(blob);
  state.urls.push(u);
  return u;
}
function revokeUrls() {
  state.urls.forEach((u) => URL.revokeObjectURL(u));
  state.urls = [];
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht erzeugt werden'))), type, quality));
}
function scaleCanvas(src, width) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.round((src.height * width) / src.width);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

let toastTimer = null;
// action: { label, onClick } → Knopf in der Meldung (z. B. „Bearbeiten“)
function toast(msg, ms = 1900, action = null) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('has-action', !!action);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => { els.toast.classList.remove('show'); action.onClick(); });
    els.toast.append(b);
  }
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

// ---------- Laufende Sitzung merken (übersteht Schließen des Tabs / der App) ----------
const ACTIVE_KEY = 'folienscanner.active';
const RESUME_MAX_MS = 12 * 3600 * 1000;
function setActiveLecture(id) {
  try {
    if (id == null) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, JSON.stringify({ id, t: Date.now() }));
  } catch { /* privat/blockiert */ }
}
function getActiveLecture() {
  try {
    const a = JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null');
    return a && Date.now() - a.t < RESUME_MAX_MS ? a : null;
  } catch { return null; }
}

function setLoading(text) {
  els.loading.hidden = !text;
  if (text) els.loadingText.textContent = text;
}

function setStatus(text, tone = 'idle') {
  els.statusText.textContent = text;
  els.status.dataset.tone = tone;
}

function showScreen(name, push = true) {
  for (const s of ['home', 'scan', 'gallery']) $(s).classList.toggle('active', s === name);
  document.body.classList.toggle('on-scan', name === 'scan');
  state.screen = name;
  if (push && name !== 'home') history.pushState({ screen: name }, '');
  if (name === 'scan') requestAnimationFrame(drawOverlay);
}

function lectureName(input) {
  const d = fmtDate(Date.now());
  const n = input.trim();
  return n ? `${n} – ${d}` : `Vorlesung ${d}`;
}

async function ensurePipeline() {
  if (state.pipeline) return state.pipeline;
  setLoading('Bildverarbeitung wird geladen… (beim ersten Start ein paar Sekunden)');
  try {
    state.cv = await cvPromise;
  } finally {
    setLoading(null);
  }
  state.pipeline = new Pipeline(state.cv, pipelineSettings());
  return state.pipeline;
}

// ---------- Startseite ----------
async function renderHome() {
  revokeUrls();
  let lectures = await store.listLectures();
  // Wurde ein Scan unterbrochen (Tab/App geschlossen, Akku leer …)? Dann Weitermachen anbieten.
  const active = state.scanning ? null : getActiveLecture();
  const resume = active && lectures.find((l) => l.id === active.id);
  if (active && !resume?.slideCount) {
    setActiveLecture(null);
    if (resume) { // leer unterbrochen → wie beim normalen Beenden nicht aufheben
      await store.deleteLecture(resume.id);
      lectures = lectures.filter((l) => l !== resume);
    }
  }
  const showResume = !!resume?.slideCount;
  els.resumeCard.hidden = !showResume;
  if (showResume) {
    state.resumeLecture = resume;
    els.resumeName.textContent = resume.name;
    els.resumeMeta.textContent = `${plural(resume.slideCount)} · zuletzt ${new Date(resume.updated).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`;
  }
  els.emptyLectures.hidden = lectures.length > 0;
  const items = await Promise.all(lectures.map(async (l) => {
    const li = document.createElement('li');
    li.className = 'lecture';
    const img = document.createElement('img');
    img.className = 'lthumb';
    img.alt = '';
    const first = await store.firstSlide(l.id);
    if (first?.thumb) img.src = trackUrl(first.thumb);
    const main = document.createElement('div');
    main.className = 'lmain';
    const name = document.createElement('div');
    name.className = 'lname';
    name.textContent = l.name;
    const meta = document.createElement('div');
    meta.className = 'lmeta';
    meta.textContent = `${fmtDate(l.created)} · ${plural(l.slideCount || 0)}`;
    main.append(name, meta);
    main.addEventListener('click', () => openGallery(l.id));
    img.addEventListener('click', () => openGallery(l.id));
    const btns = document.createElement('div');
    btns.className = 'lbtns';
    btns.append(
      iconButton('i-share', 'PDF teilen', () => sharePdf(l)),
      iconButton('i-trash', 'Löschen', () => removeLecture(l)),
    );
    li.append(img, main, btns);
    return li;
  }));
  els.lectureList.replaceChildren(...items);
}

function iconButton(icon, label, onClick) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg>`;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

async function removeLecture(l) {
  if (!confirm(`„${l.name}“ mit ${plural(l.slideCount || 0)} löschen? Das lässt sich nicht rückgängig machen.`)) return;
  await store.deleteLecture(l.id);
  renderHome();
}

function showHome(push = false) {
  showScreen('home', push);
  renderHome();
}

// ---------- Scannen ----------
async function startScan(lecture, mode = 'camera', file = null) {
  let pipeline;
  try {
    pipeline = await ensurePipeline();
  } catch (e) {
    alert(`${e.message}. Bitte Seite neu laden.`);
    return;
  }
  Object.assign(state, {
    lecture, mode, lastSlideId: null, lastSlideNo: lecture.slideCount || 0, paused: false,
    videoDone: false, videoTime: 0, quad: null, quadState: 'none', status: 'search',
  });
  pipeline.setSettings(pipelineSettings());
  pipeline.reset();
  pipeline.lock(null);
  pipeline.setRotation(null);
  showScreen('scan');
  $('scan').classList.toggle('camera', mode === 'camera');
  updatePauseButton();
  updateLockButton();
  await refreshScanThumb();
  setStatus(mode === 'camera' ? 'Starte Kamera…' : 'Lade Video…');
  try {
    if (mode === 'camera') {
      await startCamera(els.video);
      keepAwake(true);
      startMotion();
    } else {
      await loadVideoFile(els.video, file);
      els.videoProgress.hidden = false;
      els.videoProgressBar.style.width = '0%';
    }
  } catch (e) {
    setStatus(e.message || 'Kamera nicht verfügbar', 'bad');
    return;
  }
  updateRotation(); // Video: immer aufrecht; Kamera: Querformat-Anzeige oder Lagesensor
  await setupZoom();
  state.searchSince = performance.now();
  state.scanning = true;
  setActiveLecture(lecture.id);
  emitLectureStart(lecture);
  store.requestPersistence();
  if (mode === 'camera') cameraLoop();
  else videoLoop();
}

async function stopScan() {
  state.scanning = false;
  setActiveLecture(null); // regulär beendet → kein „Weitermachen“-Hinweis
  clearTimeout(state.loopTimer);
  try { await state.stepPromise; } catch { /* schon protokolliert */ }
  stopCamera(els.video);
  els.video.pause();
  if (els.video.src) {
    URL.revokeObjectURL(els.video.src);
    els.video.removeAttribute('src');
    els.video.load();
  }
  keepAwake(false);
  stopMotion();
  leaveLandscape();
  els.video.style.transform = '';
  els.scanHint.hidden = true;
  els.videoProgress.hidden = true;
  if (!state.lecture) return null;
  const lec = await store.getLecture(state.lecture.id);
  if (lec && !lec.slideCount) {
    await store.deleteLecture(lec.id); // leere Vorlesung nicht aufheben
    return null;
  }
  return lec;
}

async function exitScan(push = true) {
  const lec = await stopScan();
  if (lec) openGallery(lec.id, push);
  else showHome(false);
}

function cameraLoop() {
  if (!state.scanning || state.mode !== 'camera') return;
  const t0 = performance.now();
  state.stepPromise = cameraStep().catch((e) => console.error(e));
  state.stepPromise.then(() => {
    if (!state.scanning) return;
    state.loopTimer = setTimeout(cameraLoop, Math.max(40, 250 - (performance.now() - t0)));
  });
}

async function cameraStep() {
  const v = els.video;
  if (document.hidden || v.readyState < 2 || !v.videoWidth || state.drag || els.cropper.open) return;
  const res = await state.pipeline.analyze(v, v.videoWidth, v.videoHeight, performance.now(), {
    auto: state.settings.auto && !state.paused,
  });
  handleResult(res);
  if (res.event && state.scanning) await saveCapture(res.event);
}

async function videoLoop() {
  const v = els.video;
  const dur = v.duration;
  while (state.scanning && state.mode === 'video') {
    if (state.paused || state.drag) { await sleep(150); continue; }
    if (state.videoTime > dur) break;
    const t = Math.min(state.videoTime, Math.max(0, dur - 0.05));
    state.stepPromise = (async () => {
      await seekTo(v, t);
      const res = await state.pipeline.analyze(v, v.videoWidth, v.videoHeight, t * 1000, { auto: true });
      handleResult(res);
      if (res.event) await saveCapture(res.event);
    })();
    try { await state.stepPromise; } catch (e) { console.error(e); }
    state.videoTime += Number(state.settings.videoStep) || 0.5;
    els.videoProgressBar.style.width = `${Math.min(100, (state.videoTime / dur) * 100)}%`;
  }
  if (state.scanning && state.mode === 'video') {
    state.videoDone = true;
    setStatus(`Video fertig – ${plural(state.lecture.slideCount || 0)}`, 'locked');
    toast('Video komplett analysiert');
  }
}

function handleResult(res) {
  if (res.status === 'search' && state.status !== 'search') state.searchSince = performance.now();
  state.quad = res.quad;
  state.quadState = res.quadState;
  state.status = res.status;
  state.progress = res.progress || 0;
  updateStatus();
  if (res.status === 'duplicate') toast('Folie war schon dabei – übersprungen');
}

function updateStatus() {
  if (state.videoDone) return;
  const s = state.status, locked = state.quadState === 'locked';
  let text, tone;
  if (state.paused) { text = 'Pausiert'; tone = 'idle'; }
  else if (s === 'paused') { text = 'Auto-Aufnahme aus – Auslöser benutzen'; tone = locked ? 'locked' : 'ok'; }
  else {
    switch (s) {
      case 'search': text = 'Suche Folie…'; tone = 'idle'; break;
      case 'tracking': text = 'Folie gefunden – ruhig halten'; tone = 'busy'; break;
      case 'watch': text = locked ? 'Rahmen fixiert – warte auf neue Folie' : 'Bereit – warte auf neue Folie'; tone = locked ? 'locked' : 'ok'; break;
      case 'candidate': text = 'Neue Folie – ruhig halten…'; tone = 'busy'; break;
      case 'captured': text = 'Folie gespeichert'; tone = 'ok'; break;
      case 'duplicate': text = 'Folie schon vorhanden'; tone = 'ok'; break;
      case 'blank': text = 'Projektion leer oder dunkel'; tone = 'idle'; break;
      case 'occluded': text = 'Folie verdeckt – warte…'; tone = 'busy'; break;
      default: text = 'Suche Folie…'; tone = 'idle';
    }
  }
  if (state.quadState === 'held' && s !== 'candidate') { text = 'Folie kurz verdeckt'; tone = 'busy'; }
  setStatus(text, tone);
  updateHint();
}

function updateHint() {
  let hint = '';
  if (state.scanning && !state.paused && !state.videoDone) {
    const searching = state.status === 'search' && performance.now() - state.searchSince > 3000;
    const portraitUi = window.innerHeight > window.innerWidth;
    if (searching) hint = 'Folie nicht gefunden? Tippe sie an – oder Zoom ändern (zwei Finger), sodass die ganze Folie im Bild ist.';
    else if (state.mode === 'camera' && portraitUi && motion.deviceRot === 0) hint = 'Tipp: Handy quer halten – dann wird die Folie größer und schärfer.';
  }
  els.scanHint.textContent = hint;
  els.scanHint.hidden = !hint;
}

// Originalfoto (Canvas oder ImageBitmap) als JPEG – damit lässt sich der Ausschnitt später korrigieren.
async function frameToBlob(frame) {
  let c = frame;
  if (!(frame instanceof HTMLCanvasElement)) {
    c = document.createElement('canvas');
    c.width = frame.width;
    c.height = frame.height;
    c.getContext('2d').drawImage(frame, 0, 0);
    frame.close?.();
  }
  return canvasToBlob(c, 'image/jpeg', 0.88);
}

async function slideData(image) {
  const blob = await canvasToBlob(image.canvas, 'image/jpeg', 0.85);
  const thumb = await canvasToBlob(scaleCanvas(image.canvas, 360), 'image/jpeg', 0.7);
  return { blob, thumb, width: image.width, height: image.height };
}

async function saveCapture({ image, type, frame, quad, zoom }) {
  const lecture = state.lecture;
  const data = await slideData(image);
  if (frame) Object.assign(data, { source: await frameToBlob(frame), quad, zoom: zoom || 1 });
  let slide = null;
  if (type === 'replace' && state.lastSlideId != null) slide = await store.replaceSlide(state.lastSlideId, data);
  const replaced = !!slide;
  if (!slide) slide = await store.addSlide(lecture.id, data);
  state.lastSlideId = slide.id;
  state.lecture = (await store.getLecture(lecture.id)) || lecture;
  setActiveLecture(lecture.id);
  const edit = { label: 'Bearbeiten', onClick: () => openCropper(slide) };
  if (replaced) {
    await emitSlideReplaced(slide, state.lecture);
    toast(`↻ Folie ${state.lastSlideNo} ergänzt`, 3000, slide.source && edit);
  } else {
    state.lastSlideNo = state.lecture.slideCount;
    await emitSlideAdded(slide, state.lecture);
    toast(`✓ Folie ${state.lastSlideNo} gespeichert`, 3000, slide.source && edit);
  }
  setScanThumb(data.thumb, state.lecture.slideCount);
  els.flash.classList.remove('on');
  void els.flash.offsetWidth;
  els.flash.classList.add('on');
  if (state.settings.vibrate) navigator.vibrate?.(replaced ? 30 : 60);
  return slide;
}

// Auslöser: Foto festhalten, erst danach darin die Folie suchen und ausschneiden.
let capturing = false;
async function manualCapture() {
  const v = els.video;
  if (!state.scanning || !v.videoWidth || capturing) return;
  capturing = true;
  try {
    const shot = state.pipeline.captureStill(v, v.videoWidth, v.videoHeight);
    const slide = await saveCapture({ ...shot, type: 'add' });
    if (shot.how === 'full') {
      toast('Keine Folie erkannt – ganzes Bild gespeichert', 4000, { label: 'Zuschneiden', onClick: () => openCropper(slide) });
    }
  } catch (e) {
    console.error(e);
    toast('Aufnahme fehlgeschlagen');
  } finally {
    capturing = false;
  }
}

let thumbUrl = null;
function setScanThumb(blob, count) {
  if (thumbUrl) URL.revokeObjectURL(thumbUrl);
  thumbUrl = blob ? URL.createObjectURL(blob) : null;
  if (thumbUrl) els.lastThumb.src = thumbUrl;
  else els.lastThumb.removeAttribute('src');
  els.slideCount.textContent = String(count || 0);
  els.btnGallery.classList.remove('bump');
  void els.btnGallery.offsetWidth;
  if (blob) els.btnGallery.classList.add('bump');
}

async function refreshScanThumb() {
  const last = state.lecture ? await store.lastSlide(state.lecture.id) : null;
  if (thumbUrl) URL.revokeObjectURL(thumbUrl);
  thumbUrl = last?.thumb ? URL.createObjectURL(last.thumb) : null;
  if (thumbUrl) els.lastThumb.src = thumbUrl;
  else els.lastThumb.removeAttribute('src');
  els.slideCount.textContent = String(state.lecture?.slideCount || 0);
}

function updatePauseButton() {
  els.btnPause.classList.toggle('on', state.paused);
  els.btnPause.setAttribute('aria-label', state.paused ? 'Weiter' : 'Pause');
  els.btnPause.querySelector('use').setAttribute('href', state.paused ? '#i-play' : '#i-pause');
}

function updateLockButton() {
  const on = !!state.pipeline?.locked;
  els.btnLock.classList.toggle('on', on);
  els.btnLock.setAttribute('aria-label', on ? 'Rahmen lösen' : 'Rahmen fixieren');
  els.btnLock.querySelector('use').setAttribute('href', on ? '#i-lock' : '#i-unlock');
}

function toggleLock() {
  const p = state.pipeline;
  if (!p) return;
  if (p.locked) {
    p.lock(null);
    toast('Automatische Erkennung an');
  } else if (state.quad) {
    p.lock(state.quad);
    toast('Rahmen fixiert – Ecken lassen sich verschieben');
  } else {
    const i = 0.15;
    p.lock([{ x: i, y: i }, { x: 1 - i, y: i }, { x: 1 - i, y: 1 - i }, { x: i, y: 1 - i }]);
    toast('Zieh die Ecken auf die Folie');
  }
  state.quad = p.locked || state.quad;
  state.quadState = p.locked ? 'locked' : state.quadState;
  updateLockButton();
}

// ---------- Overlay (Rahmen wie bei Adobe Scan) ----------
function videoRect() {
  const v = els.video, cw = els.overlay.clientWidth, ch = els.overlay.clientHeight;
  const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
  const s = Math.min(cw / vw, ch / vh);
  const w = vw * s, h = vh * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

function drawOverlay() {
  if (state.screen !== 'scan') return;
  const c = els.overlay, dpr = window.devicePixelRatio || 1;
  const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
  const q = state.pipeline?.locked || state.quad;
  if (q && els.video.videoWidth) {
    const r = videoRect();
    const pts = q.map((p) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h }));
    const locked = !!state.pipeline?.locked;
    const candidate = state.status === 'candidate' && !state.paused;
    const solid = locked || state.quadState === 'stable';
    const color = candidate ? '#f5a524' : locked ? '#29c46f' : solid ? '#4d84ff' : 'rgba(255,255,255,.85)';
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = candidate ? 'rgba(245,165,36,.12)' : locked ? 'rgba(41,196,111,.10)' : 'rgba(77,132,255,.12)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.setLineDash(solid || candidate ? [] : [10, 8]);
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.setLineDash([]);
    const rad = locked ? 12 : 6;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
    if (candidate && state.progress > 0) {
      const cx = pts.reduce((s, p) => s + p.x, 0) / 4, cy = pts.reduce((s, p) => s + p.y, 0) / 4;
      ctx.beginPath();
      ctx.arc(cx, cy, 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, state.progress));
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#f5a524';
      ctx.stroke();
    }
  }
  const tm = state.tapMark;
  if (tm && els.video.videoWidth) {
    const age = (performance.now() - tm.t) / 700;
    if (age < 1) {
      const r = videoRect();
      ctx.beginPath();
      ctx.arc(r.x + tm.x * r.w, r.y + tm.y * r.h, 18 + age * 30, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(255,255,255,${1 - age})`;
      ctx.stroke();
    } else state.tapMark = null;
  }
  requestAnimationFrame(drawOverlay);
}

// Gesten im Kamerabild:
//  - Ecke ziehen   → Rahmen anpassen (fixiert ihn automatisch)
//  - kurz tippen   → diese Folie auswählen und verfolgen
//  - zwei Finger   → zoomen
function setupGestures() {
  const c = els.overlay;
  const pointers = new Map();
  let pinch = null, tap = null;
  const local = (e) => {
    const b = c.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const toNorm = (pt, clamp = true) => {
    const r = videoRect();
    const n = { x: (pt.x - r.x) / r.w, y: (pt.y - r.y) / r.h };
    return clamp ? { x: Math.min(1, Math.max(0, n.x)), y: Math.min(1, Math.max(0, n.y)) } : n;
  };
  const pinchDist = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  c.addEventListener('pointerdown', (e) => {
    if (!state.pipeline || !els.video.videoWidth) return;
    try { c.setPointerCapture(e.pointerId); } catch { /* z. B. Zeiger schon weg */ }
    pointers.set(e.pointerId, local(e));
    e.preventDefault();
    if (pointers.size === 2) {
      // Zweiter Finger: Zoom statt Ziehen/Tippen
      if (state.drag) endDrag();
      tap = null;
      pinch = { dist: Math.max(10, pinchDist()), zoom: state.zoom };
      return;
    }
    if (pointers.size > 2) return;
    const p = state.pipeline;
    const q = p.locked || state.quad;
    const pt = local(e);
    if (q) {
      const r = videoRect();
      let best = -1, bestD = 44;
      q.forEach((qp, i) => {
        const d = Math.hypot(r.x + qp.x * r.w - pt.x, r.y + qp.y * r.h - pt.y);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best >= 0) {
        if (!p.locked) p.lock(q);
        state.drag = { i: best, id: e.pointerId };
        updateLockButton();
        return;
      }
    }
    tap = { id: e.pointerId, x: pt.x, y: pt.y, t: performance.now() };
  });

  c.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const pt = local(e);
    pointers.set(e.pointerId, pt);
    if (pinch && pointers.size >= 2) {
      setZoom(pinch.zoom * (pinchDist() / pinch.dist));
      return;
    }
    if (state.drag && e.pointerId === state.drag.id) {
      state.pipeline.locked[state.drag.i] = toNorm(pt);
      return;
    }
    if (tap && e.pointerId === tap.id && Math.hypot(pt.x - tap.x, pt.y - tap.y) > 12) tap = null;
  });

  function endDrag() {
    state.drag = null;
    const p = state.pipeline;
    p.lock(p.locked);
    if (state.lecture?.slideCount) {
      p.rebaseline();
      toast('Rahmen angepasst – Auslöser nimmt die Folie neu auf', 2600);
    } else {
      p.change.reset();
    }
  }

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return;
    }
    if (state.drag && e.pointerId === state.drag.id) { endDrag(); return; }
    if (tap && e.pointerId === tap.id && e.type === 'pointerup' && performance.now() - tap.t < 450) {
      const n = toNorm(tap, false);
      if (n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1) selectSlideAt(n);
    }
    tap = null;
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
}

// Angetippte Stelle: genau diese Folie suchen und verfolgen.
function selectSlideAt(pt) {
  const p = state.pipeline;
  if (p.locked) { p.lock(null); updateLockButton(); }
  p.setFocus(pt);
  state.quad = null;
  state.tapMark = { ...pt, t: performance.now() };
  const crop = p.crop;
  focusAt({ x: crop.x + pt.x * crop.w, y: crop.y + pt.y * crop.h });
  toast('Folie ausgewählt');
}

// ---------- Zoom ----------
function zoomLimits() {
  return state.zoomHw ? { min: state.zoomHw.min, max: Math.min(state.zoomHw.max, 10) } : { min: 1, max: 4 };
}

async function setupZoom() {
  state.zoomHw = state.mode === 'camera' ? zoomControl() : null;
  state.zoom = state.zoomHw ? state.zoomHw.value || 1 : 1;
  state.pipeline.setDigitalZoom(1);
  els.video.style.transform = '';
  const wanted = state.mode === 'camera' ? Number(state.settings.zoom) || 1 : 1;
  setZoom(wanted);
  updateZoomButton();
}

let zoomQueued = false;
let zoomSaveTimer = null;
function setZoom(z) {
  const { min, max } = zoomLimits();
  z = Math.min(max, Math.max(min, z));
  const old = state.zoom || 1;
  if (Math.abs(z - old) < 0.01) { updateZoomButton(); return; }
  state.zoom = z;
  // Fixierten Rahmen und angetippte Stelle mitskalieren (Zoom um die Bildmitte).
  const ratio = z / old;
  const scale = (pt) => ({ x: 0.5 + (pt.x - 0.5) * ratio, y: 0.5 + (pt.y - 0.5) * ratio });
  const p = state.pipeline;
  if (p.locked) p.lock(p.locked.map(scale));
  if (p.focus) p.focus = scale(p.focus);
  p.tracker.reset();
  state.quad = null;
  p.opticalZoom = state.zoomHw ? z : 1;
  if (state.zoomHw) {
    // Kamera-Zoom gebündelt anwenden (Zwei-Finger-Geste liefert viele Werte).
    if (!zoomQueued) {
      zoomQueued = true;
      requestAnimationFrame(() => { zoomQueued = false; state.zoomHw?.set(state.zoom); });
    }
  } else {
    p.setDigitalZoom(z);
    els.video.style.transform = z > 1.001 ? `scale(${z})` : '';
  }
  updateZoomButton();
  if (state.mode === 'camera') {
    state.settings.zoom = z;
    clearTimeout(zoomSaveTimer);
    zoomSaveTimer = setTimeout(saveSettings, 600);
  }
}

function updateZoomButton() {
  const z = state.zoom || 1;
  const txt = Math.abs(z - Math.round(z)) < 0.05 ? String(Math.round(z)) : z.toFixed(1).replace('.', ',');
  els.btnZoom.textContent = `${txt}×`;
  els.btnZoom.classList.toggle('on', z > 1.05);
}

function cycleZoom() {
  const { min, max } = zoomLimits();
  const steps = [1, 2, 3, 5, 8].filter((v) => v >= min && v <= max);
  const next = steps.find((v) => v > state.zoom + 0.05);
  setZoom(next ?? Math.max(1, min));
}

// ---------- Lage des Handys ----------
// Ist die Bildschirmdrehung gesperrt, kommt das Kamerabild bei quer gehaltenem Handy gedreht an.
// Der Lagesensor sagt, wo „oben“ ist, damit die Folie richtig herum gespeichert wird.
const motion = { deviceRot: null, handler: null };

function requestMotionPermission() {
  const DME = window.DeviceMotionEvent;
  if (DME && typeof DME.requestPermission === 'function') DME.requestPermission().catch(() => {});
}

function startMotion() {
  if (motion.handler || !('DeviceMotionEvent' in window)) return;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  motion.handler = (e) => {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null || g.y == null) return;
    const x = ios ? -g.x : g.x, y = ios ? -g.y : g.y; // iOS meldet die Werte mit umgekehrtem Vorzeichen
    if (Math.hypot(x, y) < 4) return;                 // liegt flach → letzte Lage behalten
    const deg = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360; // 0 = hochkant, 90 = oben nach links
    const snapped = (Math.round(deg / 90) % 4) * 90;
    if (Math.abs(((deg - snapped + 540) % 360) - 180) > 35) return; // dazwischen → nicht umschalten
    if (snapped !== motion.deviceRot) {
      motion.deviceRot = snapped;
      updateRotation();
    }
  };
  window.addEventListener('devicemotion', motion.handler);
}

function stopMotion() {
  if (motion.handler) window.removeEventListener('devicemotion', motion.handler);
  motion.handler = null;
  motion.deviceRot = null;
}

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return typeof window.orientation === 'number' ? (window.orientation + 360) % 360 : 0;
}

function updateRotation() {
  const p = state.pipeline;
  if (!p) return;
  if (state.mode !== 'camera') { p.setRotation(0); return; }
  const angle = screenAngle();
  // Anzeige im Querformat folgt dem Handy → Bild steht richtig herum.
  if (angle === 90 || angle === 270) { p.setRotation(0); return; }
  if (motion.deviceRot == null) { p.setRotation(null); return; } // unbekannt → nach Form raten
  p.setRotation((((motion.deviceRot - angle) % 360) + 360) % 360);
}

// ---------- Vollbild im Querformat (Android) ----------
function enterLandscape() {
  if (!state.settings.forceLandscape) return;
  const el = document.documentElement;
  if (!el.requestFullscreen || document.fullscreenElement) return;
  el.requestFullscreen({ navigationUI: 'hide' })
    .then(() => screen.orientation?.lock?.('landscape'))
    .then(updateRotation)
    .catch(() => {});
}

function leaveLandscape() {
  try { screen.orientation?.unlock?.(); } catch { /* egal */ }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ---------- PDF ----------
async function sharePdf(lecture) {
  if (!lecture.slideCount) { toast('Noch keine Folien'); return; }
  let entry = pdfOut.peek(lecture);
  try {
    if (!entry) {
      setLoading('PDF wird erstellt…');
      entry = await pdfOut.get(lecture);
    }
  } catch (e) {
    console.error(e);
    toast('PDF konnte nicht erstellt werden');
    return;
  } finally {
    setLoading(null);
  }
  const r = await shareOrDownload(entry.blob, pdfFileName(lecture.name), lecture.name);
  if (r === 'downloaded') toast(`PDF heruntergeladen (${plural(entry.pages)})`);
}

async function downloadPdf(lecture) {
  if (!lecture.slideCount) { toast('Noch keine Folien'); return; }
  try {
    setLoading('PDF wird erstellt…');
    const entry = pdfOut.peek(lecture) || (await pdfOut.get(lecture));
    downloadBlob(entry.blob, pdfFileName(lecture.name));
  } catch (e) {
    console.error(e);
    toast('PDF konnte nicht erstellt werden');
  } finally {
    setLoading(null);
  }
}

// ---------- Galerie ----------
async function openGallery(lectureId, push = true) {
  const lecture = await store.getLecture(lectureId);
  if (!lecture) return showHome();
  state.galleryLecture = lecture;
  showScreen('gallery', push);
  await renderGallery();
  if (lecture.slideCount) pdfOut.get(lecture).catch(() => {}); // im Hintergrund vorbereiten
}

async function renderGallery() {
  revokeUrls();
  const lecture = (await store.getLecture(state.galleryLecture.id)) || state.galleryLecture;
  state.galleryLecture = lecture;
  const slides = await store.listSlides(lecture.id);
  els.galTitle.textContent = lecture.name;
  els.galMeta.textContent = `${plural(slides.length)} · ${fmtDate(lecture.created)}`;
  els.galEmpty.hidden = slides.length > 0;
  $('galShare').disabled = $('galDownload').disabled = !slides.length;
  els.galGrid.replaceChildren(...slides.map((s, i) => {
    const b = document.createElement('button');
    b.className = 'tile';
    b.style.aspectRatio = `${s.width} / ${s.height}`;
    const img = document.createElement('img');
    img.src = trackUrl(s.thumb || s.blob);
    img.alt = `Folie ${i + 1}`;
    img.loading = 'lazy';
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);
    b.append(img, num);
    b.addEventListener('click', () => openViewer(s, i + 1));
    return b;
  }));
}

let viewerUrl = null;
function openViewer(slide, no) {
  state.viewerSlide = slide;
  state.viewerNo = no;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(slide.blob);
  els.viewerImg.src = viewerUrl;
  els.viewerInfo.textContent = `Folie ${no}`;
  els.viewerCrop.disabled = !slide.source;
  els.viewerCrop.title = slide.source ? 'Ausschnitt korrigieren' : 'Für Folien aus älteren Versionen nicht möglich';
  if (!els.viewer.open) els.viewer.showModal();
}

// ---------- Ausschnitt bearbeiten ----------
// Zeigt das gespeicherte Originalfoto; die vier Ecken lassen sich verschieben.
// Die obere Kante (dicker, „oben“) bestimmt, wie herum die Folie im PDF steht.
const crop = { slide: null, img: null, w: 0, h: 0, quad: null, drag: null, view: null, previewUrl: null, previewTimer: null };

async function openCropper(slide) {
  slide = (await store.getSlide(slide.id)) || slide;
  if (!slide.source) { toast('Für diese Folie ist kein Originalfoto gespeichert'); return; }
  try {
    await ensurePipeline();
    const img = await createImageBitmap(slide.source);
    crop.img?.close?.();
    Object.assign(crop, {
      slide, img, w: img.width, h: img.height, drag: null,
      quad: (slide.quad || FULL_FRAME).map((p) => ({ x: p.x, y: p.y })),
    });
  } catch (e) {
    console.error(e);
    toast('Originalfoto konnte nicht geladen werden');
    return;
  }
  els.cropInfo.textContent = 'Ecken auf die Folie ziehen';
  els.cropper.showModal();
  requestAnimationFrame(() => { drawCrop(); updateCropPreview(); });
}

function cropView() {
  const c = els.cropCanvas, cw = c.clientWidth, ch = c.clientHeight, pad = 22;
  const s = Math.min((cw - 2 * pad) / crop.w, (ch - 2 * pad) / crop.h);
  const w = crop.w * s, h = crop.h * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h, s };
}

function drawCrop() {
  if (!els.cropper.open || !crop.img) return;
  const c = els.cropCanvas, dpr = window.devicePixelRatio || 1;
  const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
  const v = crop.view = cropView();
  ctx.drawImage(crop.img, v.x, v.y, v.w, v.h);
  const pts = crop.quad.map((p) => ({ x: v.x + p.x * v.w, y: v.y + p.y * v.h }));
  // Außerhalb abdunkeln
  ctx.beginPath();
  ctx.rect(v.x, v.y, v.w, v.h);
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.fill('evenodd');
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#4d84ff';
  ctx.stroke();
  // Obere Kante markieren
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  ctx.lineTo(pts[1].x, pts[1].y);
  ctx.lineWidth = 5;
  ctx.stroke();
  const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
  ctx.font = '600 12px system-ui, sans-serif';
  const label = 'oben';
  const tw = ctx.measureText(label).width + 12;
  ctx.fillStyle = '#4d84ff';
  ctx.beginPath();
  ctx.roundRect?.(mx - tw / 2, my - 10, tw, 20, 10);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, mx, my);
  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, crop.drag?.i === i ? 16 : 12, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#4d84ff';
    ctx.stroke();
  });
  if (crop.drag) drawLoupe(ctx, v, pts[crop.drag.i]);
}

// Lupe beim Ziehen: Ausschnitt um die Ecke vergrößert (der Finger verdeckt sie sonst).
function drawLoupe(ctx, v, p) {
  const r = 52, zoom = 3;
  const cw = els.cropCanvas.clientWidth;
  const cx = p.x < cw / 2 ? cw - r - 12 : r + 12, cy = r + 12;
  const sx = (p.x - v.x) / v.s, sy = (p.y - v.y) / v.s; // Ecke in Fotopixeln
  const half = r / (v.s * zoom);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#000';
  ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  ctx.drawImage(crop.img, sx - half, sy - half, 2 * half, 2 * half, cx - r, cy - r, 2 * r, 2 * r);
  ctx.strokeStyle = '#4d84ff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy);
  ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10);
  ctx.stroke();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

function updateCropPreview(delay = 0) {
  clearTimeout(crop.previewTimer);
  crop.previewTimer = setTimeout(async () => {
    if (!els.cropper.open || !crop.img) return;
    try {
      const out = state.pipeline.renderFromFrame(crop.img, crop.w, crop.h, crop.quad, { zoom: crop.slide.zoom || 1, outWidth: 480 });
      const blob = await canvasToBlob(out.canvas, 'image/jpeg', 0.8);
      if (crop.previewUrl) URL.revokeObjectURL(crop.previewUrl);
      crop.previewUrl = URL.createObjectURL(blob);
      els.cropPreview.src = crop.previewUrl;
    } catch (e) { console.error(e); }
  }, delay);
}

function setupCropGestures() {
  const c = els.cropCanvas;
  const local = (e) => {
    const b = c.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  c.addEventListener('pointerdown', (e) => {
    if (!crop.view || crop.drag) return;
    const pt = local(e), v = crop.view;
    let best = -1, bestD = 48;
    crop.quad.forEach((q, i) => {
      const d = Math.hypot(v.x + q.x * v.w - pt.x, v.y + q.y * v.h - pt.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) return;
    e.preventDefault();
    try { c.setPointerCapture(e.pointerId); } catch { /* egal */ }
    const q = crop.quad[best];
    // Versatz merken: Die Ecke springt nicht unter den Finger, sondern bleibt sichtbar daneben.
    crop.drag = { i: best, id: e.pointerId, dx: v.x + q.x * v.w - pt.x, dy: v.y + q.y * v.h - pt.y };
    drawCrop();
  });
  c.addEventListener('pointermove', (e) => {
    if (!crop.drag || e.pointerId !== crop.drag.id) return;
    const pt = local(e), v = crop.view;
    crop.quad[crop.drag.i] = {
      x: Math.min(1, Math.max(0, (pt.x + crop.drag.dx - v.x) / v.w)),
      y: Math.min(1, Math.max(0, (pt.y + crop.drag.dy - v.y) / v.h)),
    };
    drawCrop();
  });
  const end = (e) => {
    if (!crop.drag || e.pointerId !== crop.drag.id) return;
    crop.drag = null;
    drawCrop();
    updateCropPreview(50);
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
}

// Neu erkannte Ecken so durchnummerieren, dass „oben“ möglichst bleibt, wo es war.
function keepOrientation(next, prev) {
  let best = next, bestD = Infinity;
  for (let k = 0; k < 4; k++) {
    const r = next.map((_, i) => next[(i + k) % 4]);
    const d = r.reduce((s, p, i) => s + Math.hypot(p.x - prev[i].x, p.y - prev[i].y), 0);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

function cropAuto() {
  const q = state.pipeline.detectInImage(crop.img, crop.w, crop.h, crop.slide.zoom || 1);
  if (!q) { toast('Keine Folie gefunden – bitte Ecken von Hand setzen', 2600); return; }
  crop.quad = keepOrientation(q, crop.quad);
  drawCrop();
  updateCropPreview();
}

function cropRotate() {
  const q = crop.quad;
  crop.quad = [q[3], q[0], q[1], q[2]]; // 90° im Uhrzeigersinn
  drawCrop();
  updateCropPreview();
}

function cropFull() {
  crop.quad = FULL_FRAME.map((p) => ({ ...p }));
  drawCrop();
  updateCropPreview();
}

async function cropApply() {
  const { slide } = crop;
  try {
    setLoading('Folie wird neu zugeschnitten…');
    const image = state.pipeline.renderFromFrame(crop.img, crop.w, crop.h, crop.quad, { zoom: slide.zoom || 1 });
    const data = await slideData(image);
    const updated = await store.replaceSlide(slide.id, { ...data, quad: crop.quad });
    const lecture = await store.getLecture(slide.lectureId);
    if (updated && lecture) await emitSlideReplaced(updated, lecture);
    els.cropper.close();
    toast('Ausschnitt übernommen');
    if (state.screen === 'scan') {
      if (state.lecture?.id === slide.lectureId) await refreshScanThumb();
    } else if (state.screen === 'gallery') {
      await renderGallery();
    }
    if (els.viewer.open && updated && state.viewerSlide?.id === slide.id) openViewer(updated, state.viewerNo);
  } catch (e) {
    console.error(e);
    toast('Zuschneiden fehlgeschlagen');
  } finally {
    setLoading(null);
  }
}

function closeCropper() {
  clearTimeout(crop.previewTimer);
  crop.img?.close?.();
  crop.img = null;
  if (crop.previewUrl) URL.revokeObjectURL(crop.previewUrl);
  crop.previewUrl = null;
  els.cropPreview.removeAttribute('src');
}

async function deleteViewerSlide() {
  const s = state.viewerSlide;
  if (!s || !confirm('Diese Folie löschen?')) return;
  await store.deleteSlide(s.id);
  if (state.lastSlideId === s.id) state.lastSlideId = null;
  const lecture = await store.getLecture(s.lectureId);
  if (lecture) await emitSlideDeleted(s.id, lecture);
  els.viewer.close();
  renderGallery();
}

// ---------- Einstellungen ----------
function openSettings() {
  const f = els.settingsForm;
  const s = state.settings;
  f.auto.checked = !!s.auto;
  f.sensitivity.value = s.sensitivity;
  f.stableSec.value = s.stableSec;
  f.merge.checked = !!s.merge;
  f.skipDuplicates.checked = !!s.skipDuplicates;
  f.vibrate.checked = !!s.vibrate;
  f.forceLandscape.checked = !!s.forceLandscape;
  f.filter.value = s.filter;
  f.aspect.value = s.aspect;
  f.videoStep.value = String(s.videoStep);
  // Vor dem Scan: alles außer Belichtung und Rahmen (die brauchen ein laufendes Kamerabild).
  $('frameFieldset').hidden = !state.scanning;
  $('settingsNote').hidden = state.scanning;
  const ec = state.mode === 'camera' && state.scanning ? exposureControl() : null;
  els.exposureRow.hidden = !ec;
  if (ec) {
    Object.assign(f.exposure, { min: ec.min, max: ec.max, step: ec.step, value: ec.value });
    f.exposure.oninput = () => { ec.set(Number(f.exposure.value)); updateOutputs(); };
  }
  updateOutputs();
  els.settings.showModal();
}

function updateOutputs() {
  const f = els.settingsForm;
  f.sensitivityOut.value = f.sensitivity.value;
  f.stableSecOut.value = `${Number(f.stableSec.value).toFixed(1).replace('.', ',')} s`;
  f.exposureOut.value = Number(f.exposure.value || 0).toFixed(1).replace('.', ',');
}

function readSettingsForm() {
  const f = els.settingsForm;
  Object.assign(state.settings, {
    auto: f.auto.checked,
    sensitivity: Number(f.sensitivity.value),
    stableSec: Number(f.stableSec.value),
    merge: f.merge.checked,
    skipDuplicates: f.skipDuplicates.checked,
    vibrate: f.vibrate.checked,
    forceLandscape: f.forceLandscape.checked,
    filter: f.filter.value,
    aspect: f.aspect.value,
    videoStep: Number(f.videoStep.value),
  });
  saveSettings();
  state.pipeline?.setSettings(pipelineSettings());
  updateOutputs();
  updateStatus();
}

// ---------- Ereignisse ----------
function bind() {
  $('startForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    enterLandscape();          // braucht den Tipp des Nutzers → vor allem anderen
    requestMotionPermission();
    const lecture = await store.createLecture(lectureName(els.lectureName.value));
    els.lectureName.value = '';
    startScan(lecture, 'camera');
  });
  $('videoFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const base = file.name.replace(/\.[^.]+$/, '');
    const lecture = await store.createLecture(base || lectureName(''));
    startScan(lecture, 'video', file);
  });

  els.btnBack.addEventListener('click', () => history.back());
  els.btnGallery.addEventListener('click', () => history.back());
  els.btnShutter.addEventListener('click', manualCapture);
  els.btnLock.addEventListener('click', toggleLock);
  els.btnPdf.addEventListener('click', () => state.lecture && sharePdf(state.lecture));
  els.btnSettings.addEventListener('click', openSettings);
  $('btnHomeSettings').addEventListener('click', openSettings);
  // Tipp neben das Fenster schließt es (Einstellungen sind dann schon übernommen).
  for (const dlg of [els.settings, els.viewer]) {
    dlg.addEventListener('click', (e) => {
      if (e.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside || dlg === els.viewer) dlg.close();
    });
  }
  els.settings.addEventListener('close', readSettingsForm);
  els.btnPause.addEventListener('click', () => {
    state.paused = !state.paused;
    updatePauseButton();
    updateStatus();
  });
  els.btnZoom.addEventListener('click', cycleZoom);
  setupGestures();
  screen.orientation?.addEventListener?.('change', updateRotation);
  window.addEventListener('orientationchange', updateRotation);
  window.addEventListener('resize', updateHint);

  $('galBack').addEventListener('click', () => history.back());
  $('galShare').addEventListener('click', () => sharePdf(state.galleryLecture));
  $('galDownload').addEventListener('click', () => downloadPdf(state.galleryLecture));
  $('galContinue').addEventListener('click', () => {
    enterLandscape();
    requestMotionPermission();
    startScan(state.galleryLecture, 'camera');
  });
  $('galRename').addEventListener('click', async () => {
    const l = state.galleryLecture;
    const name = prompt('Name der Vorlesung', l.name);
    if (!name || !name.trim()) return;
    await store.renameLecture(l.id, name.trim());
    pdfOut.markDirty(l); // Titel im PDF aktualisieren
    renderGallery();
  });

  $('viewerClose').addEventListener('click', () => els.viewer.close());
  $('viewerDelete').addEventListener('click', deleteViewerSlide);
  els.viewerCrop.addEventListener('click', () => state.viewerSlide && openCropper(state.viewerSlide));

  setupCropGestures();
  $('cropRotate').addEventListener('click', cropRotate);
  $('cropAuto').addEventListener('click', cropAuto);
  $('cropFull').addEventListener('click', cropFull);
  $('cropCancel').addEventListener('click', () => els.cropper.close());
  $('cropApply').addEventListener('click', cropApply);
  els.cropper.addEventListener('close', closeCropper);
  window.addEventListener('resize', () => els.cropper.open && drawCrop());

  $('resumeContinue').addEventListener('click', () => {
    if (!state.resumeLecture) return;
    enterLandscape();
    requestMotionPermission();
    startScan(state.resumeLecture, 'camera');
  });
  $('resumeOpen').addEventListener('click', () => state.resumeLecture && openGallery(state.resumeLecture.id));
  $('resumeDismiss').addEventListener('click', () => { setActiveLecture(null); els.resumeCard.hidden = true; });

  els.settingsForm.addEventListener('input', readSettingsForm);
  els.settingsForm.addEventListener('change', readSettingsForm);
  $('btnFullFrame').addEventListener('click', () => {
    if (!state.pipeline) return;
    state.pipeline.lock(FULL_FRAME);
    state.pipeline.change.reset();
    updateLockButton();
    els.settings.close();
    toast('Ganzes Bild wird verwendet');
  });
  $('btnAutoFrame').addEventListener('click', () => {
    state.pipeline?.lock(null);
    updateLockButton();
    els.settings.close();
    toast('Automatische Erkennung an');
  });

  window.addEventListener('popstate', (e) => {
    if (els.cropper.open) els.cropper.close();
    if (els.viewer.open) els.viewer.close();
    if (els.settings.open) els.settings.close();
    if (state.screen === 'scan') exitScan(e.state?.screen !== 'gallery');
    else if (state.screen === 'gallery') {
      if (e.state?.screen === 'gallery') renderGallery();
      else showHome(false);
    }
  });

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !state.scanning || state.mode !== 'camera') return;
    if (!cameraAlive()) {
      try {
        await startCamera(els.video);
        toast('Kamera neu gestartet');
      } catch (e) {
        setStatus(e.message, 'bad');
      }
    }
  });
}

function registerServiceWorker() {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker:', e));
  }
}

bind();
renderHome();
registerServiceWorker();
