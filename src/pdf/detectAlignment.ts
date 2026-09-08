import type { Align, TextRun } from '../lib/types';

/** Edges are considered shared when within this many points. */
const EDGE_TOLERANCE = 0.8;
/** Only runs this close vertically, in multiples of the run's size, are neighbours. */
const NEIGHBOUR_ROWS = 5;
/** Neighbours must be within this relative size difference to count. */
const SIZE_RATIO = 0.3;

/**
 * Infers whether a run is left, centre or right aligned by looking at which edge it
 * shares with its vertical neighbours.
 *
 * This matters because replacement text is almost never the same width as the original.
 * Drawing a longer "12 750,00 EUR" from the original left origin pushes it out of its
 * column; pinning the right edge instead keeps the invoice looking right.
 */
export function detectAlignment(run: TextRun, all: TextRun[]): Align {
  const window = NEIGHBOUR_ROWS * run.size;
  const left = run.x;
  const right = run.x + run.width;
  const center = run.x + run.width / 2;

  let leftVotes = 0;
  let rightVotes = 0;
  let centerVotes = 0;

  for (const other of all) {
    if (other === run || other.pageIndex !== run.pageIndex) continue;
    if (Math.abs(other.y - run.y) > window || other.y === run.y) continue;
    if (Math.abs(other.size - run.size) / Math.max(other.size, run.size) > SIZE_RATIO) continue;

    if (Math.abs(other.x - left) <= EDGE_TOLERANCE) leftVotes++;
    if (Math.abs(other.x + other.width - right) <= EDGE_TOLERANCE) rightVotes++;
    if (Math.abs(other.x + other.width / 2 - center) <= EDGE_TOLERANCE) centerVotes++;
  }

  // A run whose left edge lines up with its neighbours is left-aligned even if the right
  // edges happen to agree too (common with equal-length lines), so left wins ties.
  if (leftVotes >= rightVotes && leftVotes >= centerVotes) return 'left';
  if (rightVotes >= centerVotes) return 'right';
  return 'center';
}
