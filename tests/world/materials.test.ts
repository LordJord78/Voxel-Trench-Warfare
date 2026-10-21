import { describe, expect, it } from 'vitest';
import * as m from '../../src/world/materials';

describe('materials', () => {
  it('keeps the Python rules for the original kinds', () => {
    const solid = [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1];
    const granular = [0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0];
    const loose = [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0];
    const spoil = [0, 5, 5, 5, 5, 5, 5, 15, 15, 15, 15, 15, 13, 0, 14, 15, 0, 15];
    const hard = [0, 1, 1, 1.1, 1.2, 0.8, 1.4, 0.9, 1, 1.3, 4, 2.6, 1.6, 0.7, 0, 1.2, 0.5, 3.4];
    for (let k = 0; k < 18; k++) {
      expect(m.KIND_SOLID[k], `solid ${k}`).toBe(solid[k]);
      expect(m.KIND_GRANULAR[k], `granular ${k}`).toBe(granular[k]);
      expect(m.KIND_LOOSE[k], `loose ${k}`).toBe(loose[k]);
      expect(m.KIND_SPOIL[k], `spoil ${k}`).toBe(spoil[k]);
      expect(m.KIND_HARDNESS[k]).toBeCloseTo(hard[k], 6);
    }
    expect(m.KIND_SOLID[m.K.CLOTH]).toBe(0);
    expect(m.KIND_BLOCKS_SIGHT[m.K.CLOTH]).toBe(1);
    expect(m.KIND_SPOIL[m.K.MORTAR]).toBe(m.K.RUBBLE);
  });
  it('has a palette whose shades belong to their kinds', () => {
    expect(m.PALETTE[0].name).toBe('AIR');
    expect(m.PALETTE.length).toBeLessThanOrEqual(256);
    expect(m.kindOf(m.P.MUD_WET)).toBe(m.K.MUD);
    expect(m.kindOf(m.P.LANTERN_GLOW)).toBe(m.K.PICKET);
    expect(m.baseOf(m.K.SANDBAG)).toBe(m.P.SANDBAG);
    expect(m.spoilOf(m.P.SOD_TUFT)).toBe(m.P.SPOIL);
    expect(m.spoilOf(m.P.BRICK_BURNT)).toBe(m.P.RUBBLE);
    expect(m.isSolid(m.P.WATER)).toBe(false);
    expect(m.isLoose(m.P.SANDBAG_SEAM)).toBe(true);
    for (const name of Object.keys(m.P) as (keyof typeof m.P)[]) expect(m.PALETTE[m.P[name]].name).toBe(name);
  });
  it('packs linear colour, roughness and emission for the GPU', () => {
    const d = m.paletteData();
    expect(d.length).toBe(256 * 8);
    const mud = m.P.MUD * 8;
    expect(d[mud]).toBeCloseTo(Math.pow(112 / 255, 2.2), 6);
    expect(d[mud + 7]).toBe(m.K.MUD);
    const glow = m.P.LANTERN_GLOW * 8;
    expect(d[glow + 4]).toBeCloseTo(6 * Math.pow(255 / 255, 2.2), 5);
    expect(d[m.P.MUD * 8 + 4]).toBe(0);
  });
});
