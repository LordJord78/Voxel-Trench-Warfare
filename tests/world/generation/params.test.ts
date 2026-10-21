import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../../src/core/tunables';
import { genParams, vx } from '../../../src/world/generation/params';

describe('genParams', () => {
  const p = genParams(loadTunables());
  it('derives the 10 cm world from metres', () => {
    expect(vx(2.25, 0.1)).toBe(23);
    expect(p.dims).toEqual({ x: 2560, y: 320, z: 2560 });
    expect(p.ground).toBe(160);
    expect(p.waterTable).toBe(125);
    expect(p.trench.width).toBe(25);
    expect(p.trench.depth).toBe(25);
    expect(p.trench.crestRise).toBe(15);
    expect(p.trench.treadsAcross).toBe(3);
    expect(p.trench.offset).toBe(35);
    expect(p.layout.front).toBe(1060);
  });
  it('keeps the peek: crest between the crouched and standing eye', () => {
    expect(p.eye.crouched).toBeLessThan(p.trench.crestRise);
    expect(p.trench.crestRise).toBeLessThan(p.eye.standing);
  });
  it('lists every line, with comm trenches along z', () => {
    expect(p.lines.map((l) => l.name)).toEqual([
      'front', 'support', 'reserve', 'enemy_front', 'enemy_support', 'enemy_reserve',
      'comm_0', 'comm_1', 'comm_2', 'enemy_comm_0', 'enemy_comm_1',
    ]);
    const comm = p.lines[6];
    expect(comm.longAxis).toBe(2);
    expect(comm.aStart).toBe(p.layout.reserve - 1);
    expect(p.lines[0].aStart).toBe(60);
    expect(p.lines[0].aEnd).toBe(2500);
  });
  it('refuses a crest that gives no peek', () => {
    expect(() => genParams(loadTunables(), (raw: any) => { raw.world.trench.crest_clearance_m = 0.6; })).toThrow(RangeError);
  });
});
