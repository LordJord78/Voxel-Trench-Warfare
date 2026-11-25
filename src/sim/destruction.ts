/**
 * The session's craters, cut off the main thread (the spec's §3): each shell's
 * region is copied out (world/region-copy.ts) and posted to a runner — the
 * destruction worker in play, in-process in tests, the same job either way
 * (world/detonation.ts) — which hands back the bricks it changed: its cut as
 * soon as it is made, then everything settled. Those are written into the
 * world `bricks_per_tick` a tick, oldest crater first, so a crater costs a
 * frame about a millisecond however large it is, and its cut is in the world
 * within a few ticks of the shell, its slump when it has settled.
 *
 * A region is out from its copy to its settled bricks' return. A round's mark
 * inside one is held, and made again once its bricks are back, so the
 * write-back cannot undo it. A shell whose region overlaps one that is out
 * waits for it, and so does every shell behind it: they are served in order,
 * each copied from the world as the last left it. A job that asks for a wider
 * region is copied again, wider, and posted again; if the wider one overlaps
 * another that is out, it goes back to wait its turn, its held marks made now.
 * With no tick nothing is written: a crater out while paused lands after.
 *
 * A shell on the ground (in a room) is cut where the ground is when its job goes out, not where it
 * was when it landed: by then every earlier crater that overlaps it is in, so every client cuts it
 * from the same ground however late its worker hands craters back, and says what it struck there.
 *
 * In a room, a shell also waits to go out while `waits` holds it: another's scoop that came before
 * it, still to be dug over its region (sim/room-battle.ts), so its crater is copied with that scoop
 * in, as its digger's was. Until it goes out a shell has copied nothing, so ground it alone has
 * queued is pending only to what comes after it (`overlapsPendingBy`).
 *
 * A catch-up on the room's log may have a shell's crater cut ahead of its turn (`ahead`), on a copy
 * of its region as the world is then, while the craters before it are still being cut. That job is
 * no shell of the session's: nothing waits for it, and nothing of it is written. When the shell's own
 * job goes out, it takes the work over only if it would have been given the same: the same centre,
 * radius and seed, and its region the same voxel for voxel, so the same ground top and material (the
 * job is a function of what it is given: world/detonation.ts). Anything written there in between (a
 * crater, a scoop, a char) and the work is dropped, and the job is cut afresh. So the craters go in
 * as they would have, in their order, each from the ground it would have been cut from; only sooner.
 */

import type { Tunables } from '../core/tunables';
import type { BrickMap } from '../world/bricks';
import { chip, type DetonateOptions } from '../world/destruction';
import { detonationRegion, runDetonation, type DetonationRequest, type DetonationResult } from '../world/detonation';
import { P } from '../world/materials';
import { groundTop } from '../world/raycast';
import { overlapXZ, type Box } from '../world/region';
import { applyPatch, copyRegion, sameCopy, type BrickPatch, type RegionCopy } from '../world/region-copy';

/** Where a crater's job runs: post it, and take what has come back since. */
export interface DetonationRunner {
  post(req: DetonationRequest): void;
  take(): DetonationResult[];
}

/** The job run at once, in-process, its cut and its settled crater handed to the next take: in step with the ticks. */
export function inProcessRunner(): DetonationRunner {
  const done: DetonationResult[] = [];
  return {
    post: (req) => done.push(runDetonation(req, (cut) => done.push(cut))),
    take: () => done.splice(0),
  };
}

/** A crater written back into the world: voxels, and how many bricks it changed. */
export interface Crater {
  id: number;
  centre: [number, number, number];
  radius: number;
  bricks: number;
  /** A crater on the ground's: the voxel under its centre when it went out. */
  material?: number;
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
  /** Centred on the top of the ground when it goes out; and the voxel under it then, once it has. */
  onGround: boolean;
  material?: number;
  /** Queued; out (posted, its settled bricks not yet back); or landing (they are). */
  state: 'queued' | 'out' | 'landing';
  /** Its bricks as they came back, cut then settled, and how many are written. */
  patches: BrickPatch[];
  applied: number;
  /** Where its cut's bricks end in `patches`, once its cut has come back; and whether they are all in. */
  cutEnd: number | null;
  cutIn: boolean;
  held: Mark[];
}

/**
 * A crater's job sent ahead of its turn (`ahead`): what it was given, its copy kept to be checked
 * against the world's when its shell's own job goes out, what has come back of it meanwhile, and the
 * job that took it over.
 */
interface Ahead {
  centre: [number, number, number];
  radius: number;
  seed: number;
  box: Box;
  material: number;
  /** As it was sent; none once a shell's job has taken the work over. */
  copy: RegionCopy | null;
  back: DetonationResult[];
  job: Job | null;
}

/** A job's crater, `bricks` written: what it struck, if it was cut on the ground. */
const crater = (j: Job, bricks: number): Crater => ({ id: j.id, centre: j.centre, radius: j.radius, bricks, ...(j.material === undefined ? {} : { material: j.material }) });
const inside = (b: Box, x: number, y: number, z: number) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 && z >= b.z0 && z < b.z1;

export class Destruction {
  /** Queued, out or landing, in the order they were shelled. */
  private readonly jobs: Job[] = [];
  /** Bricks the last tick wrote into the world. */
  written = 0;
  /**
   * Whether shell `id`'s job, over `box`, waits to go out: in a room, while a scoop before it is still
   * to be dug there (sim/room-battle.ts). Like a region out, it holds every shell behind it too.
   */
  waits: (id: number, box: Box) => boolean = () => false;
  /** The craters whose cuts the last tick finished writing (their settling still to come). */
  cuts: Crater[] = [];
  /** Of the jobs sent ahead (`ahead`): those whose shell's own job took the work over, and those dropped, the world changed under them. */
  aheadTaken = 0;
  aheadDropped = 0;
  private nextId = 1;
  /** The jobs sent ahead and not yet done with, by their runner ids (−1, −2, …: never a shell's). */
  private readonly aheads = new Map<number, Ahead>();
  private nextAhead = -1;
  /** What came back of a job sent ahead before its shell's own job took it over: taken by the next tick, as that job's. */
  private early: DetonationResult[] = [];

  constructor(
    readonly map: BrickMap,
    private readonly runner: DetonationRunner,
    readonly t: DestructionTunables,
  ) {}

  /** Shells queued or out. */
  get pending(): number {
    return this.jobs.length;
  }

  /** The id the last shell was given (0 before any): every shell after it has a greater one. */
  get lastId(): number {
    return this.nextId - 1;
  }

  /**
   * The oldest shell still pending, and how it stands: queued, out or landing; null with none. Every
   * shell after it goes out behind it or beside it, so a wait that never ends is its.
   */
  get oldest(): { id: number; state: 'queued' | 'out' | 'landing' } | null {
    const j = this.jobs[0];
    return j ? { id: j.id, state: j.state } : null;
  }

  /** The regions out now. */
  get out(): readonly Box[] {
    return this.jobs.filter((j) => j.state !== 'queued').map((j) => j.box);
  }

  /** Whether `box` reaches into a region out now: an edit there would be undone when its bricks come back. */
  overlapsOut(box: Box): boolean {
    return this.jobs.some((j) => j.state !== 'queued' && overlapXZ(j.box, box));
  }

  /** Whether `box` reaches into the region of a shell queued, out or landing: ground a crater is still to be cut from. */
  overlapsPending(box: Box): boolean {
    return this.jobs.some((j) => overlapXZ(j.box, box));
  }

  /**
   * Whether `box` reaches into the region of a shell pending to an edit that comes after shell `upTo`:
   * one of id `upTo` or less, queued, out or landing; or a later one out or landing, whose bricks
   * would come back over the edit. A later one still queued has copied nothing yet (and `waits` keeps
   * it so, while the edit is held there).
   */
  overlapsPendingBy(box: Box, upTo: number): boolean {
    return this.jobs.some((j) => (j.id <= upTo || j.state !== 'queued') && overlapXZ(j.box, box));
  }

  /**
   * A shell of `radius` at `centre` (voxels), its crater cut with `seed`: queued, and its id. One off
   * the map cuts nothing. `onGround`: its centre's y is the top of the ground there when it goes out
   * (whatever `centre` says), and its crater says what it struck (`material`).
   */
  shell(centre: readonly [number, number, number], radius: number, seed: number, onGround = false): number {
    const id = this.nextId++;
    const box = detonationRegion(this.map.dims, centre, radius, this.t.options.loosen);
    if (box) this.jobs.push({ id, centre: [centre[0], centre[1], centre[2]], radius, seed, box, onGround, state: 'queued', patches: [], applied: 0, cutEnd: null, cutIn: false, held: [] });
    return id;
  }

  /**
   * A shell on the ground of `radius` at `centre` (voxels) and `seed`, as `shell(..., true)` will be
   * given it, its crater cut ahead of its turn: posted now, on a copy of its region as the world is
   * now, centred on the ground's top there now. Nothing waits for it and nothing of it is written:
   * its shell's own job takes the work over when it goes out, if the world there is still as it was
   * (`post`). One off the map sends nothing.
   */
  ahead(centre: readonly [number, number, number], radius: number, seed: number): void {
    const box = detonationRegion(this.map.dims, centre, radius, this.t.options.loosen);
    if (!box) return;
    const at: [number, number, number] = [centre[0], centre[1], centre[2]];
    const material = this.groundUnder(at);
    const copy = copyRegion(this.map, box);
    const id = this.nextAhead--;
    // Kept as it was sent: the runner may take the copy's buffers.
    this.aheads.set(id, { centre: [at[0], at[1], at[2]], radius, seed, box, material, copy: { ...copy, entries: copy.entries.slice(), dense: copy.dense.slice() }, back: [], job: null });
    this.runner.post({ id, centre: at, radius, seed, options: this.t.options, copy, world: this.map.dims });
  }

  /** The jobs sent ahead that no shell's job has taken over dropped, whatever comes back of them: a catch-up done with them. */
  dropAhead(): void {
    for (const [id, a] of this.aheads) if (!a.job) this.aheads.delete(id);
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

  /** One tick: what has come back, the write-back's budget of it, and the shells now free to go out; the craters that settled (their cuts in `cuts`). */
  tick(): Crater[] {
    this.cuts = [];
    for (let r of [...this.early.splice(0), ...this.runner.take()]) {
      if (r.id < 0) {
        // A job sent ahead: kept until a shell's job takes it over, then that job's; dropped, nothing.
        const a = this.aheads.get(r.id);
        if (!a) continue;
        if (!a.job) {
          a.back.push(r);
          continue;
        }
        if (!('stage' in r) || r.stage === 'settled') this.aheads.delete(r.id);
        r = { ...r, id: a.job.id };
      }
      const j = this.jobs.find((o) => o.id === r.id);
      if (!j || j.state !== 'out') continue;
      if ('wider' in r) {
        j.box = r.wider;
        if (this.waits(j.id, j.box) || this.jobs.some((o) => o !== j && o.state !== 'queued' && overlapXZ(o.box, j.box))) {
          j.state = 'queued';
          this.makeHeld(j);
        } else this.post(j);
        continue;
      }
      j.patches.push(...r.patches);
      if (r.stage === 'cut') j.cutEnd ??= j.patches.length;
      else j.state = 'landing';
    }
    const landed: Crater[] = [];
    let budget = this.t.bricksPerTick;
    this.written = 0;
    for (const j of this.jobs) {
      if (j.state === 'queued') continue;
      while (budget > 0 && j.applied < j.patches.length) {
        applyPatch(this.map, j.patches[j.applied++]);
        budget--;
        this.written++;
      }
      if (j.cutEnd !== null && !j.cutIn && j.applied >= j.cutEnd) {
        j.cutIn = true;
        this.cuts.push(crater(j, j.cutEnd));
      }
      if (j.applied < j.patches.length) break;
      if (j.state !== 'landing') continue;
      this.makeHeld(j);
      landed.push(crater(j, j.patches.length - (j.cutEnd ?? 0)));
    }
    for (const c of landed) this.jobs.splice(this.jobs.findIndex((j) => j.id === c.id), 1);
    // In order: the first that would overlap a region out, or that `waits` holds, waits, and every one behind it.
    for (const j of this.jobs) {
      if (j.state !== 'queued') continue;
      if (this.waits(j.id, j.box) || this.jobs.some((o) => o !== j && o.state !== 'queued' && overlapXZ(o.box, j.box))) break;
      this.post(j);
    }
    return landed;
  }

  private post(j: Job): void {
    // On the ground: centred where it is now, the first time it goes out (a wider region asked for
    // is copied again about the same centre). Nothing has written into its region since.
    const first = j.onGround && j.material === undefined;
    if (first) j.material = this.groundUnder(j.centre);
    j.state = 'out';
    const copy = copyRegion(this.map, j.box);
    if (first && this.takeOver(j, copy)) return;
    this.runner.post({ id: j.id, centre: j.centre, radius: j.radius, seed: j.seed, options: this.t.options, copy, world: this.map.dims });
  }

  /** A crater on the ground at `centre`: its y set to the top of the ground there (if any), and the voxel under it, what it strikes. */
  private groundUnder(centre: [number, number, number]): number {
    const top = groundTop(this.map, centre[0], centre[2]);
    if (top !== null) centre[1] = top;
    return top === null ? P.AIR : this.map.get(Math.floor(centre[0]), top - 1, Math.floor(centre[2]));
  }

  /**
   * Job `j`, going out for the first time with `copy`, takes over the work of the job sent ahead for its
   * shell (the same seed, radius and place), if that one was given the same: the same centre, region
   * and material, and a copy the same voxel for voxel. What has come back of it is `j`'s from the next
   * tick, and what comes back after. One given otherwise (the world changed under it) is dropped.
   * Whether `j` has its work.
   */
  private takeOver(j: Job, copy: RegionCopy): boolean {
    for (const [id, a] of this.aheads) {
      if (a.job || a.seed !== j.seed || a.radius !== j.radius || a.centre[0] !== j.centre[0] || a.centre[2] !== j.centre[2]) continue;
      const box = a.box;
      if (a.centre[1] !== j.centre[1] || a.material !== j.material || box.x0 !== j.box.x0 || box.z0 !== j.box.z0 || box.x1 !== j.box.x1 || box.z1 !== j.box.z1 || !sameCopy(a.copy!, copy)) {
        this.aheads.delete(id);
        this.aheadDropped++;
        return false;
      }
      a.job = j;
      a.copy = null;
      this.aheadTaken++;
      this.early.push(...a.back.splice(0));
      return true;
    }
    return false;
  }

  private makeHeld(j: Job): void {
    for (const m of j.held.splice(0)) chip(this.map, m.x, m.y, m.z, m.energyJ, m.chipEnergyJ);
  }
}
