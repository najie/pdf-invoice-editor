import { EncryptedPDFError, PDFDocument, type PDFFont, type PDFName, type PDFPage } from '@cantoo/pdf-lib';
import { fontkit } from '../fonts/fontkit';
import type { PageViewport } from 'pdfjs-dist';
import type { Align, FontInfo, RGB, TextRun } from '../lib/types';
import { alignedOrigin, baselineUnit, inkQuadBounds, rectToDevice, runInkBox, type Rect } from '../lib/geometry';
import { advanceWidth, coverOperators, textOperators, type Content } from './emitText';
import { sampleBackground } from './sampleBackground';
import { resolveFont, type FontChoice } from '../fonts/resolveFont';
import { standardFontName } from '../fonts/provider';
import { choiceKey } from '../fonts/choiceKey';
import { eraseSurgically } from './surgicalErase';

/** One line the user retyped. */
export interface RunEdit {
  runId: string;
  text: string;
  align: Align;
  shrinkToFit: boolean;
  /** Multiplies the original size. 1 keeps it. */
  sizeScale: number;
  /** Extra character spacing, in points. */
  tracking: number;
  /** Move offset in user-space points, from dragging the run. */
  dx: number;
  dy: number;
  /** `catalog:<id>`, `standard:<family>` or `reuse` — omit to let the resolver decide. */
  fontOverride?: string;
}

export interface PageSource {
  pageIndex: number;
  runs: Map<string, TextRun>;
  fonts: Map<string, FontInfo>;
  /** A render of the untouched page, used to read the paper colour behind the text. */
  raster?: { pixels: Uint8ClampedArray; width: number; height: number; viewport: PageViewport };
  /** Show-text operator count from the text index; the surgical erase needs it to agree. */
  showTextOps?: number;
  /**
   * Text boxes the user added on this page, keyed by id, as synthetic runs.
   *
   * Kept apart from `runs` so the page's real text index stays pristine — the surgical
   * erase, the block grouping and the pixel diff all read `runs` — and so the writer can
   * tell an addition from a replacement without inspecting the id.
   */
  boxes?: Map<string, TextRun>;
}

/**
 * `cover` paints a background-coloured rectangle over the old text. It never fails and
 * never touches an existing object, but it can seam over patterned artwork and it leaves
 * the original string extractable.
 *
 * `surgical` removes the show-text operators from the content stream instead, then falls
 * back to covering for any page it cannot patch safely.
 */
export type EraseMode = 'cover' | 'surgical';

export interface EditReport {
  runId: string;
  pageIndex: number;
  /** `run` replaced existing text; `box` added text where there was none. */
  kind: 'run' | 'box';
  text: string;
  tier: FontChoice['tier'];
  label: string;
  /** Final size after any shrink-to-fit. */
  size: number;
  /** Drawn width over the width the original occupied. */
  widthRatio: number;
  /** Points by which the new text exceeds the original's box. 0 when it fits. */
  overflow: number;
  /** Uniformity of the area painted over; low values mean a visible seam. */
  backgroundUniformity: number;
  missing: string[];
  /** How the original ink was removed. `none` for an addition: there was nothing to remove. */
  erasedBy: EraseMode | 'none';
  /**
   * Bounds of the text actually drawn, user space. This is the writer's own account of where
   * it put ink, which is what the pixel diff needs for added text: a box erases nothing, so
   * its glyph bounds are a genuinely tight region for "what this change was allowed to
   * touch", rather than the wide band a replacement needs.
   */
  drawnBox?: Rect;
  /**
   * True when part of the drawn text falls outside the page's visible area. Easy to do with
   * an added box near a margin — click too close to the edge and the text simply runs off,
   * with the file otherwise perfectly valid and nothing to see on the page.
   */
  offPage: boolean;
}

export interface RegenerateResult {
  bytes: Uint8Array;
  reports: EditReport[];
  /** Per page index, why the surgical erase declined. Empty when it was not requested. */
  surgicalFallbacks: Array<{ pageIndex: number; reason: string }>;
  /**
   * True when the input carried encryption that was decrypted to edit it. The export is
   * plaintext, which is a change in the file's security properties worth telling the user
   * about rather than performing silently.
   */
  wasEncrypted: boolean;
}

const WHITE: RGB = { r: 1, g: 1, b: 1 };
/** Grows the erase box slightly so antialiased edges of the old glyphs are covered. */
const ERASE_PAD = 0.35;
/**
 * Grows the reported drawn box so a pixel diff is not tripped by the antialiased fringe of
 * the new glyphs. Small on purpose: for added text this box is the whole allowed region, so
 * generosity here would weaken the check rather than merely widen a highlight.
 */
const DRAWN_PAD = 1.5;

/**
 * Produces the edited PDF.
 *
 * In `cover` mode the original bytes are reloaded and only *appended* to: no existing
 * object, content stream or resource is rewritten. That is what keeps logos, vector rules,
 * images and every untouched line of text bit-identical — the edited regions are the only
 * thing that differs, because they are literally the only thing added.
 *
 * `surgical` mode additionally rewrites the content stream of pages it can patch, removing
 * the replaced strings outright. Everything else in those streams is passed through byte
 * for byte, and any page it cannot patch keeps the append-only path.
 */
export async function regenerate(opts: {
  originalBytes: Uint8Array;
  pages: PageSource[];
  edits: RunEdit[];
  /** Defaults to `cover`, the mode that cannot fail. */
  eraseMode?: EraseMode;
}): Promise<RegenerateResult> {
  const { doc: out, wasEncrypted } = await load(opts.originalBytes);
  out.registerFontkit(fontkit);

  /** Fonts embedded so far, keyed by source identity, plus their per-page resource keys. */
  const embedded = new Map<string, PDFFont>();
  const fontKeys = new Map<string, PDFName>();

  const reports: EditReport[] = [];
  const surgicalFallbacks: Array<{ pageIndex: number; reason: string }> = [];
  const wantSurgical = opts.eraseMode === 'surgical';

  for (const page of opts.pages) {
    const runEdits = opts.edits.filter((edit) => page.runs.has(edit.runId));
    // A box with nothing typed into it is one the user has not filled in yet: there is
    // nothing to draw, and no report, so it cannot raise a warning about text that does not
    // exist. An empty *run* edit means something else entirely — erase that line — which is
    // why the two cannot share the empty-text path below.
    const boxEdits = opts.edits.filter(
      (edit) => page.boxes?.has(edit.runId) && edit.text.trim() !== '',
    );
    if (!runEdits.length && !boxEdits.length) continue;
    const target = out.getPage(page.pageIndex);

    // Attempted once per page, before anything is drawn: if the operators can be removed
    // there is no rectangle to paint, and if they cannot the page keeps the cover path.
    // Skipped when the page only gained boxes — nothing is being replaced there, so a patch
    // that declined would report a failure to remove text nobody asked to remove.
    let erasedBy: EraseMode = 'cover';
    if (wantSurgical && runEdits.length) {
      const outcome = eraseSurgically({
        doc: out,
        page: target,
        runs: runEdits.map((edit) => page.runs.get(edit.runId)!),
        expectedShowOps: page.showTextOps ?? -1,
      });
      if (outcome.ok) erasedBy = 'surgical';
      else surgicalFallbacks.push({ pageIndex: page.pageIndex, reason: outcome.reason });
    }

    // Replacements first, additions second. Each replacement paints its cover rectangle as
    // it goes, so a box drawn earlier that happened to overlap one would be painted straight
    // back out again.
    for (const edit of runEdits) {
      const run = page.runs.get(edit.runId)!;
      reports.push(
        await applyEdit({ out, target, page, run, edit, embedded, fontKeys, erasedBy, kind: 'run' }),
      );
    }
    for (const edit of boxEdits) {
      const run = page.boxes!.get(edit.runId)!;
      reports.push(
        await applyEdit({ out, target, page, run, edit, embedded, fontKeys, erasedBy, kind: 'box' }),
      );
    }
  }

  return {
    bytes: await out.save({ useObjectStreams: false }),
    reports,
    surgicalFallbacks,
    wasEncrypted,
  };
}

export class PasswordRequiredError extends Error {
  constructor() {
    super('This PDF needs a password to open. Remove the password and try again.');
    this.name = 'PasswordRequiredError';
  }
}

/**
 * Opens the original for writing.
 *
 * Encryption is decrypted rather than ignored. Owner-password-only encryption — very
 * common on invoices from banks and utilities, where anyone can open the file but
 * permissions are restricted — decrypts with an empty user password and edits normally.
 * Passing `ignoreEncryption` instead would leave every stream encrypted and produce a file
 * that looks saved and is unreadable, which is the worst possible outcome.
 */
async function load(bytes: Uint8Array): Promise<{ doc: PDFDocument; wasEncrypted: boolean }> {
  try {
    const doc = await PDFDocument.load(bytes, { password: '' });
    // A successful decrypt clears `isEncrypted`, so it cannot answer whether the *input*
    // was encrypted; the context's own flag is what records that.
    return { doc, wasEncrypted: !!doc.context.isDecrypted };
  } catch (err) {
    // The parser signals a genuine user password with a bare `Error('NEEDS PASSWORD')`
    // rather than the typed error, so both spellings have to be recognised.
    const message = err instanceof Error ? `${err.name} ${err.message}` : '';
    if (err instanceof EncryptedPDFError || /needs password|password/i.test(message)) {
      throw new PasswordRequiredError();
    }
    throw err;
  }
}

async function applyEdit(ctx: {
  out: PDFDocument;
  target: PDFPage;
  page: PageSource;
  run: TextRun;
  edit: RunEdit;
  embedded: Map<string, PDFFont>;
  fontKeys: Map<string, PDFName>;
  erasedBy: EraseMode;
  /** `box` skips the erase entirely: added text covers no original ink. */
  kind: 'run' | 'box';
}): Promise<EditReport> {
  const { out, target, page, run, edit, embedded, fontKeys, erasedBy, kind } = ctx;
  const isBox = kind === 'box';

  // --- erase ---------------------------------------------------------------
  // A box adds ink to paper nobody has touched, so there is nothing to hide and no
  // background to sample. Everything the erase produces — the rectangle, the sampled colour,
  // the uniformity warning — is meaningless for an addition and is skipped, not defaulted.
  let uniformity = 1;
  if (!isBox) {
    const inkBox = runInkBox(run, ERASE_PAD);
    let background = WHITE;
    if (page.raster) {
      const device = rectToDevice(inkBox, page.raster.viewport);
      const sample = sampleBackground(page.raster.pixels, page.raster.width, page.raster.height, device);
      background = sample.color;
      uniformity = sample.uniformity;
    }
    // Surgical mode already removed the operators, so there is nothing to hide.
    if (erasedBy === 'cover') target.pushOperators(...coverOperators(inkBox, background));
  }

  if (!edit.text) {
    return {
      runId: run.id, pageIndex: page.pageIndex, kind, text: '', tier: 1, label: 'Removed',
      size: run.size, widthRatio: 0, overflow: 0, backgroundUniformity: uniformity,
      missing: [], erasedBy, offPage: false,
    };
  }

  // --- font ----------------------------------------------------------------
  const runFont = page.fonts.get(run.fontLoadedName);
  const { best, alternatives } = await resolveFont({
    runFont,
    documentFonts: page.fonts.values(),
    newText: edit.text,
    originalText: run.str,
    size: run.size * edit.sizeScale,
    originalWidth: run.width,
  });
  const choice = pickOverride(edit.fontOverride, best, alternatives);

  const { hScale } = baselineUnit(run);
  const spaceCount = [...edit.text].filter((ch) => ch === ' ').length;
  const charSpacing = run.charSpacing + edit.tracking;

  const widthAt = (size: number): number => {
    const base = scaleWidth(choice, size);
    return advanceWidth({
      baseWidth: base,
      charCount: [...edit.text].length,
      spaceCount,
      charSpacing,
      wordSpacing: run.wordSpacing,
      hScale,
    });
  };

  // --- fit -----------------------------------------------------------------
  let size = run.size * edit.sizeScale;
  let width = widthAt(size);
  if (edit.shrinkToFit && width > run.width && run.width > 0) {
    // Advance is linear in size apart from the spacing terms, so two passes converge.
    for (let i = 0; i < 2 && width > run.width; i++) {
      size *= run.width / width;
      width = widthAt(size);
    }
  }

  // --- draw ----------------------------------------------------------------
  const font = await embedChoice(out, choice, embedded);
  const cacheKey = choiceKey(choice);
  let fontKey = fontKeys.get(`${page.pageIndex}:${cacheKey}`);
  if (!fontKey) {
    fontKey = target.node.newFontDictionary(font.name, font.ref);
    fontKeys.set(`${page.pageIndex}:${cacheKey}`, fontKey);
  }

  const origin = alignedOrigin(run, width, edit.align);
  const content: Content =
    choice.source.kind === 'reuse'
      ? { kind: 'plan', plan: choice.source.plan }
      : { kind: 'text', text: edit.text };

  target.pushOperators(
    ...textOperators({
      x: origin.x + edit.dx,
      y: origin.y + edit.dy,
      matrix: run.matrix,
      size,
      color: run.color,
      charSpacing,
      wordSpacing: run.wordSpacing,
      fontKey,
      font,
      content,
    }),
  );

  const placed = { ...run, x: origin.x + edit.dx, y: origin.y + edit.dy };
  const drawnBox = inkQuadBounds(placed, width, DRAWN_PAD);

  return {
    runId: run.id,
    pageIndex: page.pageIndex,
    kind,
    text: edit.text,
    tier: choice.tier,
    label: choice.label,
    size,
    // A box has no original width, so every fit signal is nonsense for it rather than
    // merely uninteresting: `run.width` is 0, and left alone `overflow` would report the
    // full width of the new text as an overrun of a box that never existed.
    widthRatio: isBox ? 1 : run.width > 0 ? width / run.width : 1,
    overflow: isBox ? 0 : Math.max(0, width - run.width),
    backgroundUniformity: isBox ? 1 : uniformity,
    missing: choice.missing,
    erasedBy: isBox ? 'none' : erasedBy,
    drawnBox,
    // Measured on the unpadded glyph box: `drawnBox` carries an antialiasing pad, and testing
    // that instead would warn about text a third of a millimetre from the margin.
    offPage: escapesPage(target, inkQuadBounds(placed, width, 0)),
  };
}

/**
 * Whether drawn text spills out of the page's visible area.
 *
 * Measured against the CropBox rather than the MediaBox, because that is what a viewer shows
 * and a printer prints. A point of slack keeps a glyph that merely touches the margin from
 * being reported; beyond that, ink really is being lost.
 */
function escapesPage(target: PDFPage, drawn: Rect): boolean {
  const crop = target.getCropBox();
  const slack = 1;
  return (
    drawn.x < crop.x - slack ||
    drawn.y < crop.y - slack ||
    drawn.x + drawn.width > crop.x + crop.width + slack ||
    drawn.y + drawn.height > crop.y + crop.height + slack
  );
}

/** Width of the edit's text in a choice's font at `size`, in text-space points. */
function scaleWidth(choice: FontChoice, size: number): number {
  // `choice.width` was measured at the size passed to resolveFont; advance is linear in
  // size, so rescaling avoids re-measuring on every shrink iteration.
  if (choice.width === 0 || !choice.measuredAtSize) return 0;
  return (choice.width / choice.measuredAtSize) * size;
}

function pickOverride(override: string | undefined, best: FontChoice, alternatives: FontChoice[]): FontChoice {
  if (!override) return best;
  const all = [best, ...alternatives];
  return all.find((c) => choiceKey(c).startsWith(override)) ?? best;
}

async function embedChoice(
  out: PDFDocument,
  choice: FontChoice,
  cache: Map<string, PDFFont>,
): Promise<PDFFont> {
  const key = choiceKey(choice);
  const source = choice.source;

  let font = cache.get(key);
  if (!font) {
    if (source.kind === 'standard') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      font = out.embedStandardFont(standardFontName(source.family, source.style) as any);
    } else if (source.kind === 'catalog') {
      font = await out.embedFont(source.loaded.bytes, { subset: true });
    } else {
      // pdf.js's rebuilt programs are already tiny subsets; re-subsetting them buys
      // nothing and risks disturbing a font that has already been through one rewrite.
      font = await out.embedFont(source.font.data!, { subset: false, customName: `Reused${cache.size}` });
    }
    cache.set(key, font);
  }

  if (source.kind === 'reuse') repairToUnicode(font, source.plan.puaToUnicode);
  return font;
}

/**
 * Points the embedded font's glyphs back at the characters they really represent.
 *
 * pdf.js maps a rebuilt font's glyphs into the Unicode private-use area, and pdf-lib
 * derives /ToUnicode from exactly those code points. Left alone, the edited text renders
 * perfectly but copy-pastes as U+E0xx gibberish — so an invoice would look right and be
 * unusable to anything reading it as text.
 */
function repairToUnicode(font: PDFFont, pairs: Array<[number, number]>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fk = (font as any).embedder?.font;
  if (!fk?.glyphForCodePoint) return;
  for (const [pua, unicode] of pairs) {
    const glyph = fk.glyphForCodePoint(pua);
    if (glyph) glyph.codePoints = [unicode];
  }
}
