/**
 * The room's shelling (the shared-battle spec's "The shelling"): when and where each shell lands in
 * a match, drawn by the room over its map's pinned field (shell-fields.ts) from the match's seed, so
 * every client is told the same shells and none decides its own.
 *
 * - A shell lands a gap after the last, drawn in the intensity's range: 6–10 s on light, 2.5–4 s on
 *   heavy; none when off.
 * - About half land in no man's land, the rest on a front or support line of either side, within a
 *   few metres of it; none within `spawnClearM` of either side's start.
 * - Its time is kept to the millisecond and its place and radius to the millimetre, so the wire
 *   (protocol.ts encodeShell) carries them exactly.
 *
 * Shells are drawn lazily, in one order from one stream, and kept: `between` is a filter over
 * them, so the room makes the same shells however its time is asked for.
 *
 * Pure and small, because the room imports it: nothing here reaches the tunables. `SHELLING` is
 * the room's copy of `[room_battle]`, held to it by tests/net/shelling.test.ts.
 */

import { hash32 } from '../core/hash';
import { hypot } from '../core/dmath';
import { Rng } from '../core/rng';
import type { Intensity } from './protocol';

/** `[room_battle]`'s numbers, copied for the relay, which cannot read data/tunables.toml. */
export const SHELLING = {
  lightGapS: [6, 10],
  heavyGapS: [2.5, 4],
  /** A shell is told this long before it lands: its whistle. */
  leadS: 1.5,
  radiusM: [2.2, 3.4],
  spawnClearM: 15,
  /** The share drawn in no man's land; the rest on a line. */
  nmlShare: 0.5,
  /** A line's shell lands this far either side of its trench. */
  lineSpreadM: 4,
  /** No man's land is the ground between the two front lines, this far in from each. */
  nmlInsetM: 8,
  /** Places tried for a shell before its slot sends nothing. */
  tries: 8,
} as const;

/**
 * Where a map's shells may land, in metres: its size, the front and support lines of both sides
 * (each across x at its z), no man's land (a band of z), and both teams' starts as (x, z), Red's then Blue's.
 */
export interface ShellField {
  size: [number, number];
  lines: { z: number; x0: number; x1: number }[];
  nml: [number, number];
  spawns: [number, number][];
}

/** A shell in the room's schedule: its id, when it lands (match seconds), where ([x, z], metres), how big, and the seed its crater is cut with. Not combat/artillery.ts's `Shell`. */
export interface ScheduledShell {
  id: number;
  landS: number;
  at: [number, number];
  radius: number;
  seed: number;
}

/** A match's shelling seed: its map's seed and its start on the room's clock (ms, both words). */
export function shellingSeed(startAt: number, mapSeed: number): number {
  return hash32(mapSeed, Math.floor(startAt / 4294967296), startAt >>> 0);
}

const mm = (m: number) => Math.round(m * 1000) / 1000;

export class Shelling {
  private readonly rng: Rng;
  private readonly gap: readonly [number, number] | null;
  private readonly made: ScheduledShell[] = [];
  /** The last slot's time, in whole milliseconds of the match. */
  private slotMs = 0;
  private nextId: number;

  constructor(
    private readonly field: ShellField,
    seed: number,
    intensity: Intensity,
    firstId = 1,
  ) {
    this.rng = Rng.root(seed).derive('shelling');
    this.gap = intensity === 'heavy' ? SHELLING.heavyGapS : intensity === 'light' ? SHELLING.lightGapS : null;
    this.nextId = firstId;
  }

  /** The shells landing after `fromS` and by `toS` (match seconds), in the order they land. */
  between(fromS: number, toS: number): ScheduledShell[] {
    if (!this.gap) return [];
    while (this.slotMs / 1000 <= toS) this.slot(this.gap);
    return this.made.filter((s) => fromS < s.landS && s.landS <= toS);
  }

  /** The next slot: a gap on, then a shell if any of its tries finds a place clear of the starts. */
  private slot([lo, hi]: readonly [number, number]): void {
    const r = this.rng;
    this.slotMs += Math.round(r.uniform(lo, hi) * 1000);
    const at = this.place();
    if (!at) return;
    const radius = mm(r.uniform(SHELLING.radiusM[0], SHELLING.radiusM[1]));
    this.made.push({ id: this.nextId++, landS: this.slotMs / 1000, at, radius, seed: r.nextU32() });
  }

  private place(): [number, number] | null {
    const r = this.rng;
    const { size, lines, nml, spawns } = this.field;
    for (let k = 0; k < SHELLING.tries; k++) {
      let x: number;
      let z: number;
      if (r.float() < SHELLING.nmlShare || lines.length === 0) {
        x = r.uniform(0, size[0]);
        z = r.uniform(nml[0], nml[1]);
      } else {
        const line = lines[r.randint(0, lines.length)];
        x = r.uniform(line.x0, line.x1);
        z = r.uniform(line.z - SHELLING.lineSpreadM, line.z + SHELLING.lineSpreadM);
      }
      // Rounded, never onto the map's far edge: the world is [0, size).
      const at: [number, number] = [Math.min(mm(x), mm(size[0] - 0.001)), mm(z)];
      if (spawns.every(([sx, sz]) => hypot(at[0] - sx, at[1] - sz) >= SHELLING.spawnClearM)) return at;
    }
    return null;
  }
}
