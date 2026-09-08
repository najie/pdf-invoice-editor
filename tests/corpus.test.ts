import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fixtureBytes, openBytes, openFixture, renderRGBA } from './helpers';
import { buildTextIndex } from '../src/pdf/buildTextIndex';
import { groupRuns } from '../src/pdf/groupRuns';
import { regenerate, type EditReport, type EraseMode, type PageSource, type RunEdit } from '../src/pdf/regenerate';
import { setFontLoader } from '../src/fonts/provider';
import { createTextBox, nearestRun } from '../src/pdf/textBox';
import { deviceToUser, rectToDevice, runInkBox } from '../src/lib/geometry';
import type { Align, FontInfo, TextRun } from '../src/lib/types';

const SCALE = 2;

beforeAll(() => {
  setFontLoader(async (path) => new Uint8Array(await readFile(`public${path}`)));
});

interface Prepared {
  bytes: Uint8Array;
  pages: Array<{
    source: PageSource;
    runs: TextRun[];
    fonts: Map<string, FontInfo>;
    raster: Awaited<ReturnType<typeof renderRGBA>>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    viewport: any;
  }>;
}

async function prepare(fixture: string): Promise<Prepared> {
  const bytes = await fixtureBytes(fixture);
  const doc = await openFixture(fixture);
  const pages: Prepared['pages'] = [];

  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    const index = await buildTextIndex(page, i);
    const { runs } = groupRuns(index.fragments, index.fonts, i);
    const raster = await renderRGBA(doc, i + 1, SCALE);
    const viewport = page.getViewport({ scale: SCALE });
    pages.push({
      source: {
        pageIndex: i,
        runs: new Map(runs.map((r) => [r.id, r])),
        fonts: index.fonts,
        raster: { pixels: raster.data, width: raster.width, height: raster.height, viewport },
        showTextOps: index.showTextOps,
      },
      runs,
      fonts: index.fonts,
      raster,
      viewport,
    });
  }
  return { bytes, pages };
}

const edit = (run: TextRun, text: string): RunEdit => ({
  runId: run.id, text, align: run.align, shrinkToFit: false,
  sizeScale: 1, tracking: 0, dx: 0, dy: 0,
});

/**
 * Changed pixels, split by whether they land where an edit is allowed to change things.
 *
 * Added text takes its allowed region from the writer's own report rather than from a band
 * around an original that does not exist — the same contract the Verify panel relies on, so
 * exercising it here keeps the two honest together.
 */
function countChanges(
  prepared: Prepared,
  after: Prepared['pages'],
  edits: RunEdit[],
  reports: EditReport[] = [],
) {
  let inside = 0;
  let outside = 0;
  for (const [i, page] of prepared.pages.entries()) {
    const before = page.raster.data;
    const now = after[i].raster.data;
    const allowed = edits
      .filter((e) => page.source.runs.has(e.runId))
      .map((e) => {
        const run = page.source.runs.get(e.runId)!;
        const box = runInkBox(run, 2);
        // Replacement text may be longer, so allow the whole band around the line.
        return rectToDevice({ ...box, x: box.x - 300, width: box.width + 600 }, page.viewport);
      });

    for (const report of reports) {
      if (report.kind !== 'box' || report.pageIndex !== i || !report.drawnBox) continue;
      allowed.push(rectToDevice(report.drawnBox, page.viewport));
    }

    for (let y = 0; y < page.raster.height; y++) {
      for (let x = 0; x < page.raster.width; x++) {
        const p = (y * page.raster.width + x) * 4;
        const delta =
          Math.abs(before[p] - now[p]) +
          Math.abs(before[p + 1] - now[p + 1]) +
          Math.abs(before[p + 2] - now[p + 2]);
        if (delta <= 12) continue;
        if (allowed.some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height)) inside++;
        else outside++;
      }
    }
  }
  return { inside, outside };
}

async function editAndVerify(fixture: string, pick: (runs: TextRun[]) => TextRun, text: string) {
  const prepared = await prepare(fixture);
  const allRuns = prepared.pages.flatMap((p) => p.runs);
  const target = pick(allRuns);
  const edits = [edit(target, text)];

  const { bytes: outBytes, reports } = await regenerate({
    originalBytes: prepared.bytes,
    pages: prepared.pages.map((p) => p.source),
    edits,
  });

  // Re-render the export against the same viewports the original was measured with.
  const doc = await openBytes(outBytes);
  const after: Prepared['pages'] = [];
  for (let i = 0; i < prepared.pages.length; i++) {
    after.push({ ...prepared.pages[i], raster: await renderRGBA(doc, i + 1, SCALE) });
  }

  const counts = countChanges(prepared, after, edits);
  const extracted = (await (await doc.getPage(target.pageIndex + 1)).getTextContent()).items
    .map((item) => ('str' in item ? item.str : ''))
    .join('');

  return { reports, counts, extracted, target, prepared };
}

describe('fixture corpus', () => {
  it('handles a page rotated with /Rotate', async () => {
    const r = await editAndVerify('invoice-rotated.pdf', (runs) => runs.find((x) => x.str === '69003 Lyon')!, '75006 Paris');
    console.log(`rotated: tier ${r.reports[0].tier} ${r.reports[0].label} | changes ${r.counts.inside} in / ${r.counts.outside} out`);
    expect(r.counts.outside).toBe(0);
    expect(r.counts.inside).toBeGreaterThan(100);
    expect(r.extracted).toContain('75006 Paris');
  });

  it('handles a non-zero CropBox origin', async () => {
    const r = await editAndVerify('invoice-cropbox.pdf', (runs) => runs.find((x) => x.str === '69003 Lyon')!, '75006 Paris');
    console.log(`cropbox: tier ${r.reports[0].tier} ${r.reports[0].label} | changes ${r.counts.inside} in / ${r.counts.outside} out`);
    expect(r.counts.outside).toBe(0);
    expect(r.counts.inside).toBeGreaterThan(100);
    expect(r.extracted).toContain('75006 Paris');
  });

  it('edits the right page of a multi-page document', async () => {
    const prepared = await prepare('invoice-2pages.pdf');
    expect(prepared.pages).toHaveLength(2);
    // Same text exists on both pages; target the copy on page 2 only.
    const second = prepared.pages[1].runs.find((r) => r.str === '69003 Lyon')!;
    const edits = [edit(second, '75006 Paris')];

    const { bytes: outBytes } = await regenerate({
      originalBytes: prepared.bytes,
      pages: prepared.pages.map((p) => p.source),
      edits,
    });

    const doc = await openBytes(outBytes);
    const textOf = async (n: number) =>
      (await (await doc.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join('');

    expect(await textOf(2)).toContain('75006 Paris');
    expect(await textOf(1)).toContain('69003 Lyon');
    expect(await textOf(1)).not.toContain('75006 Paris');
  });

  it('uses the real standard-14 font when the PDF embeds nothing', async () => {
    const prepared = await prepare('invoice-standard14.pdf');
    const runs = prepared.pages[0].runs;
    const fonts = prepared.pages[0].fonts;
    for (const font of fonts.values()) {
      console.log(`  ${font.baseFont} standard=${font.standard} hasProgram=${font.hasProgram} family=${font.family}`);
      // pdf.js loads its own copy of a standard-14 face, so `hasProgram` is true here;
      // `standard` is the flag that says the file only *names* the font.
      expect(font.standard).not.toBeNull();
    }

    const r = await editAndVerify(
      'invoice-standard14.pdf',
      (all) => all.find((x) => x.str.includes('44000 Nantes'))!,
      '13001 Marseille',
    );
    console.log(`standard14: tier ${r.reports[0].tier} ${r.reports[0].label} | changes ${r.counts.inside} in / ${r.counts.outside} out`);
    expect(r.reports[0].tier).toBe(0);
    expect(r.counts.outside).toBe(0);
    expect(r.extracted).toContain('13001 Marseille');
    expect(runs.length).toBeGreaterThan(5);
  });

  it('keeps a right-aligned standard-14 amount pinned to its column', async () => {
    const prepared = await prepare('invoice-standard14.pdf');
    const amount = prepared.pages[0].runs.find((r) => r.str === '2 640,00 €' && r.align === 'right');
    expect(amount, 'a right-aligned amount should be detected').toBeDefined();

    const { bytes: outBytes } = await regenerate({
      originalBytes: prepared.bytes,
      pages: prepared.pages.map((p) => p.source),
      edits: [edit(amount!, '18 250,00 €')],
    });

    const doc = await openBytes(outBytes);
    const page = await doc.getPage(1);
    const index = await buildTextIndex(page, 0);
    const { runs } = groupRuns(index.fragments, index.fonts, 0);
    const replaced = runs.find((r) => r.str.includes('18 250,00'))!;
    expect(replaced).toBeDefined();
    console.log(`right edge: ${(amount!.x + amount!.width).toFixed(2)} -> ${(replaced.x + replaced.width).toFixed(2)}`);
    expect(Math.abs(replaced.x + replaced.width - (amount!.x + amount!.width))).toBeLessThan(0.6);
  });

  it('shrinks oversized replacements to the original width when asked', async () => {
    const prepared = await prepare('invoice-chrome.pdf');
    const run = prepared.pages[0].runs.find((r) => r.str === '69003 Lyon')!;
    const long = 'Saint-Germain-en-Laye Cedex 12';

    for (const shrinkToFit of [false, true]) {
      const { reports } = await regenerate({
        originalBytes: prepared.bytes,
        pages: prepared.pages.map((p) => p.source),
        edits: [{ ...edit(run, long), shrinkToFit }],
      });
      const report = reports[0];
      console.log(`shrink=${shrinkToFit}: size ${report.size.toFixed(2)}pt fit ${report.widthRatio.toFixed(3)} overflow ${report.overflow.toFixed(2)}pt`);
      if (shrinkToFit) {
        expect(report.overflow).toBeLessThan(0.2);
        expect(report.size).toBeLessThan(run.size);
      } else {
        expect(report.overflow).toBeGreaterThan(1);
        expect(report.size).toBeCloseTo(run.size, 5);
      }
    }
  });

  it('erases a line when the replacement text is empty', async () => {
    const prepared = await prepare('invoice-chrome.pdf');
    const run = prepared.pages[0].runs.find((r) => r.str === 'Mme Camille Durand')!;

    const { bytes: outBytes } = await regenerate({
      originalBytes: prepared.bytes,
      pages: prepared.pages.map((p) => p.source),
      edits: [edit(run, '')],
    });

    const doc = await openBytes(outBytes);
    const raster = await renderRGBA(doc, 1, SCALE);
    const box = rectToDevice(runInkBox(run, 0), prepared.pages[0].viewport);

    // Every pixel where the line used to be must now be paper.
    let ink = 0;
    for (let y = Math.ceil(box.y); y < Math.floor(box.y + box.height); y++) {
      for (let x = Math.ceil(box.x); x < Math.floor(box.x + box.width); x++) {
        const p = (y * raster.width + x) * 4;
        if (raster.data[p] < 200) ink++;
      }
    }
    console.log(`erased line leaves ${ink} dark pixels behind`);
    expect(ink).toBe(0);
  });
});

describe('erasing over non-white backgrounds', () => {
  it('samples a tinted table header rather than assuming white', async () => {
    const prepared = await prepare('invoice-chrome.pdf');
    // This heading sits on a #eef2f8 band. Painting white over it would leave a hole.
    const heading = prepared.pages[0].runs.find((r) => r.str === 'Désignation')!;

    const { bytes: outBytes, reports } = await regenerate({
      originalBytes: prepared.bytes,
      pages: prepared.pages.map((p) => p.source),
      edits: [edit(heading, 'Libellé')],
    });
    console.log(`table header: bg uniformity ${reports[0].backgroundUniformity.toFixed(2)}`);

    const doc = await openBytes(outBytes);
    const raster = await renderRGBA(doc, 1, SCALE);
    const box = rectToDevice(runInkBox(heading, 0), prepared.pages[0].viewport);

    // Sample the band just above the text, inside the erased rectangle: it must still be
    // the header tint, not paper white.
    const y = Math.round(box.y + 1);
    let tinted = 0;
    let white = 0;
    for (let x = Math.ceil(box.x); x < Math.floor(box.x + box.width); x++) {
      const p = (y * raster.width + x) * 4;
      const [r, g, b] = [raster.data[p], raster.data[p + 1], raster.data[p + 2]];
      if (r > 250 && g > 250 && b > 250) white++;
      else if (b > r && b > 230) tinted++;
    }
    console.log(`  above the text: ${tinted} tinted px, ${white} white px`);
    expect(tinted).toBeGreaterThan(white);
  });

  it('flags a gradient background as unsafe to paint over', async () => {
    const prepared = await prepare('invoice-chrome.pdf');
    // White text on the logo's blue gradient — the one place a flat fill cannot work.
    const logo = prepared.pages[0].runs.find((r) => r.str === 'ACMECO')!;

    const { reports } = await regenerate({
      originalBytes: prepared.bytes,
      pages: prepared.pages.map((p) => p.source),
      edits: [edit(logo, 'VIZZIO')],
    });
    console.log(`logo: bg uniformity ${reports[0].backgroundUniformity.toFixed(2)} (lower is worse)`);
    // The warning threshold in ExportBar is 0.6; a gradient must fall under it while the
    // flat-tinted header above stays over it, or the warning means nothing.
    expect(reports[0].backgroundUniformity).toBeLessThan(0.6);
  });
});

/* ----------------------------- added text boxes ---------------------------- */

/**
 * Places a box where the user clicked and exports it.
 *
 * The click is given in *device* pixels, because that is what the browser hands the app: a
 * position on the rendered page. Everything after it — the conversion to user space, the
 * choice of template, the drawing — is the real path, so a mistake in any of it shows up
 * here rather than only in the browser.
 */
async function addBoxAndVerify(opts: {
  fixture: string;
  pageIndex?: number;
  /** Where on the rendered page the user clicked, device pixels. */
  click: (page: Prepared['pages'][number]) => [number, number];
  text: string;
  align?: Align;
  eraseMode?: EraseMode;
}) {
  const prepared = await prepare(opts.fixture);
  const pageIndex = opts.pageIndex ?? 0;
  const target = prepared.pages[pageIndex];

  const [deviceX, deviceY] = opts.click(target);
  const [x, y] = deviceToUser(deviceX, deviceY, target.viewport);
  const box = createTextBox({
    id: `p${pageIndex}-box0`,
    pageIndex,
    x,
    y,
    template: nearestRun(target.runs, x, y),
  });
  const edits: RunEdit[] = [{
    runId: box.run.id, text: opts.text, align: opts.align ?? 'left',
    shrinkToFit: false, sizeScale: 1, tracking: 0, dx: 0, dy: 0,
  }];

  const { bytes: outBytes, reports, surgicalFallbacks } = await regenerate({
    originalBytes: prepared.bytes,
    pages: prepared.pages.map((p, i) => ({
      ...p.source,
      boxes: i === pageIndex ? new Map([[box.run.id, box.run]]) : new Map(),
    })),
    edits,
    eraseMode: opts.eraseMode,
  });

  const doc = await openBytes(outBytes);
  const after: Prepared['pages'] = [];
  const extracted: string[] = [];
  for (let i = 0; i < prepared.pages.length; i++) {
    after.push({ ...prepared.pages[i], raster: await renderRGBA(doc, i + 1, SCALE) });
    const text = (await (await doc.getPage(i + 1)).getTextContent()).items
      .map((item) => ('str' in item ? item.str : ''))
      .join('');
    extracted.push(text);
  }

  // Re-index the exported page so the added text can be measured as the document now
  // describes it, not as we hoped to describe it.
  const page = await doc.getPage(pageIndex + 1);
  const index = await buildTextIndex(page, pageIndex);
  const { runs: newRuns } = groupRuns(index.fragments, index.fonts, pageIndex);

  return {
    box,
    reports,
    surgicalFallbacks,
    extracted,
    counts: countChanges(prepared, after, edits, reports),
    prepared,
    target,
    click: [deviceX, deviceY] as [number, number],
    reindexed: newRuns.find((r) => r.str.includes(opts.text.slice(0, 12))),
    viewport: target.viewport,
  };
}

/** A user-space point as the browser would see it: a position on the rendered page. */
function pointToDevice(x: number, y: number, viewport: Prepared['pages'][number]['viewport']) {
  const rect = rectToDevice({ x, y, width: 0, height: 0 }, viewport);
  return [rect.x, rect.y] as [number, number];
}

/**
 * Where a user would click to put a TVA number under the invoice's existing one: the empty
 * band 25 pt below that line *in the invoice's own layout*.
 *
 * Expressed in the layout rather than on the screen because the fixtures disagree about
 * which screen direction that is — on the `/Rotate` page, down-the-screen is along user-space
 * x, and clicking 50 px "below" the line there runs the text off the right edge of the paper.
 * The click still reaches the code as device pixels, so both transforms are still exercised.
 */
const belowTva = (page: Prepared['pages'][number]): [number, number] => {
  const tva = page.runs.find((r) => r.str.startsWith('TVA FR'))!;
  return pointToDevice(tva.x + 1, tva.y - 25, page.viewport);
};

describe('added text boxes', () => {
  it('lands where it was asked, in the invoice’s own font, and touches nothing else', async () => {
    const result = await addBoxAndVerify({
      fixture: 'invoice-chrome.pdf',
      click: belowTva,
      text: 'TVA FR 42 999888777',
    });

    // It is real text, not a picture of text.
    expect(result.extracted[0]).toContain('TVA FR 42 999888777');

    // Tier 0 or 1 means the glyphs come from the font the invoice itself uses, which is the
    // whole point of templating a box off the nearest line.
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].kind).toBe('box');
    expect(result.reports[0].tier).toBeLessThanOrEqual(1);
    // Nothing was replaced, so every fit and erase signal must be inert rather than
    // accidentally alarming: an unguarded `overflow` would report the full width as overrun.
    expect(result.reports[0].overflow).toBe(0);
    expect(result.reports[0].widthRatio).toBe(1);
    expect(result.reports[0].erasedBy).toBe('none');

    // Placed at the anchor, to within a rounding error.
    expect(result.reindexed).toBeDefined();
    expect(result.reindexed!.x).toBeCloseTo(result.box.run.x, 1);
    expect(result.reindexed!.y).toBeCloseTo(result.box.run.y, 1);

    // And the promise the tool makes: the only pixels that moved are the ones the writer
    // said it drew on.
    expect(result.counts.inside).toBeGreaterThan(200);
    expect(result.counts.outside).toBe(0);
  });

  it('inherits the size and colour of the line it was dropped beside', async () => {
    const result = await addBoxAndVerify({
      fixture: 'invoice-chrome.pdf',
      click: belowTva,
      text: 'TVA FR 42 999888777',
    });
    const tva = result.target.runs.find((r) => r.str.startsWith('TVA FR'))!;
    expect(result.box.run.size).toBe(tva.size);
    expect(result.reports[0].size).toBeCloseTo(tva.size, 3);
    expect(result.reindexed!.size).toBeCloseTo(tva.size, 1);
    expect(result.reindexed!.color).toEqual(tva.color);
  });

  it('pins the anchor edge the alignment names', async () => {
    const left = await addBoxAndVerify({
      fixture: 'invoice-chrome.pdf', click: belowTva, text: 'FR 42 999888777', align: 'left',
    });
    const right = await addBoxAndVerify({
      fixture: 'invoice-chrome.pdf', click: belowTva, text: 'FR 42 999888777', align: 'right',
    });
    const center = await addBoxAndVerify({
      fixture: 'invoice-chrome.pdf', click: belowTva, text: 'FR 42 999888777', align: 'center',
    });

    const anchor = left.box.run.x;
    // A box has no original width, which is exactly what turns `alignedOrigin` into anchor
    // semantics: the named edge lands on the point that was clicked.
    expect(left.reindexed!.x).toBeCloseTo(anchor, 1);
    expect(right.reindexed!.x + right.reindexed!.width).toBeCloseTo(anchor, 1);
    expect(center.reindexed!.x + center.reindexed!.width / 2).toBeCloseTo(anchor, 1);
    // All three drew the same string, so a shift is the only difference.
    expect(right.reindexed!.width).toBeCloseTo(left.reindexed!.width, 1);
  });

  it('lands under the cursor on a page rotated with /Rotate', async () => {
    const result = await addBoxAndVerify({
      fixture: 'invoice-rotated.pdf',
      click: belowTva,
      text: 'TVA FR 42 999888777',
    });
    expect(result.extracted[0]).toContain('TVA FR 42 999888777');

    // Asserted in *device* space on purpose. User-space coordinates would agree even if the
    // text landed a quarter turn away from where the user clicked; only the rendered
    // position catches a rotation mistake.
    const drawn = rectToDevice(runInkBox(result.reindexed!, 1), result.viewport);
    const [cx, cy] = result.click;
    expect(cx).toBeGreaterThanOrEqual(drawn.x - 3);
    expect(cy).toBeGreaterThanOrEqual(drawn.y - 3);
    expect(cy).toBeLessThanOrEqual(drawn.y + drawn.height + 3);
    expect(result.counts.outside).toBe(0);
  });

  it('lands under the cursor on a page whose CropBox does not start at the origin', async () => {
    const result = await addBoxAndVerify({
      fixture: 'invoice-cropbox.pdf',
      click: belowTva,
      text: 'TVA FR 42 999888777',
    });
    expect(result.extracted[0]).toContain('TVA FR 42 999888777');

    const drawn = rectToDevice(runInkBox(result.reindexed!, 1), result.viewport);
    const [cx, cy] = result.click;
    expect(cx).toBeGreaterThanOrEqual(drawn.x - 3);
    expect(cy).toBeGreaterThanOrEqual(drawn.y - 3);
    expect(cy).toBeLessThanOrEqual(drawn.y + drawn.height + 3);
    expect(result.counts.outside).toBe(0);
  });

  it('adds to one page of a multi-page document and leaves the other untouched', async () => {
    const result = await addBoxAndVerify({
      fixture: 'invoice-2pages.pdf',
      pageIndex: 1,
      click: belowTva,
      text: 'TVA FR 42 999888777',
    });
    expect(result.extracted[1]).toContain('TVA FR 42 999888777');
    expect(result.extracted[0]).not.toContain('999888777');
    expect(result.reports[0].pageIndex).toBe(1);
    expect(result.counts.outside).toBe(0);
  });

  it('never asks the surgical erase to patch a page it only added text to', async () => {
    // This is the fixture the surgical erase must decline: its text lives in a Form XObject,
    // so the operator ordinals do not line up. A box replaces nothing, so the patch must not
    // even be attempted — otherwise the user is told the old text could not be removed when
    // they never asked to remove any.
    const result = await addBoxAndVerify({
      fixture: 'invoice-xobject.pdf',
      click: belowTva,
      text: 'TVA FR 42 999888777',
      eraseMode: 'surgical',
    });
    expect(result.surgicalFallbacks).toEqual([]);
    expect(result.extracted[0]).toContain('TVA FR 42 999888777');
    expect(result.counts.outside).toBe(0);
  });

  it('draws nothing for a box that was never typed into', async () => {
    const result = await addBoxAndVerify({
      fixture: 'invoice-chrome.pdf',
      click: belowTva,
      // An empty *box* means "not filled in yet" — unlike an empty edit of an existing line,
      // which means "erase it".
      text: '   ',
    });
    expect(result.reports).toEqual([]);
    expect(result.counts.inside).toBe(0);
    expect(result.counts.outside).toBe(0);
  });

  it('says so when the text runs off the paper', async () => {
    // Clicking near a margin is easy to do and silent otherwise: the export is a perfectly
    // valid PDF in which the number the user typed simply is not on the page.
    const spilled = await addBoxAndVerify({
      fixture: 'invoice-chrome.pdf',
      click: (page) => pointToDevice(page.source.raster!.viewport.viewBox[2] - 12, 300, page.viewport),
      text: 'TVA FR 42 999888777',
    });
    expect(spilled.reports[0].offPage).toBe(true);

    // And does not cry wolf over a box comfortably inside the margins.
    const fine = await addBoxAndVerify({
      fixture: 'invoice-chrome.pdf', click: belowTva, text: 'TVA FR 42 999888777',
    });
    expect(fine.reports[0].offPage).toBe(false);
  });
});
