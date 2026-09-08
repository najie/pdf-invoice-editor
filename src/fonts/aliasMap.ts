/**
 * Maps a normalised PDF font family (see normalizeName.ts) to a bundled family with the
 * *same advance widths*.
 *
 * Deliberately conservative: only genuine metric clones and exact-family matches live
 * here. Anything else falls through to the measured ranking in score.ts, which is more
 * honest than asserting that, say, Verdana looks like Arial.
 */
export const ALIASES: Record<string, string> = {
  // Arial / Helvetica metric group
  arial: 'arimo',
  helvetica: 'arimo',
  helv: 'arimo',
  arimo: 'arimo',
  liberationsans: 'arimo',
  nimbussans: 'arimo',
  nimbussanl: 'arimo',
  albany: 'arimo',
  sansserif: 'arimo',

  // Times New Roman metric group
  times: 'tinos',
  timesnewroman: 'tinos',
  timesroman: 'tinos',
  tinos: 'tinos',
  liberationserif: 'tinos',
  nimbusroman: 'tinos',
  nimbusromno9l: 'tinos',
  thorndale: 'tinos',
  serif: 'tinos',

  // Calibri metric group
  calibri: 'carlito',
  carlito: 'carlito',

  // Courier New metric group
  courier: 'cousine',
  couriernew: 'cousine',
  cousine: 'cousine',
  liberationmono: 'cousine',
  nimbusmono: 'cousine',
  nimbusmonol: 'cousine',
  cumberland: 'cousine',
  monospace: 'cousine',

  // Cambria metric group
  cambria: 'caladea',
  caladea: 'caladea',

  roboto: 'roboto',
};

import type { StandardFamily } from '../lib/types';

/**
 * The standard-14 families, keyed by normalised family name.
 *
 * A PDF may name any of these without embedding a program; every conforming viewer has
 * them. Drawing replacement text with the same reference adds no bytes and renders exactly
 * as the rest of the document does, which beats embedding any substitute.
 */
export const STANDARD_14: Record<string, StandardFamily> = {
  helvetica: 'Helvetica',
  arial: 'Helvetica',
  times: 'Times',
  timesroman: 'Times',
  timesnewroman: 'Times',
  courier: 'Courier',
  couriernew: 'Courier',
  symbol: 'Symbol',
  zapfdingbats: 'ZapfDingbats',
};
