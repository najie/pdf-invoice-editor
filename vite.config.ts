import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  // pdf.js ships large prebuilt bundles; let Vite pre-bundle them once.
  optimizeDeps: { include: ['pdfjs-dist'] },
  build: { target: 'es2022' },
});
