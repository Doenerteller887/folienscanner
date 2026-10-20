// PDF aus den gespeicherten Folien erzeugen und teilen/herunterladen.
// Nutzt jsPDF (lib/jspdf.umd.min.js, global als window.jspdf).

const PAGE_W = 842; // pt, Breite einer A4-Querseite; Höhe folgt dem Seitenverhältnis der Folie

export function pdfFileName(name) {
  const base = (name || 'Folien').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  return `${base || 'Folien'}.pdf`;
}

// slides: [{ blob, width, height }] in Seitenreihenfolge
export async function buildPdf(slides, title) {
  const { jsPDF } = window.jspdf;
  if (!slides.length) throw new Error('Noch keine Folien vorhanden');
  let doc = null;
  for (const s of slides) {
    const h = Math.round((PAGE_W * s.height) / s.width);
    const orientation = PAGE_W >= h ? 'landscape' : 'portrait';
    if (!doc) doc = new jsPDF({ orientation, unit: 'pt', format: [PAGE_W, h], compress: true });
    else doc.addPage([PAGE_W, h], orientation);
    const bytes = new Uint8Array(await s.blob.arrayBuffer());
    doc.addImage(bytes, 'JPEG', 0, 0, PAGE_W, h, undefined, 'NONE');
  }
  doc.setProperties({ title: title || 'Folien', creator: 'Folienscanner' });
  return { blob: doc.output('blob'), pages: doc.getNumberOfPages() };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Teilt das PDF über das Teilen-Menü des Handys (Drive, OneNote-App, Mail …).
// Gibt false zurück, wenn Teilen nicht möglich ist – dann wird heruntergeladen.
export async function shareOrDownload(blob, filename, title) {
  const file = new File([blob], filename, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
    }
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}
