/**
 * The session's craters, cut off the main thread (the spec's §3): each shell's
 * region is copied out (world/region-copy.ts) and posted to a runner — the
 * destruction worker in play, in-process in tests, the same job either way
 * (world/detonation.ts) — which hands back the bricks it changed. Those are
 * written into the world `bricks_per_tick` a tick, oldest crater first, so a
 * crater costs a frame about a millisecond however large it is.
 *
 * A region is out from its copy to its last brick's return. A round's mark
 * inside one is held, and made again once its bricks are back, so the
 * write-back cannot undo it. A shell whose region overlaps one that is out
 * waits for it, and so does every shell behind it: they are served in order,
 * each copied from the world as the last left it. A job that asks for a wider
 * region is copied again, wider, and posted again; if the wider one overlaps
 * another that is out, it goes back to wait its turn, its held marks made now.
 * With no tick nothing is written: a crater out while paused lands after.
 */

import type { Tunables } from '../core/tunables';
import type { BrickMap } from '../world/bricks';
import { chip, type DetonateOptions } from '../world/destruction';
import { detonationRegion, runDetonation, type DetonationRequest, type DetonationResult } from '../world/detonation';
import type { Box } from '../world/region';
import { applyPatch, copyRegion, type BrickPatch } from '../world/region-copy';

/** Where a crater's job runs: post it, and take what has come back since. */
export interface DetonationRunner {
  post(req: DetonationRequest): void;
  take(): DetonationResult[];
}

/** The job run at once, in-process, its result handed to the next take: in step with the ticks. */
export function inProcessRunner(): DetonationRunner {
  const done: DetonationResult[] = [];
  return {
    post: (req) => done.push(runDetonation(req)),
    take: () => done.splice(0),
  };
}

/** A crater written back into the world: voxels, and how many bricks it changed. */
export interface Crater {
  id: number;
  centre: [number, number, number];
  radius: number;
  bricks: number;
}

export interface DestructionTunables {
  options: DetonateOptions;
  bricksPerTick: number;
}

/** `[destruction]`'s, with the world's water table in voxels. */
export function destructionTunables(tun: Tunables, waterTable: number): DestructionTunables {
  return {
    options: {
      hardLimit: tun.f('destruction.resists_above_hardness'),
      core: tun.f('destruction.core_radius_scale'),
      loosen: tun.f('destruction.loosen_radius_scale'),
      waterTable,
    },
    bricksPerTick: tun.i('destruction.bricks_per_tick'),
  };
}

interface Mark {
  x: number;
  y: number;
  z: number;
  energyJ: number;
  chipEnergyJ: number;
}

interface Job {
  id: number;
  centre: [number, number, number];
  radius: number;
  seed: number;
  box: Box;
  state: 'queued' | 'out' | 'landing';
  patches: BrickPatch[];
  applied: number;
  held: Mark[];
}

const inside = (b: Box, x: number, y: number, z: number) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 && z >= b.z0 && z < b.z1;
const overlap = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

export class Destruction {
  /** Queued, out or landing, in the order they were shelled. */
  private readonly jobs: Job[] = [];
  /** Bricks the last tick wrote into the world. */
  written = 0;
  private nextId = 1;

  constructor(
    readonly map: BrickMap,
    private readonly runner: DetonationRunner,
    readonly t: DestructionTunables,
  ) {}

  /** Shells queued or out. */
  get pending(): number {
    return this.jobs.length;
  }

  /** The regions out now. */
  get out(): readonly Box[] {
    return this.jobs.filter((j) => j.state !== 'queued').map((j) => j.box);
  }

  /** A shell of `radius` at `centre` (voxels), its crater cut with `seed`: queued, and its id. One off the map cuts nothing. */
  shell(centre: readonly [number, number, number], radius: number, seed: number): number {
    const id = this.nextId++;
    const box = detonationRegion(this.map.dims, centre, radius, this.t.options.loosen);
    if (box) this.jobs.push({ id, centre: [centre[0], centre[1], centre[2]], radius, seed, box, state: 'queued', patches: [], applied: 0, held: [] });
    return id;
  }

  /** A round's mark (world/destruction.ts `chip`): made now, or held while a region it is in is out. */
  mark(x: number, y: number, z: number, energyJ: number, chipEnergyJ: number): boolean | 'held' {
    for (const j of this.jobs) {
      if (j.state === 'queued' || !inside(j.box, x, y, z)) continue;
      j.held.push({ x, y, z, energyJ, chipEnergyJ });
      return 'held';
    }
    return chip(this.map, x, y, z, energyJ, chipEnergyJ);
  }

  /** One tick: what has come back, the write-back's budget of it, and the shells now free to go out; the craters that landed. */
  tick(): Crater[] {
    for (const r of this.runner.take()) {
      const j = this.jobs.find((o) => o.id === r.id);
      if (!j || j.state !== 'out') continue;
      if ('wider' in r) {
        j.box = r.wider;
        if (this.jobs.some((o) => o !== j && o.state !== 'queued' && overlap(o.box, j.box))) {
          j.state = 'queued';
          this.makeHeld(j);
        } else this.post(j);
        continue;
      }
      j.patches = r.patches;
      j.state = 'landing';
    }
    const landed: Crater[] = [];
    let budget = this.t.bricksPerTick;
    this.written = 0;
    for (const j of this.jobs) {
      if (j.state !== 'landing') continue;
      while (budget > 0 && j.applied < j.patches.length) {
        applyPatch(this.map, j.patches[j.applied++]);
        budget--;
        this.written++;
      }
      if (j.applied < j.patches.length) break;
      this.makeHeld(j);
      landed.push({ id: j.id, centre: j.centre, radius: j.radius, bricks: j.patches.length });
    }
    for (const c of landed) this.jobs.splice(this.jobs.findIndex((j) => j.id === c.id), 1);
    // In order: the first that would overlap a region out waits, and every one behind it.
    for (const j of this.jobs) {
      if (j.state !== 'queued') continue;
      if (this.jobs.some((o) => o !== j && o.state !== 'queued' && overlap(o.box, j.box))) break;
      this.post(j);
    }
    return landed;
  }

  private post(j: Job): void {
    j.state = 'out';
    this.runner.post({ id: j.id, centre: j.centre, radius: j.radius, seed: j.seed, options: this.t.options, copy: copyRegion(this.map, j.box), world: this.map.dims });
  }

  private makeHeld(j: Job): void {
    for (const m of j.held.splice(0)) chip(this.map, m.x, m.y, m.z, m.energyJ, m.chipEnergyJ);
  }
}
