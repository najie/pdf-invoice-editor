import {
  PDFOperator, PDFOperatorNames as Ops, type PDFFont, type PDFName,
  beginText, endText, pushGraphicsState, popGraphicsState,
  setCharacterSpacing, setFillingRgbColor, setFontAndSize, setTextMatrix, setWordSpacing,
} from '@cantoo/pdf-lib';
import type { EncodePlan } from '../fonts/reuseEmbedded';
import type { RGB } from '../lib/types';
import type { Rect } from '../lib/geometry';

/**
 * Builds the content-stream operators for one line of replacement text.
 *
 * Deliberately not `page.drawText`. That helper cannot express character spacing, word
 * spacing, horizontal scaling or an arbitrary text matrix — and invoice generators use
 * all of them, several for justification. Ignoring the original's Tc/Tw makes replacement
 * text the wrong width even when the font is a perfect match, and ignoring the matrix
 * loses rotation and skew. Emitting the operators directly keeps every one of those.
 */

export type Content =
  /** Tier 1: pre-encoded runs of the document's own font, with gaps as TJ offsets. */
  | { kind: 'plan'; plan: EncodePlan }
  /** Tiers 0, 2 and 3: plain text the embedded font encodes itself. */
  | { kind: 'text'; text: string };

export interface DrawSpec {
  /** Baseline origin in PDF user space. */
  x: number;
  y: number;
  /** Text matrix with the font size divided out — pairs with `size` below. */
  matrix: [number, number, number, number];
  size: number;
  color: RGB;
  charSpacing: number;
  wordSpacing: number;
  fontKey: PDFName;
  font: PDFFont;
  content: Content;
}

/** `TJ` numbers displace by `-n/1000 * size`, hence the negation. */
const advanceOperand = (width1000: number) => (-width1000).toFixed(3);

export function textOperators(spec: DrawSpec): PDFOperator[] {
  const { matrix, size, color, font, content } = spec;

  const pieces: string[] =
    content.kind === 'text'
      ? [font.encodeText(content.text).toString()]
      : content.plan.parts.map((part) =>
          part.kind === 'text'
            ? font.encodeText(part.value).toString()
            : advanceOperand(part.width1000),
        );

  const ops: PDFOperator[] = [
    pushGraphicsState(),
    beginText(),
    setFontAndSize(spec.fontKey, size),
    setFillingRgbColor(color.r, color.g, color.b),
  ];
  if (spec.charSpacing) ops.push(setCharacterSpacing(spec.charSpacing));
  if (spec.wordSpacing) ops.push(setWordSpacing(spec.wordSpacing));
  ops.push(
    setTextMatrix(matrix[0], matrix[1], matrix[2], matrix[3], spec.x, spec.y),
    PDFOperator.of(Ops.ShowTextAdjusted, [`[${pieces.join(' ')}]`]),
    endText(),
    popGraphicsState(),
  );
  return ops;
}

/** Paints over the original ink. Skipped when the surgical erase removed it instead. */
export function coverOperators(rect: Rect, color: RGB): PDFOperator[] {
  return [
    pushGraphicsState(),
    setFillingRgbColor(color.r, color.g, color.b),
    PDFOperator.of(Ops.AppendRectangle, [
      rect.x.toFixed(3), rect.y.toFixed(3), rect.width.toFixed(3), rect.height.toFixed(3),
    ]),
    PDFOperator.of(Ops.FillNonZero, []),
    popGraphicsState(),
  ];
}

/**
 * Advance width of text in a font, in user-space points, including the spacing operators.
 *
 * Per the PDF spec, Tc is applied after every glyph and Tw after every space, so both
 * have to be in the total or right-aligned text lands in the wrong place.
 */
export function advanceWidth(opts: {
  baseWidth: number;
  charCount: number;
  spaceCount: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
}): number {
  const spacing = opts.charSpacing * opts.charCount + opts.wordSpacing * opts.spaceCount;
  return (opts.baseWidth + spacing) * opts.hScale;
}
