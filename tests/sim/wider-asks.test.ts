import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';
import { MAP_SEEDS } from '../../src/net/room-core';
import { SHELL_FIELDS } from '../../src/net/shell-fields';
import { Shelling, shellingSeed } from '../../src/net/shelling';
import { Destruction, destructionTunables, inProcessRunner, type DetonationRunner } from '../../src/sim/destruction';
import { BrickMap } from '../../src/world/bricks';
import { cutCrater } from '../../src/world/destruction';
import { runDetonation, type DetonationRequest, type DetonationResult } from '../../src/world/detonation';
import { fillBand } from '../../src/world/generation/fill';
import { generateWorld } from '../../src/world/generation/generate';
import { genParams, type MapId } from '../../src/world/generation/params';
import { planWorld } from '../../src/world/generation/plan';
import { K, kindOf } from '../../src/world/materials';
import { groundTop } from '../../src/world/raycast';
import { regionMap, type RegionCopy } from '../../src/world/region-copy';
import { cloneMap, sameWorld } from '../support/worlds';

// A bench, not a test of the suite (some 4 minutes): how often a room's crater asks for a wider region, on
// each map's heavy shelling, and how often such a crater has a tree's trunk in its rim, the one
// material a cut over its own cut changes (sim/destruction.ts `before`). Each map's world generated
// as the room's pages have it; the room's heavy schedule (net/shelling.ts) from one match's start,
// its shells landed in turn as Session.land lands them in a room. Twice: each job's results in one
// take (in-process), and a live page's way (its cut back and written, then the rest), the worlds
// compared at the end. Run with TRENCHLINE_BENCH=1 (and, to narrow it, TRENCHLINE_BENCH_MAP=ravine and
// TRENCHLINE_BENCH_S=260: one map, its first 260 s).
//
//   TRENCHLINE_BENCH=1 npx vitest run tests/sim/wider-asks.test.ts --silent=false

const tun = loadTunables();
/** A match's start on the room's clock (ms): any will do; this one is a November evening's. */
const START_AT = 1_795_000_000_000;
/** Seconds of heavy shelling drawn: some 220 shells, a long match's (or TRENCHLINE_BENCH_S). */
const SPAN_S = Number(process.env.TRENCHLINE_BENCH_S ?? 720);
/** The maps benched: both, or TRENCHLINE_BENCH_MAP's. */
const MAPS = (process.env.TRENCHLINE_BENCH_MAP ? [process.env.TRENCHLINE_BENCH_MAP] : ['ravine', 'corridor']) as MapId[];

/** What a crater's job was asked: its first request (the ground before its cut) and how many wider regions it asked for. */
interface Asked {
  first: DetonationRequest;
  wider: number;
}

/** The trunk voxels in the rim `cutCrater` loosens (spoilOf: a trunk to a branch): from radius to radius × loosen of the centre. */
function trunksInRim(req: DetonationRequest): number {
  const map = regionMap(req.copy);
  const ox = req.copy.origin[0] * 8;
  const oz = req.copy.origin[2] * 8;
  const [cx, cy, cz] = [req.centre[0] - ox, req.centre[1], req.centre[2] - oz];
  const inner = req.radius;
  const outer = req.radius * req.options.loosen;
  let n = 0;
  for (let z = Math.floor(cz - outer); z <= Math.ceil(cz + outer); z++) {
    for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y++) {
      for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
        const d2 = (x + 0.5 - cx) * (x + 0.5 - cx) + (y + 0.5 - cy) * (y + 0.5 - cy) + (z + 0.5 - cz) * (z + 0.5 - cz);
        if (d2 >= inner * inner && d2 < outer * outer && kindOf(map.get(x, y, z)) === K.TRUNK) n++;
      }
    }
  }
  return n;
}

/** Whether cutting the crater again over its own cut changes a voxel: its region cut once, and cut twice. */
function cutTwiceDiffers(req: DetonationRequest): boolean {
  const cut = (copy: RegionCopy, times: number) => {
    const map = regionMap(copy);
    const ox = copy.origin[0] * 8;
    const oz = copy.origin[2] * 8;
    for (let k = 0; k < times; k++) cutCrater(map, req.centre[0] - ox, req.centre[1], req.centre[2] - oz, req.radius, Rng.root(req.seed), req.options);
    return map;
  };
  return !sameWorld(cut(req.copy, 1), cut(req.copy, 2));
}

/** How many voxels two worlds differ by. */
function voxelsDiffering(a: BrickMap, b: BrickMap): number {
  const x = new Uint8Array(512);
  const y = new Uint8Array(512);
  let n = 0;
  for (let bi = 0; bi < a.table.length; bi++) {
    if (a.table[bi] === b.table[bi] && (a.table[bi] === 0 || a.table[bi] & 0x80000000)) continue;
    a.readBrick(bi, x);
    b.readBrick(bi, y);
    for (let i = 0; i < 512; i++) if (x[i] !== y[i]) n++;
  }
  return n;
}

/** A copy's buffers kept: the runner may hand them on. */
const keep = (req: DetonationRequest): DetonationRequest => ({ ...req, copy: { ...req.copy, entries: req.copy.entries.slice(), dense: req.copy.dense.slice() } });

/** Each job's results by the runner it is given, every request and result seen. */
function watched(inner: DetonationRunner, asked: Map<number, Asked>): DetonationRunner {
  return {
    post: (req) => {
      if (!asked.has(req.id)) asked.set(req.id, { first: keep(req), wider: 0 });
      inner.post(req);
    },
    take: () => {
      const out = inner.take();
      for (const r of out) if ('wider' in r) asked.get(r.id)!.wider++;
      return out;
    },
  };
}

/** A live page's worker: each job's cut handed back when released, and its rest (settled, or a wider region) when released once its cut is back. */
function liveRunner(): DetonationRunner & { cuts(): void; rest(): void } {
  const jobs: { cut: DetonationResult | null; rest: DetonationResult; cutBack: boolean }[] = [];
  const done: DetonationResult[] = [];
  return {
    post: (req) => {
      const cut: DetonationResult[] = [];
      const rest = runDetonation(req, (c) => cut.push(c));
      jobs.push({ cut: cut[0] ?? null, rest, cutBack: cut.length === 0 });
    },
    take: () => done.splice(0),
    cuts: () => {
      for (const j of jobs) if (!j.cutBack) {
        done.push(j.cut!);
        j.cutBack = true;
      }
    },
    rest: () => {
      for (let k = 0; k < jobs.length; ) if (jobs[k].cutBack) done.push(jobs.splice(k, 1)[0].rest);
      else k++;
    },
  };
}

describe.skipIf(!process.env.TRENCHLINE_BENCH)('the bench: craters that ask for a wider region, on each map\'s heavy shelling', () => {
  for (const name of MAPS) {
    it(`the ${name}`, async () => {
      const t0 = performance.now();
      const params = genParams(tun, undefined, name);
      const plan = planWorld(params, MAP_SEEDS[name]);
      const base = (await generateWorld(plan, async (bands) => bands.map((b) => fillBand(plan, b)))).map;
      base.takeDirty();
      const genMs = performance.now() - t0;
      const v = params.voxel;
      const shells = new Shelling(SHELL_FIELDS[name], shellingSeed(START_AT, MAP_SEEDS[name]), 'heavy').between(0, SPAN_S);
      expect(shells.length).toBeGreaterThanOrEqual(SPAN_S >= 240 ? 60 : 1);
      const dt = destructionTunables(tun, params.waterTable);

      /** The shells landed in turn, each settled before the next: the world, what each job asked, and the most kept at once (bricks, bytes) with each job's peak. */
      const run = (isLive: boolean) => {
        const map: BrickMap = cloneMap(base);
        const asked = new Map<number, Asked>();
        const lr = liveRunner();
        const d = new Destruction(map, watched(isLive ? lr : inProcessRunner(), asked), dt);
        const peaks: { bricks: number; bytes: number }[] = [];
        const r0 = performance.now();
        for (const s of shells) {
          const top = groundTop(map, s.at[0] / v, s.at[1] / v);
          if (top === null) continue;
          d.shell([s.at[0] / v, top, s.at[1] / v], s.radius / v, s.seed, true);
          const peak = { bricks: 0, bytes: 0 };
          for (let k = 0; k < 400 && d.pending > 0; k++) {
            if (!isLive) {
              d.tick();
              continue;
            }
            // Its cut back and wholly written, as on a page whose settling comes some ten frames later; then the rest.
            lr.cuts();
            d.tick();
            while (d.written > 0) d.tick();
            // (Absent on a Destruction from before Task 8e, which this bench also runs on.)
            const kept = d.kept as { bricks: number; bytes: number } | undefined;
            if (kept && kept.bricks > peak.bricks) Object.assign(peak, kept);
            lr.rest();
            d.tick();
          }
          expect(d.pending).toBe(0);
          peaks.push(peak);
        }
        return { map, asked, peaks, ms: performance.now() - r0 };
      };
      const together = run(false);
      const live = run(true);
      const wider = [...together.asked.values()].filter((a) => a.wider > 0);
      const twice = wider.filter((a) => a.wider > 1);
      const trunked = wider.filter((a) => trunksInRim(a.first) > 0);
      const differs = wider.filter((a) => cutTwiceDiffers(a.first));
      const allTrunked = [...together.asked.values()].filter((a) => trunksInRim(a.first) > 0);
      const liveWider = [...live.asked.values()].filter((a) => a.wider > 0).length;
      const keptBricks = live.peaks.map((p) => p.bricks);
      const differing = sameWorld(together.map, live.map) ? 0 : voxelsDiffering(together.map, live.map);
      const keptBytes = live.peaks.map((p) => p.bytes);
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      console.log(
        `${name}: ${shells.length} shells (${together.asked.size} craters) in ${SPAN_S} s of heavy; ` +
          `${wider.length} asked for a wider region (${twice.length} twice or more; live ${liveWider}), ` +
          `${trunked.length} of them with a trunk in their rim [${trunked.map((a) => `#${a.first.id} ${trunksInRim(a.first)} voxels`).join(', ')}], ` +
          `${differs.length} of them changed by a second cut; of all craters, ${allTrunked.length} with a trunk in their rim. ` +
          `Kept per live job: mean ${mean(keptBricks).toFixed(0)} bricks / ${(mean(keptBytes) / 1024).toFixed(1)} KiB, most ${Math.max(...keptBricks)} bricks / ${(Math.max(...keptBytes) / 1024).toFixed(1)} KiB. ` +
          `World live = in one take: ${differing === 0} (${differing} voxels differ). Generation ${(genMs / 1000).toFixed(1)} s; runs ${(together.ms / 1000).toFixed(1)} s and ${(live.ms / 1000).toFixed(1)} s`,
      );
      expect(sameWorld(together.map, live.map)).toBe(true);
    }, 600_000);
  }
});
