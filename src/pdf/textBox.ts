import { advanceWidth } from './emitText';
import { alignedOrigin, baselineUnit, inkQuadBounds, runInkBox, type Rect } from '../lib/geometry';
import type { FontChoice } from '../fonts/resolveFont';
import type { RunEdit } from './regenerate';
import type { RGB, TextRun } from '../lib/types';

/**
 * Text the user adds to a page, for the case the rest of the app cannot serve: a TVA number
 * the invoice simply never contained, so there is no line to click and retype.
 *
 * A box is modelled as a *synthetic `TextRun`* rather than as a new kind of thing, which is
 * what keeps this feature small. With `width: 0` the whole writer works unchanged —
 * `alignedOrigin` degenerates to anchor-point semantics, the shrink-to-fit loop's
 * `run.width > 0` guard makes it inert, and `resolveFont` sees an empty original and so
 * claims no similarity. With `pieces: []` the surgical erase can never splice anything for
 * a box, because there is no original ink to remove.
 *
 * This is the third producer of `TextRun`, beside `buildTextIndex` and `groupRuns`.
 */
export interface TextBox {
  /**
   * The synthesised run. Built once, here, and never rebuilt: `useFontChoices` keys its
   * debounced resolve on run identity, so a run re-synthesised during render would
   * re-resolve forever.
   */
  run: TextRun;
  /** The run the typography was copied from, for the panel's provenance line. */
  templateRunId: string | null;
  /**
   * Advance width of the text as it will be drawn, in points. 0 until a font resolves.
   * Only ever sizes the on-page handle — the writer measures its own, so a stale value here
   * can never misplace ink.
   */
  measuredWidth: number;
}

/** Font metrics pdf.js could not supply. The same fallbacks `groupRuns` already uses. */
const DEFAULT_ASCENT = 0.75;
const DEFAULT_DESCENT = -0.25;
const DEFAULT_SIZE = 10;
const BLACK: RGB = { r: 0, g: 0, b: 0 };

/** Rec. 709 relative luminance. */
const luminance = (c: RGB) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * The colour to type in.
 *
 * The template's own colour, so an added line matches the invoice — unless the nearest text
 * happened to be white-on-dark logo type, in which case the addition would be invisible on
 * paper and read as "the feature is broken". Black is the honest fallback there.
 */
function inkColor(template: TextRun | null): RGB {
  if (!template) return BLACK;
  return luminance(template.color) > 0.85 ? BLACK : template.color;
}

/**
 * Creates a box anchored at a point in PDF user space.
 *
 * Typography is inherited from `template` — the nearest existing line — so a TVA number
 * dropped under the address comes out in the invoice's own font at the invoice's own size,
 * and resolves through the same four tiers as a retype. Two things are deliberately *not*
 * inherited: `wordSpacing`, because `Tw` is nearly always a justification hack and copying
 * it puts multi-point gaps inside a freshly typed string; and the template matrix's scale
 * and skew, because a horizontal squeeze or a synthetic italic is not something the user
 * asked for and cannot see the cause of. Rotation *is* kept, so a box templated off rotated
 * text runs along the same baseline.
 */
export function createTextBox(opts: {
  id: string;
  pageIndex: number;
  /** Click point, user space. Ends up the vertical middle of the text, not its baseline. */
  x: number;
  y: number;
  template: TextRun | null;
}): TextBox {
  const { id, pageIndex, x, y, template } = opts;

  const size = template?.size ?? DEFAULT_SIZE;
  const ascent = template?.ascent ?? DEFAULT_ASCENT;
  const descent = template?.descent ?? DEFAULT_DESCENT;

  // Keep the template's rotation, drop its scale and skew. Dividing the baseline vector by
  // its own length also makes `baselineUnit(run).hScale === 1`, so the advance arithmetic
  // downstream stays plain.
  const unit = template ? baselineUnit(template) : { ux: 1, uy: 0 };
  // `+ 0` collapses the negative zero `-uy` yields for upright text: harmless in the output,
  // but it makes the matrix compare unequal to the identity it is.
  const matrix: [number, number, number, number] = [unit.ux, unit.uy, -unit.uy + 0, unit.ux];

  // A run's origin is its baseline, and text drawn from the click point would sit entirely
  // above the cursor. Shifting down by half the em height puts the click in the middle of
  // the text, which is where a user who clicked there expects it.
  const mid = ((ascent + descent) / 2) * size;
  const nx = -unit.uy;
  const ny = unit.ux;

  return {
    templateRunId: template?.id ?? null,
    measuredWidth: 0,
    run: {
      id,
      pageIndex,
      // "There was nothing here." Makes `isDirty` true on the first keystroke, and gives
      // `resolveFont` an empty original so it ranks candidates without claiming a match.
      str: '',
      x: x - nx * mid,
      y: y - ny * mid,
      // Unlocks anchor semantics in `alignedOrigin`: left starts at the anchor, right ends
      // at it, center is centred on it.
      width: 0,
      size,
      // '' resolves to `undefined` in `page.fonts`, so a page with no text needs no
      // special case: the resolver simply skips the tiers that need a source font.
      fontLoadedName: template?.fontLoadedName ?? '',
      color: inkColor(template),
      charSpacing: template?.charSpacing ?? 0,
      wordSpacing: 0,
      hScale: 1,
      matrix,
      ascent,
      descent,
      pieces: [],
      align: 'left',
    },
  };
}

/**
 * The run nearest a point, or null on a page with no text.
 *
 * Distance is to a run's ink box, not to its origin: a long line whose origin sits far to
 * the left must not lose to a short irrelevant one that happens to start nearby.
 */
export function nearestRun(runs: TextRun[], x: number, y: number): TextRun | null {
  let best: TextRun | null = null;
  let bestDistance = Infinity;
  for (const run of runs) {
    const box = runInkBox(run, 0);
    const dx = Math.max(box.x - x, 0, x - (box.x + box.width));
    const dy = Math.max(box.y - y, 0, y - (box.y + box.height));
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = run;
    }
  }
  return best;
}

/**
 * Advance width of a box's text in a resolved font, points.
 *
 * Deliberately the same `advanceWidth` call the writer makes, so the on-page handle bounds
 * exactly the glyphs that will be drawn rather than an approximation of them.
 */
export function boxTextWidth(box: TextBox, edit: RunEdit, choice: FontChoice): number {
  const size = box.run.size * edit.sizeScale;
  const base = choice.measuredAtSize ? (choice.width / choice.measuredAtSize) * size : 0;
  const { hScale } = baselineUnit(box.run);
  return advanceWidth({
    baseWidth: base,
    charCount: [...edit.text].length,
    spaceCount: [...edit.text].filter((ch) => ch === ' ').length,
    charSpacing: box.run.charSpacing + edit.tracking,
    wordSpacing: box.run.wordSpacing,
    hScale,
  });
}

/**
 * Width to draw the handle at before any font has resolved.
 *
 * 0.55 em is about the average advance of digits and mixed-case Latin in Helvetica/Arial
 * metrics. Being ten percent out is invisible in a click target, and it is replaced by the
 * measured width as soon as the resolver returns.
 */
export function estimateBoxWidth(box: TextBox, text: string): number {
  return 0.55 * box.run.size * [...text].length;
}

/** Where a box's text sits on the page right now, for the overlay handle. */
export function boxBounds(box: TextBox, edit: RunEdit | undefined): Rect {
  const text = edit?.text ?? '';
  const width = box.measuredWidth || estimateBoxWidth(box, text);
  // Through `alignedOrigin` so the handle tracks the alignment anchor the same way the ink
  // does: a right-aligned box grows leftwards from the point that was clicked.
  const origin = alignedOrigin(box.run, width, edit?.align ?? 'left');
  return inkQuadBounds(
    { ...box.run, x: origin.x + (edit?.dx ?? 0), y: origin.y + (edit?.dy ?? 0) },
    Math.max(width, 1),
    0.4,
  );
}
