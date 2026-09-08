import { useState } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import { deviceToUser } from '../lib/geometry';
import { useStore } from '../state/store';

type Drag = { id: string; startX: number; startY: number; baseDx: number; baseDy: number };

/**
 * Dragging a run or a box on the page, in one place because the screen-to-page conversion is
 * the easy thing to get wrong.
 *
 * The pointer moves in CSS pixels; `dx`/`dy` are PDF points along the *page's* axes. Rather
 * than derive a scale factor by hand — the earlier code used `display`, which is CSS pixels
 * per *raster* pixel, and so moved the exported text twice as far as the cursor — the delta
 * is put through the viewport's own inverse transform. Translation cancels in the
 * subtraction, leaving exactly its linear part, which is also what makes dragging correct on
 * a page with `/Rotate`: there, moving the pointer right moves the text along user-space *y*,
 * and a hand-rolled factor cannot know that.
 */
export function useDragOffset(display: number, viewport: PageViewport) {
  const editRun = useStore((s) => s.editRun);
  const [drag, setDrag] = useState<Drag | null>(null);

  const begin = (event: React.PointerEvent, id: string, base: { dx: number; dy: number }) => {
    setDrag({ id, startX: event.clientX, startY: event.clientY, baseDx: base.dx, baseDy: base.dy });
    (event.target as Element).setPointerCapture(event.pointerId);
  };

  const move = (event: React.PointerEvent) => {
    if (!drag) return;
    // CSS pixels -> raster pixels, the space the viewport transform speaks.
    const ddx = (event.clientX - drag.startX) / display;
    const ddy = (event.clientY - drag.startY) / display;
    const [x0, y0] = deviceToUser(0, 0, viewport);
    const [x1, y1] = deviceToUser(ddx, ddy, viewport);
    const round = (n: number) => Math.round(n * 10) / 10;
    editRun(drag.id, { dx: round(drag.baseDx + x1 - x0), dy: round(drag.baseDy + y1 - y0) });
  };

  const end = () => setDrag(null);

  return { begin, move, end };
}
