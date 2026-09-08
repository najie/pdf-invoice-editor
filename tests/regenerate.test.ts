import { beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { fixtureBytes, openBytes, openFixture, renderRGBA } from './helpers';
import { buildTextIndex } from '../src/pdf/buildTextIndex';
import { groupRuns } from '../src/pdf/groupRuns';
import { regenerate, type RunEdit } from '../src/pdf/regenerate';
import { setFontLoader } from '../src/fonts/provider';
import { rectToDevice, runInkBox } from '../src/lib/geometry';
import type { TextRun } from '../src/lib/types';

const SCALE = 2;

beforeAll(() => {
  setFontLoader(async (path) => new Uint8Array(await readFile(`public${path}`)));
});

async function prepare(fixture: string) {
  const bytes = await fixtureBytes(fixture);
  const doc = await openFixture(fixture);
  const page = await doc.getPage(1);
  const index = await buildTextIndex(page, 0);
  const { runs } = groupRuns(index.fragments, index.fonts, 0);
  const raster = await renderRGBA(doc, 1, SCALE);
  const viewport = page.getViewport({ scale: SCALE });
  return {
    bytes,
    runs,
    runMap: new Map(runs.map((r) => [r.id, r])),
    fonts: index.fonts,
    raster,
    viewport,
    showTextOps: index.showTextOps,
  };
}

function defaults(run: TextRun, text: string): RunEdit {
  return {
    runId: run.id, text, align: run.align, shrinkToFit: false,
    sizeScale: 1, tracking: 0, dx: 0, dy: 0,
  };
}

/** Counts differing pixels, split by whether they fall inside an allowed box. */
function diff(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  width: number,
  height: number,
  allowed: Array<{ x: number; y: number; width: number; height: number }>,
) {
  let inside = 0;
  let outside = 0;
  const worst: Array<[number, number]> = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (delta <= 12) continue; // ignore antialiasing jitter
      const hit = allowed.some(
        (r) => x >= r.x - 2 && x <= r.x + r.width + 2 && y >= r.y - 2 && y <= r.y + r.height + 2,
      );
      if (hit) inside++;
      else {
        outside++;
        if (worst.length < 12) worst.push([x, y]);
      }
    }
  }
  return { inside, outside, worst };
}

describe('regenerate', () => {
  it('changes only the edited regions and nothing else', async () => {
    const { bytes, runMap, runs, fonts, raster, viewport } = await prepare('invoice-chrome.pdf');

    const street = runs.find((r) => r.str === '27 avenue des Champs')!;
    const city = runs.find((r) => r.str === '69003 Lyon')!;
    const edits: RunEdit[] = [
      defaults(street, '14 boulevard Saint-Germain'),
      defaults(city, '75006 Paris'),
    ];

    const { bytes: outBytes, reports } = await regenerate({
      originalBytes: bytes,
      pages: [{
        pageIndex: 0, runs: runMap, fonts,
        raster: { pixels: raster.data, width: raster.width, height: raster.height, viewport },
      }],
      edits,
    });
    for (const r of reports) {
      console.log(`"${r.text}" tier ${r.tier} ${r.label} | size ${r.size.toFixed(2)} ` +
        `| fit ${r.widthRatio.toFixed(3)} overflow ${r.overflow.toFixed(1)}pt ` +
        `| bg uniformity ${r.backgroundUniformity.toFixed(2)}`);
    }
    await writeFile('fixtures/out-edited.pdf', outBytes);

    // --- nothing outside the edited boxes may change ------------------------
    const after = await renderRGBA(await openBytes(outBytes), 1, SCALE);
    expect(after.width).toBe(raster.width);

    const allowed = edits.map((e) => {
      const run = runMap.get(e.runId)!;
      // The replacement can be wider than the original, so allow the full line width.
      const box = runInkBox(run, 1);
      return rectToDevice({ ...box, width: Math.max(box.width, 400) }, viewport);
    });
    const result = diff(raster.data, after.data, raster.width, raster.height, allowed);
    console.log(`changed pixels: ${result.inside} inside the edits, ${result.outside} outside`);
    if (result.outside) console.log('  first offenders:', result.worst);

    expect(result.inside).toBeGreaterThan(200); // the edit really happened
    expect(result.outside).toBe(0);
  });

  it('exports text that extracts as the new string', async () => {
    const { bytes, runMap, runs, fonts, raster, viewport } = await prepare('invoice-chrome.pdf');
    const city = runs.find((r) => r.str === '69003 Lyon')!;

    const { bytes: outBytes } = await regenerate({
      originalBytes: bytes,
      pages: [{
        pageIndex: 0, runs: runMap, fonts,
        raster: { pixels: raster.data, width: raster.width, height: raster.height, viewport },
      }],
      edits: [defaults(city, '75006 Paris')],
    });

    const doc = await openBytes(outBytes);
    const text = (await (await doc.getPage(1)).getTextContent()).items
      .map((i) => ('str' in i ? i.str : ''))
      .join('');
    expect(text).toContain('75006 Paris');
  });

  it('pins the right edge of a right-aligned amount', async () => {
    const { bytes, runMap, runs, fonts, raster, viewport } = await prepare('invoice-chrome.pdf');
    const total = runs.find((r) => r.str === '5 388,00 €')!;
    expect(total.align).toBe('right');

    const { bytes: outBytes, reports } = await regenerate({
      originalBytes: bytes,
      pages: [{
        pageIndex: 0, runs: runMap, fonts,
        raster: { pixels: raster.data, width: raster.width, height: raster.height, viewport },
      }],
      edits: [defaults(total, '12 750,00 €')],
    });
    console.log('amount edit:', reports[0].label, 'fit', reports[0].widthRatio.toFixed(3));

    const doc = await openBytes(outBytes);
    const page = await doc.getPage(1);
    const index = await buildTextIndex(page, 0);
    const { runs: newRuns } = groupRuns(index.fragments, index.fonts, 0);
    const replaced = newRuns.find((r) => r.str.includes('12 750,00'))!;
    expect(replaced, 'new amount should be found').toBeDefined();

    const originalRight = total.x + total.width;
    const newRight = replaced.x + replaced.width;
    console.log(`right edge: original ${originalRight.toFixed(2)} -> new ${newRight.toFixed(2)}`);
    expect(Math.abs(newRight - originalRight)).toBeLessThan(0.6);
    // Longer text must have grown leftwards, not out of the column.
    expect(replaced.x).toBeLessThan(total.x);
  });
});
