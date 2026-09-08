// Builds the fixture corpus. Each file exercises a path that is easy to get wrong and
// silent when it breaks. Run with: node scripts/make-fixtures.mjs
import { PDFDocument, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib';
import { readFile, writeFile } from 'node:fs/promises';

const base = new Uint8Array(await readFile('fixtures/invoice-chrome.pdf'));

/* --- a page rotated by /Rotate ------------------------------------------- */
// Text coordinates stay in unrotated user space while the raster does not, so anything
// that maps between the two by hand instead of through the viewport transform breaks here.
{
  const doc = await PDFDocument.load(base);
  doc.getPage(0).setRotation(degrees(90));
  await writeFile('fixtures/invoice-rotated.pdf', await doc.save());
}

/* --- a page whose CropBox does not start at the origin -------------------- */
// The classic off-by-a-margin bug: user-space text positions are unchanged, but the
// rendered raster is offset and smaller.
{
  const doc = await PDFDocument.load(base);
  const page = doc.getPage(0);
  const { width, height } = page.getSize();
  page.setCropBox(24, 36, width - 48, height - 72);
  await writeFile('fixtures/invoice-cropbox.pdf', await doc.save());
}

/* --- the same page twice -------------------------------------------------- */
{
  const doc = await PDFDocument.load(base);
  const [copy] = await doc.copyPages(doc, [0]);
  doc.addPage(copy);
  await writeFile('fixtures/invoice-2pages.pdf', await doc.save());
}

/* --- text wrapped inside a Form XObject ----------------------------------- */
// pdf.js inlines an XObject's operators into the page's list, but their bytes live in a
// different stream. Ordinals then disagree, and the surgical erase must decline rather
// than patch the wrong operator.
{
  const doc = await PDFDocument.create();
  const source = await PDFDocument.load(base);
  const embedded = await doc.embedPage(source.getPage(0));
  const page = doc.addPage([embedded.width, embedded.height]);
  page.drawPage(embedded);
  await writeFile('fixtures/invoice-xobject.pdf', await doc.save());
}

/* --- an invoice with no embedded fonts at all ----------------------------- */
// References Helvetica and Times without embedding them, which is the standard-14 path:
// pdf.js reports `missingFile`, and the right answer is the real font, not a substitute.
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const helv = await doc.embedStandardFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedStandardFont(StandardFonts.HelveticaBold);
  const times = await doc.embedStandardFont(StandardFonts.TimesRoman);
  const ink = rgb(0.13, 0.13, 0.13);

  const line = (text, x, y, font, size) => page.drawText(text, { x, y, size, font, color: ink });

  line('FACTURE', 51, 780, helvBold, 22);
  line('N° FA-2026-0912', 51, 758, helv, 10);
  line('Date : 03/08/2026', 51, 744, helv, 10);

  line('Client', 51, 700, helvBold, 10);
  line('Épicerie Moreau SAS', 51, 684, helv, 10);
  line('42 quai de la Loire', 51, 670, helv, 10);
  line('44000 Nantes', 51, 656, helv, 10);

  line('Prestation', 51, 600, helvBold, 10);
  line('Conseil — juillet 2026', 51, 584, times, 10);
  line('Total TTC : 2 640,00 €', 51, 552, helvBold, 12);

  // A right-aligned amount column, to exercise alignment detection here too.
  for (const [i, amount] of ['2 200,00 €', '440,00 €', '2 640,00 €'].entries()) {
    const width = helv.widthOfTextAtSize(amount, 10);
    line(amount, 500 - width, 500 - i * 16, helv, 10);
  }

  await writeFile('fixtures/invoice-standard14.pdf', await doc.save());
}

/* --- encrypted, the two flavours that behave differently ------------------ */
// Owner-password-only encryption is extremely common on invoices from banks and utilities:
// anyone can open it, but permissions are restricted. It must be editable. A real user
// password must not be — and must fail with a clear message rather than a corrupt export.
{
  const doc = await PDFDocument.load(base);
  doc.encrypt({ ownerPassword: 'owner-secret' });
  await writeFile('fixtures/invoice-owner-locked.pdf', await doc.save());
}
{
  const doc = await PDFDocument.load(base);
  doc.encrypt({ ownerPassword: 'owner-secret', userPassword: 'user-secret' });
  await writeFile('fixtures/invoice-password.pdf', await doc.save());
}

console.log('fixtures written: rotated, cropbox, 2pages, xobject, standard14, encrypted x2');
