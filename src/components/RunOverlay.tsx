import { rectToDevice, runInkBox } from '../lib/geometry';
import { isDirty, useStore, type PageData } from '../state/store';
import { useDragOffset } from './useDragOffset';
import type { PageViewport } from 'pdfjs-dist';
import type { TextRun } from '../lib/types';

interface Props {
  page: PageData;
  /** Ratio between the displayed size and the raster the boxes were measured against. */
  display: number;
  viewport: PageViewport;
  /** True while the Add-text tool is armed, so the click reaches the page instead. */
  disabled: boolean;
}

/**
 * Click targets laid over the page raster, one per text run.
 *
 * Boxes are mapped through the viewport transform rather than scaled by hand, so they stay
 * on the glyphs on rotated pages and on pages whose CropBox does not start at the origin.
 */
export function RunOverlay({ page, display, viewport, disabled }: Props) {
  const selection = useStore((s) => s.selection);
  const edits = useStore((s) => s.edits);
  const select = useStore((s) => s.select);
  const drag = useDragOffset(display, viewport);

  const selectedIds = new Set<string>();
  if (selection?.kind === 'run') selectedIds.add(selection.id);
  if (selection?.kind === 'block') {
    const block = page.blocks.find((b) => b.id === selection.id);
    for (const id of block?.runIds ?? []) selectedIds.add(id);
  }

  const onPointerDown = (event: React.PointerEvent, run: TextRun) => {
    event.stopPropagation();
    select({ kind: 'run', id: run.id });
    const edit = edits[run.id];
    drag.begin(event, run.id, { dx: edit?.dx ?? 0, dy: edit?.dy ?? 0 });
  };

  return (
    <div
      className={`absolute inset-0 ${disabled ? 'pointer-events-none' : ''}`}
      onPointerMove={drag.move}
      onPointerUp={drag.end}
      onPointerCancel={drag.end}
    >
      {page.runList.map((run) => {
        const edit = edits[run.id];
        // Measured from the *shifted* run, exactly as the writer does, so the highlight sits
        // where the ink will land — including on a rotated page, where a CSS offset in
        // screen space would drift away from the glyphs.
        const moved = { ...run, x: run.x + (edit?.dx ?? 0), y: run.y + (edit?.dy ?? 0) };
        const box = rectToDevice(runInkBox(moved, 0.4), viewport);
        const dirty = isDirty(run, edit);
        const selected = selectedIds.has(run.id);
        return (
          <button
            key={run.id}
            type="button"
            title={run.str}
            onPointerDown={(e) => onPointerDown(e, run)}
            style={{
              left: box.x * display,
              top: box.y * display,
              width: Math.max(box.width * display, 6),
              height: Math.max(box.height * display, 8),
            }}
            className={`absolute cursor-move rounded-[2px] border transition-colors ${
              selected
                ? 'border-blue-500 bg-blue-500/15'
                : dirty
                  ? 'border-amber-400/70 bg-amber-300/20 hover:bg-amber-300/30'
                  : 'border-transparent hover:border-blue-400/60 hover:bg-blue-400/10'
            }`}
          />
        );
      })}
    </div>
  );
}
