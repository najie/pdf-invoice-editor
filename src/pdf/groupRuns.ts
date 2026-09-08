import type { Block, Fragment, FontInfo, TextRun } from '../lib/types';
import { detectAlignment } from './detectAlignment';

/** Fragments merge into one run when the gap between them is under this share of size. */
const MERGE_GAP = 0.42;
/** A gap this wide (relative to size) means a space was implied rather than encoded. */
const SPACE_GAP = 0.16;
/** Baselines within this many points are the same line. */
const BASELINE_TOLERANCE = 0.6;

/** Signature of a fragment's orientation, so rotated text never merges with upright. */
function orientationKey(f: Fragment): string {
  const [a, b, c, d] = f.transform;
  const s = f.size || 1;
  return [a / s, b / s, c / s, d / s].map((n) => n.toFixed(3)).join(',');
}

/** Unit vector along the text baseline. */
function baselineAxis(f: Fragment): { ux: number; uy: number } {
  const [a, b] = f.transform;
  const len = Math.hypot(a, b) || 1;
  return { ux: a / len, uy: b / len };
}

const colorKey = (f: Fragment) => `${f.color.r.toFixed(3)},${f.color.g.toFixed(3)},${f.color.b.toFixed(3)}`;

/**
 * Merges show-text fragments into visual lines, then chains lines into blocks.
 *
 * pdf.js emits one fragment per show-text operator. Generators split lines freely — a
 * LaTeX invoice can emit a fragment per word or even per kerning pair — so the raw
 * fragments are useless as click targets. A *run* is what a human sees as one line; a
 * *block* is what they see as one paragraph, which is the unit you want when retyping a
 * four-line delivery address.
 */
export function groupRuns(
  fragments: Fragment[],
  fonts: Map<string, FontInfo>,
  pageIndex: number,
): { runs: TextRun[]; blocks: Block[] } {
  // --- bucket fragments into lines -----------------------------------------
  const lines = new Map<string, Fragment[]>();
  for (const f of fragments) {
    if (!f.str.trim()) continue;
    // Render mode 3 and 7 are invisible (OCR layers, and how M5 neutralises old text).
    if (f.renderMode === 3 || f.renderMode === 7) continue;
    const { ux, uy } = baselineAxis(f);
    const [, , , , x, y] = f.transform;
    // Distance from the origin perpendicular to the baseline: constant along one line,
    // and rotation-agnostic.
    const perp = -x * uy + y * ux;
    const key = [
      orientationKey(f),
      f.fontLoadedName,
      f.size.toFixed(2),
      colorKey(f),
      Math.round(perp / BASELINE_TOLERANCE),
    ].join('|');
    const bucket = lines.get(key);
    if (bucket) bucket.push(f);
    else lines.set(key, [f]);
  }

  // --- merge each line's fragments left to right ---------------------------
  const runs: TextRun[] = [];
  for (const bucket of lines.values()) {
    const { ux, uy } = baselineAxis(bucket[0]);
    // Sort by position along the baseline, not by raw x, so rotated text works too.
    const along = (f: Fragment) => f.transform[4] * ux + f.transform[5] * uy;
    bucket.sort((p, q) => along(p) - along(q));

    let group: Fragment[] = [];
    const flush = () => {
      if (group.length) runs.push(makeRun(group, fonts, pageIndex, runs.length));
      group = [];
    };
    for (const f of bucket) {
      if (group.length) {
        const prev = group[group.length - 1];
        const gap = along(f) - (along(prev) + prev.width);
        if (gap > MERGE_GAP * f.size) {
          flush();
        }
      }
      group.push(f);
    }
    flush();
  }

  runs.sort((p, q) => q.y - p.y || p.x - q.x);
  for (const run of runs) run.align = detectAlignment(run, runs);

  return { runs, blocks: buildBlocks(runs, fonts, pageIndex) };
}

function makeRun(
  group: Fragment[],
  fonts: Map<string, FontInfo>,
  pageIndex: number,
  seq: number,
): TextRun {
  const first = group[0];
  const { ux, uy } = baselineAxis(first);
  const along = (f: Fragment) => f.transform[4] * ux + f.transform[5] * uy;

  let str = '';
  for (let i = 0; i < group.length; i++) {
    const f = group[i];
    if (i > 0) {
      const prev = group[i - 1];
      const gap = along(f) - (along(prev) + prev.width);
      // A visible gap that neither side encoded as a space really is a space.
      if (gap > SPACE_GAP * f.size && !/\s$/.test(str) && !/^\s/.test(f.str)) str += ' ';
    }
    str += f.str;
  }

  const last = group[group.length - 1];
  const width = along(last) + last.width - along(first);
  const font = fonts.get(first.fontLoadedName);
  const s = first.size || 1;
  const [a, b, c, d] = first.transform;

  return {
    id: `p${pageIndex}-r${seq}`,
    pageIndex,
    str,
    x: first.transform[4],
    y: first.transform[5],
    width,
    size: first.size,
    fontLoadedName: first.fontLoadedName,
    color: first.color,
    charSpacing: first.charSpacing,
    wordSpacing: first.wordSpacing,
    hScale: first.hScale,
    // The font size is baked into pdf.js's transform; divide it out so the writer can
    // pair this matrix with a plain `Tf <size>` operator.
    matrix: [a / s, b / s, c / s, d / s],
    ascent: font?.ascent ?? 0.75,
    descent: font?.descent ?? -0.25,
    pieces: group.flatMap((f) => f.showOps),
    align: 'left',
  };
}

/** Leading must sit in this multiple-of-size band for two lines to be one paragraph. */
const MIN_LEADING = 0.7;
const MAX_LEADING = 2.4;

/**
 * Style identity for block chaining. Not the pdf.js font id: generators routinely split
 * one typeface into several subset fonts (this project's Chrome fixture uses eight for a
 * single Arial), so consecutive lines of the same address can carry different ids.
 */
function styleKey(run: TextRun, fonts: Map<string, FontInfo>): string {
  const f = fonts.get(run.fontLoadedName);
  return `${f?.family ?? run.fontLoadedName}|${f?.bold ? 'b' : ''}${f?.italic ? 'i' : ''}`;
}

function buildBlocks(runs: TextRun[], fonts: Map<string, FontInfo>, pageIndex: number): Block[] {
  const blocks: Block[] = [];
  const used = new Set<string>();

  const edge = (r: TextRun) =>
    r.align === 'right' ? r.x + r.width : r.align === 'center' ? r.x + r.width / 2 : r.x;

  for (let i = 0; i < runs.length; i++) {
    if (used.has(runs[i].id)) continue;
    const chain = [runs[i]];
    used.add(runs[i].id);

    for (let j = i + 1; j < runs.length; j++) {
      const prev = chain[chain.length - 1];
      const cand = runs[j];
      if (used.has(cand.id)) continue;
      const leading = prev.y - cand.y;
      if (leading <= 0) continue;
      if (leading > MAX_LEADING * Math.max(prev.size, cand.size)) break; // runs are y-sorted
      if (leading < MIN_LEADING * Math.min(prev.size, cand.size)) continue;
      if (cand.align !== prev.align) continue;
      if (Math.abs(cand.size - prev.size) / Math.max(cand.size, prev.size) > 0.25) continue;
      if (Math.abs(edge(cand) - edge(prev)) > 1.2) continue;
      if (cand.matrix.join() !== prev.matrix.join()) continue;
      // A heading in bold above a paragraph is two blocks, not one: keeping a block to a
      // single style means the whole block resolves to one font when it is re-typed.
      if (styleKey(cand, fonts) !== styleKey(prev, fonts)) continue;
      chain.push(cand);
      used.add(cand.id);
    }

    if (chain.length > 1) {
      const leadings = chain.slice(1).map((r, k) => chain[k].y - r.y);
      blocks.push({
        id: `p${pageIndex}-b${blocks.length}`,
        pageIndex,
        runIds: chain.map((r) => r.id),
        align: chain[0].align,
        leading: leadings.reduce((a, b) => a + b, 0) / leadings.length,
      });
    }
  }
  return blocks;
}
