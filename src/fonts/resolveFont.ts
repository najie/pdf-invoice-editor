import type { FontInfo } from '../lib/types';
import { ALIASES } from './aliasMap';
import { CATALOG, TOP_FIVE, byId, styleOf, type Style } from './catalog';
import { parseFontName } from './normalizeName';
import {
  loadCatalogFont, measureStandard, standardMissing, type CatalogFont, type StandardFamily,
} from './provider';
import { pickReusableFont, planText, type EncodePlan } from './reuseEmbedded';

/** How the replacement glyphs will be produced. */
export type FontSource =
  /** Tier 1 — the document's own embedded font program. */
  | { kind: 'reuse'; font: FontInfo; plan: EncodePlan; sibling: boolean }
  /** Tier 0 — a standard-14 face, which needs no embedding at all. */
  | { kind: 'standard'; family: StandardFamily; style: Style }
  /** Tiers 2 and 3 — a bundled TTF. */
  | { kind: 'catalog'; familyId: string; style: Style; loaded: CatalogFont };

export type Confidence = 'exact' | 'metric' | 'approximate';

export interface FontChoice {
  tier: 0 | 1 | 2 | 3;
  source: FontSource;
  confidence: Confidence;
  /** Short badge for the UI, e.g. `Metric match: Arial -> Arimo`. */
  label: string;
  /** Advance width of the new text, in points, at `measuredAtSize`. */
  width: number;
  /** The size `width` was measured at. Advance is linear in size, so it can be rescaled. */
  measuredAtSize: number;
  /**
   * Fit signal: the new text's width over the space the original occupied. Above 1 means
   * the replacement is longer than what it replaces — a layout question, not a font one.
   */
  widthRatio: number;
  /**
   * Similarity signal: this font's width for the *original* text over the width the
   * original actually occupied. 1.000 means metrically identical to the real font, which
   * is the only objective measure of how good a substitute is. Undefined for tier 1, where
   * the font is not a substitute at all, and for added text, which replaces nothing and so
   * has no width to be compared against.
   */
  metricRatio?: number;
  /** Characters the choice cannot draw. Non-empty choices are never auto-selected. */
  missing: string[];
}

export interface ResolveInput {
  /** The font pdf.js attached to the run being edited. */
  runFont: FontInfo | undefined;
  /** Every font in the document, for the sibling-subset search. */
  documentFonts: Iterable<FontInfo>;
  newText: string;
  /** The text being replaced. Candidates are ranked by how closely they reproduce it. */
  originalText: string;
  size: number;
  /** Width the original text occupied, in points. */
  originalWidth: number;
}

/* --------------------------------- scoring -------------------------------- */

/**
 * How badly a candidate misses.
 *
 * The metric ratio dominates, and it is measured on the text being *replaced*, not on the
 * replacement: rendering the original string in a candidate and comparing against the
 * width it really occupied is a direct measurement of how close that candidate is to the
 * font the invoice was set in. Ranking on the new text instead would just reward
 * whichever font renders the user's typing shortest, which says nothing about similarity.
 */
export function scoreCandidate(opts: {
  metricRatio: number;
  serifMismatch: boolean;
  monoMismatch: boolean;
  weightMismatch: boolean;
  italicMismatch: boolean;
}): number {
  return (
    8 * Math.abs(1 - opts.metricRatio) +
    1.0 * (opts.serifMismatch ? 1 : 0) +
    1.0 * (opts.monoMismatch ? 1 : 0) +
    1.0 * (opts.weightMismatch ? 1 : 0) +
    0.5 * (opts.italicMismatch ? 1 : 0)
  );
}

/* -------------------------------- resolution ------------------------------- */

/**
 * Picks the best way to draw `newText`, and returns the runners-up so the user can
 * override. Ordering is by tier, then by measured score — never by name similarity
 * alone, which is what makes a wrong guess look confident.
 */
export async function resolveFont(input: ResolveInput): Promise<{ best: FontChoice; alternatives: FontChoice[] }> {
  const { runFont, documentFonts, newText, originalText, size, originalWidth } = input;
  const ratio = (width: number) => (originalWidth > 0 ? width / originalWidth : 1);
  /**
   * Whether there is an original to be measured against at all. Added text boxes replace
   * nothing, and `ratio` would answer 1.000 for every candidate — the UI would then assert
   * "reproduces the original width at 100.0%" about text that has no original. Leaving
   * `metricRatio` undefined says "not applicable", which is the truth. Ranking is
   * unaffected: the sort already reads `metricRatio ?? 1`.
   */
  const comparable = originalWidth > 0 && originalText.length > 0;
  const choices: FontChoice[] = [];

  const parsed = runFont ? parseFontName(runFont.baseFont) : null;
  const bold = runFont?.bold ?? false;
  const italic = runFont?.italic ?? false;
  const style = styleOf(bold, italic);

  // --- tier 1: the document's own font ------------------------------------
  if (runFont && newText) {
    const reuse = pickReusableFont(runFont, documentFonts, newText);
    if (reuse) {
      const width = (reuse.plan.width1000 / 1000) * size;
      choices.push({
        tier: 1,
        source: { kind: 'reuse', font: reuse.font, plan: reuse.plan, sibling: reuse.sibling },
        confidence: 'exact',
        label: reuse.sibling
          ? `Exact — the invoice's own ${reuse.font.family}`
          : `Exact — the invoice's own font`,
        width,
        measuredAtSize: size,
        widthRatio: ratio(width),
        missing: [],
      });
    }
  }

  // --- tier 0: a standard-14 face the file names rather than embeds --------
  if (runFont?.standard) {
    const family = runFont.standard;
    const missing = standardMissing(family, newText);
    const width = measureStandard(family, style, newText, size);
    choices.push({
      tier: 0,
      source: { kind: 'standard', family, style },
      confidence: missing.length ? 'approximate' : 'exact',
      label: missing.length
        ? `${family} (standard) — cannot draw ${missing.join(' ')}`
        : `Exact — ${family}, the font this PDF asks for`,
      width,
      measuredAtSize: size,
      widthRatio: ratio(width),
      metricRatio: comparable ? ratio(measureStandard(family, style, originalText, size)) : undefined,
      missing,
    });
  }

  // --- tiers 2 and 3: bundled families ------------------------------------
  const aliasId = parsed ? ALIASES[parsed.key] : undefined;
  const candidateIds = [...new Set([...(aliasId ? [aliasId] : []), ...TOP_FIVE, ...CATALOG.map((f) => f.id)])];

  const loaded = await Promise.all(
    candidateIds.map(async (id) => {
      try {
        return { id, font: await loadCatalogFont(id, style) };
      } catch {
        return null;
      }
    }),
  );

  for (const entry of loaded) {
    if (!entry) continue;
    const family = byId(entry.id)!;
    const width = entry.font.measure(newText, size);
    // Measured on the original text: this is the similarity signal, not the fit signal.
    const metricRatio = comparable ? ratio(entry.font.measure(originalText, size)) : undefined;
    const isAlias = entry.id === aliasId;
    const exactFamily = parsed?.key === entry.id;
    choices.push({
      tier: isAlias ? 2 : 3,
      source: { kind: 'catalog', familyId: entry.id, style, loaded: entry.font },
      confidence: isAlias ? 'metric' : 'approximate',
      label: exactFamily
        ? `Exact family — ${family.name}`
        : isAlias
          ? `Metric match: ${parsed?.family} → ${family.name}`
          : family.metricCloneOf
            ? `${family.name} (${family.metricCloneOf} metrics)`
            : family.name,
      width,
      measuredAtSize: size,
      widthRatio: ratio(width),
      metricRatio,
      missing: entry.font.missing(newText),
    });
  }

  // Rank: usable before unusable, then by tier, then by measured score.
  const scored = choices.map((choice) => {
    const family = choice.source.kind === 'catalog' ? byId(choice.source.familyId) : undefined;
    return {
      choice,
      score: scoreCandidate({
        metricRatio: choice.metricRatio ?? 1,
        serifMismatch: !!runFont && !!family && family.serif !== runFont.serif,
        monoMismatch: !!runFont && !!family && family.monospace !== runFont.monospace,
        weightMismatch: false, // the requested style is already applied per candidate
        italicMismatch: false,
      }),
    };
  });

  scored.sort((a, b) => {
    const usable = (a.choice.missing.length === 0 ? 0 : 1) - (b.choice.missing.length === 0 ? 0 : 1);
    if (usable !== 0) return usable;
    if (a.choice.tier !== b.choice.tier) return a.choice.tier - b.choice.tier;
    return a.score - b.score;
  });

  const ordered = scored.map((s) => s.choice);
  return { best: ordered[0], alternatives: ordered.slice(1) };
}

/** True when the document's own font can draw the text — used for the UI's badge. */
export function canReuseFor(runFont: FontInfo | undefined, text: string): boolean {
  return !!runFont && !!planText(runFont, text);
}
