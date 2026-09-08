import type { RGB } from '../lib/types';
import type { Rect } from '../lib/geometry';

export interface BackgroundSample {
  color: RGB;
  /**
   * How much of the sampled area is that one colour. Below ~0.55 the area is patterned,
   * ruled or gradient-filled, and painting a flat rectangle over it will show a seam —
   * which is what the UI warns about and what M5's surgical erase avoids entirely.
   */
  uniformity: number;
}

/** Channel values are bucketed this coarsely before voting, to absorb antialiasing. */
const BUCKETS = 12;

/**
 * Reads the background colour behind a piece of text out of the rendered page.
 *
 * Voting on the most common colour inside the text's own box works because glyph ink
 * covers only a fraction of it — even bold 10pt type inks under a third of its line box —
 * so the mode is the paper, not the letters.
 */
export function sampleBackground(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  rect: Rect,
): BackgroundSample {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(imageWidth, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(imageHeight, Math.ceil(rect.y + rect.height));
  if (x1 <= x0 || y1 <= y0) return { color: { r: 1, g: 1, b: 1 }, uniformity: 0 };

  const votes = new Map<number, { count: number; r: number; g: number; b: number }>();
  let total = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * imageWidth + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const key =
        (Math.floor((r / 256) * BUCKETS) * BUCKETS + Math.floor((g / 256) * BUCKETS)) * BUCKETS +
        Math.floor((b / 256) * BUCKETS);
      const bucket = votes.get(key);
      if (bucket) {
        bucket.count++;
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
      } else {
        votes.set(key, { count: 1, r, g, b });
      }
      total++;
    }
  }

  let winner = { count: 0, r: 255, g: 255, b: 255 };
  for (const bucket of votes.values()) if (bucket.count > winner.count) winner = bucket;

  return {
    // Average within the winning bucket rather than using its centre, so a near-white
    // paper comes back as its real value instead of snapping to pure white.
    color: {
      r: winner.r / winner.count / 255,
      g: winner.g / winner.count / 255,
      b: winner.b / winner.count / 255,
    },
    uniformity: total ? winner.count / total : 0,
  };
}
