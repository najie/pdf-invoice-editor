// Browser-only: wires up the pdf.js worker. Imported once from main.tsx. Kept apart from
// loadDocument.ts so the parsing code stays importable from Node tests.
import { GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
