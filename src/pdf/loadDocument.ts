import * as pdfjs from 'pdfjs-dist';

/**
 * `fontExtraProperties` is the load-bearing option here: without it pdf.js strips
 * `data` / `toUnicode` / `toFontChar` / `widths` from the font objects it hands back, and
 * the font engine degrades from "reuse the invoice's own font" to "guess a lookalike".
 * `disableNormalization` (passed at getTextContent time) keeps the extracted strings
 * aligned with the glyphs in the operator list, which is what lets buildTextIndex pair
 * the two together.
 */
export const PDFJS_PARAMS = {
  fontExtraProperties: true,
  isEvalSupported: false,
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
} as const;

export type PdfDoc = pdfjs.PDFDocumentProxy;

export class PasswordProtectedError extends Error {
  constructor() {
    super('This PDF is password-protected. Remove the password before editing it.');
    this.name = 'PasswordProtectedError';
  }
}

/**
 * Loads a document from a *copy* of `bytes`. pdf.js takes ownership of the buffer it is
 * given (it transfers it to the worker), and the writer needs the pristine original
 * later, so never hand it the caller's array.
 */
export async function loadDocument(
  bytes: Uint8Array,
  params: Record<string, unknown> = {},
): Promise<PdfDoc> {
  try {
    return await pdfjs.getDocument({ data: bytes.slice(), ...PDFJS_PARAMS, ...params }).promise;
  } catch (err) {
    if (err instanceof Error && /password/i.test(err.name + err.message)) {
      throw new PasswordProtectedError();
    }
    throw err;
  }
}

export { pdfjs };
