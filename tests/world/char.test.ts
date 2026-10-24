import { describe, expect, it } from 'vitest';
import { BrickMap } from '../../src/world/bricks';
import { charAround, charBox, CharQueue } from '../../src/world/char';
import { K, P, PALETTE, PALETTE_KIND } from '../../src/world/materials';
import type { Box } from '../../src/world/region';

// What a fire burned (the battle spec's §5): once it is at full burn, the timber, cloth, duckboards
// and hull within 1.5 m of it turn to their burnt shades, of the same kinds, and stay so.
const V = 0.1;
const CENTRE: [number, number, number] = [1.6, 1.6, 1.6];
const BURNT: Record<number, number> = { [P.TIMBER]: P.CHAR_TIMBER, [P.TIMBER_DARK]: P.CHAR_TIMBER, [P.DUCKBOARD]: P.CHAR_DUCKBOARD, [P.CLOTH]: P.CHAR_CLOTH, [P.HULL_RUST]: P.CHAR_HULL };

/** 3.2 m a side: slabs of every flammable shade and of soil, sandbags and brick, through the middle. */
function yard(): BrickMap {
  const map = new BrickMap({ x: 32, y: 32, z: 32 });
  const shades = [P.TIMBER, P.TIMBER_DARK, P.DUCKBOARD, P.CLOTH, P.HULL_RUST, P.SOD, P.SANDBAG, P.BRICK];
  shades.forEach((p, i) => map.fillBox(i * 4, 0, 0, i * 4 + 4, 32, 32, p));
  return map;
}

const within = (x: number, y: number, z: number, r: number) => Math.hypot((x + 0.5) * V - CENTRE[0], (y + 0.5) * V - CENTRE[1], (z + 0.5) * V - CENTRE[2]) <= r;

describe('char', () => {
  it('char turns timber, cloth, duckboards and hull near the fire to their burnt shades, and nothing else', () => {
    const before = yard();
    const map = yard();
    const charred = charAround(map, CENTRE, 1.5, V);
    let changed = 0;
    for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) {
      const was = before.get(x, y, z);
      const now = map.get(x, y, z);
      const burns = was in BURNT;
      if (burns && within(x, y, z, 1.5)) expect(now, `${x},${y},${z}`).toBe(BURNT[was]);
      else expect(now, `${x},${y},${z}`).toBe(was);
      if (now !== was) changed++;
    }
    expect(charred).toBe(changed);
    expect(changed).toBeGreaterThan(1000);
    // The box it may touch holds every voxel it charred.
    const b = charBox(CENTRE, 1.5, V);
    for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) {
      if (map.get(x, y, z) === before.get(x, y, z)) continue;
      expect(x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 && z >= b.z0 && z < b.z1).toBe(true);
    }
  });

  it('charred stays charred, its kind unchanged', () => {
    for (const [from, to] of Object.entries(BURNT)) expect(PALETTE_KIND[to], PALETTE[to].name).toBe(PALETTE_KIND[Number(from)]);
    expect([PALETTE[P.CHAR_TIMBER].kind, PALETTE[P.CHAR_DUCKBOARD].kind, PALETTE[P.CHAR_CLOTH].kind, PALETTE[P.CHAR_HULL].kind]).toEqual([K.TIMBER, K.DUCKBOARD, K.CLOTH, K.HULL]);
    // Darker than what they were.
    const luma = (p: number) => PALETTE[p].srgb.reduce((s, c) => s + c, 0);
    for (const [from, to] of Object.entries(BURNT)) expect(luma(to)).toBeLessThan(luma(Number(from)));
    const map = yard();
    charAround(map, CENTRE, 1.5, V);
    const once = map.takeDirty().length;
    expect(once).toBeGreaterThan(0);
    // A second fire there: nothing more to char.
    expect(charAround(map, CENTRE, 1.5, V)).toBe(0);
    expect(map.takeDirty()).toEqual([]);
  });

  it('a char waits while a crater about it is out, and is made once it is back', () => {
    const map = yard();
    const queue = new CharQueue(1.5, V);
    queue.add(CENTRE);
    const asked: Box[] = [];
    // Out: nothing charred, still waiting.
    expect(queue.make(map, (box) => (asked.push(box), true))).toBe(0);
    expect(queue.pending).toBe(1);
    expect(map.get(1, 16, 16)).toBe(P.TIMBER);
    expect(asked).toEqual([charBox(CENTRE, 1.5, V)]);
    // Back: charred, and done.
    expect(queue.make(map, () => false)).toBeGreaterThan(1000);
    expect(queue.pending).toBe(0);
    expect(map.get(1, 16, 16)).toBe(P.CHAR_TIMBER);
    expect(queue.make(map, () => false)).toBe(0);
  });
});
