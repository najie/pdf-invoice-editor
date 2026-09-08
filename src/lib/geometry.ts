import type { PageViewport } from 'pdfjs-dist';
import { pdfjs } from '../pdf/loadDocument';
import type { Align, RGB, TextRun } from './types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Ink box of a run in PDF user space, from the font's own ascent and descent.
 *
 * Used both as the area to paint over when erasing and as the click target in the
 * overlay, so it must bound the glyphs tightly: too generous and erasing eats the table
 * rule above, too tight and descenders survive as slivers.
 */
export function runInkBox(run: TextRun, pad = 0): Rect {
  const top = run.ascent * run.size;
  const bottom = run.descent * run.size; // negative
  return {
    x: run.x - pad,
    y: run.y + bottom - pad,
    width: run.width + pad * 2,
    height: top - bottom + pad * 2,
  };
}

/**
 * Axis-aligned user-space bounds of a line of text of `width`, drawn from `run`'s origin
 * along `run`'s baseline.
 *
 * Unlike `runInkBox` this honours the text matrix, because it bounds the *drawn* extent of
 * text rather than the rectangle to paint over: it is what tells the pixel diff which
 * region an addition was allowed to change. `runInkBox` is deliberately left alone — it
 * feeds the erase rectangle, whose behaviour is pinned by the surgical and background
 * fixtures, and rotating that is a separate change.
 */
export function inkQuadBounds(run: TextRun, width: number, pad = 0): Rect {
  const { ux, uy } = baselineUnit(run);
  // Baseline normal, i.e. "up" in text space. Ascent is positive, descent negative.
  const nx = -uy;
  const ny = ux;
  const top = run.ascent * run.size;
  const bottom = run.descent * run.size;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const along of [0, width]) {
    for (const across of [bottom, top]) {
      xs.push(run.x + ux * along + nx * across);
      ys.push(run.y + uy * along + ny * across);
    }
  }
  return {
    x: Math.min(...xs) - pad,
    y: Math.min(...ys) - pad,
    width: Math.max(...xs) - Math.min(...xs) + pad * 2,
    height: Math.max(...ys) - Math.min(...ys) + pad * 2,
  };
}

/**
 * Maps a user-space rect to device pixels, as an axis-aligned box.
 *
 * Goes through the viewport transform rather than doing the arithmetic by hand, so page
 * /Rotate and a non-zero CropBox origin are handled by pdf.js instead of by us.
 */
export function rectToDevice(rect: Rect, viewport: PageViewport): Rect {
  // The helper *grows* an existing box (`output[i] = Math.min(output[i], ...)`) so it can
  // be called repeatedly. Seeding with zeros would silently force every result to contain
  // the page origin; it has to start empty.
  const out: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  pdfjs.Util.axialAlignedBoundingBox(
    [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    viewport.transform,
    out,
  );
  return { x: out[0], y: out[1], width: out[2] - out[0], height: out[3] - out[1] };
}

/** Device pixel -> user space. */
export function deviceToUser(x: number, y: number, viewport: PageViewport): [number, number] {
  // pdf.js's transform helpers mutate the point in place and return nothing.
  const point: [number, number] = [x, y];
  pdfjs.Util.applyInverseTransform(point, viewport.transform);
  return point;
}

/** Unit vector along a run's baseline, from its normalised matrix. */
export function baselineUnit(run: TextRun): { ux: number; uy: number; hScale: number } {
  const [a, b] = run.matrix;
  const hScale = Math.hypot(a, b) || 1;
  return { ux: a / hScale, uy: b / hScale, hScale };
}

/**
 * Where to put the baseline origin so that replacement text of `newWidth` keeps the
 * original's alignment edge. Rotation-aware: the shift travels along the baseline.
 */
export function alignedOrigin(
  run: TextRun,
  newWidth: number,
  align: Align,
): { x: number; y: number } {
  const { ux, uy } = baselineUnit(run);
  const factor = align === 'right' ? 1 : align === 'center' ? 0.5 : 0;
  const shift = (run.width - newWidth) * factor;
  return { x: run.x + ux * shift, y: run.y + uy * shift };
}

export const rgbEqual = (a: RGB, b: RGB, tol = 0.02) =>
  Math.abs(a.r - b.r) < tol && Math.abs(a.g - b.g) < tol && Math.abs(a.b - b.b) < tol;
