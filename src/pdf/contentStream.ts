/**
 * A minimal content-stream scanner, just enough to locate show-text operators by byte
 * range so they can be spliced out.
 *
 * It deliberately does not interpret the stream. Everything needed to decide *what* to
 * change already came from pdf.js; the only thing missing was *where* in the bytes it
 * lives. Scanning for that is a lexing problem, and the lexer only has to be right about
 * the constructs that can hide an operator-looking byte sequence: literal strings with
 * escapes and nesting, hex strings, comments, and inline images whose binary payload can
 * contain anything at all.
 */

const enum Byte {
  LF = 0x0a,
  CR = 0x0d,
  Space = 0x20,
  Tab = 0x09,
  FormFeed = 0x0c,
  Null = 0x00,
  Percent = 0x25,
  LParen = 0x28,
  RParen = 0x29,
  Backslash = 0x5c,
  Less = 0x3c,
  Greater = 0x3e,
  LBracket = 0x5b,
  RBracket = 0x5d,
  LBrace = 0x7b,
  RBrace = 0x7d,
  Slash = 0x2f,
}

const isWhitespace = (b: number) =>
  b === Byte.Space || b === Byte.LF || b === Byte.CR || b === Byte.Tab ||
  b === Byte.FormFeed || b === Byte.Null;

const isDelimiter = (b: number) =>
  b === Byte.LParen || b === Byte.RParen || b === Byte.Less || b === Byte.Greater ||
  b === Byte.LBracket || b === Byte.RBracket || b === Byte.LBrace || b === Byte.RBrace ||
  b === Byte.Slash || b === Byte.Percent;

/** The four operators that draw text. */
export const SHOW_TEXT_OPERATORS = new Set(['Tj', 'TJ', "'", '"']);

export interface ShowTextSpan {
  /** Ordinal among the stream's show-text operators, counting from 0. */
  index: number;
  /** Byte offset of the first operand. */
  start: number;
  /** Byte offset just past the operator name. */
  end: number;
  operator: string;
  /** How many glyph-bearing string tokens the operator carried. */
  stringCount: number;
  /** Total bytes across those strings — a cheap fingerprint for cross-checking. */
  stringBytes: number;
  /**
   * The size operand of the `Tf` in force, or null if none was seen.
   *
   * Needed because character and word spacing are added in unscaled text space while glyph
   * widths are scaled by this size, so converting a spacing contribution into a `TJ` offset
   * requires knowing the two apart. pdf.js only ever reports their product.
   */
  fontSize: number | null;
}

export class ContentStreamParseError extends Error {}

const ascii = (bytes: Uint8Array, start: number, end: number) => {
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
};

/**
 * Finds every show-text operator in `bytes`, with the byte range covering its operands
 * and the operator itself.
 */
export function findShowTextSpans(bytes: Uint8Array): ShowTextSpan[] {
  const spans: ShowTextSpan[] = [];
  let i = 0;
  // Where the operands for the operator currently being accumulated began.
  let operandStart = -1;
  let stringCount = 0;
  let stringBytes = 0;
  /** Numbers seen in the current operand run, so `Tf`'s size operand can be picked up. */
  let numbers: number[] = [];
  let fontSize: number | null = null;

  const resetOperands = () => {
    operandStart = -1;
    stringCount = 0;
    stringBytes = 0;
    numbers = [];
  };

  while (i < bytes.length) {
    const b = bytes[i];

    if (isWhitespace(b)) {
      i++;
      continue;
    }

    // Comments run to end of line and are not operands.
    if (b === Byte.Percent) {
      while (i < bytes.length && bytes[i] !== Byte.LF && bytes[i] !== Byte.CR) i++;
      continue;
    }

    if (operandStart < 0) operandStart = i;

    // Literal string: parentheses nest, and a backslash escapes the next byte.
    if (b === Byte.LParen) {
      const from = i;
      let depth = 0;
      for (; i < bytes.length; i++) {
        const c = bytes[i];
        if (c === Byte.Backslash) {
          i++;
          continue;
        }
        if (c === Byte.LParen) depth++;
        else if (c === Byte.RParen) {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      if (depth !== 0) throw new ContentStreamParseError('unterminated literal string');
      stringCount++;
      stringBytes += i - from;
      continue;
    }

    // Hex string or dictionary.
    if (b === Byte.Less) {
      if (bytes[i + 1] === Byte.Less) {
        i += 2;
        continue; // dictionaries are just tokens to us; their contents are scanned too
      }
      const from = i;
      i++;
      while (i < bytes.length && bytes[i] !== Byte.Greater) i++;
      if (i >= bytes.length) throw new ContentStreamParseError('unterminated hex string');
      i++;
      stringCount++;
      stringBytes += i - from;
      continue;
    }

    if (b === Byte.Greater && bytes[i + 1] === Byte.Greater) {
      i += 2;
      continue;
    }

    if (isDelimiter(b)) {
      // Names, arrays and braces: single-byte tokens for our purposes. Array brackets in
      // particular must not end the operand run, since `[...] TJ` is one operator.
      if (b === Byte.Slash) {
        i++;
        while (i < bytes.length && !isWhitespace(bytes[i]) && !isDelimiter(bytes[i])) i++;
      } else {
        i++;
      }
      continue;
    }

    // A bare token: either a number or an operator keyword.
    const from = i;
    while (i < bytes.length && !isWhitespace(bytes[i]) && !isDelimiter(bytes[i])) i++;
    const token = ascii(bytes, from, i);

    if (/^[+-.\d]/.test(token)) {
      const value = Number(token);
      if (Number.isFinite(value)) numbers.push(value);
      continue; // number operand
    }

    // An operator ends the operand run.
    if (token === 'BI') {
      // Inline image. Everything between ID and EI is opaque binary that may contain
      // parentheses, backslashes, or the letters of any operator, so it must be skipped
      // wholesale rather than tokenised.
      i = skipInlineImage(bytes, i);
      resetOperands();
      continue;
    }

    if (token === 'Tf' && numbers.length) {
      fontSize = numbers[numbers.length - 1];
    }

    if (SHOW_TEXT_OPERATORS.has(token)) {
      spans.push({
        index: spans.length,
        start: operandStart,
        end: i,
        operator: token,
        stringCount,
        stringBytes,
        fontSize,
      });
    }
    resetOperands();
  }

  return spans;
}

/** Returns the offset just past the inline image's `EI`. `i` points just past `BI`. */
function skipInlineImage(bytes: Uint8Array, i: number): number {
  // Find the ID that opens the binary payload.
  while (i < bytes.length - 1) {
    if (bytes[i] === 0x49 /* I */ && bytes[i + 1] === 0x44 /* D */) {
      const before = i === 0 ? Byte.Space : bytes[i - 1];
      const after = bytes[i + 2];
      if ((isWhitespace(before) || isDelimiter(before)) && (isWhitespace(after) || isDelimiter(after))) {
        i += 3; // past "ID" and the single whitespace byte that follows it
        break;
      }
    }
    i++;
  }
  // Then scan for a whitespace-delimited EI.
  while (i < bytes.length - 1) {
    if (
      bytes[i] === 0x45 /* E */ &&
      bytes[i + 1] === 0x49 /* I */ &&
      isWhitespace(bytes[i - 1]) &&
      (i + 2 >= bytes.length || isWhitespace(bytes[i + 2]) || isDelimiter(bytes[i + 2]))
    ) {
      return i + 2;
    }
    i++;
  }
  throw new ContentStreamParseError('unterminated inline image');
}

/**
 * Replaces byte ranges in `bytes`. Patches must not overlap; they are applied back to
 * front so earlier offsets stay valid.
 */
export function splice(
  bytes: Uint8Array,
  patches: Array<{ start: number; end: number; replacement: string }>,
): Uint8Array {
  const ordered = [...patches].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start < ordered[i - 1].end) {
      throw new ContentStreamParseError('overlapping patches');
    }
  }

  const encoder = new TextEncoder();
  const pieces: Uint8Array[] = [];
  let cursor = 0;
  for (const patch of ordered) {
    pieces.push(bytes.subarray(cursor, patch.start));
    pieces.push(encoder.encode(patch.replacement));
    cursor = patch.end;
  }
  pieces.push(bytes.subarray(cursor));

  const total = pieces.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}
