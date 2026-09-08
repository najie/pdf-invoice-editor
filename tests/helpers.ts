import { readFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { loadDocument } from '../src/pdf/loadDocument';

/** Node needs filesystem paths for the assets the browser fetches over HTTP. */
export const NODE_PARAMS = {
  cMapUrl: './public/pdfjs/cmaps/',
  standardFontDataUrl: './public/pdfjs/standard_fonts/',
};

export async function openFixture(name: string): Promise<PDFDocumentProxy> {
  const bytes = new Uint8Array(await readFile(`fixtures/${name}`));
  return loadDocument(bytes, NODE_PARAMS);
}

export async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`fixtures/${name}`));
}

export async function openBytes(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return loadDocument(bytes, NODE_PARAMS);
}

const canvasFactory = {
  create: (w: number, h: number) => {
    const canvas = createCanvas(w, h);
    return { canvas, context: canvas.getContext('2d') };
  },
  reset: (ci: { canvas: { width: number; height: number } }, w: number, h: number) => {
    ci.canvas.width = w;
    ci.canvas.height = h;
  },
  destroy: (ci: Record<string, unknown>) => {
    ci.canvas = null;
    ci.context = null;
  },
};

/** Renders a page to raw RGBA pixels for pixel-diffing. */
export async function renderRGBA(doc: PDFDocumentProxy, pageNo: number, scale = 2) {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.render({ canvasContext: ctx as any, viewport, canvasFactory: canvasFactory as any }).promise;
  return { data: ctx.getImageData(0, 0, width, height).data, width, height, canvas };
}
