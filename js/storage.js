// IndexedDB-Speicher: Vorlesungen und ihre Folien (JPEG-Blobs).
// Alles bleibt lokal auf dem Gerät und übersteht Neuladen oder Abstürze.

const DB_NAME = 'folienscanner';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('lectures', { keyPath: 'id', autoIncrement: true });
      const slides = db.createObjectStore('slides', { keyPath: 'id', autoIncrement: true });
      slides.createIndex('lecture', 'lectureId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function createLecture(name) {
  const now = Date.now();
  const lecture = { name, created: now, updated: now, slideCount: 0 };
  const id = await tx(['lectures'], 'readwrite', (t) => promisify(t.objectStore('lectures').add(lecture)));
  return { ...lecture, id };
}

export async function getLecture(id) {
  return tx(['lectures'], 'readonly', (t) => promisify(t.objectStore('lectures').get(id)));
}

export async function listLectures() {
  const all = await tx(['lectures'], 'readonly', (t) => promisify(t.objectStore('lectures').getAll()));
  return all.sort((a, b) => b.updated - a.updated);
}

export async function renameLecture(id, name) {
  return tx(['lectures'], 'readwrite', async (t) => {
    const store = t.objectStore('lectures');
    const l = await promisify(store.get(id));
    if (l) { l.name = name; l.updated = Date.now(); store.put(l); }
  });
}

export async function deleteLecture(id) {
  return tx(['lectures', 'slides'], 'readwrite', async (t) => {
    const keys = await promisify(t.objectStore('slides').index('lecture').getAllKeys(id));
    for (const k of keys) t.objectStore('slides').delete(k);
    t.objectStore('lectures').delete(id);
  });
}

async function touchLecture(t, lectureId, delta) {
  const store = t.objectStore('lectures');
  const l = await promisify(store.get(lectureId));
  if (!l) return;
  l.slideCount = Math.max(0, (l.slideCount || 0) + delta);
  l.updated = Date.now();
  store.put(l);
}

export async function listSlides(lectureId) {
  const all = await tx(['slides'], 'readonly', (t) =>
    promisify(t.objectStore('slides').index('lecture').getAll(lectureId)));
  return all.sort((a, b) => a.order - b.order);
}

export async function getSlide(id) {
  return tx(['slides'], 'readonly', (t) => promisify(t.objectStore('slides').get(id)));
}

// slide: { blob, thumb, width, height }
export async function addSlide(lectureId, slide) {
  return tx(['slides', 'lectures'], 'readwrite', async (t) => {
    const lectures = t.objectStore('lectures');
    const l = await promisify(lectures.get(lectureId));
    if (!l) throw new Error('Vorlesung nicht gefunden');
    const order = l.nextOrder ?? l.slideCount ?? 0;
    const rec = { ...slide, lectureId, order, created: Date.now() };
    const id = await promisify(t.objectStore('slides').add(rec));
    l.nextOrder = order + 1;
    l.slideCount = (l.slideCount || 0) + 1;
    l.updated = Date.now();
    lectures.put(l);
    return { ...rec, id };
  });
}

export async function replaceSlide(id, slide) {
  return tx(['slides', 'lectures'], 'readwrite', async (t) => {
    const store = t.objectStore('slides');
    const old = await promisify(store.get(id));
    if (!old) return null;
    const rec = { ...old, ...slide, created: Date.now() };
    store.put(rec);
    await touchLecture(t, old.lectureId, 0);
    return rec;
  });
}

export async function deleteSlide(id) {
  return tx(['slides', 'lectures'], 'readwrite', async (t) => {
    const store = t.objectStore('slides');
    const old = await promisify(store.get(id));
    if (!old) return;
    store.delete(id);
    await touchLecture(t, old.lectureId, -1);
  });
}

// Bittet den Browser, die Daten nicht automatisch zu löschen, wenn Speicher knapp wird.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* nicht unterstützt */ }
  return false;
}

async function edgeSlide(lectureId, direction) {
  return tx(['slides'], 'readonly', (t) => new Promise((resolve, reject) => {
    const req = t.objectStore('slides').index('lecture').openCursor(IDBKeyRange.only(lectureId), direction);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  }));
}

export const firstSlide = (lectureId) => edgeSlide(lectureId, 'next');
export const lastSlide = (lectureId) => edgeSlide(lectureId, 'prev');
