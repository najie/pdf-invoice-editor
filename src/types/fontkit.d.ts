declare module 'fontkit' {
  /** Advance widths come back in font units; divide by `unitsPerEm`. */
  export interface GlyphRun {
    advanceWidth: number;
  }
  export interface Glyph {
    id: number;
    /** Mutable: the writer rewrites these to repair /ToUnicode. */
    codePoints: number[];
  }
  export interface FontkitFont {
    unitsPerEm: number;
    postscriptName: string | null;
    characterSet: number[];
    layout(text: string, features?: string[]): GlyphRun;
    hasGlyphForCodePoint(codePoint: number): boolean;
    glyphForCodePoint(codePoint: number): Glyph | null;
  }
  export function create(data: Uint8Array, postscriptName?: string): FontkitFont;
}
