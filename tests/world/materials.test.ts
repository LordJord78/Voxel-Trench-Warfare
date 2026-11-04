import { describe, expect, it } from 'vitest';
import { BrickMap } from '../../src/world/bricks';
import { chip } from '../../src/world/destruction';
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
  it('the range adds three palette entries after the guns', () => {
    expect([m.P.TARGET_STEEL, m.P.TARGET_STEEL_HIT, m.P.TAPE_RANGE]).toEqual([80, 81, 82]);
    // The plates' steel, painted and splashed, is hull, so a round sparks off it; the dummies' tape
    // is cloth, lit a little as the teams' tapes are so it reads at night.
    expect([m.P.TARGET_STEEL, m.P.TARGET_STEEL_HIT].map((p) => m.kindOf(p))).toEqual([m.K.HULL, m.K.HULL]);
    expect(m.kindOf(m.P.TAPE_RANGE)).toBe(m.K.CLOTH);
    expect(m.PALETTE[m.P.TAPE_RANGE].emission).toBe(m.PALETTE[m.P.TAPE_RED].emission);
  });
  it("blood adds eight shades after the range's, each of the kind it marks; sod and mud take BLOOD_SOIL, clay, subsoil and spoil their own", () => {
    const blood = [
      m.P.BLOOD_SOIL, m.P.BLOOD_TIMBER, m.P.BLOOD_SANDBAG, m.P.BLOOD_DUCKBOARD, m.P.BLOOD_CLOTH,
      m.P.BLOOD_CLAY, m.P.BLOOD_SUBSOIL, m.P.BLOOD_SPOIL,
    ];
    // Appended in order, so no id before them moves.
    expect(blood[0]).toBeGreaterThan(m.P.TAPE_RANGE);
    expect(blood).toEqual(blood.map((_, i) => blood[0] + i));
    expect(blood.map((p) => m.PALETTE[p].srgb)).toEqual([
      [70, 22, 18], [72, 20, 16], [84, 26, 20], [70, 22, 16], [80, 16, 16], [86, 30, 22], [78, 26, 20], [72, 22, 17],
    ]);
    // Soil's is mud's: a carve or a round leaves it spoil, as it does the soil it marked.
    expect(blood.map((p) => m.kindOf(p))).toEqual([m.K.MUD, m.K.TIMBER, m.K.SANDBAG, m.K.DUCKBOARD, m.K.CLOTH, m.K.CLAY, m.K.SUBSOIL, m.K.SPOIL]);
    for (const p of blood) {
      const name = m.PALETTE[p].name;
      // Lit as what they mark: their kind's roughness, and no glow.
      expect(m.PALETTE[p].roughness, name).toBe(m.PALETTE[m.baseOf(m.kindOf(p))].roughness);
      expect(m.PALETTE[p].emission, name).toBe(0);
      // Never a kind's plain shade, so what a carve leaves (spoilOf) is never blood.
      expect(m.baseOf(m.kindOf(p)), name).not.toBe(p);
    }
    // Sod's rules are mud's.
    const takes: Partial<Record<number, number>> = {
      [m.K.SOD]: m.P.BLOOD_SOIL, [m.K.MUD]: m.P.BLOOD_SOIL, [m.K.CLAY]: m.P.BLOOD_CLAY, [m.K.SUBSOIL]: m.P.BLOOD_SUBSOIL, [m.K.SPOIL]: m.P.BLOOD_SPOIL,
      [m.K.TIMBER]: m.P.BLOOD_TIMBER, [m.K.SANDBAG]: m.P.BLOOD_SANDBAG, [m.K.DUCKBOARD]: m.P.BLOOD_DUCKBOARD, [m.K.CLOTH]: m.P.BLOOD_CLOTH,
    };
    for (let k = 0; k < m.KIND_COUNT; k++) expect(m.BLOOD_OF(k), `kind ${k}`).toBe(takes[k] ?? null);
    expect([m.P.BLOOD_SOIL, m.P.BLOOD_CLAY, m.P.BLOOD_SUBSOIL, m.P.BLOOD_SPOIL].map((p) => m.spoilOf(p))).toEqual([m.P.SPOIL, m.P.SPOIL, m.P.SPOIL, m.P.SPOIL]);
  });
  it('every blood shade keeps the rules of each kind that takes it: solid, opaque, sight, granular, loose, hardness, what a carve leaves, and roughness', () => {
    // What the world's rules read of a voxel: the shovel and a collapse move what is loose
    // (combat/entrenching.ts, world/destruction.ts), a round chips by hardness to its spoil. In a
    // match each client spatters its own hits, so a world spattered otherwise must differ only in
    // colour (the shots spec's §4), and M6 may count every blood shade as cosmetic.
    const rules = (k: number) => [m.KIND_SOLID[k], m.KIND_OPAQUE[k], m.KIND_BLOCKS_SIGHT[k], m.KIND_GRANULAR[k], m.KIND_LOOSE[k], m.KIND_HARDNESS[k], m.KIND_SPOIL[k]];
    const taken: number[] = [];
    for (let k = 0; k < m.KIND_COUNT; k++) {
      const blood = m.BLOOD_OF(k);
      if (blood === null) continue;
      taken.push(k);
      const clean = m.baseOf(k);
      const name = m.PALETTE[clean].name;
      expect(rules(m.kindOf(blood)), name).toEqual(rules(k));
      expect(m.hardness(blood), name).toBe(m.hardness(clean));
      // A round's mark leaves what it would have left of the clean voxel, or leaves both alone.
      expect(m.spoilOf(blood), name).toBe(m.spoilOf(clean));
      expect(m.kindOf(m.spoilOf(blood)) === m.kindOf(blood), name).toBe(m.kindOf(m.spoilOf(clean)) === k);
      // Lit as the voxel it marked.
      expect(m.PALETTE[blood].roughness, name).toBe(m.PALETTE[clean].roughness);
    }
    // With no exception: every earth, and timber, sandbags, duckboards and cloth.
    expect(taken).toEqual([m.K.SOD, m.K.MUD, m.K.CLAY, m.K.SUBSOIL, m.K.SPOIL, m.K.SANDBAG, m.K.DUCKBOARD, m.K.TIMBER, m.K.CLOTH]);
  });
  it('a round does not chip target steel', () => {
    for (const p of [m.P.TARGET_STEEL, m.P.TARGET_STEEL_HIT]) {
      const map = new BrickMap({ x: 32, y: 32, z: 32 });
      map.set(4, 4, 4, p);
      map.takeDirty();
      expect(chip(map, 4, 4, 4, 1e6, 260), m.PALETTE[p]?.name).toBe(false);
      expect(map.get(4, 4, 4)).toBe(p);
      expect(map.takeDirty()).toEqual([]);
      expect(m.spoilOf(p)).toBe(p);
    }
  });
});
