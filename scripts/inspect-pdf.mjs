// Dumps what pdf.js knows about a document's fonts and operators.
//
// The fastest way to see why a given invoice resolved to the font tier it did: whether a
// face is embedded or merely named, how much of it the subset actually contains, and
// whether the ToUnicode table can be reversed at all.
//
//   node scripts/inspect-pdf.mjs fixtures/invoice-chrome.pdf
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFile } from 'node:fs/promises';

const data = new Uint8Array(await readFile(process.argv[2]));
const doc = await pdfjs.getDocument({
  data, fontExtraProperties: true, isEvalSupported: false,
  cMapUrl: './public/pdfjs/cmaps/', cMapPacked: true,
  standardFontDataUrl: './public/pdfjs/standard_fonts/',
}).promise;
console.log('pages:', doc.numPages);
const page = await doc.getPage(1);
const opList = await page.getOperatorList();
const OPS = pdfjs.OPS;

// which ops appear
const counts = {};
const names = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));
for (const fn of opList.fnArray) counts[names[fn]] = (counts[names[fn]] || 0) + 1;
console.log('ops:', JSON.stringify(counts));

// fonts referenced by setFont
const seen = new Set();
for (let i = 0; i < opList.fnArray.length; i++) {
  if (opList.fnArray[i] !== OPS.setFont) continue;
  seen.add(opList.argsArray[i][0]);
}
console.log('\nsetFont loadedNames:', [...seen]);

for (const ln of seen) {
  const f = page.commonObjs.get(ln);
  console.log(`\n=== ${ln} ===`);
  for (const k of ['name','loadedName','mimetype','missingFile','isType3Font','bold','italic','black',
                   'vertical','subtype','type','composite','isMonospace','isSerifFont','isSymbolicFont',
                   'defaultWidth','fallbackName','isInvalidPDFjsFont','remeasure']) {
    if (f[k] !== undefined) console.log(`  ${k}:`, JSON.stringify(f[k]));
  }
  console.log('  fontMatrix:', JSON.stringify(f.fontMatrix));
  console.log('  ascent/descent:', f.ascent, f.descent);
  console.log('  data:', f.data ? `${f.data.length} bytes, magic=${[...f.data.slice(0,4)].map(b=>b.toString(16).padStart(2,'0')).join(' ')}` : 'NONE');
  console.log('  toUnicode:', f.toUnicode ? `${f.toUnicode.constructor.name}` : 'NONE');
  if (f.toUnicode) {
    const pairs = [];
    f.toUnicode.forEach?.((code, uni) => { if (pairs.length < 12) pairs.push(`${code}->${JSON.stringify(uni)}`); });
    console.log('    sample:', pairs.join(' '));
  }
  console.log('  toFontChar:', f.toFontChar ? `len=${f.toFontChar.length} sample=${JSON.stringify([...f.toFontChar.slice(64,80)])}` : 'NONE');
  console.log('  widths:', f.widths ? `keys=${Object.keys(f.widths).length} sample=${JSON.stringify(Object.entries(f.widths).slice(0,6))}` : 'NONE');
  console.log('  differences:', f.differences ? `len=${f.differences.length}` : 'NONE');
  console.log('  defaultEncoding:', f.defaultEncoding ? `len=${f.defaultEncoding.length}` : 'NONE');
}

// showText glyph shape
for (let i = 0; i < opList.fnArray.length; i++) {
  if (opList.fnArray[i] !== OPS.showText) continue;
  const glyphs = opList.argsArray[i][0];
  console.log('\n=== first showText glyphs ===');
  console.log(JSON.stringify(glyphs.slice(0, 6), (k, v) => (k === 'accent' ? undefined : v), 1).slice(0, 1400));
  break;
}
