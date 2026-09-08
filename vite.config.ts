import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  // Served from https://najie.github.io/pdf-invoice-editor/. Set unconditionally so `dev`
  // and `preview` serve the same subpath as production and a base-path slip shows up
  // locally rather than only once deployed.
  base: '/pdf-invoice-editor/',
  plugins: [react(), tailwind()],
  // pdf.js ships large prebuilt bundles; let Vite pre-bundle them once.
  optimizeDeps: { include: ['pdfjs-dist'] },
  build: { target: 'es2022' },
});
