import { byId } from '../fonts/catalog';
import type { FontChoice } from '../fonts/resolveFont';
import { choiceKey, tierName } from '../fonts/choiceKey';

interface Props {
  best: FontChoice | null;
  alternatives: FontChoice[];
  override: string | undefined;
  onPick(key: string | undefined): void;
  /** Blocks have no single width to compare, so the fit column is suppressed. */
  showFit: boolean;
  /**
   * False for added text, which replaces nothing. The percentages are a measurement against
   * the width the original occupied; with no original there is nothing to measure, and
   * printing a number anyway would be the one thing this panel must never do.
   */
  showMetric: boolean;
  loading: boolean;
  /**
   * Set for a block, naming how many lines the measurement covers. Choosing one font for
   * several lines is a different question from choosing one for a single line, and the
   * label should not pretend otherwise.
   */
  scope: string | null;
}

const TIER_STYLE: Record<number, string> = {
  0: 'bg-emerald-100 text-emerald-800',
  1: 'bg-emerald-100 text-emerald-800',
  2: 'bg-sky-100 text-sky-800',
  3: 'bg-amber-100 text-amber-800',
};

export function FontPicker({ best, alternatives, override, onPick, showFit, showMetric, loading, scope }: Props) {
  if (!best) {
    return (
      <div>
        <span className="mb-1.5 block text-xs font-medium text-neutral-600">Font</span>
        <div className="h-[76px] animate-pulse rounded-md bg-neutral-100" />
        {loading && <p className="mt-1 text-[10px] text-neutral-400">Measuring candidates…</p>}
      </div>
    );
  }
  const all = [best, ...alternatives];
  const active = override ? all.find((c) => choiceKey(c) === override) ?? best : best;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-600">
          Font{scope && <span className="font-normal text-neutral-400"> · one for {scope}</span>}
        </span>
        {override && (
          <button type="button" className="text-[11px] text-blue-600 hover:underline" onClick={() => onPick(undefined)}>
            use best match
          </button>
        )}
      </div>

      <div className={`mb-2 rounded-md px-2.5 py-2 text-[11px] ${TIER_STYLE[active.tier]}`}>
        <div className="font-medium">{active.label}</div>
        <div className="mt-0.5 opacity-80">
          {tierName(active.tier)}
          {showMetric && active.metricRatio !== undefined &&
            ` · reproduces the original width at ${(active.metricRatio * 100).toFixed(1)}%`}
        </div>
        {active.missing.length > 0 && (
          <div className="mt-1 font-medium">
            Cannot draw: {active.missing.join(' ')} — pick another font.
          </div>
        )}
      </div>

      <div className="max-h-56 overflow-y-auto rounded-md border border-edge divide-y divide-neutral-100">
        {all.map((choice) => {
          const key = choiceKey(choice);
          const family = choice.source.kind === 'catalog' ? byId(choice.source.familyId) : undefined;
          const selected = key === choiceKey(active);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onPick(key === choiceKey(best) ? undefined : key)}
              disabled={choice.missing.length > 0}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] disabled:opacity-40 ${
                selected ? 'bg-blue-50' : 'bg-white hover:bg-neutral-50'
              }`}
            >
              <span className={`w-4 shrink-0 text-center font-mono ${selected ? 'text-blue-600' : 'text-transparent'}`}>
                ●
              </span>
              <span className="min-w-0 flex-1 truncate">
                {choice.source.kind === 'reuse'
                  ? `${choice.source.font.family} (embedded)`
                  : choice.source.kind === 'standard'
                    ? `${choice.source.family} (standard)`
                    : family?.name}
                {family?.metricCloneOf && (
                  <span className="text-neutral-400"> — {family.metricCloneOf} metrics</span>
                )}
              </span>
              {showMetric && (
                <span className="shrink-0 font-mono text-neutral-500">
                  {choice.metricRatio !== undefined ? `${(choice.metricRatio * 100).toFixed(1)}%` : 'exact'}
                </span>
              )}
              {showFit && (
                <span
                  className={`w-12 shrink-0 text-right font-mono ${
                    choice.widthRatio > 1.02 ? 'text-amber-600' : 'text-neutral-400'
                  }`}
                >
                  fit {choice.widthRatio.toFixed(2)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[10px] leading-snug text-neutral-500">
        {showMetric ? (
          <>
            Percentages are measured, not guessed: each font renders the <em>original</em> text and
            is compared against the width it really occupied. 100.0% means metrically identical.
          </>
        ) : (
          <>
            Added text replaces nothing, so there is no original width to measure against. The
            tier still tells you whether these glyphs come from the invoice’s own font.
          </>
        )}
      </p>
    </div>
  );
}
