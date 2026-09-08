import { useEffect, useRef } from 'react';
import { RunOverlay } from './RunOverlay';
import { BoxOverlay } from './BoxOverlay';
import { deviceToUser } from '../lib/geometry';
import { RASTER_SCALE, useStore, type PageData } from '../state/store';

/** Blits the pre-rendered page bitmap and lays the click targets over it. */
export function PageView({ page }: { page: PageData }) {
  const zoom = useStore((s) => s.zoom);
  const select = useStore((s) => s.select);
  const tool = useStore((s) => s.tool);
  const addBox = useStore((s) => s.addBox);
  const diffOverlay = useStore((s) => s.diff?.overlays[page.info.index]);
  const host = useRef<HTMLCanvasElement>(null);

  const display = zoom / RASTER_SCALE;
  const width = page.canvas.width * display;
  const height = page.canvas.height * display;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (tool !== 'addText') {
      select(null);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    // CSS pixels -> raster pixels -> user space. Dividing by `display` first is what makes
    // the zoom level irrelevant, and going through the viewport transform is what makes
    // `/Rotate` and a CropBox that does not start at the origin free.
    const [x, y] = deviceToUser(
      (event.clientX - bounds.left) / display,
      (event.clientY - bounds.top) / display,
      page.viewport,
    );
    addBox(page.info.index, x, y);
  };

  useEffect(() => {
    const canvas = host.current;
    if (!canvas) return;
    canvas.width = page.canvas.width;
    canvas.height = page.canvas.height;
    canvas.getContext('2d')!.drawImage(page.canvas, 0, 0);
  }, [page]);

  return (
    <div className="mx-auto" style={{ width }}>
      <div className="mb-1 flex items-baseline gap-2 text-[11px] text-neutral-500">
        <span>Page {page.info.index + 1}</span>
        <span>·</span>
        <span>
          {Math.round(page.info.width)} × {Math.round(page.info.height)} pt
        </span>
        {page.info.rotation !== 0 && <span>· rotated {page.info.rotation}°</span>}
        <span>· {page.runList.length} text runs</span>
      </div>
      <div
        className={`relative shadow-md ring-1 ring-black/10 ${
          tool === 'addText' ? 'cursor-crosshair' : ''
        }`}
        style={{ width, height }}
        onPointerDown={onPointerDown}
      >
        <canvas
          ref={host}
          className="page-canvas block h-full w-full bg-white"
          style={{ width, height }}
        />
        {diffOverlay && (
          <img
            src={diffOverlay}
            alt={`Pixels that changed on page ${page.info.index + 1}`}
            className="pointer-events-none absolute inset-0 h-full w-full"
          />
        )}
        <RunOverlay
          page={page}
          display={display}
          viewport={page.viewport}
          disabled={tool === 'addText'}
        />
        <BoxOverlay
          page={page}
          display={display}
          viewport={page.viewport}
          disabled={tool === 'addText'}
        />
      </div>
    </div>
  );
}
