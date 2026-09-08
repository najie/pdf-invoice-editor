import { useEffect, useState } from 'react';
import { pendingEdits, useStore } from '../state/store';
import type { EditReport } from '../pdf/regenerate';

/**
 * What is worth telling the user about one edit, as sentence fragments to be joined.
 *
 * A list rather than nested conditionals because the clauses are independent: a line can
 * overrun its column, sit on artwork *and* fall off the page, and each was a separate
 * measurement the export already made.
 */
function problems(report: EditReport): string[] {
  const clauses: string[] = [];
  if (report.overflow > 0.5) {
    clauses.push(`runs ${report.overflow.toFixed(1)} pt past the original width`);
  }
  // A seam is only possible where a rectangle was actually painted.
  if (report.erasedBy === 'cover' && report.backgroundUniformity < 0.6) {
    clauses.push(
      'sits on patterned or ruled artwork, where the covering rectangle may show a seam — try Remove',
    );
  }
  if (report.offPage) {
    clauses.push('extends past the edge of the page, so part of it will not print');
  }
  return clauses;
}

export function ExportBar() {
  const fileName = useStore((s) => s.fileName);
  const pages = useStore((s) => s.pages);
  const edits = useStore((s) => s.edits);
  const boxes = useStore((s) => s.boxes);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const exporting = useStore((s) => s.exporting);
  const exportPdf = useStore((s) => s.exportPdf);
  const clearAllEdits = useStore((s) => s.clearAllEdits);
  const reset = useStore((s) => s.reset);
  const zoom = useStore((s) => s.zoom);
  const setZoom = useStore((s) => s.setZoom);
  const reports = useStore((s) => s.lastReports);
  const fallbacks = useStore((s) => s.lastFallbacks);
  const wasEncrypted = useStore((s) => s.lastWasEncrypted);
  const eraseMode = useStore((s) => s.eraseMode);
  const setEraseMode = useStore((s) => s.setEraseMode);
  const [error, setError] = useState<string | null>(null);

  const pending = pendingEdits(pages, boxes, edits);
  // Counted apart from each other: a box is not a line of the document that changed, and
  // rolling the two together would report one addition as two changes.
  const changedLines = pending.filter((edit) => !boxes[edit.runId]).length;
  const boxCount = Object.keys(boxes).length;
  const summary = [
    changedLines > 0 && `${changedLines} line${changedLines === 1 ? '' : 's'} changed`,
    boxCount > 0 && `${boxCount} text box${boxCount === 1 ? '' : 'es'} added`,
  ].filter(Boolean);

  // Escape disarms. A tool that can only be turned off by clicking the same small button
  // again is the kind of thing you notice only after dropping a box you did not want.
  useEffect(() => {
    if (tool !== 'addText') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTool('select');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, setTool]);

  const download = async () => {
    setError(null);
    try {
      const result = await exportPdf();
      if (!result) return;
      const blob = new Blob([result.bytes as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = (fileName ?? 'invoice.pdf').replace(/\.pdf$/i, '') + '-edited.pdf';
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const warnings = (reports ?? []).filter((r) => problems(r).length > 0);

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-edge bg-white px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{fileName}</div>
        <div className="text-[11px] text-neutral-500">
          {pages.length} page{pages.length === 1 ? '' : 's'} ·{' '}
          {pages.reduce((n, p) => n + p.runList.length, 0)} text runs ·{' '}
          {summary.length ? summary.join(' · ') : 'no changes'}
        </div>
      </div>

      <button
        type="button"
        onClick={() => setTool(tool === 'addText' ? 'select' : 'addText')}
        title="Type text the invoice does not contain — a missing TVA number, say. Click where it belongs; it takes the font and size of the nearest line. Escape cancels."
        className={`rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition ${
          tool === 'addText'
            ? 'border-blue-600 bg-blue-600 text-white'
            : 'border-edge bg-white hover:bg-neutral-50'
        }`}
      >
        {tool === 'addText' ? 'Click the page…' : 'Add text'}
      </button>

      <div
        className="flex items-center gap-1.5 text-[11px] text-neutral-600"
        title={
          eraseMode === 'surgical'
            ? 'Deletes the replaced text from the file, so nothing is left to extract and no rectangle is painted. Falls back to Cover on pages it cannot patch safely.'
            : 'Paints a background-coloured rectangle over the old text. Always works, but the old text stays in the file and the patch can show a seam on artwork.'
        }
      >
        Erase
        <div className="flex overflow-hidden rounded-md border border-edge">
          {(['surgical', 'cover'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setEraseMode(mode)}
              className={`px-2 py-1 capitalize transition ${
                mode === eraseMode ? 'bg-blue-600 text-white' : 'bg-white hover:bg-neutral-50'
              }`}
            >
              {mode === 'surgical' ? 'Remove' : 'Cover'}
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-1.5 text-[11px] text-neutral-600">
        Zoom
        <input
          type="range"
          min={0.5}
          max={3}
          step={0.1}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="w-24 accent-blue-600"
        />
        <span className="w-9 font-mono">{Math.round(zoom * 100)}%</span>
      </label>

      {(pending.length > 0 || boxCount > 0) && (
        <button
          type="button"
          onClick={clearAllEdits}
          className="rounded-md border border-edge px-2.5 py-1.5 text-[11px] hover:bg-neutral-50"
        >
          Revert all
        </button>
      )}
      <button
        type="button"
        onClick={reset}
        className="rounded-md border border-edge px-2.5 py-1.5 text-[11px] hover:bg-neutral-50"
      >
        Close
      </button>
      <button
        type="button"
        disabled={pending.length === 0 || exporting}
        onClick={() => void download()}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-40"
      >
        {exporting ? 'Generating…' : 'Export PDF'}
      </button>

      {(error || warnings.length > 0 || fallbacks.length > 0 || wasEncrypted) && (
        <div className="w-full space-y-1">
          {error && <p className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">{error}</p>}
          {wasEncrypted && (
            <p className="rounded bg-sky-50 px-2 py-1 text-[11px] text-sky-800">
              This PDF was encrypted with restricted permissions. It was decrypted so it could be
              edited, so the exported file is not encrypted.
            </p>
          )}
          {fallbacks.map((f) => (
            <p key={f.pageIndex} className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
              Page {f.pageIndex + 1}: could not remove the old text, so it was covered instead —{' '}
              {f.reason}.
            </p>
          ))}
          {warnings.map((w) => (
            <p key={w.runId} className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
              “{w.text}” {problems(w).join(' and ')}.
            </p>
          ))}
        </div>
      )}
    </header>
  );
}
