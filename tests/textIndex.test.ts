import { describe, expect, it } from 'vitest';
import { openFixture } from './helpers';
import { buildTextIndex } from '../src/pdf/buildTextIndex';

describe('buildTextIndex', () => {
  it('attributes style to every fragment of a Chrome-printed invoice', async () => {
    const doc = await openFixture('invoice-chrome.pdf');
    const page = await doc.getPage(1);
    const index = await buildTextIndex(page, 0);

    console.log('alignment:', index.alignment);
    console.log('fonts:', [...index.fonts.values()].map(f =>
      `${f.baseFont} -> ${f.family}${f.bold ? ' bold' : ''}${f.italic ? ' italic' : ''} ` +
      `embedded=${f.embedded} data=${f.data?.length ?? 0} rev=${f.unicodeToCode?.size ?? 0}`).join('\n       '));

    expect(index.fragments.length).toBeGreaterThan(50);
    // Every fragment must be paired with a real operator, else colour/spacing is a guess.
    expect(index.alignment.aligned).toBe(index.alignment.total);

    const colours = new Set(index.fragments.map(f => `${f.color.r},${f.color.g},${f.color.b}`));
    console.log('distinct text colours:', [...colours]);
    // The fixture has dark body text, grey footnotes and white text in the logo.
    expect(colours.size).toBeGreaterThanOrEqual(3);

    const white = index.fragments.filter(f => f.color.r > 0.9 && f.color.g > 0.9 && f.color.b > 0.9);
    console.log('white fragments:', white.map(f => f.str));
    expect(white.some(f => f.str.includes('ACMECO'))).toBe(true);
  });
});

describe('groupRuns', () => {
  it('merges the client address into one left-aligned block', async () => {
    const { groupRuns } = await import('../src/pdf/groupRuns');
    const doc = await openFixture('invoice-chrome.pdf');
    const page = await doc.getPage(1);
    const index = await buildTextIndex(page, 0);
    const { runs, blocks } = groupRuns(index.fragments, index.fonts, 0);

    const byId = new Map(runs.map(r => [r.id, r]));
    console.log('runs:', runs.length, 'blocks:', blocks.length);
    for (const b of blocks) {
      console.log(`  ${b.align.padEnd(6)} lead=${b.leading.toFixed(1)}  ` +
        b.runIds.map(id => JSON.stringify(byId.get(id)!.str)).join(' | '));
    }

    const address = blocks.find(b => byId.get(b.runIds[0])!.str.includes('Boulangerie'));

    expect(address, 'client address should form a block').toBeDefined();
    expect(address!.align).toBe('left');
    expect(address!.runIds.map(id => byId.get(id)!.str)).toEqual([
      'Boulangerie Durand SARL', 'Mme Camille Durand', '27 avenue des Champs', '69003 Lyon', 'France',
    ]);

    // The reference column on the right must come out right-aligned, or replacement text
    // would drift out of its column.
    const ref = runs.find(r => r.str.includes('Bon de commande'));
    expect(ref?.align).toBe('right');

    const amount = runs.find(r => r.str === '5 388,00 €');
    expect(amount?.align).toBe('right');
  });
});
