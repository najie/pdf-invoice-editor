import { useEffect, useMemo, useRef } from 'react';
import { ALIGNMENTS, baseEdit, isDirty, useStore, type PageData } from '../state/store';
import { useFontChoices } from '../fonts/useFontChoices';
import { FontPicker } from './FontPicker';
import { AbOverlay } from './AbOverlay';
import { choiceKey } from '../fonts/choiceKey';
import { boxTextWidth } from '../pdf/textBox';
import type { RunEdit } from '../pdf/regenerate';
import type { Align, TextRun } from '../lib/types';

interface Context {
  page: PageData;
  runs: TextRun[];
  blockId: string | null;
  /** `box` is text the user added, which has no original and so no fit or erase questions. */
  kind: 'run' | 'box';
}

export function EditPanel() {
  const pages = useStore((s) => s.pages);
  const boxes = useStore((s) => s.boxes);
  const selection = useStore((s) => s.selection);
  const edits = useStore((s) => s.edits);
  const editRun = useStore((s) => s.editRun);
  const clearEdit = useStore((s) => s.clearEdit);
  const select = useStore((s) => s.select);
  const removeBox = useStore((s) => s.removeBox);
  const setBoxWidth = useStore((s) => s.setBoxWidth);

  const context = useMemo<Context | null>(() => {
    if (!selection) return null;
    if (selection.kind === 'box') {
      const box = boxes[selection.id];
      const page = box ? pages[box.run.pageIndex] : undefined;
      if (!box || !page) return null;
      return { page, runs: [box.run], blockId: null, kind: 'box' };
    }
    for (const page of pages) {
      if (selection.kind === 'run' && page.runs.has(selection.id)) {
        const run = page.runs.get(selection.id)!;
        return { page, runs: [run], blockId: page.blockOfRun.get(run.id) ?? null, kind: 'run' };
      }
      if (selection.kind === 'block') {
        const block = page.blocks.find((b) => b.id === selection.id);
        if (block) {
          return {
            page,
            runs: block.runIds.map((id) => page.runs.get(id)!).filter(Boolean),
            blockId: block.id,
            kind: 'run',
          };
        }
      }
    }
    return null;
  }, [pages, boxes, selection]);

  const isBlock = selection?.kind === 'block';
  const lead = context?.runs[0] ?? null;
  // Memoised because it feeds an effect below, and `baseEdit` would otherwise mint a fresh
  // object on every render for anything not yet edited.
  const leadEdit = useMemo(
    () => (lead ? edits[lead.id] ?? baseEdit(lead) : null),
    [lead, edits],
  );

  // Resolved against the text that will actually be redrawn. For a block that is the
  // changed lines only — untouched lines are never re-emitted, so folding them in would
  // report a substitution the export is not going to make. Before anything is typed,
  // every line counts, which is what makes the initial badge meaningful.
  const changed = context?.runs.filter((r) => (edits[r.id]?.text ?? r.str) !== r.str) ?? [];
  const measured = changed.length ? changed : (context?.runs ?? []);
  const combinedText = measured.map((r) => edits[r.id]?.text ?? r.str).join('');
  const choices = useFontChoices({
    page: context?.page ?? null,
    run: lead,
    text: combinedText,
    sizeScale: leadEdit?.sizeScale ?? 1,
  });

  const all = choices.best ? [choices.best, ...choices.alternatives] : [];
  const active = all.find((c) => choiceKey(c) === leadEdit?.fontOverride) ?? choices.best;

  // An added box's handle has to bound glyphs nobody has measured yet — its width only
  // exists once a font resolves. Written back through the same `advanceWidth` call the
  // writer makes, so the handle bounds exactly the ink that will be drawn. `setBoxWidth` is
  // idempotent below 0.05 pt and preserves the box's run identity, which is what keeps this
  // from re-resolving in a loop.
  const boxId = context?.kind === 'box' ? lead?.id ?? null : null;
  useEffect(() => {
    if (!boxId || !leadEdit || !active) return;
    const target = useStore.getState().boxes[boxId];
    if (target) setBoxWidth(boxId, boxTextWidth(target, leadEdit, active));
  }, [boxId, leadEdit, active, setBoxWidth]);

  if (!context || !lead || !leadEdit) {
    return (
      <div className="p-4 text-xs leading-relaxed text-neutral-500">
        Click any text on the page to edit it. Lines that belong to the same paragraph can be
        retyped together, and dragging a highlighted box moves that line. For something the
        invoice never contained — a missing TVA number — use <strong>Add text</strong> and
        click where it belongs.
      </div>
    );
  }

  const { page, runs, blockId, kind } = context;
  const isBox = kind === 'box';
  const box = isBox ? boxes[lead.id] : undefined;
  const font = page.fonts.get(lead.fontLoadedName);
  const template = box?.templateRunId ? page.runs.get(box.templateRunId) : undefined;
  const block = blockId ? page.blocks.find((b) => b.id === blockId) : undefined;

  const patchAll = (patch: Partial<RunEdit>) => {
    for (const run of runs) editRun(run.id, patch);
  };

  const candidate = active?.source.kind === 'catalog' ? active.source.loaded : null;
  const candidateName = active?.source.kind === 'catalog' ? active.source.familyId : '';

  const dirtyRuns = runs.filter((r) => isDirty(r, edits[r.id]));

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b border-edge px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            {isBox ? 'Added text' : isBlock ? `Paragraph · ${runs.length} lines` : 'Line'}
          </h2>
          {isBox ? (
            <button
              type="button"
              className="text-[11px] text-red-600 hover:underline"
              onClick={() => removeBox(lead.id)}
            >
              delete
            </button>
          ) : (
            dirtyRuns.length > 0 && (
              <button
                type="button"
                className="text-[11px] text-blue-600 hover:underline"
                onClick={() => dirtyRuns.forEach((r) => clearEdit(r.id))}
              >
                revert
              </button>
            )
          )}
        </div>
        <p className="mt-1 font-mono text-[10px] leading-relaxed break-all text-neutral-500">
          {font?.baseFont ?? lead.fontLoadedName} · {lead.size.toFixed(1)} pt
          {font?.bold ? ' · bold' : ''}
          {font?.italic ? ' · italic' : ''}
          {lead.charSpacing ? ` · Tc ${lead.charSpacing}` : ''}
          {lead.hScale !== 1 ? ` · Tz ${(lead.hScale * 100).toFixed(0)}%` : ''}
        </p>
        {isBox && (
          <p className="mt-1 text-[10px] leading-snug text-neutral-500">
            {template
              ? `Typography taken from the nearest line, “${
                  template.str.length > 28 ? `${template.str.slice(0, 28)}…` : template.str
                }”.`
              : 'This page has no text to match, so a bundled default is used.'}
          </p>
        )}

        {block && !isBlock && (
          <button
            type="button"
            className="mt-2 w-full rounded-md bg-neutral-100 px-2 py-1.5 text-[11px] font-medium hover:bg-neutral-200"
            onClick={() => select({ kind: 'block', id: block.id })}
          >
            Edit all {block.runIds.length} lines together
          </button>
        )}
        {isBlock && (
          <button
            type="button"
            className="mt-2 w-full rounded-md bg-neutral-100 px-2 py-1.5 text-[11px] font-medium hover:bg-neutral-200"
            onClick={() => select({ kind: 'run', id: lead.id })}
          >
            Edit just one line
          </button>
        )}
      </header>

      <div className="space-y-4 px-4 py-4">
        <TextInputs runs={runs} isBox={isBox} />

        <FontPicker
          best={choices.best}
          alternatives={choices.alternatives}
          override={leadEdit.fontOverride}
          onPick={(key) => patchAll({ fontOverride: key })}
          showFit={!isBlock && !isBox}
          showMetric={!isBox}
          loading={choices.loading}
          scope={isBlock ? `${measured.length} line${measured.length === 1 ? '' : 's'}` : null}
        />

        {/* The A/B panel superimposes a candidate on the original ink. Added text has no
            original to superimpose on, and its zero-width run would size the canvas to
            nothing, so it is suppressed rather than fed empty data. */}
        {active && !isBox && (
          <AbOverlay page={page} run={lead} candidate={candidate} familyName={candidateName} />
        )}

        <Segmented
          label="Alignment"
          hint={isBox ? 'anchored to where you clicked' : `detected: ${lead.align}`}
          value={leadEdit.align}
          options={ALIGNMENTS}
          onChange={(align) => patchAll({ align: align as Align })}
        />

        {!isBox && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={leadEdit.shrinkToFit}
              onChange={(e) => patchAll({ shrinkToFit: e.target.checked })}
              className="size-3.5 accent-blue-600"
            />
            <span>Shrink to fit the original width</span>
          </label>
        )}

        <Slider
          label="Size"
          value={leadEdit.sizeScale}
          min={0.5}
          max={1.6}
          step={0.01}
          format={(v) => `${(lead.size * v).toFixed(1)} pt`}
          onChange={(v) => patchAll({ sizeScale: v })}
        />
        <Slider
          label="Letter spacing"
          value={leadEdit.tracking}
          min={-0.5}
          max={1.5}
          step={0.05}
          format={(v) => `${v.toFixed(2)} pt`}
          onChange={(v) => patchAll({ tracking: v })}
        />

        <Nudge dx={leadEdit.dx} dy={leadEdit.dy} onChange={patchAll} />
      </div>
    </div>
  );
}

function TextInputs({ runs, isBox }: { runs: TextRun[]; isBox: boolean }) {
  const edits = useStore((s) => s.edits);
  const editRun = useStore((s) => s.editRun);
  const first = useRef<HTMLInputElement>(null);
  const boxId = isBox ? runs[0]?.id ?? null : null;

  // Placing a box and then having to go and find the field is the wrong shape for the one
  // thing this feature is for: click where the number belongs, type it. Deferred to the next
  // frame because the click that created the box has not finished yet — the browser's own
  // focus handling for that mousedown runs after our handler and would take it straight back.
  useEffect(() => {
    if (!boxId) return;
    const frame = requestAnimationFrame(() => first.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [boxId]);

  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-neutral-600">
        {runs.length > 1 ? 'Text — one field per line' : 'Text'}
      </span>
      <div className="space-y-1">
        {runs.map((run, index) => {
          const value = edits[run.id]?.text ?? run.str;
          return (
            <input
              key={run.id}
              ref={index === 0 ? first : undefined}
              value={value}
              onChange={(e) => editRun(run.id, { text: e.target.value })}
              // An empty field means two different things. On an existing line it erases it;
              // on an added box it is simply not filled in yet, and nothing is drawn.
              placeholder={isBox ? 'Type the text to add' : '(empty erases this line)'}
              className={`w-full rounded-md border px-2 py-1.5 text-xs outline-none focus:border-blue-500 ${
                value !== run.str ? 'border-amber-400 bg-amber-50/60' : 'border-edge bg-white'
              }`}
            />
          );
        })}
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: readonly T[];
  onChange(value: T): void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-xs font-medium text-neutral-600">{label}</span>
        {hint && <span className="text-[10px] text-neutral-400">{hint}</span>}
      </div>
      <div className="flex overflow-hidden rounded-md border border-edge">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={`flex-1 px-2 py-1.5 text-[11px] capitalize transition ${
              option === value ? 'bg-blue-600 text-white' : 'bg-white hover:bg-neutral-50'
            }`}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format(value: number): string;
  onChange(value: number): void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium text-neutral-600">{label}</span>
        <span className="font-mono text-[10px] text-neutral-500">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-600"
      />
    </div>
  );
}

function Nudge({
  dx,
  dy,
  onChange,
}: {
  dx: number;
  dy: number;
  onChange(patch: Partial<RunEdit>): void;
}) {
  const step = 0.5;
  const buttons: Array<[string, Partial<RunEdit>]> = [
    ['←', { dx: dx - step }],
    ['→', { dx: dx + step }],
    ['↑', { dy: dy + step }],
    ['↓', { dy: dy - step }],
  ];
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium text-neutral-600">Position</span>
        <span className="font-mono text-[10px] text-neutral-500">
          {dx.toFixed(1)}, {dy.toFixed(1)} pt
        </span>
      </div>
      <div className="flex gap-1">
        {buttons.map(([glyph, patch]) => (
          <button
            key={glyph}
            type="button"
            onClick={() => onChange(patch)}
            className="flex-1 rounded-md border border-edge bg-white py-1 text-xs hover:bg-neutral-50"
          >
            {glyph}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onChange({ dx: 0, dy: 0 })}
          className="rounded-md border border-edge bg-white px-2 py-1 text-[11px] hover:bg-neutral-50"
        >
          reset
        </button>
      </div>
    </div>
  );
}
