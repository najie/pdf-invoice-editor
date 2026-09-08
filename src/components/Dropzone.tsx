import { useCallback, useRef, useState } from 'react';
import { useStore } from '../state/store';

export function Dropzone() {
  const open = useStore((s) => s.open);
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const [hover, setHover] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const take = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (file) void open(file);
    },
    [open],
  );

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-xl">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Invoice PDF editor</h1>
        <p className="mb-6 text-sm text-neutral-500">
          Retype any text on an invoice and export it again. Logos, tables and every line you
          do not touch are carried over untouched. Nothing leaves your browser.
        </p>

        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setHover(true);
          }}
          onDragLeave={() => setHover(false)}
          onDrop={(e) => {
            e.preventDefault();
            setHover(false);
            take(e.dataTransfer.files);
          }}
          className={`w-full rounded-xl border-2 border-dashed px-6 py-16 text-center transition ${
            hover ? 'border-blue-500 bg-blue-50' : 'border-edge bg-white hover:border-neutral-400'
          }`}
        >
          {status === 'loading' ? (
            <span className="text-sm text-neutral-600">Reading fonts and text…</span>
          ) : (
            <>
              <span className="block text-sm font-medium">Drop a PDF here</span>
              <span className="mt-1 block text-xs text-neutral-500">or click to choose a file</span>
            </>
          )}
        </button>

        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => take(e.target.files)}
        />

        {error && (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
      </div>
    </div>
  );
}
