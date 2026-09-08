import type { PageViewport } from 'pdfjs-dist';
import { rectToDevice } from '../lib/geometry';
import { boxBounds } from '../pdf/textBox';
import { useStore, type PageData } from '../state/store';
import { useDragOffset } from './useDragOffset';
import type { TextBox } from '../pdf/textBox';

interface Props {
  page: PageData;
  display: number;
  viewport: PageViewport;
  /** True while the Add-text tool is armed, so a click anywhere places a box. */
  disabled: boolean;
}

/**
 * Handles for the text boxes the user added to this page.
 *
 * Deliberately a sibling of `RunOverlay` rather than a branch inside it: a run is a click
 * target over ink that is already on the page, whereas a box is the only on-screen evidence
 * that added text exists at all, so it stays visible when empty and is drawn on top.
 */
export function BoxOverlay({ page, display, viewport, disabled }: Props) {
  const boxes = useStore((s) => s.boxes);
  const edits = useStore((s) => s.edits);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const drag = useDragOffset(display, viewport);

  const mine = Object.values(boxes).filter((b) => b.run.pageIndex === page.info.index);
  if (!mine.length) return null;

  const onPointerDown = (event: React.PointerEvent, box: TextBox) => {
    event.stopPropagation();
    select({ kind: 'box', id: box.run.id });
    const edit = edits[box.run.id];
    drag.begin(event, box.run.id, { dx: edit?.dx ?? 0, dy: edit?.dy ?? 0 });
  };

  return (
    <div
      className={`absolute inset-0 ${disabled ? 'pointer-events-none' : ''}`}
      onPointerMove={drag.move}
      onPointerUp={drag.end}
      onPointerCancel={drag.end}
    >
      {mine.map((box) => {
        const edit = edits[box.run.id];
        const rect = rectToDevice(boxBounds(box, edit), viewport);
        const selected = selection?.kind === 'box' && selection.id === box.run.id;
        const empty = !edit?.text.trim();
        return (
          <button
            key={box.run.id}
            type="button"
            title={edit?.text || 'Added text — type it in the panel'}
            onPointerDown={(e) => onPointerDown(e, box)}
            style={{
              left: rect.x * display,
              top: rect.y * display,
              // An empty box has no glyphs to bound, and would otherwise be a sliver nobody
              // can grab or notice they left behind.
              width: Math.max(rect.width * display, 24),
              height: Math.max(rect.height * display, 10),
            }}
            className={`absolute cursor-move rounded-[2px] transition-colors ${
              selected
                ? 'border-2 border-blue-500 bg-blue-500/15'
                : empty
                  ? 'border border-dashed border-blue-400 bg-blue-400/10 hover:bg-blue-400/20'
                  : 'border border-emerald-500/70 bg-emerald-400/15 hover:bg-emerald-400/25'
            }`}
          />
        );
      })}
    </div>
  );
}
