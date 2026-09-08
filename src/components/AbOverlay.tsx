import { useEffect, useRef, useState } from 'react';
import type { CatalogFont } from '../fonts/provider';
import { rectToDevice, runInkBox } from '../lib/geometry';
import { sampleBackground } from '../pdf/sampleBackground';
import { RASTER_SCALE, type PageData } from '../state/store';
import type { TextRun } from '../lib/types';

interface Props {
  page: PageData;
  run: TextRun;
  candidate: CatalogFont | null;
  familyName: string;
}

/**
 * Superimposes a candidate substitute on the original, in `difference` blend mode, drawing
 * the *original* string in both. Black means the letterforms coincide; visible ghosting is
 * exactly the mismatch the numbers cannot convey.
 *
 * Only meaningful for substitutes — tiers 0 and 1 use the real font, so there is nothing
 * to compare.
 */
export function AbOverlay({ page, run, candidate, familyName }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const zoom = 4;

  useEffect(() => {
    if (!candidate) return;
    let cancelled = false;
    const family = `ab-${candidate.familyId}-${candidate.style}`;

    (async () => {
      const face = new FontFace(family, candidate.bytes as unknown as ArrayBuffer);
      await face.load();
      if (cancelled) return;
      document.fonts.add(face);
      setReady(true);
    })().catch(() => setReady(false));

    return () => {
      cancelled = true;
    };
  }, [candidate]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !candidate || !ready) return;

    const box = runInkBox(run, 1);
    const device = rectToDevice(box, page.viewport);
    const w = Math.ceil(device.width);
    const h = Math.ceil(device.height);
    el.width = w * zoom;
    el.height = h * zoom;

    const ctx = el.getContext('2d')!;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, el.width, el.height);

    // `difference` compares two ink masks, so the original has to become one: white where
    // there are glyphs, black where there is background. Inverting the raster would only
    // work for dark text on light paper — the reversed-out text in a logo would come out
    // backwards — so ink is identified by distance from the region's own background
    // colour, which is direction-agnostic.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(page.canvas, device.x, device.y, w, h, 0, 0, el.width, el.height);

    const region = ctx.getImageData(0, 0, el.width, el.height);
    const { color: bg } = sampleBackground(region.data, el.width, el.height, {
      x: 0, y: 0, width: el.width, height: el.height,
    });
    const bgR = bg.r * 255;
    const bgG = bg.g * 255;
    const bgB = bg.b * 255;
    // Full ink at a quarter of the maximum possible distance, so antialiased edges still
    // register while sensor-level noise does not.
    const fullInk = 3 * 255 * 0.25;
    for (let i = 0; i < region.data.length; i += 4) {
      const distance =
        Math.abs(region.data[i] - bgR) +
        Math.abs(region.data[i + 1] - bgG) +
        Math.abs(region.data[i + 2] - bgB);
      const level = Math.min(255, (distance / fullInk) * 255);
      region.data[i] = level;
      region.data[i + 1] = level;
      region.data[i + 2] = level;
      region.data[i + 3] = 255;
    }
    ctx.putImageData(region, 0, 0);

    // The candidate on top: same string, same baseline, drawn as a white mask.
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#fff';
    const family = `ab-${candidate.familyId}-${candidate.style}`;
    const pixelsPerPoint = RASTER_SCALE * zoom;
    ctx.font = `${run.size * pixelsPerPoint}px "${family}"`;
    ctx.textBaseline = 'alphabetic';
    // Baseline offset inside the ink box: the box starts `ascent` above the baseline.
    const baselineY = (run.ascent * run.size + 1) * pixelsPerPoint;
    ctx.fillText(run.str, (run.x - box.x) * pixelsPerPoint, baselineY);
    ctx.restore();
  }, [page, run, candidate, ready, zoom]);

  if (!candidate) {
    return (
      <p className="rounded-md bg-emerald-50 px-2.5 py-2 text-[11px] text-emerald-800">
        No comparison needed — this uses the real font, not a stand-in.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] text-neutral-500">
        <span>Original vs {familyName}</span>
        <span>white = mismatch</span>
      </div>
      <div className="overflow-x-auto rounded-md border border-edge bg-white">
        <canvas ref={canvas} className="block h-auto max-w-none" style={{ imageRendering: 'pixelated' }} />
      </div>
    </div>
  );
}
