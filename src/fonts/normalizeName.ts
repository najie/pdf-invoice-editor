/**
 * Turns a raw PDF `/BaseFont` into a family name plus style flags.
 *
 * Real-world inputs this has to survive:
 *   DAAAAA+ArialMT              -> Arial,           regular
 *   ABCDEF+Arial-BoldMT         -> Arial,           bold
 *   Arial,BoldItalic            -> Arial,           bold + italic
 *   TimesNewRomanPS-BoldMT      -> Times New Roman, bold
 *   Helvetica-Oblique           -> Helvetica,       italic
 *   LiberationSans-Regular      -> Liberation Sans, regular
 *   Calibri-Light               -> Calibri,         regular
 *   NimbusSanL-Bold             -> Nimbus San L,    bold
 */

export interface ParsedFontName {
  /** Display family, e.g. `Times New Roman`. */
  family: string;
  /** Lowercased, punctuation-free key for alias lookup, e.g. `timesnewroman`. */
  key: string;
  bold: boolean;
  italic: boolean;
  /** True when a subset prefix like `DAAAAA+` was present. */
  subset: boolean;
}

const SUBSET_PREFIX = /^[A-Z]{6}\+/;

/** Style words, longest first so `BoldItalic` wins over `Bold`. */
const STYLE_WORDS: Array<[RegExp, { bold?: boolean; italic?: boolean }]> = [
  [/bolditalic/, { bold: true, italic: true }],
  [/boldoblique/, { bold: true, italic: true }],
  [/semibolditalic/, { bold: true, italic: true }],
  [/demibolditalic/, { bold: true, italic: true }],
  [/extrabold/, { bold: true }],
  [/semibold/, { bold: true }],
  [/demibold/, { bold: true }],
  [/ultrabold/, { bold: true }],
  [/heavy/, { bold: true }],
  [/black/, { bold: true }],
  [/bold/, { bold: true }],
  [/italic/, { italic: true }],
  [/oblique/, { italic: true }],
];

/** Style abbreviations, matched only against a whole separated segment. */
const STYLE_ABBREV: Record<string, { bold?: boolean; italic?: boolean }> = {
  it: { italic: true },
  ita: { italic: true },
  obl: { italic: true },
  i: { italic: true },
  bd: { bold: true },
  b: { bold: true },
  bi: { bold: true, italic: true },
  bdit: { bold: true, italic: true },
};

/** Weight/width words that carry no bold or italic meaning but pollute the family. */
const NOISE_WORDS = [
  'regular', 'normal', 'roman', 'book', 'medium', 'light', 'thin', 'extralight',
  'ultralight', 'condensed', 'narrow', 'std', 'pro', 'mt', 'ps', 'psmt', 'ttf',
  'identity', 'h', 'v',
];

/** Insert spaces at camelCase boundaries: `TimesNewRoman` -> `Times New Roman`. */
function splitCamel(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

export function parseFontName(baseFont: string): ParsedFontName {
  const subset = SUBSET_PREFIX.test(baseFont);
  let name = baseFont.replace(SUBSET_PREFIX, '');

  // `Arial,BoldItalic` and `Arial-BoldMT` both put the style after a separator, but
  // plenty of fonts glue it on: `ArialBold`. Split on separators first, then fall back
  // to substring matching over whatever is left.
  const segments = name.split(/[-,_]/).filter(Boolean);
  let bold = false;
  let italic = false;

  const keep: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const low = seg.toLowerCase();
    // The first segment is the family even if it happens to contain a style word
    // (e.g. the family "Bodoni"); only later segments are treated as style.
    if (i > 0) {
      const abbrev = STYLE_ABBREV[low.replace(/[^a-z]/g, '')];
      if (abbrev) {
        bold = bold || !!abbrev.bold;
        italic = italic || !!abbrev.italic;
        continue;
      }
      const hit = STYLE_WORDS.find(([re]) => re.test(low));
      if (hit) {
        bold = bold || !!hit[1].bold;
        italic = italic || !!hit[1].italic;
        continue;
      }
      if (NOISE_WORDS.includes(low.replace(/[^a-z]/g, ''))) continue;
    }
    keep.push(seg);
  }
  name = keep.join(' ') || segments[0] || baseFont;

  // Glued-on styles in the family segment, e.g. `ArialBoldMT`, `Helvetica-BoldOblique`.
  const glued = name.toLowerCase().replace(/[^a-z]/g, '');
  for (const [re, flags] of STYLE_WORDS) {
    if (!re.test(glued)) continue;
    // Only strip when it leaves something behind — the family may *be* "Black".
    const stripped = name.replace(new RegExp(re.source, 'i'), '');
    if (stripped.replace(/[^A-Za-z]/g, '').length >= 3) {
      bold = bold || !!flags.bold;
      italic = italic || !!flags.italic;
      name = stripped;
    }
    break;
  }

  // Trailing foundry suffixes that survived: ArialMT, TimesNewRomanPSMT.
  name = name.replace(/(PSMT|PSM|PS|MT|MS)$/i, '');

  const family = splitCamel(name).replace(/\s+/g, ' ').trim() || baseFont;
  return {
    family,
    key: family.toLowerCase().replace(/[^a-z0-9]/g, ''),
    bold,
    italic,
    subset,
  };
}
