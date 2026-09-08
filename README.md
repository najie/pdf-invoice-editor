# Invoice PDF editor

Retype text on an existing invoice PDF and export it again, with everything you did not
touch carried over unchanged — logos, images, table rules, and every other line of text.
Runs entirely in the browser; no invoice is ever uploaded anywhere.

**Live: https://najie.github.io/pdf-invoice-editor/**

```bash
npm install     # also copies font and pdf.js assets into public/
npm run dev
```

Open the page, drop a PDF, click a line, retype it, press **Export PDF**. For something the
invoice never contained — a missing TVA number — press **Add text** and click where it belongs.

---

## The font problem

Replacing text in a PDF is easy. Replacing it so the result does not look patched is the
whole difficulty, and it comes down to the font. This app tries four things in order, and
tells you which one it used.

**Tier 1 — the invoice's own font.** With `fontExtraProperties` enabled, pdf.js hands over
each font's rebuilt program plus its `toUnicode`, `toFontChar` and `widths` tables. That is
enough to re-embed the exact typeface the invoice was set in and draw the new text with it,
so the result is not a lookalike. The catch is subsetting: embedded invoice fonts usually
contain only the glyphs the document already uses, so a character the original never
contained has nothing to draw. Those tables make the coverage test exact rather than a
guess, and generators routinely split one typeface across several subsets — the Chrome
fixture here uses eight for a single Arial — so when the run's own font falls short, its
siblings are checked before giving up.

**Tier 0 — a standard-14 face.** If the file only *names* Helvetica, Times or Courier
rather than embedding it, the right answer is that same reference: no bytes added, and it
renders exactly as the rest of the document does.

**Tier 2 — a metric-compatible clone.** When characters really are missing, substitute a
bundled family with *identical advance widths*, so replacement text occupies exactly the
space the original did and no column drifts:

| Original | Substitute | Licence |
|---|---|---|
| Arial, Helvetica, Liberation Sans, Nimbus Sans | Arimo | Apache-2.0 |
| Times New Roman, Nimbus Roman, Liberation Serif | Tinos | Apache-2.0 |
| Calibri | Carlito | OFL-1.1 |
| Courier New, Liberation Mono | Cousine | Apache-2.0 |
| Cambria | Caladea | OFL-1.1 |

The claim is verified, not assumed: `tests/fonts.test.ts` measures the fixture's Arial
subset at 117.822 pt and Arimo at 117.822 pt for the same string — 0.000% drift.

**Tier 3 — the closest of the bundled families**, ranked by measurement rather than by name.
Each candidate renders the *original* text and is compared against the width that text
really occupied; 100.0% means metrically identical. Ranking the *replacement* text instead
would only reward whichever font renders your typing shortest, which says nothing about
similarity. Alongside the numbers, an A/B panel superimposes the candidate on the original
at 4× in `difference` mode — black means the letterforms coincide.

## Erasing the old text

Two modes, switched in the toolbar.

**Remove** (default) rewrites the page's content stream, replacing each show-text operator
with `[ n ] TJ` — a text operator carrying only a position adjustment. It draws nothing,
deletes the string from the file, and advances the text position by exactly what the
original advanced, so nothing downstream shifts. Best-effort by design: any page it cannot
patch safely falls back to covering, with the reason surfaced.

**Cover** paints a background-coloured rectangle over the old text and draws on top. It
never fails, but the old text stays in the file — an "edited" invoice still carries the old
address for anything reading it as text — and a flat fill shows a seam over artwork. The
background colour is sampled from the rendered page, so tinted table rows survive; a
gradient is detected and warned about.

## Layout

Replacement text is rarely the same width as what it replaces, so alignment is detected
from which edge a line shares with its neighbours, and can be overridden. A right-aligned
amount stays pinned to its column when it grows. Shrink-to-fit, size and letter-spacing
nudges, and dragging a line to move it are all available per line. Lines that read as one
paragraph — an address, a totals column — are grouped so they can be retyped together.

## Adding a line that was never there

Not every fix is a retype. A TVA number is routinely just absent, and then there is nothing to
click. **Add text** places a new line wherever you click, and the interesting part is that it is
not a fresh object with its own defaults: it copies the font, size, colour and character
spacing of the *nearest existing line*, so it goes through the same four tiers as a retype and
normally comes out set in the invoice's own embedded font. It inherits that line's rotation
too, which is what makes a rotated page work without a special case.

Two things it deliberately does not inherit: word spacing, because `Tw` is almost always a
justification hack and copying it drops multi-point gaps into a freshly typed string; and the
template matrix's horizontal squeeze, which you did not ask for and could not see the cause of.
White ink is swapped for black, because a box templated off white-on-dark logo type would
otherwise be invisible on paper.

The anchor is a baseline point rather than a frame, so alignment means which edge is pinned to
where you clicked: left starts there, right ends there, centre straddles it. Internally a box
is just a `TextRun` of zero width, which is what makes the alignment arithmetic, the writer and
the font resolver work on it unchanged. Nothing is erased — there was no ink there — so Verify's
allowed region for added text is the glyphs' own bounding box, a tighter check than the band a
replacement needs. Text drawn past the paper's edge is called out rather than left to be
discovered at the printer.

## Verifying it

The **Verify** button re-renders the export, diffs it against the original pixel by pixel,
and marks what changed on the page: green inside the lines you edited or added, red outside.
Red is a bug. It is the direct machine check of the promise the tool makes.

The same check runs headlessly over a fixture corpus:

```bash
npm test
```

`fixtures/` is generated by `node scripts/make-fixtures.mjs` and covers the cases that are
easy to get wrong and silent when they break: a Chrome-printed invoice with eight Arial
subsets, a page rotated with `/Rotate`, a non-zero `CropBox` origin, two pages, text wrapped
in a Form XObject (which the surgical erase must decline rather than mis-patch), an invoice
with no embedded fonts at all, and both flavours of encryption.

## Notes

- **Encrypted input** is decrypted rather than ignored. Owner-password-only encryption is
  common on invoices from banks and utilities; those edit normally, and the export is
  plaintext, which the UI says out loud. A real user password is refused with a clear
  message instead of a corrupt export.
- **Scope**: edits existing text, moves or resizes it, and adds new single-line text boxes. It
  does not delete the document's own text boxes, and it does not replace images.

## How it fits together

```
pdfjs-dist 6 ──read──▶  TextRun / Block / FontInfo  ──write──▶ @cantoo/pdf-lib
```

| Path | Role |
|---|---|
| `src/pdf/buildTextIndex.ts` | One walk of the operator list: real font names, exact fill colours, `Tc`/`Tw`/`Tz`, and the show-operator ordinals the eraser needs |
| `src/pdf/groupRuns.ts` | Show-text fragments → visual lines → paragraphs, rotation-aware |
| `src/pdf/emitText.ts` | Emits `q BT Tf Tc Tw Tm TJ ET Q` directly, because `drawText` cannot express the original's spacing or matrix |
| `src/pdf/contentStream.ts` | Locates show-text operators by byte range, undeceived by escaped parens, comments and inline images |
| `src/pdf/surgicalErase.ts` | Splices those operators out, or declines with a reason |
| `src/pdf/textBox.ts` | Added text, as a synthetic zero-width `TextRun` templated off the nearest line |
| `src/fonts/` | The four tiers, the measured ranking, and the bundled catalogue |

`scripts/inspect-pdf.mjs <file.pdf>` dumps what pdf.js knows about a document's fonts —
the fastest way to see why a particular invoice resolved the way it did.
