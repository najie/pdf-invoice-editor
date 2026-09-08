import { beforeAll, describe, expect, it } from 'vitest';
import { openFixture } from './helpers';
import { buildTextIndex } from '../src/pdf/buildTextIndex';
import { groupRuns } from '../src/pdf/groupRuns';
import { deviceToUser, rectToDevice, runInkBox } from '../src/lib/geometry';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { TextRun } from '../src/lib/types';

const SCALE = 2;

let page: PDFPageProxy;
let runs: TextRun[];

beforeAll(async () => {
  const doc = await openFixture('invoice-chrome.pdf');
  page = await doc.getPage(1);
  const index = await buildTextIndex(page, 0);
  runs = groupRuns(index.fragments, index.fonts, 0).runs;
});

describe('run ink boxes', () => {
  it('bounds each run tightly, without swallowing the page', async () => {
    const viewport = page.getViewport({ scale: SCALE });

    for (const run of runs) {
      const box = rectToDevice(runInkBox(run, 0.4), viewport);
      // A line of text is at most a few times its own point size tall.
      expect(box.height, `${run.str} height`).toBeLessThan(run.size * SCALE * 3);
      expect(box.height).toBeGreaterThan(0);
      expect(box.width).toBeGreaterThan(0);
      expect(box.x).toBeGreaterThan(-1);
      expect(box.y).toBeGreaterThan(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    }
  });

  it('places boxes on the glyphs, not at the origin', async () => {
    const viewport = page.getViewport({ scale: SCALE });
    // The footer is the last line on the page; its box must be near the bottom, which is
    // the case a zero-seeded bounding box silently broke by anchoring everything at (0,0).
    const footer = runs.find((r) => r.str.startsWith('Pénalités'))!;
    const box = rectToDevice(runInkBox(footer, 0.4), viewport);
    expect(box.y).toBeGreaterThan(viewport.height * 0.6);
    expect(box.x).toBeGreaterThan(viewport.width * 0.05);
  });

  it('round-trips device and user coordinates', () => {
    const viewport = page.getViewport({ scale: SCALE });
    const run = runs[0];
    const box = rectToDevice(runInkBox(run, 0), viewport);
    const [ux, uy] = deviceToUser(box.x, box.y + box.height, viewport);
    expect(ux).toBeCloseTo(run.x, 3);
    expect(uy).toBeCloseTo(run.y + run.descent * run.size, 3);
  });
});
