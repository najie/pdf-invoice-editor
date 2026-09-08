// fontkit ships no type declarations; see src/types/fontkit.d.ts for the surface used.
import { create } from 'fontkit';

/**
 * The font engine used both for measuring candidates and for pdf-lib's embedding.
 *
 * Upstream `fontkit` rather than `@pdf-lib/fontkit`: the latter is a 2022 fork whose
 * subsetter throws on several of the families bundled here, Arimo among them, and
 * subsetting is not optional — embedding a whole substitute face costs ~200 KB against
 * ~4 KB subsetted. fontkit ships a browser build, so the same code serves both targets.
 */
// pdf-lib's `Fontkit` type describes its own vendored fork's `Font`; structurally this is
// the same engine, so the cast is the narrowest way to hand it over.
export const fontkit = { create } as unknown as Parameters<
  import('@cantoo/pdf-lib').PDFDocument['registerFontkit']
>[0];

export function createFont(bytes: Uint8Array) {
  return create(bytes);
}

export type FontkitFont = ReturnType<typeof create>;
