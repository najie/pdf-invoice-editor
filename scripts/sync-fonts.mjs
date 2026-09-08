// Copies static TTFs out of the @expo-google-fonts/* packages into public/fonts/.
//
// Why those packages: they are the only npm distribution of these families that ships
// real static .ttf files. @fontsource/* ships woff/woff2 only, which @pdf-lib/fontkit
// cannot parse, and pdf-lib needs a parseable TTF/OTF to embed.
//
// Naming: <Family>-<Regular|Bold|Italic|BoldItalic>.ttf, which is what fonts/catalog.ts
// expects. Weights other than 400/700 are ignored.
import { mkdir, copyFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'fonts');

const FAMILIES = ['arimo', 'tinos', 'carlito', 'cousine', 'caladea', 'roboto'];

/** 'Arimo_700Bold_Italic.ttf' -> 'BoldItalic' | null (null = a weight we don't ship) */
function styleFromFilename(file) {
  const m = /^[A-Za-z]+_(\d{3})[A-Za-z]*(_Italic)?\.ttf$/.exec(file);
  if (!m) return null;
  const [, weight, italic] = m;
  const bold = weight === '700';
  if (weight !== '400' && weight !== '700') return null;
  return bold ? (italic ? 'BoldItalic' : 'Bold') : italic ? 'Italic' : 'Regular';
}

async function* walkTtf(dir) {
  for (const entry of await readdir(dir)) {
    const p = join(dir, entry);
    if ((await stat(p)).isDirectory()) yield* walkTtf(p);
    else if (entry.endsWith('.ttf')) yield p;
  }
}

const titled = (s) => s[0].toUpperCase() + s.slice(1);

await mkdir(outDir, { recursive: true });
let copied = 0;
const missing = [];

for (const family of FAMILIES) {
  const pkgDir = join(root, 'node_modules', '@expo-google-fonts', family);
  if (!existsSync(pkgDir)) {
    missing.push(family);
    continue;
  }
  for await (const src of walkTtf(pkgDir)) {
    const style = styleFromFilename(src.split('/').pop());
    if (!style) continue;
    await copyFile(src, join(outDir, `${titled(family)}-${style}.ttf`));
    copied++;
  }
}

console.log(`sync-fonts: ${copied} TTFs -> public/fonts/`);
if (missing.length) {
  console.warn(`sync-fonts: not installed, skipped: ${missing.join(', ')}`);
}
