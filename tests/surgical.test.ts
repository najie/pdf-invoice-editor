import { beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument } from '@cantoo/pdf-lib';
import { fixtureBytes, openBytes, openFixture, renderRGBA } from './helpers';
import { buildTextIndex } from '../src/pdf/buildTextIndex';
import { groupRuns } from '../src/pdf/groupRuns';
import { regenerate, type PageSource, type RunEdit } from '../src/pdf/regenerate';
import { findShowTextSpans, splice } from '../src/pdf/contentStream';
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
  const source: PageSource = {
    pageIndex: 0,
    runs: new Map(runs.map((r) => [r.id, r])),
    fonts: index.fonts,
    raster: { pixels: raster.data, width: raster.width, height: raster.height, viewport },
    showTextOps: index.showTextOps,
  };
  return { bytes, runs, source, raster, viewport, showTextOps: index.showTextOps };
}

const edit = (run: TextRun, text: string): RunEdit => ({
  runId: run.id, text, align: run.align, shrinkToFit: false,
  sizeScale: 1, tracking: 0, dx: 0, dy: 0,
});

describe('content stream scanner', () => {
  it('finds exactly as many show-text operators as pdf.js reports', async () => {
    const { bytes, showTextOps } = await prepare('invoice-chrome.pdf');
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    // Reach the raw bytes the same way the eraser does.
    const { eraseSurgically } = await import('../src/pdf/surgicalErase');
    const outcome = eraseSurgically({
      doc, page: doc.getPage(0), runs: [], expectedShowOps: showTextOps,
    });
    console.log('scanner agreement:', outcome.ok ? 'exact' : outcome.reason);
    expect(outcome.ok).toBe(true);
  });

  it('splices without disturbing the surrounding bytes', () => {
    const encoder = new TextEncoder();
    const source = encoder.encode('BT /F1 9 Tf (hello) Tj 1 0 0 1 5 5 Tm (world) Tj ET');
    const spans = findShowTextSpans(source);
    expect(spans.map((s) => s.operator)).toEqual(['Tj', 'Tj']);
    expect(spans[0].stringCount).toBe(1);

    const patched = splice(source, [
      { start: spans[1].start, end: spans[1].end, replacement: '[-500.0]TJ' },
    ]);
    const text = new TextDecoder().decode(patched);
    expect(text).toBe('BT /F1 9 Tf (hello) Tj 1 0 0 1 5 5 Tm [-500.0]TJ ET');
  });

  it('is not fooled by parentheses, escapes or comments', () => {
    const encoder = new TextEncoder();
    // A string containing "Tj", an escaped paren, a nested paren, and a comment.
    const source = encoder.encode('BT (a Tj \\) b (nested) c) Tj % Tj in a comment\n(x) Tj ET');
    const spans = findShowTextSpans(source);
    expect(spans).toHaveLength(2);
    expect(new TextDecoder().decode(source.subarray(spans[0].start, spans[0].end)))
      .toBe('(a Tj \\) b (nested) c) Tj');
  });

  it('skips inline image payloads', () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('q BI /W 2 /H 1 /CS /G /BPC 8 ID '),
      // Binary bytes that spell out something operator-like, plus an unbalanced paren.
      0x28, 0x54, 0x6a, 0xff,
      ...new TextEncoder().encode(' EI Q (safe) Tj'),
    ]);
    const spans = findShowTextSpans(bytes);
    expect(spans).toHaveLength(1);
    expect(new TextDecoder().decode(bytes.subarray(spans[0].start, spans[0].end))).toBe('(safe) Tj');
  });
});

describe('surgical erase', () => {
  it('removes the original text from the file entirely', async () => {
    const { bytes, runs, source } = await prepare('invoice-chrome.pdf');
    const street = runs.find((r) => r.str === '27 avenue des Champs')!;

    for (const eraseMode of ['cover', 'surgical'] as const) {
      const { bytes: outBytes, reports, surgicalFallbacks } = await regenerate({
        originalBytes: bytes,
        pages: [source],
        edits: [edit(street, '9 place Bellecour')],
        eraseMode,
      });
      expect(surgicalFallbacks, `fallbacks in ${eraseMode}`).toEqual([]);
      expect(reports[0].erasedBy).toBe(eraseMode);

      const doc = await openBytes(outBytes);
      const text = (await (await doc.getPage(1)).getTextContent()).items
        .map((i) => ('str' in i ? i.str : '')).join('');

      expect(text, `${eraseMode} draws the new text`).toContain('9 place Bellecour');
      if (eraseMode === 'cover') {
        // The whole point of the comparison: covering hides the old address, it does not
        // remove it, so it is still there for anything reading the file as text.
        expect(text).toContain('27 avenue des Champs');
      } else {
        expect(text).not.toContain('27 avenue des Champs');
      }
      await writeFile(`fixtures/out-${eraseMode}.pdf`, outBytes);
    }
  });

  it('leaves everything outside the edit untouched', async () => {
    const { bytes, runs, source, raster, viewport } = await prepare('invoice-chrome.pdf');
    const street = runs.find((r) => r.str === '27 avenue des Champs')!;

    const { bytes: outBytes } = await regenerate({
      originalBytes: bytes,
      pages: [source],
      edits: [edit(street, '9 place Bellecour')],
      eraseMode: 'surgical',
    });

    const after = await renderRGBA(await openBytes(outBytes), 1, SCALE);
    const box = runInkBox(street, 2);
    const allowed = rectToDevice({ ...box, x: box.x - 300, width: box.width + 600 }, viewport);

    let outside = 0;
    for (let y = 0; y < raster.height; y++) {
      for (let x = 0; x < raster.width; x++) {
        const p = (y * raster.width + x) * 4;
        const delta =
          Math.abs(raster.data[p] - after.data[p]) +
          Math.abs(raster.data[p + 1] - after.data[p + 1]) +
          Math.abs(raster.data[p + 2] - after.data[p + 2]);
        if (delta <= 12) continue;
        const hit = x >= allowed.x && x <= allowed.x + allowed.width &&
                    y >= allowed.y && y <= allowed.y + allowed.height;
        if (!hit) outside++;
      }
    }
    console.log(`surgical: ${outside} changed pixels outside the edited line`);
    expect(outside).toBe(0);
  });

  it('leaves no ink behind when a line is erased outright', async () => {
    const { bytes, runs, source, viewport } = await prepare('invoice-chrome.pdf');
    // The decisive check. A per-glyph generator like Chrome emits one show-text operator
    // per character, so an eraser that only neutralises the first operator of a run still
    // renders the rest — and still defeats a naive substring assertion on the extracted
    // text, because breaking the first character is enough to make the match fail.
    const line = runs.find((r) => r.str === 'Mme Camille Durand')!;
    expect(line.pieces.length).toBeGreaterThan(10);

    const { bytes: out, reports } = await regenerate({
      originalBytes: bytes, pages: [source], edits: [edit(line, '')], eraseMode: 'surgical',
    });
    expect(reports[0].erasedBy).toBe('surgical');

    const img = await renderRGBA(await openBytes(out), 1, SCALE);
    const box = rectToDevice(runInkBox(line, 0), viewport);
    let ink = 0;
    for (let y = Math.ceil(box.y); y < Math.floor(box.y + box.height); y++) {
      for (let x = Math.ceil(box.x); x < Math.floor(box.x + box.width); x++) {
        if (img.data[(y * img.width + x) * 4] < 200) ink++;
      }
    }
    console.log(`${line.pieces.length} operators removed, ${ink} dark pixels left`);
    expect(ink).toBe(0);
  });

  it('keeps every other run at exactly its original position', async () => {
    const { bytes, runs, source } = await prepare('invoice-chrome.pdf');
    // The removed operators are replaced by an equal advance, so nothing laid out after
    // them may shift. Compared as a multiset of positions, because an invoice legitimately
    // repeats a string at the same baseline — "1 250,00 €" appears twice in one table row.
    const target = runs.find((r) => r.str === 'Boulangerie Durand SARL')!;
    const key = (r: { str: string; x: number; y: number }) =>
      `${r.str}@${r.x.toFixed(3)},${r.y.toFixed(3)}`;
    const expected = runs.filter((r) => r.id !== target.id).map(key).sort();

    const { bytes: out } = await regenerate({
      originalBytes: bytes, pages: [source], edits: [edit(target, '')], eraseMode: 'surgical',
    });

    const doc = await openBytes(out);
    const index = await buildTextIndex(await doc.getPage(1), 0);
    const actual = groupRuns(index.fragments, index.fonts, 0).runs.map(key).sort();

    console.log(`${expected.length} runs before, ${actual.length} after the erase`);
    expect(actual).toEqual(expected);
  });

  it('paints no rectangle, so a gradient background survives', async () => {
    const { bytes, runs, source, raster, viewport } = await prepare('invoice-chrome.pdf');
    // White text on the logo's gradient: covering leaves a flat patch, surgery does not.
    const logo = runs.find((r) => r.str === 'ACMECO')!;
    const box = rectToDevice(runInkBox(logo, 0), viewport);

    const distinctColours = async (mode: 'cover' | 'surgical') => {
      const { bytes: out } = await regenerate({
        originalBytes: bytes, pages: [source], edits: [edit(logo, '')], eraseMode: mode,
      });
      const img = await renderRGBA(await openBytes(out), 1, SCALE);
      const seen = new Set<string>();
      const y = Math.round(box.y + box.height / 2);
      for (let x = Math.ceil(box.x); x < Math.floor(box.x + box.width); x++) {
        const p = (y * img.width + x) * 4;
        seen.add(`${img.data[p] >> 3},${img.data[p + 1] >> 3},${img.data[p + 2] >> 3}`);
      }
      return seen.size;
    };

    const covered = await distinctColours('cover');
    const surgical = await distinctColours('surgical');
    console.log(`colours across the erased logo band: cover ${covered}, surgical ${surgical}`);
    // The gradient spans many shades; a flat fill collapses them to roughly one.
    expect(covered).toBeLessThan(4);
    expect(surgical).toBeGreaterThan(covered * 3);
    expect(raster.width).toBeGreaterThan(0);
  });
});

describe('declining safely', () => {
  it('falls back to covering when the text lives in a Form XObject', async () => {
    const { bytes, runs, source } = await prepare('invoice-xobject.pdf');
    const street = runs.find((r) => r.str === '27 avenue des Champs')!;

    const { bytes: out, reports, surgicalFallbacks } = await regenerate({
      originalBytes: bytes,
      pages: [source],
      edits: [edit(street, '9 place Bellecour')],
      eraseMode: 'surgical',
    });

    expect(surgicalFallbacks).toHaveLength(1);
    console.log('declined because:', surgicalFallbacks[0].reason);
    expect(reports[0].erasedBy).toBe('cover');

    // Declining must still produce a correct document via the cover path.
    const doc = await openBytes(out);
    const text = (await (await doc.getPage(1)).getTextContent()).items
      .map((i) => ('str' in i ? i.str : '')).join('');
    expect(text).toContain('9 place Bellecour');
  });

  it('reports a reason instead of throwing on an unpatchable page', async () => {
    const { bytes, runs, source } = await prepare('invoice-chrome.pdf');
    const street = runs.find((r) => r.str === '27 avenue des Champs')!;
    // Lie about the operator count: the guard must catch the mismatch, not mis-patch.
    const { reports, surgicalFallbacks } = await regenerate({
      originalBytes: bytes,
      pages: [{ ...source, showTextOps: 999 }],
      edits: [edit(street, '9 place Bellecour')],
      eraseMode: 'surgical',
    });
    expect(surgicalFallbacks[0].reason).toMatch(/show-text operators/);
    expect(reports[0].erasedBy).toBe('cover');
  });
});
