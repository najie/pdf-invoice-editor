/** Shared document model. Produced by src/pdf/*, consumed by the UI and the writer. */

export type RGB = { r: number; g: number; b: number };

/** The font families a PDF may reference without embedding anything. */
export type StandardFamily = 'Helvetica' | 'Times' | 'Courier' | 'Symbol' | 'ZapfDingbats';

/** Everything we could learn about one font used by the document. */
export interface FontInfo {
  /** pdf.js internal id, e.g. `g_d0_f4`. Also the key in `page.commonObjs`. */
  loadedName: string;
  /** Raw `/BaseFont`, subset prefix included: `DAAAAA+ArialMT`. */
  baseFont: string;
  /** Human family name, subset prefix and style suffixes stripped: `Arial`. */
  family: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  monospace: boolean;
  /**
   * True when pdf.js has a font program for this font. Note this is *not* "the PDF
   * embedded it": for a standard-14 face the PDF names but does not embed, pdf.js loads
   * its own shipped copy and still reports a program. Use `standard` for that question.
   */
  hasProgram: boolean;
  /**
   * The standard-14 family this font names, or null. Set only when the name carries no
   * subset prefix, which is what distinguishes "the file asks for Helvetica" from "the
   * file embedded a subset that happens to be Helvetica-derived".
   */
  standard: StandardFamily | null;
  type3: boolean;
  /** pdf.js's rebuilt, browser-loadable font program. Null for Type3 / missing files. */
  data: Uint8Array | null;
  /** Reverse of the ToUnicode CMap: character -> charcode. Null when unbuildable. */
  unicodeToCode: Map<string, number> | null;
  /** charcode -> codepoint inside `data`. pdf.js puts these in the private-use area. */
  toFontChar: (number | null)[] | null;
  /** charcode -> advance width in 1/1000 em. */
  widths: Record<number, number> | null;
  defaultWidth: number;
  /** Fractions of em, as pdf.js reports them. */
  ascent: number;
  descent: number;
}

/** One show-text operator's worth of text, with the graphics state that applied to it. */
export interface Fragment {
  str: string;
  /** `[a,b,c,d,e,f]` in PDF user space. The font size is baked into a..d. */
  transform: number[];
  /** Advance width in user-space units. */
  width: number;
  height: number;
  fontLoadedName: string;
  /** Effective font size, i.e. `hypot(transform[2], transform[3])`. */
  size: number;
  color: RGB;
  charSpacing: number;
  wordSpacing: number;
  /** Horizontal scaling as a fraction (Tz/100). */
  hScale: number;
  renderMode: number;
  hasEOL: boolean;
  /** Index into pdf.js's operator list. */
  opIndex: number;
  /**
   * Every show-text operator this fragment was assembled from. Generators split text
   * freely — the Chrome fixture here emits one operator per glyph — so a fragment routinely
   * spans dozens, and the surgical erase has to neutralise all of them, not just the first.
   */
  showOps: ShowOpRef[];
}

/** One show-text operator, with what it needs to be replaced by an equivalent advance. */
export interface ShowOpRef {
  /** Ordinal among the page's show-text operators. */
  showIndex: number;
  /** Sum of the glyph advances it drew, in 1/1000 em. */
  width1000: number;
  /** Sum of its inline TJ kerning numbers, in 1/1000 em. */
  adjust1000: number;
  glyphCount: number;
  spaceCount: number;
}

export type Align = 'left' | 'center' | 'right';

/** Fragments merged into one visual line. This is the unit the user clicks. */
export interface TextRun {
  id: string;
  pageIndex: number;
  str: string;
  /** Baseline origin, user space. */
  x: number;
  y: number;
  width: number;
  size: number;
  fontLoadedName: string;
  color: RGB;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  /** Normalised text matrix (font size divided out) for re-emission. */
  matrix: [number, number, number, number];
  ascent: number;
  descent: number;
  /**
   * Every show-text operator this run was assembled from. The surgical erase replaces each
   * with a bare `TJ` offset of the same advance, which removes the ink and the string while
   * leaving the text position exactly where it was.
   */
  pieces: ShowOpRef[];
  align: Align;
}

/** Consecutive runs that read as one paragraph — an address, a totals column. */
export interface Block {
  id: string;
  pageIndex: number;
  runIds: string[];
  align: Align;
  /** Baseline-to-baseline distance, user space. */
  leading: number;
}

export interface PageInfo {
  index: number;
  /** Unrotated user-space size, from the viewport at scale 1. */
  width: number;
  height: number;
  rotation: number;
}
