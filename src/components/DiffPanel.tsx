import { useState } from 'react';
import { loadDocument } from '../pdf/loadDocument';
import { rectToDevice, runInkBox } from '../lib/geometry';
import { pendingEdits, RASTER_SCALE, useStore } from '../state/store';

/** Ignores antialiasing jitter between two renders of identical content. */
const NOISE = 12;

/**
 * Re-renders the exported PDF and diffs it against the original.
 *
 * This is the direct machine check of the one promise the tool makes: that everything you
 * did not touch survives unchanged. A non-zero count outside the edited boxes means
 * something moved that should not have — a claim worth verifying rather than asserting.
 */
export function DiffPanel() {
  const pages = useStore((s) => s.pages);
  const edits = useStore((s) => s.edits);
  const boxes = useStore((s) => s.boxes);
  const exportPdf = useStore((s) => s.exportPdf);
  const diff = useStore((s) => s.diff);
  const setDiff = useStore((s) => s.setDiff);
  const [running, setRunning] = useState(false);

  const dirty = pendingEdits(pages, boxes, edits).length > 0;

  const run = async () => {
    setRunning(true);
    try {
      await compare();
    } finally {
      setRunning(false);
    }
  };

  const compare = async () => {
    const result = await exportPdf();
    if (!result) return;

    const doc = await loadDocument(result.bytes);
    let inside = 0;
    let outside = 0;
    const images: string[] = [];

    for (const source of pages) {
      const page = await doc.getPage(source.info.index + 1);
      const viewport = page.getViewport({ scale: RASTER_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = source.canvas.width;
      canvas.height = source.canvas.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;

      const after = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const before = source.pixels;

      // Boxes an edit is allowed to change: the original ink box, widened to the page edge
      // because replacement text may legitimately be longer than what it replaced.
      const allowed = Object.values(edits)
        .filter((edit) => source.runs.has(edit.runId))
        .map((edit) => {
          const target = source.runs.get(edit.runId)!;
          const box = runInkBox(target, 1.5);
          return rectToDevice({ ...box, x: box.x - 260, width: box.width + 520 }, viewport);
        });

      // Added text gets its region from the writer's own report rather than from anything the
      // UI estimated: this check is the tool's headline claim, and validating it against a
      // guess would hollow it out. Because a box erases nothing, the glyphs' own bounds are
      // the whole of what it was allowed to change — a stricter test than the band above,
      // which has to be wide because a replacement may legitimately be longer.
      for (const report of result.reports) {
        if (report.kind !== 'box' || report.pageIndex !== source.info.index) continue;
        if (report.drawnBox) allowed.push(rectToDevice(report.drawnBox, viewport));
      }

      const overlay = ctx.createImageData(canvas.width, canvas.height);
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          const delta =
            Math.abs(before[i] - after[i]) +
            Math.abs(before[i + 1] - after[i + 1]) +
            Math.abs(before[i + 2] - after[i + 2]);
          overlay.data[i + 3] = 30;
          if (delta <= NOISE) continue;
          const hit = allowed.some(
            (r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height,
          );
          if (hit) inside++;
          else outside++;
          overlay.data[i] = hit ? 34 : 220;
          overlay.data[i + 1] = hit ? 160 : 38;
          overlay.data[i + 2] = hit ? 90 : 38;
          overlay.data[i + 3] = 235;
        }
      }
      ctx.putImageData(overlay, 0, 0);
      images.push(canvas.toDataURL('image/png'));
    }

    setDiff({ changedInside: inside, changedOutside: outside, overlays: images });
  };

  return (
    <div className="border-t border-edge px-4 py-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold">Verify</h3>
          <p className="mt-0.5 text-[10px] leading-snug text-neutral-500">
            Re-renders the export and compares it pixel by pixel with the original.
          </p>
        </div>
        <button
          type="button"
          disabled={!dirty || running}
          onClick={() => void run()}
          className="shrink-0 rounded-md border border-edge bg-white px-2.5 py-1.5 text-[11px] font-medium hover:bg-neutral-50 disabled:opacity-40"
        >
          {running ? 'Checking…' : diff ? 'Re-check' : 'Check'}
        </button>
      </div>

      {diff && (
        <div className="mt-2.5">
          <div
            className={`rounded-md px-2.5 py-2 text-[11px] ${
              diff.changedOutside === 0 ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'
            }`}
          >
            {diff.changedOutside === 0 ? (
              <>
                <span className="font-medium">Clean.</span> {diff.changedInside.toLocaleString()} pixels
                changed, all inside the lines you edited or added. Everything else is identical.
              </>
            ) : (
              <>
                <span className="font-medium">{diff.changedOutside.toLocaleString()} pixels</span> changed
                outside the lines you edited or added, marked red on the page.
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => setDiff(null)}
            className="mt-1.5 text-[11px] text-blue-600 hover:underline"
          >
            hide the overlay
          </button>
        </div>
      )}
    </div>
  );
}
