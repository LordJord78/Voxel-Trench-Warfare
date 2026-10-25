/**
 * An image's size from its header alone: PNG (IHDR), JPEG (the first start-of-frame segment) and
 * WebP (VP8, VP8L or VP8X). For tests that check the game's stills without the image tools, which the
 * Pages workflow's runner does not have.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number; type: 'png' | 'jpeg' | 'webp' } {
  const at = (i: number) => bytes[i] ?? 0;
  const text = (i: number, n: number) => String.fromCharCode(...bytes.subarray(i, i + n));
  const be16 = (i: number) => (at(i) << 8) | at(i + 1);
  const be32 = (i: number) => ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0;
  const le16 = (i: number) => at(i) | (at(i + 1) << 8);
  const le24 = (i: number) => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16);
  const le32 = (i: number) => (at(i) | (at(i + 1) << 8) | (at(i + 2) << 16) | (at(i + 3) << 24)) >>> 0;
  if (at(0) === 0x89 && text(1, 3) === 'PNG' && text(12, 4) === 'IHDR') return { width: be32(16), height: be32(20), type: 'png' };
  if (at(0) === 0xff && at(1) === 0xd8) {
    // Segments from the start-of-image on: the first start-of-frame (SOF0–SOF15 but DHT, JPG and DAC) holds the size.
    for (let i = 2; i + 9 < bytes.length; ) {
      if (at(i) !== 0xff) break;
      const marker = at(i + 1);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: be16(i + 7), height: be16(i + 5), type: 'jpeg' };
      i += 2 + be16(i + 2);
    }
  }
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const chunk = text(12, 4);
    if (chunk === 'VP8 ' && at(23) === 0x9d && at(24) === 0x01 && at(25) === 0x2a) return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff, type: 'webp' };
    if (chunk === 'VP8L' && at(20) === 0x2f) {
      const b = le32(21);
      return { width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1, type: 'webp' };
    }
    if (chunk === 'VP8X') return { width: le24(24) + 1, height: le24(27) + 1, type: 'webp' };
  }
  throw new Error('not a PNG, JPEG or WebP image');
}
