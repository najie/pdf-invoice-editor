import type { FontChoice } from './resolveFont';

/** Stable identity for a resolved font, used for selection and for embed caching. */
export function choiceKey(choice: FontChoice): string {
  const s = choice.source;
  if (s.kind === 'reuse') return `reuse:${s.font.loadedName}`;
  if (s.kind === 'standard') return `standard:${s.family}:${s.style}`;
  return `catalog:${s.familyId}:${s.style}`;
}

export function tierName(tier: FontChoice['tier']): string {
  switch (tier) {
    case 0:
      return 'A standard PDF font — the one this file names';
    case 1:
      return "The document's own embedded font";
    case 2:
      return 'Metric-compatible substitute';
    default:
      return 'Closest available substitute';
  }
}
