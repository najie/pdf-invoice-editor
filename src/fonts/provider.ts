import { Encodings, Font as AfmFont, FontNames } from '@pdf-lib/standard-fonts';
import { createFont } from './fontkit';
import { CATALOG, fontPath, type Style } from './catalog';

/**
 * Loads and measures replacement fonts.
 *
 * Measuring is deliberately independent of writing: the UI ranks candidates and previews
 * fit while the user types, long before any PDF is generated. Widths come straight from
 * fontkit, which is the same engine pdf-lib will use to lay the text out, so what is
 * measured here is what gets drawn.
 */

export type FontLoader = (path: string) => Promise<Uint8Array>;

let loadBytes: FontLoader = async (path) => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`could not load ${path}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

/** Node tests read from disk instead of fetching over HTTP. */
export function setFontLoader(loader: FontLoader): void {
  loadBytes = loader;
}

export interface CatalogFont {
  familyId: string;
  style: Style;
  bytes: Uint8Array;
  /** Advance width of `text` at `size`, in points. */
  measure(text: string, size: number): number;
  covers(text: string): boolean;
  missing(text: string): string[];
}

const cache = new Map<string, Promise<CatalogFont>>();

export function loadCatalogFont(familyId: string, style: Style): Promise<CatalogFont> {
  const key = `${familyId}/${style}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const promise = (async (): Promise<CatalogFont> => {
    const bytes = await loadBytes(fontPath(familyId, style));
    const font = createFont(bytes);
    const scale = 1 / font.unitsPerEm;
    return {
      familyId,
      style,
      bytes,
      measure: (text, size) => font.layout(text).advanceWidth * scale * size,
      covers: (text) => [...text].every((ch) => /\s/.test(ch) || font.hasGlyphForCodePoint(ch.codePointAt(0)!)),
      missing: (text) => [...new Set([...text])].filter(
        (ch) => !/\s/.test(ch) && !font.hasGlyphForCodePoint(ch.codePointAt(0)!),
      ),
    };
  })();

  cache.set(key, promise);
  return promise;
}

export function preloadTopFonts(ids: readonly string[], style: Style): void {
  for (const id of ids) void loadCatalogFont(id, style).catch(() => undefined);
}

/* ------------------------------- standard 14 ------------------------------- */

export type StandardFamily = 'Helvetica' | 'Times' | 'Courier' | 'Symbol' | 'ZapfDingbats';

const STANDARD_NAMES: Record<StandardFamily, Record<Style, string>> = {
  Helvetica: {
    Regular: FontNames.Helvetica, Bold: FontNames.HelveticaBold,
    Italic: FontNames.HelveticaOblique, BoldItalic: FontNames.HelveticaBoldOblique,
  },
  Times: {
    Regular: FontNames.TimesRoman, Bold: FontNames.TimesRomanBold,
    Italic: FontNames.TimesRomanItalic, BoldItalic: FontNames.TimesRomanBoldItalic,
  },
  Courier: {
    Regular: FontNames.Courier, Bold: FontNames.CourierBold,
    Italic: FontNames.CourierOblique, BoldItalic: FontNames.CourierBoldOblique,
  },
  Symbol: { Regular: FontNames.Symbol, Bold: FontNames.Symbol, Italic: FontNames.Symbol, BoldItalic: FontNames.Symbol },
  ZapfDingbats: {
    Regular: FontNames.ZapfDingbats, Bold: FontNames.ZapfDingbats,
    Italic: FontNames.ZapfDingbats, BoldItalic: FontNames.ZapfDingbats,
  },
};

export function standardFontName(family: StandardFamily, style: Style): string {
  return STANDARD_NAMES[family][style];
}

const afmCache = new Map<string, ReturnType<typeof AfmFont.load>>();

function afm(name: string) {
  let font = afmCache.get(name);
  if (!font) {
    font = AfmFont.load(name as Parameters<typeof AfmFont.load>[0]);
    afmCache.set(name, font);
  }
  return font;
}

/**
 * The standard-14 fonts are encoded with WinAnsi, which covers Latin-1 and the euro sign
 * but nothing beyond — a curly apostrophe or an "š" has no code point to write. pdf-lib
 * throws when asked to encode one, so coverage is checked up front and the resolver
 * escalates to an embedded TTF instead.
 */
export function standardCovers(family: StandardFamily, text: string): boolean {
  return standardMissing(family, text).length === 0;
}

export function standardMissing(family: StandardFamily, text: string): string[] {
  const encoding = family === 'Symbol' ? Encodings.Symbol
    : family === 'ZapfDingbats' ? Encodings.ZapfDingbats
    : Encodings.WinAnsi;
  return [...new Set([...text])].filter((ch) => {
    if (/\s/.test(ch)) return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return !(encoding as any).encodeUnicodeCodePoint(ch.codePointAt(0));
    } catch {
      return true;
    }
  });
}

export function measureStandard(family: StandardFamily, style: Style, text: string, size: number): number {
  const font = afm(standardFontName(family, style));
  const encoding = family === 'Symbol' ? Encodings.Symbol
    : family === 'ZapfDingbats' ? Encodings.ZapfDingbats
    : Encodings.WinAnsi;
  let total = 0;
  for (const ch of text) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { name } = (encoding as any).encodeUnicodeCodePoint(ch.codePointAt(0));
      total += font.getWidthOfGlyph(name) ?? 0;
    } catch {
      total += 0;
    }
  }
  return (total / 1000) * size;
}

export const CATALOG_IDS = CATALOG.map((f) => f.id);
