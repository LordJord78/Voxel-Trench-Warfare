import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BrickMap } from '../../src/world/bricks';
import { canonicalChunks, fingerprint } from '../../src/world/fingerprint';

function sample(): BrickMap {
  const w = new BrickMap({ x: 64, y: 32, z: 64 });
  w.fillBox(0, 0, 0, 64, 9, 64, 4);
  w.set(5, 9, 5, 7);
  return w;
}

describe('fingerprint', () => {
  it('is SHA-256 over per-chunk SHA-256 digests of the canonical stream', async () => {
    const w = sample();
    const outer = createHash('sha256');
    for (const chunk of canonicalChunks(w)) outer.update(createHash('sha256').update(chunk).digest());
    expect(await fingerprint(w)).toBe(outer.digest('hex'));
  });
  it('changes with one voxel and ignores compaction state', async () => {
    const a = sample();
    const b = sample();
    expect(await fingerprint(a)).toBe(await fingerprint(b));
    b.set(5, 9, 6, 7);
    expect(await fingerprint(b)).not.toBe(await fingerprint(a));
    const c = sample();
    c.set(1, 1, 1, 9);
    c.set(1, 1, 1, 4);
    expect(await fingerprint(c)).toBe(await fingerprint(a));
  });
  it('cuts chunks at the requested size', () => {
    const sizes = [...canonicalChunks(sample(), 100)].map((c) => c.length);
    expect(sizes.slice(0, -1).every((n) => n === 100)).toBe(true);
    // 64 uniform bricks (2 bytes), 64 dense (1 + 512), 128 empty (1)
    expect(sizes.reduce((s, n) => s + n, 0)).toBe(64 * 2 + 64 * 513 + 128);
  });
});
