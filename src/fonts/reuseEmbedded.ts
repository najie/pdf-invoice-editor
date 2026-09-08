import type { FontInfo } from '../lib/types';

/**
 * Tier 1 of the font engine: draw the replacement text with the font the PDF already
 * carries, so the result is not a lookalike but the same typeface at the same metrics.
 *
 * The mechanism, all of it supplied by pdf.js when `fontExtraProperties` is on:
 *   `toUnicode`   charcode -> character, reversed here to go the other way
 *   `toFontChar`  charcode -> codepoint inside the rebuilt font program (`data`)
 *   `widths`      charcode -> advance in 1/1000 em
 *
 * The catch is subsetting. Embedded invoice fonts usually contain only the glyphs the
 * document actually uses, so typing a character the original never contained has nothing
 * to draw. `planText` returns null in that case rather than emitting blanks, which is
 * what hands control to the substitution tiers.
 */

export type EncodePart =
  | { kind: 'text'; value: string }
  /** A character with a known width but no drawable glyph — emitted as a TJ offset. */
  | { kind: 'advance'; width1000: number };

export interface EncodePlan {
  parts: EncodePart[];
  /** Total advance in 1/1000 em, from the font's own width table. */
  width1000: number;
  /**
   * The private-use codepoints used, paired with the real characters they stand for.
   * The writer needs this to repair /ToUnicode so the export copy-pastes as real text.
   */
  puaToUnicode: Array<[pua: number, unicode: number]>;
}

export function canReuse(font: FontInfo): boolean {
  return font.hasProgram && !font.type3 && !!font.data && !!font.unicodeToCode && !!font.toFontChar;
}

export function planText(font: FontInfo, text: string): EncodePlan | null {
  if (!canReuse(font)) return null;
  const codes = font.unicodeToCode!;
  const toFontChar = font.toFontChar!;

  const parts: EncodePart[] = [];
  const puaToUnicode: Array<[number, number]> = [];
  let pending = '';
  let width1000 = 0;

  for (const ch of text) {
    const code = codes.get(ch);
    if (code === undefined) return null;

    const width = font.widths?.[code] ?? font.defaultWidth;
    width1000 += width;

    const fontChar = toFontChar[code];
    if (fontChar == null) {
      // pdf.js leaves the space out of toFontChar. Advancing by its width reproduces the
      // original spacing exactly and needs no glyph, so a missing *space* is not a miss.
      if (!/\s/.test(ch)) return null;
      if (pending) {
        parts.push({ kind: 'text', value: pending });
        pending = '';
      }
      parts.push({ kind: 'advance', width1000: width });
      continue;
    }

    pending += String.fromCodePoint(fontChar);
    puaToUnicode.push([fontChar, ch.codePointAt(0)!]);
  }
  if (pending) parts.push({ kind: 'text', value: pending });

  return { parts, width1000, puaToUnicode };
}

/** Advance width of `text` in this font, in user-space units, or null if uncoverable. */
export function measureReuse(font: FontInfo, text: string, size: number): number | null {
  const plan = planText(font, text);
  return plan ? (plan.width1000 / 1000) * size : null;
}

/**
 * Finds an embedded font in the document that can render `text`.
 *
 * Generators split one typeface across many subsets — the Chrome fixture here uses eight
 * subsets of a single Arial — so the font attached to the run being edited often lacks a
 * character that a sibling subset of the very same typeface has. Checking the siblings
 * costs nothing and turns a good number of tier-2 fallbacks back into exact matches.
 */
export function pickReusableFont(
  preferred: FontInfo,
  allFonts: Iterable<FontInfo>,
  text: string,
): { font: FontInfo; plan: EncodePlan; sibling: boolean } | null {
  const direct = planText(preferred, text);
  if (direct) return { font: preferred, plan: direct, sibling: false };

  for (const candidate of allFonts) {
    if (candidate.loadedName === preferred.loadedName) continue;
    // Only a subset of the *same* typeface is a safe stand-in; a different family would
    // change the letterforms, which is exactly what tier 1 exists to avoid.
    if (candidate.family !== preferred.family) continue;
    if (candidate.bold !== preferred.bold || candidate.italic !== preferred.italic) continue;
    const plan = planText(candidate, text);
    if (plan) return { font: candidate, plan, sibling: true };
  }
  return null;
}

/** Characters in `text` that no embedded sibling can draw. Drives the UI's explanation. */
export function missingCharacters(fonts: Iterable<FontInfo>, text: string): string[] {
  const usable = [...fonts].filter(canReuse);
  const missing = new Set<string>();
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (!usable.some((f) => f.unicodeToCode!.has(ch))) missing.add(ch);
  }
  return [...missing];
}
