import { create } from 'zustand';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { loadDocument, type PdfDoc } from '../pdf/loadDocument';
import { buildTextIndex } from '../pdf/buildTextIndex';
import { groupRuns } from '../pdf/groupRuns';
import { regenerate, type EditReport, type EraseMode, type RunEdit } from '../pdf/regenerate';
import { createTextBox, nearestRun, type TextBox } from '../pdf/textBox';
import type { Align, Block, FontInfo, PageInfo, TextRun } from '../lib/types';

/**
 * Pages are rasterised once at this scale. The same bitmap serves the on-screen view (CSS
 * scales it, so zooming never re-renders) and the background sampling the eraser needs,
 * which is why it is captured up front rather than on demand.
 */
export const RASTER_SCALE = 2;

export interface PageData {
  info: PageInfo;
  page: PDFPageProxy;
  runs: Map<string, TextRun>;
  runList: TextRun[];
  blocks: Block[];
  blockOfRun: Map<string, string>;
  fonts: Map<string, FontInfo>;
  /** Show-text operator count, which the surgical erase checks the raw stream against. */
  showTextOps: number;
  canvas: HTMLCanvasElement;
  pixels: Uint8ClampedArray;
  viewport: PageViewport;
  alignment: { total: number; aligned: number; resynced: number };
}

export type Selection =
  | { kind: 'run'; id: string }
  | { kind: 'block'; id: string }
  | { kind: 'box'; id: string }
  | null;

/**
 * `addText` arms a single click on a page to place a new text box; it disarms itself once a
 * box is placed. A persistently armed tool on a page that also deselects on click is a
 * foot-gun — every miss would drop another empty box.
 */
export type Tool = 'select' | 'addText';

export interface DiffResult {
  changedInside: number;
  changedOutside: number;
  /**
   * One PNG data URL per page, highlighting every pixel that moved: green inside the
   * edited lines, red outside. Rendered over the page itself rather than in the sidebar,
   * because a page-sized image is unreadable at sidebar width.
   */
  overlays: string[];
}

interface State {
  fileName: string | null;
  bytes: Uint8Array | null;
  doc: PdfDoc | null;
  pages: PageData[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  zoom: number;
  selection: Selection;
  tool: Tool;
  /**
   * Text the user added, keyed by box id.
   *
   * Held beside `pages` rather than inside it: a `PageData` is what the document actually
   * contains, and `runs` / `runList` / `blocks` / `showTextOps` are all read by code that
   * must never see a synthetic run — the surgical erase counts operators against it, and the
   * block grouper would try to chain an added line into a paragraph.
   */
  boxes: Record<string, TextBox>;
  /**
   * Monotonic, never `Object.keys(boxes).length`: reusing a number after a delete would let
   * a new box inherit the deleted one's leftover `edits` entry.
   */
  nextBoxSeq: number;
  /** Keyed by run id, box ids included. An entry-less run or box is untouched. */
  edits: Record<string, RunEdit>;
  exporting: boolean;
  eraseMode: EraseMode;
  lastReports: EditReport[] | null;
  /** Pages where the surgical erase declined, with the reason. */
  lastFallbacks: Array<{ pageIndex: number; reason: string }>;
  /** True when the last export decrypted an encrypted input, so the export is plaintext. */
  lastWasEncrypted: boolean;
  diff: DiffResult | null;

  open(file: File): Promise<void>;
  reset(): void;
  setZoom(zoom: number): void;
  select(selection: Selection): void;
  setTool(tool: Tool): void;
  addBox(pageIndex: number, x: number, y: number): void;
  removeBox(id: string): void;
  setBoxWidth(id: string, width: number): void;
  setEraseMode(mode: EraseMode): void;
  editRun(runId: string, patch: Partial<RunEdit>): void;
  clearEdit(runId: string): void;
  clearAllEdits(): void;
  exportPdf(): Promise<{ bytes: Uint8Array; reports: EditReport[] } | null>;
  setDiff(diff: DiffResult | null): void;
}

/** The untouched starting point for an edit of `run`. */
export function baseEdit(run: TextRun): RunEdit {
  return {
    runId: run.id,
    text: run.str,
    align: run.align,
    shrinkToFit: false,
    sizeScale: 1,
    tracking: 0,
    dx: 0,
    dy: 0,
  };
}

export const isDirty = (run: TextRun, edit: RunEdit | undefined): boolean =>
  !!edit &&
  (edit.text !== run.str ||
    edit.align !== run.align ||
    edit.sizeScale !== 1 ||
    edit.tracking !== 0 ||
    edit.dx !== 0 ||
    edit.dy !== 0 ||
    edit.shrinkToFit);

/** A run by id, whether it came out of the document or was added as a text box. */
export function findRun(
  pages: PageData[],
  boxes: Record<string, TextBox>,
  id: string,
): TextRun | null {
  for (const page of pages) {
    const run = page.runs.get(id);
    if (run) return run;
  }
  return boxes[id]?.run ?? null;
}

/**
 * Every edit the export will actually act on.
 *
 * The two kinds answer "is this a change?" differently. A run is dirty when it differs from
 * what the document already says. A box has no such baseline: it is a change once it has
 * text to draw, and *only* then — a box that was placed and dragged but never typed into
 * draws nothing, so letting it enable Export would offer a download that changes nothing.
 */
export function pendingEdits(
  pages: PageData[],
  boxes: Record<string, TextBox>,
  edits: Record<string, RunEdit>,
): RunEdit[] {
  return Object.values(edits).filter((edit) => {
    const box = boxes[edit.runId];
    if (box) return edit.text.trim() !== '';
    const run = findRun(pages, boxes, edit.runId);
    return !!run && isDirty(run, edit);
  });
}

export const useStore = create<State>((set, get) => ({
  fileName: null,
  bytes: null,
  doc: null,
  pages: [],
  status: 'idle',
  error: null,
  zoom: 1,
  selection: null,
  tool: 'select',
  boxes: {},
  nextBoxSeq: 0,
  edits: {},
  exporting: false,
  eraseMode: 'surgical',
  lastReports: null,
  lastFallbacks: [],
  lastWasEncrypted: false,
  diff: null,

  async open(file) {
    set({
      status: 'loading', error: null, edits: {}, selection: null,
      boxes: {}, nextBoxSeq: 0, tool: 'select',
      diff: null, lastReports: null, lastFallbacks: [], lastWasEncrypted: false,
    });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc = await loadDocument(bytes);
      const pages: PageData[] = [];

      for (let i = 0; i < doc.numPages; i++) {
        const page = await doc.getPage(i + 1);
        const index = await buildTextIndex(page, i);
        const { runs, blocks } = groupRuns(index.fragments, index.fonts, i);

        const viewport = page.getViewport({ scale: RASTER_SCALE });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;

        const blockOfRun = new Map<string, string>();
        for (const block of blocks) for (const id of block.runIds) blockOfRun.set(id, block.id);

        pages.push({
          info: index.page,
          page,
          runs: new Map(runs.map((r) => [r.id, r])),
          runList: runs,
          blocks,
          blockOfRun,
          fonts: index.fonts,
          showTextOps: index.showTextOps,
          canvas,
          pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
          viewport,
          alignment: index.alignment,
        });
      }

      set({ fileName: file.name, bytes, doc, pages, status: 'ready' });
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  reset() {
    set({
      fileName: null, bytes: null, doc: null, pages: [], status: 'idle',
      error: null, selection: null, edits: {}, diff: null,
      boxes: {}, nextBoxSeq: 0, tool: 'select',
      lastReports: null, lastFallbacks: [], lastWasEncrypted: false, zoom: 1,
    });
  },

  setZoom: (zoom) => set({ zoom }),
  setEraseMode: (eraseMode) => set({ eraseMode, diff: null }),
  select: (selection) => set({ selection }),
  setTool: (tool) => set({ tool }),

  addBox(pageIndex, x, y) {
    const { pages, boxes, nextBoxSeq } = get();
    const page = pages[pageIndex];
    if (!page) return;
    const id = `p${pageIndex}-box${nextBoxSeq}`;
    // The nearest line is the template: text added under an address should come out in the
    // address's font at its size, which is also what makes rotated pages work for free.
    const box = createTextBox({ id, pageIndex, x, y, template: nearestRun(page.runList, x, y) });
    set({
      boxes: { ...boxes, [id]: box },
      nextBoxSeq: nextBoxSeq + 1,
      selection: { kind: 'box', id },
      // Disarm: one click, one box.
      tool: 'select',
      diff: null,
    });
    // No `edits` entry is seeded, so "no entry means untouched" stays true and the panel's
    // `edits[id] ?? baseEdit(run)` keeps working unchanged.
  },

  removeBox(id) {
    const { boxes, edits, selection } = get();
    if (!boxes[id]) return;
    const nextBoxes = { ...boxes };
    delete nextBoxes[id];
    const nextEdits = { ...edits };
    delete nextEdits[id];
    set({
      boxes: nextBoxes,
      edits: nextEdits,
      selection: selection?.kind === 'box' && selection.id === id ? null : selection,
      diff: null,
    });
  },

  setBoxWidth(id, width) {
    const { boxes } = get();
    const box = boxes[id];
    // Called from a render effect on every resolve, so it must be idempotent — and it must
    // keep `box.run`'s identity, because `useFontChoices` keys its debounced resolve on it
    // and a fresh object would re-resolve, re-measure and loop forever.
    if (!box || Math.abs(box.measuredWidth - width) < 0.05) return;
    set({ boxes: { ...boxes, [id]: { ...box, measuredWidth: width } } });
  },

  editRun(runId, patch) {
    const { pages, boxes, edits } = get();
    const run = findRun(pages, boxes, runId);
    if (!run) return;
    set({ edits: { ...edits, [runId]: { ...(edits[runId] ?? baseEdit(run)), ...patch } }, diff: null });
  },

  clearEdit(runId) {
    const edits = { ...get().edits };
    delete edits[runId];
    set({ edits, diff: null });
  },

  // Boxes go too: an added box whose text was reverted is an invisible leftover, and
  // "Revert all" has to mean the page is back to what the file says.
  clearAllEdits: () =>
    set({ edits: {}, boxes: {}, diff: null, lastReports: null, lastFallbacks: [], selection: null }),

  async exportPdf() {
    const { bytes, pages, boxes, edits, eraseMode } = get();
    if (!bytes) return null;
    set({ exporting: true });
    try {
      const active = pendingEdits(pages, boxes, edits);
      const boxList = Object.values(boxes);
      const result = await regenerate({
        originalBytes: bytes,
        pages: pages.map((p) => ({
          pageIndex: p.info.index,
          runs: p.runs,
          fonts: p.fonts,
          raster: { pixels: p.pixels, width: p.canvas.width, height: p.canvas.height, viewport: p.viewport },
          showTextOps: p.showTextOps,
          boxes: new Map(
            boxList.filter((b) => b.run.pageIndex === p.info.index).map((b) => [b.run.id, b.run]),
          ),
        })),
        edits: active,
        eraseMode,
      });
      set({
        lastReports: result.reports,
        lastFallbacks: result.surgicalFallbacks,
        lastWasEncrypted: result.wasEncrypted,
      });
      return result;
    } finally {
      set({ exporting: false });
    }
  },

  setDiff: (diff) => set({ diff }),
}));

/** All alignment options, for the segmented control. */
export const ALIGNMENTS: Align[] = ['left', 'center', 'right'];
