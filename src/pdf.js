// PDF export: one page per scan, each sized to its paper format.
import { pageJpeg } from './pages.js';

export async function buildPdf(pages) {
  const { jsPDF } = await import('jspdf');
  let doc = null;
  for (const page of pages) {
    const quarter = page.rotation % 180 !== 0;
    const { pageWidth, pageHeight } = page.geometry;
    const w = quarter ? pageHeight : pageWidth;
    const h = quarter ? pageWidth : pageHeight;
    const orientation = w > h ? 'landscape' : 'portrait';
    if (doc) doc.addPage([w, h], orientation);
    else doc = new jsPDF({ unit: 'pt', format: [w, h], orientation, compress: true });
    const bytes = new Uint8Array(await (await pageJpeg(page)).arrayBuffer());
    doc.addImage(bytes, 'JPEG', 0, 0, w, h, `page-${page.id}-${page.rotation}`, 'NONE');
  }
  doc.setProperties({ title: 'Scan', creator: 'Paper Scanner' });
  return doc.output('blob');
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function scanFilename(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `Scan ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}.${p(date.getMinutes())}.pdf`;
}
