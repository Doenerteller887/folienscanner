// Ausgabe-Schnittstelle: Jede gespeicherte Folie wird an alle registrierten Ausgaben gemeldet.
// Version 1 hat nur die PDF-Ausgabe. Eine spätere OneNote-Ausgabe implementiert dieselben
// Methoden (z. B. per Microsoft Graph: Seite anlegen, Bild mit PATCH …/content "append" anhängen).
//
//   {
//     onLectureStart(lecture)        // optional
//     onSlideAdded(slide, lecture)
//     onSlideReplaced(slide, lecture)
//     onSlideDeleted(slideId, lecture)
//   }

import { listSlides, getLecture } from './storage.js';
import { buildPdf } from './pdf.js';

const outputs = [];

export function registerOutput(o) {
  outputs.push(o);
}

async function emit(method, ...args) {
  for (const o of outputs) {
    if (typeof o[method] !== 'function') continue;
    try { await o[method](...args); } catch (e) { console.error(`Ausgabe ${method} fehlgeschlagen`, e); }
  }
}

export const emitLectureStart = (lecture) => emit('onLectureStart', lecture);
export const emitSlideAdded = (slide, lecture) => emit('onSlideAdded', slide, lecture);
export const emitSlideReplaced = (slide, lecture) => emit('onSlideReplaced', slide, lecture);
export const emitSlideDeleted = (slideId, lecture) => emit('onSlideDeleted', slideId, lecture);

// Hält für jede Vorlesung ein fertiges PDF bereit und baut es nach Änderungen
// im Hintergrund neu, damit „Teilen“ sofort reagiert (Teilen braucht einen frischen Tipp).
export class PdfOutput {
  constructor({ delayMs = 1500, onUpdate } = {}) {
    this.delayMs = delayMs;
    this.onUpdate = onUpdate;
    this.cache = new Map(); // lectureId → { blob, pages, version }
    this.pending = new Map(); // lectureId → { version, promise }
    this.versions = new Map();
    this.timers = new Map();
  }

  markDirty(lecture) {
    const v = (this.versions.get(lecture.id) || 0) + 1;
    this.versions.set(lecture.id, v);
    clearTimeout(this.timers.get(lecture.id));
    this.timers.set(lecture.id, setTimeout(() => this.get(lecture).catch(() => {}), this.delayMs));
  }

  onSlideAdded(_s, lecture) { this.markDirty(lecture); }
  onSlideReplaced(_s, lecture) { this.markDirty(lecture); }
  onSlideDeleted(_id, lecture) { this.markDirty(lecture); }

  // Liefert das aktuelle PDF (aus dem Cache oder neu gebaut).
  async get(lecture) {
    const id = lecture.id;
    const v = this.versions.get(id) || 0;
    const c = this.cache.get(id);
    if (c && c.version === v) return c;
    const p = this.pending.get(id);
    if (p && p.version === v) return p.promise;
    const promise = (async () => {
      const [slides, fresh] = await Promise.all([listSlides(id), getLecture(id)]);
      const { blob, pages } = await buildPdf(slides, (fresh || lecture).name);
      const entry = { blob, pages, version: v };
      if ((this.versions.get(id) || 0) === v) this.cache.set(id, entry);
      this.onUpdate?.(lecture, entry);
      return entry;
    })();
    this.pending.set(id, { version: v, promise });
    try {
      return await promise;
    } finally {
      if (this.pending.get(id)?.promise === promise) this.pending.delete(id);
    }
  }

  // Sofort verfügbares PDF, falls aktuell – sonst null.
  peek(lecture) {
    const c = this.cache.get(lecture.id);
    return c && c.version === (this.versions.get(lecture.id) || 0) ? c : null;
  }
}
