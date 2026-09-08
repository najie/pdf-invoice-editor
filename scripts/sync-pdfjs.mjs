// pdf.js loads two sets of runtime assets over HTTP rather than bundling them:
//   cmaps/         - CID character maps, needed for CJK / Identity-H encoded fonts
//   standard_fonts/ - the standard-14 font programs, needed whenever a PDF references
//                     Helvetica/Times/Courier without embedding them
// Without these, such documents render with wrong or missing glyphs.
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', 'pdfjs-dist');
const to = join(root, 'public', 'pdfjs');

if (!existsSync(from)) {
  console.warn('sync-pdfjs: pdfjs-dist not installed, skipped');
  process.exit(0);
}

await mkdir(to, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  if (existsSync(join(from, dir))) {
    await cp(join(from, dir), join(to, dir), { recursive: true });
  }
}
console.log('sync-pdfjs: cmaps + standard_fonts + wasm -> public/pdfjs/');
