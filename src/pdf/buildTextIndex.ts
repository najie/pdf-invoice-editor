import type { PDFPageProxy } from 'pdfjs-dist';
import { pdfjs } from './loadDocument';
import { parseFontName } from '../fonts/normalizeName';
import { STANDARD_14 } from '../fonts/aliasMap';
import type { Fragment, FontInfo, PageInfo, RGB, ShowOpRef } from '../lib/types';

const OPS = pdfjs.OPS;

export interface TextIndex {
  page: PageInfo;
  fonts: Map<string, FontInfo>;
  fragments: Fragment[];
  /**
   * How many show-text operators pdf.js saw on this page. The surgical erase compares this
   * against the count found in the raw content stream: if they disagree, the ordinals do
   * not line up (text inside a Form XObject is the usual cause) and it declines to patch.
   */
  showTextOps: number;
  /** Share of fragments whose style could be attributed with confidence. Diagnostics. */
  alignment: { total: number; aligned: number; resynced: number };
}

/** `#rrggbb` (pdf.js normalises every fill-colour operator to this) -> 0..1 RGB. */
function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

const BLACK: RGB = { r: 0, g: 0, b: 0 };

/** Reverse the serialized ToUnicode CMap: character -> charcode. */
function reverseToUnicode(font: { toUnicode?: { _map?: unknown } }): Map<string, number> | null {
  const map = font.toUnicode?._map;
  if (!Array.isArray(map)) return null;
  const rev = new Map<string, number>();
  for (let code = 0; code < map.length; code++) {
    const u = map[code];
    // Multi-character entries (ligatures) are skipped: we can only reverse 1:1 mappings.
    if (typeof u === 'string' && [...u].length === 1 && !rev.has(u)) rev.set(u, code);
  }
  return rev.size ? rev : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function readFontInfo(loadedName: string, f: any): FontInfo {
  const parsed = parseFontName(f.name ?? loadedName);
  return {
    loadedName,
    baseFont: f.name ?? loadedName,
    family: parsed.family,
    // pdf.js's own flags come from the FontDescriptor, so they beat name parsing;
    // fall back to the name when the descriptor said nothing.
    bold: f.bold ?? parsed.bold,
    italic: f.italic ?? parsed.italic,
    serif: !!f.isSerifFont,
    monospace: !!f.isMonospace,
    hasProgram: !f.missingFile && !!f.data,
    standard: parsed.subset ? null : STANDARD_14[parsed.key] ?? null,
    type3: !!f.isType3Font,
    data: f.data instanceof Uint8Array ? f.data : null,
    unicodeToCode: reverseToUnicode(f),
    toFontChar: Array.isArray(f.toFontChar) ? f.toFontChar : null,
    widths: f.widths && typeof f.widths === 'object' ? f.widths : null,
    defaultWidth: typeof f.defaultWidth === 'number' ? f.defaultWidth : 500,
    ascent: Number.isFinite(f.ascent) ? f.ascent : 0.75,
    descent: Number.isFinite(f.descent) ? f.descent : -0.25,
  };
}

/** One show-text operator plus the graphics state in force when it ran. */
interface StyledOp {
  opIndex: number;
  font: string;
  color: RGB;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  renderMode: number;
  /** The glyphs' unicode, concatenated — used to pair this op with a text item. */
  text: string;
  /** Advance bookkeeping, so the operator can later be replaced by an equal offset. */
  metrics: ShowOpRef;
}

const stripWs = (s: string) => s.replace(/\s+/g, '');

/**
 * Walks the operator list once and pairs each show-text operator with the text item
 * `getTextContent()` produced for it.
 *
 * Why both sources: `getTextContent()` has the battle-tested geometry (text matrix
 * bookkeeping across the Td, TD, T-star and TL operators is genuinely fiddly) but reports only a pdf.js-internal
 * font id — no colour, no character spacing, no real font name. The operator list has all
 * of those but no positions. They are emitted from the same worker parse in the same
 * order, so a two-pointer walk pairs them up, with a resync for the space characters
 * pdf.js synthesises from positional gaps and which have no operator behind them.
 */
export async function buildTextIndex(page: PDFPageProxy, pageIndex: number): Promise<TextIndex> {
  const opList = await page.getOperatorList();
  const textContent = await page.getTextContent({ disableNormalization: true });

  const fonts = new Map<string, FontInfo>();
  const ops: StyledOp[] = [];

  let font = '';
  let color: RGB = BLACK;
  let charSpacing = 0;
  let wordSpacing = 0;
  let hScale = 1;
  let renderMode = 0;

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i] as any;
    switch (fn) {
      case OPS.setFont: {
        font = args[0];
        if (!fonts.has(font)) {
          const obj = page.commonObjs.get(font) ?? page.objs.get(font);
          if (obj) fonts.set(font, readFontInfo(font, obj));
        }
        break;
      }
      // pdf.js funnels setFillGray / setFillCMYKColor / setFillColor through this one
      // operator, whose single argument is an `#rrggbb` string.
      case OPS.setFillRGBColor:
        if (typeof args[0] === 'string') color = hexToRgb(args[0]);
        break;
      case OPS.setCharSpacing:
        charSpacing = args[0];
        break;
      case OPS.setWordSpacing:
        wordSpacing = args[0];
        break;
      case OPS.setHScale:
        hScale = args[0] / 100;
        break;
      case OPS.setTextRenderingMode:
        renderMode = args[0];
        break;
      case OPS.showText: {
        const glyphs = args[0] as Array<{ unicode?: string; width?: number; isSpace?: boolean } | number | null>;
        let text = '';
        let width1000 = 0;
        let adjust1000 = 0;
        let glyphCount = 0;
        let spaceCount = 0;
        for (const g of glyphs) {
          // Numeric entries are a TJ array's kerning adjustments; the rest are glyphs.
          if (typeof g === 'number') {
            adjust1000 += g;
            continue;
          }
          if (!g || typeof g !== 'object') continue;
          if (typeof g.unicode === 'string') text += g.unicode;
          width1000 += g.width ?? 0;
          glyphCount++;
          if (g.isSpace) spaceCount++;
        }
        ops.push({
          opIndex: i,
          font, color, charSpacing, wordSpacing, hScale, renderMode, text,
          metrics: { showIndex: ops.length, width1000, adjust1000, glyphCount, spaceCount },
        });
        break;
      }
      default:
        break;
    }
  }

  // --- pair items with operators -------------------------------------------
  const fragments: Fragment[] = [];
  const stats = { total: 0, aligned: 0, resynced: 0 };
  let cursor = 0;
  let lastStyle: StyledOp | undefined;

  for (const raw of textContent.items) {
    if (!('str' in raw)) continue; // marked-content marker
    const item = raw as {
      str: string; transform: number[]; width: number; height: number;
      fontName: string; hasEOL: boolean;
    };
    if (!item.str) continue;
    stats.total++;

    const key = stripWs(item.str);

    // Resync: if the operator under the cursor belongs to a different font than the
    // item, or its text cannot start this item, look ahead for one that can.
    if (key && (cursor >= ops.length || ops[cursor].font !== item.fontName)) {
      const limit = Math.min(ops.length, cursor + 64);
      for (let j = cursor; j < limit; j++) {
        if (ops[j].font === item.fontName && stripWs(ops[j].text) && key.startsWith(stripWs(ops[j].text)[0])) {
          if (j !== cursor) stats.resynced++;
          cursor = j;
          break;
        }
      }
    }

    const first = ops[cursor];
    const consumed: StyledOp[] = [];
    let acc = '';
    while (cursor < ops.length && stripWs(acc).length < key.length) {
      acc += ops[cursor].text;
      consumed.push(ops[cursor]);
      cursor++;
    }
    const style = first ?? lastStyle;
    if (style) lastStyle = style;
    if (style && stripWs(acc).startsWith(key.slice(0, Math.min(4, key.length)))) stats.aligned++;

    const [, , c, d] = item.transform;
    const size = Math.hypot(c, d) || Math.abs(item.height) || 1;
    fragments.push({
      str: item.str,
      transform: item.transform,
      width: item.width,
      height: item.height,
      fontLoadedName: item.fontName,
      size,
      color: style?.color ?? BLACK,
      charSpacing: style?.charSpacing ?? 0,
      wordSpacing: style?.wordSpacing ?? 0,
      hScale: style?.hScale ?? 1,
      renderMode: style?.renderMode ?? 0,
      hasEOL: item.hasEOL,
      opIndex: style?.opIndex ?? -1,
      showOps: consumed.map((op) => op.metrics),
    });

    // Fonts referenced only by getTextContent (no setFont seen yet) still need an entry.
    if (!fonts.has(item.fontName)) {
      const obj = page.commonObjs.get(item.fontName) ?? page.objs.get(item.fontName);
      if (obj) fonts.set(item.fontName, readFontInfo(item.fontName, obj));
    }
  }

  const viewport = page.getViewport({ scale: 1, rotation: 0 });
  return {
    page: {
      index: pageIndex,
      width: viewport.width,
      height: viewport.height,
      rotation: page.rotate,
    },
    fonts,
    fragments,
    showTextOps: ops.length,
    alignment: stats,
  };
}
