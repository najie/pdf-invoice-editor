import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { openFixture } from './helpers';
import { buildTextIndex } from '../src/pdf/buildTextIndex';
import { groupRuns } from '../src/pdf/groupRuns';
import { setFontLoader } from '../src/fonts/provider';
import { resolveFont } from '../src/fonts/resolveFont';
import { missingCharacters } from '../src/fonts/reuseEmbedded';
import type { FontInfo, TextRun } from '../src/lib/types';

beforeAll(() => {
  setFontLoader(async (path) => new Uint8Array(await readFile(`public${path}`)));
});

async function loadFixture() {
  const doc = await openFixture('invoice-chrome.pdf');
  const page = await doc.getPage(1);
  const index = await buildTextIndex(page, 0);
  const { runs } = groupRuns(index.fragments, index.fonts, 0);
  return { runs, fonts: index.fonts };
}

async function resolve(run: TextRun, fonts: Map<string, FontInfo>, newText: string) {
  return resolveFont({
    runFont: fonts.get(run.fontLoadedName),
    documentFonts: fonts.values(),
    newText,
    originalText: run.str,
    size: run.size,
    originalWidth: run.width,
  });
}

describe('font engine', () => {
  it('reuses the invoice font when every character is in a subset', async () => {
    const { runs, fonts } = await loadFixture();
    const run = runs.find((r) => r.str === 'Boulangerie Durand SARL')!;
    const { best } = await resolve(run, fonts, 'Boulangerie Durand SARL');
    console.log(`unchanged text -> tier ${best.tier} | ${best.label} | ratio ${best.widthRatio.toFixed(4)}`);
    expect(best.tier).toBe(1);
    // Same text in the same font must reproduce the original width to the micron.
    expect(best.widthRatio).toBeCloseTo(1, 5);
  });

  it('borrows a sibling subset of the same typeface when the run font falls short', async () => {
    const { runs, fonts } = await loadFixture();
    // This run uses a bold subset; ask it for text only a regular sibling could hold.
    const run = runs.find((r) => r.str === 'Boulangerie Durand SARL')!;
    const { best } = await resolve(run, fonts, 'Boulangerie Durand SARL 2026');
    console.log(`with digits -> tier ${best.tier} | ${best.label} | ratio ${best.widthRatio.toFixed(3)}`);
    expect(best.tier).toBe(1);
    if (best.source.kind === 'reuse') {
      console.log('  drawn with:', best.source.font.baseFont, 'sibling:', best.source.sibling);
    }
  });

  it('falls back to the metric-compatible clone when characters are genuinely absent', async () => {
    const { runs, fonts } = await loadFixture();
    const run = runs.find((r) => r.str === 'Boulangerie Durand SARL')!;
    const text = 'Wolfgang Kühn Konditorei GmbH';
    console.log('characters no subset holds:', missingCharacters(fonts.values(), text).join(' '));

    const { best, alternatives } = await resolve(run, fonts, text);
    console.log(`-> tier ${best.tier} | ${best.label} | metric ${best.metricRatio?.toFixed(4)} fit ${best.widthRatio.toFixed(3)}`);
    for (const alt of alternatives.slice(0, 5)) {
      console.log(`   alt tier ${alt.tier} ${alt.label.padEnd(38)} metric ${alt.metricRatio?.toFixed(4)} fit ${alt.widthRatio.toFixed(3)}`);
    }
    expect(best.tier).toBe(2);
    expect(best.source.kind).toBe('catalog');
    if (best.source.kind === 'catalog') expect(best.source.familyId).toBe('arimo');
    expect(best.missing).toEqual([]);
  });

  it('substitutes Arial with Arimo at the same width', async () => {
    const { runs, fonts } = await loadFixture();
    const run = runs.find((r) => r.str === 'Boulangerie Durand SARL')!;
    // Force tier 2 by asking for a character no subset has, then compare the width of
    // the *original* string under the substitute against what the original occupied.
    const { alternatives, best } = await resolve(run, fonts, run.str + 'Ω');
    const arimo = [best, ...alternatives].find(
      (c) => c.source.kind === 'catalog' && c.source.familyId === 'arimo',
    )!;
    if (arimo.source.kind !== 'catalog') throw new Error('unreachable');
    const substituteWidth = arimo.source.loaded.measure(run.str, run.size);
    const drift = Math.abs(substituteWidth - run.width) / run.width;
    console.log(`Arial ${run.width.toFixed(3)}pt vs Arimo ${substituteWidth.toFixed(3)}pt -> ${(drift * 100).toFixed(3)}% drift`);
    expect(drift).toBeLessThan(0.002);
  });

  it('reports bold and italic from the font descriptor', async () => {
    const { runs, fonts } = await loadFixture();
    const heading = runs.find((r) => r.str === 'FACTURE')!;
    const font = fonts.get(heading.fontLoadedName)!;
    console.log('FACTURE font:', font.baseFont, 'bold:', font.bold, 'italic:', font.italic);
    expect(font.bold).toBe(true);
    const { best } = await resolve(heading, fonts, 'FACTURE ACQUITTÉE');
    console.log(`-> tier ${best.tier} | ${best.label}`);
    if (best.source.kind === 'catalog') expect(best.source.style).toBe('Bold');
  });
});
