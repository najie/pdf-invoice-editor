import { useEffect, useState } from 'react';
import { resolveFont, type FontChoice } from './resolveFont';
import { preloadTopFonts } from './provider';
import { styleOf } from './catalog';
import { TOP_FIVE } from './catalog';
import type { PageData } from '../state/store';
import type { TextRun } from '../lib/types';

export interface Choices {
  loading: boolean;
  best: FontChoice | null;
  alternatives: FontChoice[];
}

/**
 * Resolves the font for the text being typed, debounced.
 *
 * Re-resolving on each keystroke is the point: a subset font can cover "Lyon" and fail on
 * "Lyon 2e" the moment a digit appears, and the badge has to tell the truth about which
 * tier is actually in play right now.
 */
export function useFontChoices(opts: {
  page: PageData | null;
  run: TextRun | null;
  text: string;
  sizeScale: number;
}): Choices {
  const { page, run, text, sizeScale } = opts;
  const [state, setState] = useState<Choices>({ loading: false, best: null, alternatives: [] });

  useEffect(() => {
    if (!page || !run) {
      setState({ loading: false, best: null, alternatives: [] });
      return;
    }
    const font = page.fonts.get(run.fontLoadedName);
    preloadTopFonts(TOP_FIVE, styleOf(font?.bold ?? false, font?.italic ?? false));

    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));
    const timer = setTimeout(() => {
      void resolveFont({
        runFont: font,
        documentFonts: page.fonts.values(),
        newText: text,
        originalText: run.str,
        size: run.size * sizeScale,
        originalWidth: run.width,
      }).then((result) => {
        if (cancelled) return;
        setState({ loading: false, best: result.best, alternatives: result.alternatives });
      });
    }, 90);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [page, run, text, sizeScale]);

  return state;
}
