// Renders a PDF page to PNG in Node. Used by the verification scripts.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { readFile, writeFile } from 'node:fs/promises';

export const PDFJS_OPTS = {
  fontExtraProperties: true,
  isEvalSupported: false,
  cMapUrl: './public/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: './public/pdfjs/standard_fonts/',
};

export async function open(pathOrBytes) {
  const data = typeof pathOrBytes === 'string'
    ? new Uint8Array(await readFile(pathOrBytes))
    : new Uint8Array(pathOrBytes);
  return pdfjs.getDocument({ data, ...PDFJS_OPTS }).promise;
}

export async function renderPage(doc, pageNo, scale = 2) {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvasFactory: {
    create: (w, h) => { const c = createCanvas(w, h); return { canvas: c, context: c.getContext('2d') }; },
    reset: (ci, w, h) => { ci.canvas.width = w; ci.canvas.height = h; },
    destroy: (ci) => { ci.canvas = null; ci.context = null; },
  } }).promise;
  return canvas;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , src, out, scale] = process.argv;
  const doc = await open(src);
  const canvas = await renderPage(doc, 1, Number(scale ?? 2));
  await writeFile(out, canvas.toBuffer('image/png'));
  console.log(`rendered ${src} -> ${out} (${canvas.width}x${canvas.height})`);
}
