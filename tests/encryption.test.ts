import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fixtureBytes, openBytes, openFixture, renderRGBA } from './helpers';
import { buildTextIndex } from '../src/pdf/buildTextIndex';
import { groupRuns } from '../src/pdf/groupRuns';
import { PasswordRequiredError, regenerate, type PageSource } from '../src/pdf/regenerate';
import { setFontLoader } from '../src/fonts/provider';

beforeAll(() => setFontLoader(async (p) => new Uint8Array(await readFile(`public${p}`))));

async function prepare(fixture: string) {
  const bytes = await fixtureBytes(fixture);
  const doc = await openFixture(fixture);
  const page = await doc.getPage(1);
  const index = await buildTextIndex(page, 0);
  const { runs } = groupRuns(index.fragments, index.fonts, 0);
  const raster = await renderRGBA(doc, 1, 2);
  const source: PageSource = {
    pageIndex: 0,
    runs: new Map(runs.map((r) => [r.id, r])),
    fonts: index.fonts,
    raster: {
      pixels: raster.data, width: raster.width, height: raster.height,
      viewport: page.getViewport({ scale: 2 }),
    },
    showTextOps: index.showTextOps,
  };
  return { bytes, runs, source };
}

describe('encrypted documents', () => {
  it('edits an owner-password-only invoice and reports the decryption', async () => {
    // The common case on utility and bank invoices: openable by anyone, permissions
    // restricted. Ignoring the encryption instead of decrypting it would leave every
    // stream ciphered and produce a file that saves fine and cannot be opened.
    const { bytes, runs, source } = await prepare('invoice-owner-locked.pdf');
    const city = runs.find((r) => r.str === '69003 Lyon')!;

    const { bytes: out, wasEncrypted, reports } = await regenerate({
      originalBytes: bytes,
      pages: [source],
      edits: [{ runId: city.id, text: '75006 Paris', align: city.align, shrinkToFit: false, sizeScale: 1, tracking: 0, dx: 0, dy: 0 }],
      eraseMode: 'surgical',
    });
    console.log(`owner-locked: wasEncrypted=${wasEncrypted}, erasedBy=${reports[0].erasedBy}`);
    expect(wasEncrypted).toBe(true);

    // The export must be a readable, correct PDF.
    const doc = await openBytes(out);
    const text = (await (await doc.getPage(1)).getTextContent()).items
      .map((i) => ('str' in i ? i.str : '')).join('');
    expect(text).toContain('75006 Paris');
    expect(text).not.toContain('69003 Lyon');
    // And it must still render — a document left encrypted would draw nothing.
    const raster = await renderRGBA(doc, 1, 2);
    let ink = 0;
    for (let i = 0; i < raster.data.length; i += 4) if (raster.data[i] < 128) ink++;
    console.log(`  rendered ${ink} dark pixels`);
    expect(ink).toBeGreaterThan(5000);
  });

  it('refuses a real password-protected invoice with a clear message', async () => {
    const bytes = await fixtureBytes('invoice-password.pdf');
    await expect(
      regenerate({ originalBytes: bytes, pages: [], edits: [] }),
    ).rejects.toThrow(PasswordRequiredError);
  });

  it('reports no encryption for an ordinary invoice', async () => {
    const { bytes } = await prepare('invoice-chrome.pdf');
    const { wasEncrypted } = await regenerate({ originalBytes: bytes, pages: [], edits: [] });
    expect(wasEncrypted).toBe(false);
  });
});
