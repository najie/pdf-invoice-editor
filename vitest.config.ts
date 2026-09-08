import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The default pdfjs-dist entry needs DOMMatrix/ImageData. Tests run in Node, so
      // point at the legacy build; the public API is identical.
      'pdfjs-dist': 'pdfjs-dist/legacy/build/pdf.mjs',
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
