export type Style = 'Regular' | 'Bold' | 'Italic' | 'BoldItalic';

export interface CatalogFamily {
  id: string;
  /** File-name stem in public/fonts, e.g. `Arimo` -> Arimo-Bold.ttf. */
  name: string;
  /**
   * The proprietary family this one has identical advance widths to. That is what makes
   * a substitution safe: replacement text occupies exactly the space the original did,
   * so nothing reflows and no column drifts.
   */
  metricCloneOf?: string;
  serif: boolean;
  monospace: boolean;
  license: string;
}

export const CATALOG: CatalogFamily[] = [
  { id: 'arimo',   name: 'Arimo',   metricCloneOf: 'Arial / Helvetica', serif: false, monospace: false, license: 'Apache-2.0' },
  { id: 'tinos',   name: 'Tinos',   metricCloneOf: 'Times New Roman',   serif: true,  monospace: false, license: 'Apache-2.0' },
  { id: 'carlito', name: 'Carlito', metricCloneOf: 'Calibri',           serif: false, monospace: false, license: 'OFL-1.1' },
  { id: 'cousine', name: 'Cousine', metricCloneOf: 'Courier New',       serif: false, monospace: true,  license: 'Apache-2.0' },
  { id: 'caladea', name: 'Caladea', metricCloneOf: 'Cambria',           serif: true,  monospace: false, license: 'OFL-1.1' },
  { id: 'roboto',  name: 'Roboto',                                      serif: false, monospace: false, license: 'Apache-2.0' },
];

/** Offered, in this order, when nothing better can be inferred. */
export const TOP_FIVE = ['arimo', 'tinos', 'carlito', 'cousine', 'roboto'] as const;

export const byId = (id: string) => CATALOG.find((f) => f.id === id);

export function styleOf(bold: boolean, italic: boolean): Style {
  if (bold && italic) return 'BoldItalic';
  if (bold) return 'Bold';
  if (italic) return 'Italic';
  return 'Regular';
}

export function fontPath(id: string, style: Style): string {
  const family = byId(id);
  if (!family) throw new Error(`unknown font family: ${id}`);
  // BASE_URL keeps this correct under the Pages subpath, and resolves to '/fonts/…' in
  // Node tests, where the loader reads `public${path}` off disk.
  return `${import.meta.env.BASE_URL}fonts/${family.name}-${style}.ttf`;
}
