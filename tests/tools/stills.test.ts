import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { imageSize } from '../support/image-size';

// The game's stills (tools/stills.mjs; the showcase spec's §2): the page's first paint and its link
// previews, read by their headers (the Pages workflow runs these without the image tools).

/** Bytes from a list of numbers and strings (each string its characters' codes). */
const bytes = (...parts: (number | string)[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : [p])));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

describe("the game's stills", () => {
  it('image sizes are read from PNG, JPEG and WebP headers', () => {
    const png = bytes(0x89, 'PNG', 13, 10, 26, 10, ...be32(13), 'IHDR', ...be32(1920), ...be32(1200), 8, 2, 0, 0, 0);
    expect(imageSize(png)).toEqual({ width: 1920, height: 1200, type: 'png' });
    // A JPEG with an APP0 segment before its baseline frame.
    const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 6, 'JFIF', 0xff, 0xc0, 0, 11, 8, 0x02, 0x76, 0x04, 0xb0, 3, 0, 0, 0, 0, 0);
    expect(imageSize(jpeg)).toEqual({ width: 1200, height: 630, type: 'jpeg' });
    // WebP: lossy (VP8), lossless (VP8L) and extended (VP8X).
    const vp8 = bytes('RIFF', ...le32(30), 'WEBP', 'VP8 ', ...le32(18), 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(1920), ...le16(1200));
    expect(imageSize(vp8)).toEqual({ width: 1920, height: 1200, type: 'webp' });
    const w = 1080 - 1;
    const h = 1080 - 1;
    const vp8l = bytes('RIFF', ...le32(30), 'WEBP', 'VP8L', ...le32(10), 0x2f, ...le32(w | (h << 14)));
    expect(imageSize(vp8l)).toEqual({ width: 1080, height: 1080, type: 'webp' });
    const vp8x = bytes('RIFF', ...le32(30), 'WEBP', 'VP8X', ...le32(10), 0, 0, 0, 0, ...le24(1200 - 1), ...le24(630 - 1));
    expect(imageSize(vp8x)).toEqual({ width: 1200, height: 630, type: 'webp' });
    expect(() => imageSize(bytes('GIF89a', 0, 0))).toThrow();
  });

  it('the stills are the sizes the page and link previews use, and small', () => {
    const still = 'public/stills/dusk.webp';
    const og = 'public/stills/og.jpg';
    expect(imageSize(readFileSync(still))).toEqual({ width: 1920, height: 1200, type: 'webp' });
    expect(statSync(still).size).toBeLessThanOrEqual(200 * 1024);
    expect(imageSize(readFileSync(og))).toEqual({ width: 1200, height: 630, type: 'jpeg' });
    expect(statSync(og).size).toBeLessThanOrEqual(150 * 1024);
  });
});
