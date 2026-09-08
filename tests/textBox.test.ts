import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { openFixture } from './helpers';
import { buildTextIndex } from '../src/pdf/buildTextIndex';
import { groupRuns } from '../src/pdf/groupRuns';
import { setFontLoader } from '../src/fonts/provider';
import { createTextBox, estimateBoxWidth, nearestRun } from '../src/pdf/textBox';
import { inkQuadBounds, runInkBox } from '../src/lib/geometry';
import type { TextRun } from '../src/lib/types';

beforeAll(() => {
  setFontLoader(async (path) => new Uint8Array(await readFile(`public${path}`)));
});

async function chromeRuns(): Promise<TextRun[]> {
  const doc = await openFixture('invoice-chrome.pdf');
  const page = await doc.getPage(1);
  const index = await buildTextIndex(page, 0);
  return groupRuns(index.fragments, index.fonts, 0).runs;
}

describe('createTextBox', () => {
  it('inherits the nearest line’s typography', async () => {
    const runs = await chromeRuns();
    const template = runs.find((r) => r.str === 'TVA FR 00 123456789')!;
    const box = createTextBox({ id: 'p0-box0', pageIndex: 0, x: 443, y: 595, template });

    expect(box.templateRunId).toBe(template.id);
    expect(box.run.size).toBe(template.size);
    expect(box.run.fontLoadedName).toBe(template.fontLoadedName);
    expect(box.run.charSpacing).toBe(template.charSpacing);
    expect(box.run.color).toEqual(template.color);
    expect(box.run.ascent).toBe(template.ascent);
    expect(box.run.descent).toBe(template.descent);
  });

  it('is a run the rest of the writer can take at face value', async () => {
    const runs = await chromeRuns();
    const box = createTextBox({
      id: 'p0-box0', pageIndex: 0, x: 443, y: 595,
      template: runs.find((r) => r.str === '69003 Lyon')!,
    });

    // Zero width is what turns `alignedOrigin` into anchor semantics, and the empty pieces
    // list is what stops the surgical erase ever splicing on a box's behalf.
    expect(box.run.width).toBe(0);
    expect(box.run.pieces).toEqual([]);
    // Nothing was here before, so there is no original text to compare against.
    expect(box.run.str).toBe('');
    expect(box.run.align).toBe('left');
    expect(box.measuredWidth).toBe(0);
  });

  it('drops the template’s horizontal squeeze but keeps its rotation', async () => {
    const runs = await chromeRuns();
    const base = runs.find((r) => r.str === '69003 Lyon')!;

    const squeezed = createTextBox({
      id: 'a', pageIndex: 0, x: 0, y: 0,
      template: { ...base, matrix: [2, 0, 0, 1], hScale: 2, wordSpacing: 3 },
    });
    expect(squeezed.run.matrix).toEqual([1, 0, 0, 1]);
    expect(squeezed.run.hScale).toBe(1);
    // Tw is a justification hack; inherited, it would put multi-point gaps inside the
    // string the user just typed.
    expect(squeezed.run.wordSpacing).toBe(0);

    const rotated = createTextBox({
      id: 'b', pageIndex: 0, x: 0, y: 0,
      template: { ...base, matrix: [0, 1, -1, 0] },
    });
    expect(rotated.run.matrix[0]).toBeCloseTo(0, 6);
    expect(rotated.run.matrix[1]).toBeCloseTo(1, 6);
    expect(rotated.run.matrix[2]).toBeCloseTo(-1, 6);
    expect(rotated.run.matrix[3]).toBeCloseTo(0, 6);
  });

  it('centres the text on the click rather than hanging it above', async () => {
    const runs = await chromeRuns();
    const template = runs.find((r) => r.str === '69003 Lyon')!;
    const box = createTextBox({ id: 'a', pageIndex: 0, x: 100, y: 500, template });

    const mid = ((template.ascent + template.descent) / 2) * template.size;
    expect(box.run.x).toBeCloseTo(100, 6);
    expect(box.run.y).toBeCloseTo(500 - mid, 6);
    // The click really does land between the descender and the cap line.
    const ink = runInkBox(box.run, 0);
    expect(500).toBeGreaterThan(ink.y);
    expect(500).toBeLessThan(ink.y + ink.height);
  });

  it('falls back to a legible default on a page with no text', () => {
    const box = createTextBox({ id: 'a', pageIndex: 2, x: 10, y: 20, template: null });
    expect(box.templateRunId).toBeNull();
    expect(box.run.size).toBe(10);
    expect(box.run.color).toEqual({ r: 0, g: 0, b: 0 });
    expect(box.run.matrix).toEqual([1, 0, 0, 1]);
    expect(box.run.ascent).toBe(0.75);
    expect(box.run.descent).toBe(-0.25);
    // '' misses in `page.fonts`, which is what makes the resolver skip the tiers that need
    // a source font instead of needing a special case for a fontless page.
    expect(box.run.fontLoadedName).toBe('');
  });

  it('refuses to inherit white ink', async () => {
    const runs = await chromeRuns();
    // The logo is white type on a dark band; a box in that colour would be invisible on
    // paper and read as the feature being broken.
    const logo = runs.find((r) => r.str === 'ACMECO')!;
    expect(logo.color).toEqual({ r: 1, g: 1, b: 1 });
    const box = createTextBox({ id: 'a', pageIndex: 0, x: 96, y: 760, template: logo });
    expect(box.run.color).toEqual({ r: 0, g: 0, b: 0 });
    // Size is still the logo's, so only the unusable part was overridden.
    expect(box.run.size).toBe(logo.size);
  });
});

describe('nearestRun', () => {
  it('measures to the ink box, not to the origin', async () => {
    const runs = await chromeRuns();
    const terms = runs.find((r) => r.str.startsWith('Pénalités'))!;
    const total = runs.find((r) => r.str === '5 388,00 €')!;
    const lyon = runs.find((r) => r.str === '69003 Lyon')!;

    // A point a few points under the right-hand end of the wide terms line. That line's
    // origin is 360 pt away to the left, while the totals column's origin is a third of
    // that, so ranking by origin distance would hand this point to the total — and put the
    // added text in the wrong size and font.
    const picked = nearestRun(runs, 410, 300);
    expect(picked?.id).toBe(terms.id);
    expect(picked?.id).not.toBe(total.id);

    // And a point inside a line's own box picks that line.
    expect(nearestRun(runs, lyon.x + 5, lyon.y + 2)?.id).toBe(lyon.id);
  });

  it('returns null when the page has no text', () => {
    expect(nearestRun([], 10, 10)).toBeNull();
  });
});

describe('inkQuadBounds', () => {
  it('agrees with runInkBox for upright text', async () => {
    const runs = await chromeRuns();
    const run = runs.find((r) => r.str === '69003 Lyon')!;
    const quad = inkQuadBounds(run, run.width, 0.4);
    const plain = runInkBox(run, 0.4);
    expect(quad.x).toBeCloseTo(plain.x, 6);
    expect(quad.y).toBeCloseTo(plain.y, 6);
    expect(quad.width).toBeCloseTo(plain.width, 6);
    expect(quad.height).toBeCloseTo(plain.height, 6);
  });

  it('follows the baseline when the text matrix is rotated', async () => {
    const runs = await chromeRuns();
    const base = runs.find((r) => r.str === '69003 Lyon')!;
    // Quarter turn: the advance now runs up the page, so width and height swap. This is the
    // case `runInkBox` cannot express, and the reason added text needs its own bounds.
    const turned: TextRun = { ...base, matrix: [0, 1, -1, 0] };
    const quad = inkQuadBounds(turned, 100, 0);
    const em = (base.ascent - base.descent) * base.size;
    expect(quad.height).toBeCloseTo(100, 6);
    expect(quad.width).toBeCloseTo(em, 6);
  });
});

describe('estimateBoxWidth', () => {
  it('stands in for a measurement before any font has resolved', () => {
    const box = createTextBox({ id: 'a', pageIndex: 0, x: 0, y: 0, template: null });
    expect(estimateBoxWidth(box, '')).toBe(0);
    // Within about 20% of the real advance of 20 digits at 10 pt, which is all a click
    // target needs.
    expect(estimateBoxWidth(box, '12345678901234567890')).toBeCloseTo(110, 0);
  });
});
