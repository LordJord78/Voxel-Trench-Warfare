/**
 * The world's fingerprint: one hash of what every voxel holds.
 *
 * It answers "is this the same world?" across worker counts, browsers and
 * machines, so it hashes a canonical stream rather than memory: brick by brick
 * in table order, an empty brick as `0`, a uniform one as `1, id`, a dense one
 * as `2` plus its 512 bytes. A dense brick that happens to be uniform is
 * written as uniform, so compaction state never changes the answer.
 *
 * SHA-256 per 1 MiB chunk, then SHA-256 over the chunk digests, through
 * `crypto.subtle` — the same API in Node and in every browser, and no 200 MB
 * buffer needed to hash a 200 MB world.
 */

import { BrickMap, UNIFORM } from './bricks';

export function* canonicalChunks(map: BrickMap, chunkBytes = 1 << 20): Generator<Uint8Array<ArrayBuffer>> {
  if (!(chunkBytes >= 1)) throw new RangeError(`chunk size must be at least one byte, got ${chunkBytes}`);
  let buf = new Uint8Array(chunkBytes);
  let n = 0;
  const head = new Uint8Array(2);
  for (let bi = 0; bi < map.table.length; bi++) {
    let e = map.table[bi];
    let dense: Uint8Array | null = null;
    if (e !== 0 && !(e & UNIFORM)) {
      dense = map.denseView(bi)!;
      const first = dense[0];
      let same = true;
      for (let i = 1; i < 512 && same; i++) same = dense[i] === first;
      if (same) {
        e = first === 0 ? 0 : (UNIFORM | first) >>> 0;
        dense = null;
      }
    }
    let parts: Uint8Array[];
    if (e === 0) {
      head[0] = 0;
      parts = [head.subarray(0, 1)];
    } else if (dense === null) {
      head[0] = 1;
      head[1] = e & 0xff;
      parts = [head.subarray(0, 2)];
    } else {
      head[0] = 2;
      parts = [head.subarray(0, 1), dense];
    }
    for (const part of parts) {
      let off = 0;
      while (off < part.length) {
        const take = Math.min(part.length - off, chunkBytes - n);
        buf.set(part.subarray(off, off + take), n);
        n += take;
        off += take;
        if (n === chunkBytes) {
          yield buf;
          buf = new Uint8Array(chunkBytes);
          n = 0;
        }
      }
    }
  }
  if (n > 0) yield buf.subarray(0, n);
}

/** Lowercase hex SHA-256 over the SHA-256 of each canonical chunk. */
export async function fingerprint(map: BrickMap): Promise<string> {
  const digests: Uint8Array[] = [];
  for (const chunk of canonicalChunks(map)) {
    digests.push(new Uint8Array(await crypto.subtle.digest('SHA-256', chunk)));
  }
  const all = new Uint8Array(digests.length * 32);
  digests.forEach((d, i) => all.set(d, i * 32));
  const outer = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return Array.from(outer, (b) => b.toString(16).padStart(2, '0')).join('');
}
