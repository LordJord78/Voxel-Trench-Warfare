import { describe, expect, it } from 'vitest';
import { hash32 } from '../../src/core/hash';
import { hypot } from '../../src/core/dmath';
import { loadTunables } from '../../src/core/tunables';
import { decodeShell, encodeShell } from '../../src/net/protocol';
import { MAP_SEEDS } from '../../src/net/room-core';
import { SHELL_FIELDS } from '../../src/net/shell-fields';
import { SHELLING, Shelling, shellingSeed, type ScheduledShell, type ShellField } from '../../src/net/shelling';

// The room's shelling (the shared-battle spec's "The shelling"): a schedule the room draws over its
// map's pinned field, the same shells however its time is asked for, none near either side's start.

const MAPS = ['ravine', 'corridor'] as const;

/** Whole milliseconds between landings, the first from 0: the schedule's own unit, free of float error. */
function gapsMs(shells: readonly ScheduledShell[]): number[] {
  const ms = shells.map((s) => Math.round(s.landS * 1000));
  return ms.map((t, i) => t - (i === 0 ? 0 : ms[i - 1]));
}

function onLine(s: ScheduledShell, l: ShellField['lines'][number]): boolean {
  return Math.abs(s.at[1] - l.z) <= 4 + 1e-9 && s.at[0] >= l.x0 && s.at[0] <= l.x1;
}

describe("the room's shelling", () => {
  it('lands one shell every 6–10 s on light and every 2.5–4 s on heavy, the first a gap in, and none when off', () => {
    const field = SHELL_FIELDS.ravine;
    for (const [intensity, lo, hi] of [['light', 6, 10], ['heavy', 2.5, 4]] as const) {
      const shells = new Shelling(field, 1234, intensity).between(0, 1800);
      expect(shells.length, intensity).toBeGreaterThanOrEqual(Math.floor(1800 / hi) - 1);
      expect(shells.length, intensity).toBeLessThanOrEqual(Math.ceil(1800 / lo));
      for (const g of gapsMs(shells)) {
        expect(g, intensity).toBeGreaterThanOrEqual(lo * 1000);
        expect(g, intensity).toBeLessThanOrEqual(hi * 1000);
      }
      // Numbered 1, 2, 3… in the order they land.
      expect(shells.map((s) => s.id)).toEqual(shells.map((_, i) => i + 1));
    }
    expect(new Shelling(field, 1234, 'off').between(0, 1800)).toEqual([]);
  });

  it('is the same shells however its time is asked for, and from the same seed; another seed gives others', () => {
    const field = SHELL_FIELDS.ravine;
    const whole = new Shelling(field, 99, 'heavy').between(0, 600);
    expect(whole.length).toBeGreaterThan(100);
    const pieces = new Shelling(field, 99, 'heavy');
    expect([...pieces.between(0, 7.3), ...pieces.between(7.3, 100), ...pieces.between(100, 600)]).toEqual(whole);
    // Asked again, and asked backwards: kept, not drawn anew.
    expect(pieces.between(0, 600)).toEqual(whole);
    const backwards = new Shelling(field, 99, 'heavy');
    expect([...backwards.between(100, 600), ...backwards.between(0, 100)].sort((a, b) => a.id - b.id)).toEqual(whole);
    expect(new Shelling(field, 99, 'heavy').between(0, 600)).toEqual(whole);
    expect(new Shelling(field, 100, 'heavy').between(0, 600)).not.toEqual(whole);
    // Numbered on from a first id: the same shells, the ids moved.
    const later = new Shelling(field, 99, 'heavy', 40).between(0, 600);
    expect(later).toEqual(whole.map((s) => ({ ...s, id: s.id + 39 })));
  });

  it("seeds each match from its start on the room's clock and its map's seed", () => {
    const startAt = 1_762_600_000_123;
    expect(shellingSeed(startAt, 7)).toBe(hash32(7, Math.floor(startAt / 4294967296), startAt >>> 0));
    expect(shellingSeed(startAt, 11)).not.toBe(shellingSeed(startAt, 7));
    expect(shellingSeed(startAt + 1, 7)).not.toBe(shellingSeed(startAt, 7));
    // The high word counts: two starts 2^32 ms apart are not the same match.
    expect(shellingSeed(startAt + 4294967296, 7)).not.toBe(shellingSeed(startAt, 7));
  });

  it("never lands within 15 m of either side's start, on either map", () => {
    expect(SHELLING.spawnClearM).toBe(15);
    for (const map of MAPS) {
      const field = SHELL_FIELDS[map];
      expect(field.spawns, map).toHaveLength(8);
      const shells = new Shelling(field, 5, 'heavy').between(0, 3600);
      let near = 0;
      for (const s of shells) {
        const d = Math.min(...field.spawns.map(([x, z]) => hypot(s.at[0] - x, s.at[1] - z)));
        expect(d, `${map} shell ${s.id} at ${s.at}`).toBeGreaterThanOrEqual(SHELLING.spawnClearM);
        if (d < 25) near++;
      }
      // Not clear by luck: the lines run through the starts, and shells land just outside them.
      expect(near, map).toBeGreaterThan(0);
    }
  });

  it("lands on both sides' front and support lines and in no man's land, about half there", () => {
    for (const map of MAPS) {
      const field = SHELL_FIELDS[map];
      expect(field.lines, map).toHaveLength(4);
      const shells = new Shelling(field, 21, 'heavy').between(0, 3600);
      const inNml = (s: ScheduledShell) => s.at[1] >= field.nml[0] && s.at[1] <= field.nml[1];
      for (const s of shells) {
        expect(s.at[0] >= 0 && s.at[0] < field.size[0] && s.at[1] >= 0 && s.at[1] < field.size[1], `${map} ${s.at}`).toBe(true);
        expect(inNml(s) || field.lines.some((l) => onLine(s, l)), `${map} ${s.at}`).toBe(true);
      }
      for (const l of field.lines) expect(shells.filter((s) => onLine(s, l)).length / shells.length, `${map} line at z ${l.z}`).toBeGreaterThanOrEqual(0.05);
      const share = shells.filter(inNml).length / shells.length;
      expect(share, map).toBeGreaterThanOrEqual(0.4);
      expect(share, map).toBeLessThanOrEqual(0.6);
    }
  });

  it("draws radii in 2.2–3.4 m, and its numbers are the wire's", () => {
    const shells = new Shelling(SHELL_FIELDS.corridor, 3, 'heavy').between(0, 600);
    const radii = shells.map((s) => s.radius);
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(2.2);
    expect(Math.max(...radii)).toBeLessThanOrEqual(3.4);
    // Spread across the range, not bunched.
    expect(Math.min(...radii)).toBeLessThan(2.4);
    expect(Math.max(...radii)).toBeGreaterThan(3.2);
    const mm = (m: number) => Math.round(m * 1000) / 1000;
    for (const s of shells) {
      expect([mm(s.landS), mm(s.at[0]), mm(s.at[1]), mm(s.radius)]).toEqual([s.landS, s.at[0], s.at[1], s.radius]);
      expect(Number.isInteger(s.seed) && s.seed >= 0 && s.seed < 4294967296).toBe(true);
      const wire = encodeShell(s, 1e12);
      expect(wire.every(Number.isInteger)).toBe(true);
      expect(decodeShell(wire)).toEqual({ id: s.id, landAt: 1e12 + s.landS * 1000, at: s.at, radius: s.radius, seed: s.seed });
    }
  });

  it("holds [room_battle]'s numbers", () => {
    const tun = loadTunables();
    const keys: Record<keyof typeof SHELLING, string> = {
      lightGapS: 'light_gap_s',
      heavyGapS: 'heavy_gap_s',
      leadS: 'lead_s',
      radiusM: 'radius_m',
      spawnClearM: 'spawn_clear_m',
      nmlShare: 'nml_share',
      lineSpreadM: 'line_spread_m',
      nmlInsetM: 'nml_inset_m',
      tries: 'tries',
    };
    expect(Object.keys(SHELLING).sort()).toEqual(Object.keys(keys).sort());
    for (const [name, key] of Object.entries(keys)) expect(SHELLING[name as keyof typeof SHELLING], key).toEqual(tun.get(`room_battle.${key}`));
  });

  it('has a field for every map the room plays', () => {
    expect(Object.keys(SHELL_FIELDS).sort()).toEqual(Object.keys(MAP_SEEDS).sort());
  });
});
