import {
  PDFArray, PDFName, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream,
  type PDFDocument, type PDFPage,
} from '@cantoo/pdf-lib';
import { findShowTextSpans, splice, type ShowTextSpan } from './contentStream';
import type { ShowOpRef, TextRun } from '../lib/types';

/**
 * Removes the original text from the file instead of painting over it.
 *
 * The cover-and-redraw path is robust but leaves two marks: a flat rectangle that shows a
 * seam over anything patterned, and the original string still sitting in the content
 * stream, invisible but fully extractable — so an "edited" invoice still carries the old
 * address for anything that reads it as text rather than looking at it.
 *
 * This replaces each show-text operator with `[ n ] TJ`, a text-showing operator whose
 * array holds only a position adjustment. It draws nothing, it removes the string from the
 * file, and it advances the text position by exactly what the original advanced, so
 * anything positioned relative to it stays put.
 *
 * The whole thing is best-effort by design: every failure returns a reason and the caller
 * falls back to covering, because a half-applied content-stream patch is far worse than a
 * visible seam.
 */

export type SurgicalOutcome =
  | { ok: true; patchedStreams: number; erasedOperators: number }
  | { ok: false; reason: string };

/**
 * The `TJ` number that advances exactly as far as the operator being removed did.
 *
 * A `TJ` number displaces by `-n/1000 · Tfs · Th`, and the operator it replaces displaced
 * by `Σ((w/1000 · Tfs) + Tc + Tw·isSpace) · Th` minus its own inline adjustments. Dividing
 * through by `Tfs · Th` leaves the glyph widths in the very units `TJ` already uses, so the
 * common case — no character or word spacing — is simply the negated width sum.
 */
function advanceOperand(piece: ShowOpRef, charSpacing: number, wordSpacing: number, fontSize: number | null): string | null {
  const glyphs = piece.width1000 - piece.adjust1000;
  const spacing = charSpacing * piece.glyphCount + wordSpacing * piece.spaceCount;
  if (spacing === 0) return (-glyphs).toFixed(4);
  // Spacing is in unscaled text space, so it cannot be converted without the real Tfs.
  if (!fontSize) return null;
  return (-(glyphs + (spacing * 1000) / fontSize)).toFixed(4);
}

interface StreamSlot {
  ref: PDFRef;
  bytes: Uint8Array;
  spans: ShowTextSpan[];
  /** Ordinal of this stream's first show-text operator within the page. */
  offset: number;
}

/**
 * A page's content may be one stream or an array of them, which the spec treats as their
 * concatenation. Show-text ordinals therefore run across the whole sequence.
 */
function collectStreams(doc: PDFDocument, page: PDFPage): StreamSlot[] | string {
  const entry = page.node.get(PDFName.of('Contents'));
  if (!entry) return 'the page has no content stream';

  const refs: PDFRef[] = [];
  if (entry instanceof PDFRef) {
    const resolved = doc.context.lookup(entry);
    if (resolved instanceof PDFArray) {
      for (let i = 0; i < resolved.size(); i++) {
        const item = resolved.get(i);
        if (!(item instanceof PDFRef)) return 'content stream array holds a direct object';
        refs.push(item);
      }
    } else {
      refs.push(entry);
    }
  } else if (entry instanceof PDFArray) {
    for (let i = 0; i < entry.size(); i++) {
      const item = entry.get(i);
      if (!(item instanceof PDFRef)) return 'content stream array holds a direct object';
      refs.push(item);
    }
  } else {
    return 'unexpected /Contents type';
  }

  const slots: StreamSlot[] = [];
  let offset = 0;
  for (const ref of refs) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFStream)) return 'content stream is not a stream';
    if (!(stream instanceof PDFRawStream)) return 'content stream was already rewritten';
    let bytes: Uint8Array;
    try {
      bytes = decodePDFRawStream(stream).decode();
    } catch {
      return 'content stream uses an unsupported filter';
    }
    let spans: ShowTextSpan[];
    try {
      spans = findShowTextSpans(bytes);
    } catch (err) {
      return `content stream could not be scanned: ${err instanceof Error ? err.message : err}`;
    }
    // Renumber so each span's index is its ordinal within the page.
    slots.push({
      ref,
      bytes,
      spans: spans.map((s, i) => ({ ...s, index: offset + i })),
      offset,
    });
    offset += spans.length;
  }
  return slots;
}

export function eraseSurgically(opts: {
  doc: PDFDocument;
  page: PDFPage;
  /** Runs whose original text should disappear from the file. */
  runs: TextRun[];
  /** How many show-text operators pdf.js reported for this page. */
  expectedShowOps: number;
}): SurgicalOutcome {
  const { doc, page, runs, expectedShowOps } = opts;

  const slots = collectStreams(doc, page);
  if (typeof slots === 'string') return { ok: false, reason: slots };

  const found = slots.reduce((n, slot) => n + slot.spans.length, 0);
  if (found !== expectedShowOps) {
    // The usual cause is text inside a Form XObject: pdf.js inlines it into the page's
    // operator list, but its bytes live in another stream, so ordinals no longer line up.
    // Rather than guess which operator is which, decline.
    return {
      ok: false,
      reason: `found ${found} show-text operators in the content stream but the page has ${expectedShowOps}`,
    };
  }

  const byIndex = new Map<number, ShowTextSpan>();
  for (const slot of slots) for (const span of slot.spans) byIndex.set(span.index, span);

  const patchesByRef = new Map<PDFRef, Array<{ start: number; end: number; replacement: string }>>();
  let erased = 0;

  for (const run of runs) {
    for (const piece of run.pieces) {
      const span = byIndex.get(piece.showIndex);
      if (!span) return { ok: false, reason: `no operator found for show index ${piece.showIndex}` };

      const operand = advanceOperand(piece, run.charSpacing, run.wordSpacing, span.fontSize);
      if (operand === null) {
        return {
          ok: false,
          reason: 'the text uses character or word spacing and the stream declares no font size',
        };
      }

      const slot = slots.find((s) => s.spans.includes(span))!;
      const list = patchesByRef.get(slot.ref) ?? [];
      list.push({ start: span.start, end: span.end, replacement: `[${operand}]TJ` });
      patchesByRef.set(slot.ref, list);
      erased++;
    }
  }

  // Apply only after every target resolved, so a failure leaves the document untouched.
  for (const [ref, patches] of patchesByRef) {
    const slot = slots.find((s) => s.ref === ref)!;
    let patched: Uint8Array;
    try {
      patched = splice(slot.bytes, patches);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    doc.context.assign(ref, doc.context.flateStream(patched));
  }

  return { ok: true, patchedStreams: patchesByRef.size, erasedOperators: erased };
}
