// Kamera (Rückkamera, hohe Auflösung), Belichtung und Bildschirm-Wachhalten.

let stream = null;
let wakeLock = null;
let wantWakeLock = false;

export async function startCamera(video) {
  stopCamera(video);
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Dieser Browser unterstützt keinen Kamerazugriff (HTTPS nötig).');
  }
  const base = { facingMode: { ideal: 'environment' } };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // zoom: true bittet (wo unterstützt) zusätzlich um Zugriff auf den Kamera-Zoom.
      video: { ...base, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, zoom: true },
    });
  } catch (e) {
    if (e.name === 'NotAllowedError') throw new Error('Kamerazugriff wurde verweigert. Bitte in den Browser-Einstellungen erlauben.');
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: base });
  }
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  await waitForSize(video);
  const track = stream.getVideoTracks()[0];
  // Dauerhafter Autofokus, falls das Gerät es anbietet.
  try {
    const caps = track.getCapabilities?.() || {};
    if (caps.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch { /* egal */ }
  return track;
}

export function stopCamera(video) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (video && video.srcObject) video.srcObject = null;
}

export function cameraTrack() {
  return stream?.getVideoTracks()[0] || null;
}

export function cameraAlive() {
  const t = cameraTrack();
  return !!t && t.readyState === 'live';
}

function waitForSize(video) {
  if (video.videoWidth) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('loadedmetadata', done); resolve(); };
    video.addEventListener('loadedmetadata', done);
  });
}

// Belichtungskorrektur (Projektoren sind oft überbelichtet). null, wenn nicht unterstützt.
export function exposureControl() {
  const track = cameraTrack();
  const caps = track?.getCapabilities?.();
  const ec = caps?.exposureCompensation;
  if (!ec || ec.max === ec.min) return null;
  const settings = track.getSettings?.() || {};
  return {
    min: ec.min,
    max: ec.max,
    step: ec.step || 0.1,
    value: settings.exposureCompensation ?? 0,
    async set(v) {
      try {
        await track.applyConstraints({ advanced: [{ exposureMode: 'continuous', exposureCompensation: v }] });
      } catch { /* ignorieren */ }
    },
  };
}

// Kamera-Zoom des Handys (optisch/digital durch die Kamera selbst). null, wenn nicht unterstützt –
// dann zoomt die App selbst digital (Bildausschnitt).
export function zoomControl() {
  const track = cameraTrack();
  const z = track?.getCapabilities?.()?.zoom;
  if (!z || !(z.max > z.min)) return null;
  const settings = track.getSettings?.() || {};
  return {
    min: z.min,
    max: z.max,
    value: settings.zoom ?? z.min,
    async set(v) {
      try { await track.applyConstraints({ advanced: [{ zoom: v }] }); } catch { /* ignorieren */ }
    },
  };
}

// Scharfstellen auf einen Punkt (normiert), falls das Gerät es anbietet.
export async function focusAt(pt) {
  const track = cameraTrack();
  const caps = track?.getCapabilities?.() || {};
  if (!caps.focusMode && !('pointsOfInterest' in (track?.getSettings?.() || {}))) return;
  try {
    await track.applyConstraints({ advanced: [{ pointsOfInterest: [{ x: pt.x, y: pt.y }] }] });
  } catch { /* nicht unterstützt */ }
}

// Videodatei als Quelle (Import einer Aufzeichnung).
export async function loadVideoFile(video, file) {
  stopCamera(video);
  if (video.src) URL.revokeObjectURL(video.src);
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  await waitForSize(video);
  // Manche WebM-Aufnahmen melden keine Länge – ans Ende springen, dann ist sie bekannt.
  if (!isFinite(video.duration)) {
    await seekTo(video, 1e9);
    await seekTo(video, 0);
  }
  if (!isFinite(video.duration) || !video.duration) throw new Error('Videolänge unbekannt – bitte ein anderes Format (MP4) versuchen.');
  return video.duration;
}

export function seekTo(video, t) {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

// Bildschirm anlassen, solange gescannt wird.
export async function keepAwake(on) {
  wantWakeLock = on;
  if (!('wakeLock' in navigator)) return false;
  try {
    if (on && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
    return true;
  } catch {
    return false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantWakeLock) keepAwake(true);
});
