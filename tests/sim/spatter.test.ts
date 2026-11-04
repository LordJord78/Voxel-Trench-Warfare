import { describe, expect, it } from 'vitest';
import { projectileSpec } from '../../src/combat/ballistics';
import { pose, toWorld, type Frame, type PartName } from '../../src/combat/soldier-rig';
import { loadTunables } from '../../src/core/tunables';
import type { DetonationRunner } from '../../src/sim/destruction';
import { idleIntent, LOCAL_BODY, Session, type Body, type CombatEvents } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';
import { spatter, spatterTunables } from '../../src/world/spatter';

// The session's spatter (the shots spec's §4): every headshot into another's body marks what is
// behind it with blood, drawn from the hit's tick and where it struck, as world/spatter.ts does in
// voxels; and the app spatters a kill's (spatterAt). Neither marks inside a crater's region while it
// is out, whose bricks coming back would undo it.
const tun = loadTunables();
const AK = projectileSpec(tun, 'assault_rifle');
const V = 0.1;
const BLOOD = new Set<number>([P.BLOOD_SOIL, P.BLOOD_TIMBER, P.BLOOD_SANDBAG, P.BLOOD_DUCKBOARD, P.BLOOD_CLOTH]);

/**
 * 25.6 × 6.4 × 51.2 m of sod 0.4 m deep, the player at (12.8, 0.4, 5) facing +z, settled; walls of
 * mud across it at z 26.5–27.5 m, 1.5 m behind a target at 25 m, and at z 3–3.5 m, behind the player.
 */
function field(runner?: DetonationRunner): Session {
  const map = new BrickMap({ x: 256, y: 64, z: 512 });
  map.fillBox(0, 0, 0, 256, 4, 512, P.SOD);
  map.fillBox(0, 4, 265, 256, 64, 275, P.MUD);
  map.fillBox(0, 4, 30, 256, 64, 35, P.MUD);
  const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 5] }, ...(runner ? { runner } : {}) }, tun, 7, 0);
  s.intent = idleIntent();
  for (let k = 0; k < 40; k++) s.tick();
  return s;
}

/** A target (200 on) standing on the sod `z` m out, facing back at the player. */
function target(id = 200, x = 12.8, z = 25): Body {
  const feet: [number, number, number] = [x, 0.4, z];
  return { id, feet, frames: pose({ position: feet, yaw: 180, pitch: 0, height: 1.8, speed: 0, bob: 0, deadFor: null }) };
}

/** The player's own body, posed as the session poses it for rounds to strike. */
function own(s: Session): Record<PartName, Frame> {
  const p = s.player;
  return pose({ position: p.position.toArray(), yaw: p.yaw, pitch: p.pitch, height: p.height, speed: 0, bob: p.bobPhase, deadFor: null });
}

/** Rounds of `owner` (the player's, 0, unless told; the AK's), one from each of `from` along unit `dir`, ticked until they strike: what they struck. */
function volley(s: Session, from: readonly (readonly number[])[], dir: readonly number[], owner = 0): CombatEvents['hits'] {
  for (const o of from) s.rounds.fire([o[0], o[1], o[2]], [dir[0] * AK.muzzleVelocity, dir[1] * AK.muzzleVelocity, dir[2] * AK.muzzleVelocity], AK, owner, false);
  for (let k = 0; k < 10; k++) {
    s.tick();
    const { hits } = s.drainEvents();
    if (hits.length > 0) return hits;
  }
  throw new Error('nothing struck');
}

/** The blood in `map` between z0 and z1 (voxels): [x, y, z, shade], in x, y, z order. */
function blood(map: BrickMap, z0: number, z1: number): number[][] {
  const out: number[][] = [];
  for (let x = 0; x < 256; x++) for (let y = 0; y < 64; y++) for (let z = z0; z < z1; z++) {
    const p = map.get(x, y, z);
    if (BLOOD.has(p)) out.push([x, y, z, p]);
  }
  return out;
}

/** Within `deg` of `dir` from `from` (voxels), for a voxel some ray went into, give or take the half-diagonal it subtends. */
function inCone(cell: readonly number[], from: readonly number[], dir: readonly number[], deg: number): boolean {
  const d = [cell[0] + 0.5 - from[0], cell[1] + 0.5 - from[1], cell[2] + 0.5 - from[2]];
  const r = Math.hypot(d[0], d[1], d[2]);
  const angle = Math.acos(Math.min(1, (d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2]) / r));
  return angle <= (deg * Math.PI) / 180 + Math.asin(Math.min(1, Math.sqrt(3) / 2 / r)) + 1e-9;
}

describe('the session spatters', () => {
  const dir = [0, 0, 1];

  it("a headshot spatters the wall behind the body; a body hit does not, nor another's round through the player's own head", () => {
    const s = field();
    const t = target();
    s.targets = [t];
    // Into the chest: blood, but no spatter.
    const chest = toWorld(t.frames.torso, [0, 0.28, 0]);
    expect(volley(s, [[chest[0], chest[1], chest[2] - 5]], dir).map((h) => [h.body, h.zone])).toEqual([[200, 'torso']]);
    expect(blood(s.map, 0, 512)).toEqual([]);
    // Into the head: the wall 1.5 m behind it.
    const head = toWorld(t.frames.head, [0, 0.155, 0]);
    const [hit, ...more] = volley(s, [[head[0], head[1], head[2] - 5]], dir);
    expect(more).toEqual([]);
    expect(hit).toMatchObject({ owner: 0, body: 200, zone: 'head' });
    const behind = blood(s.map, 0, 512);
    expect(behind.length).toBeGreaterThan(0);
    expect(behind.length).toBeLessThanOrEqual(14);
    const from = hit.position.map((m) => m / V);
    for (const [x, y, z, p] of behind) {
      expect([z, p]).toEqual([265, P.BLOOD_SOIL]);
      expect(inCone([x, y, z], from, hit.dir, 25)).toBe(true);
    }
    // Another's round (seat 2's, owner 4) into the player's own face, from 5 m in front: nothing on
    // the wall behind them. Being hit is the flash, the flinch and the voice (the spec's §4).
    s.together = true;
    const face = toWorld(own(s).head, [0, 0.155, 0]);
    expect(volley(s, [[face[0], face[1], face[2] + 5]], [0, 0, -1], 4).map((h) => [h.owner, h.body, h.zone])).toEqual([[4, LOCAL_BODY, 'head']]);
    expect(blood(s.map, 0, 512)).toEqual(behind);
    // The same seat's round into another's head spatters, for whoever sees it.
    const them = target(3, 18.8);
    s.bodies = [them];
    const theirs = toWorld(them.frames.head, [0, 0.155, 0]);
    expect(volley(s, [[theirs[0], theirs[1], theirs[2] - 5]], dir, 4).map((h) => [h.owner, h.body, h.zone])).toEqual([[4, 3, 'head']]);
    const after = blood(s.map, 0, 512);
    expect(after.length).toBeGreaterThan(behind.length);
    for (const [x, , z] of after.filter((b) => !behind.some((o) => o.join() === b.join()))) expect([x > 160, z]).toEqual([true, 265]);
  });

  it("spatterAt(at, dir, seed) spatters in metres as spatter does in voxels, and leaves a crater's region out alone", () => {
    const at = [12.8, 1.6, 25];
    const free = field();
    const n = free.spatterAt(at, dir, 11);
    const all = blood(free.map, 0, 512);
    expect(n).toBe(all.length);
    expect(n).toBeGreaterThan(0);
    // The world's own, in voxels, on the same world.
    const map = field().map;
    expect(spatter(map, at.map((m) => m / V), dir, 11, spatterTunables(tun, V))).toBe(n);
    expect(blood(map, 0, 512)).toEqual(all);
    // A shell's crater 6.8 m to the left, its region (to x 12.8 m) out and its bricks not yet back.
    const held: DetonationRunner = { post: () => {}, take: () => [] };
    const s = field(held);
    s.destruction.shell([60, 4, 270], 5, 1);
    s.destruction.tick();
    expect(s.destruction.out).toHaveLength(1);
    const [region] = s.destruction.out;
    expect([region.x0, region.x1]).toEqual([0, 128]);
    const inRegion = ([x, , z]: number[]) => x >= region.x0 && x < region.x1 && z >= region.z0 && z < region.z1;
    const left = s.spatterAt(at, dir, 11);
    // What it marks without the crater, less what lies in its region.
    expect(blood(s.map, 0, 512)).toEqual(all.filter((b) => !inRegion(b)));
    expect(left).toBe(all.filter((b) => !inRegion(b)).length);
    expect(all.some(inRegion)).toBe(true);
    expect(left).toBeGreaterThan(0);
  });

  it("a headshot's spatter is drawn from its tick and where it struck: the same hits, the same voxels; the same place a tick later, others", () => {
    const run = () => {
      const s = field();
      const t = target();
      s.targets = [t];
      const head = toWorld(t.frames.head, [0, 0.155, 0]);
      const [first] = volley(s, [[head[0], head[1], head[2] - 5]], dir);
      const once = blood(s.map, 0, 512);
      const [second] = volley(s, [[head[0], head[1], head[2] - 5]], dir);
      return { first, second, once, twice: blood(s.map, 0, 512) };
    };
    const a = run();
    expect(a.second.position).toEqual(a.first.position);
    expect(a.second.tick).toBeGreaterThan(a.first.tick);
    // A second headshot in the same place, on a later tick, marks voxels the first did not.
    expect(a.twice.length).toBeGreaterThan(a.once.length);
    const b = run();
    expect(b.once).toEqual(a.once);
    expect(b.twice).toEqual(a.twice);
  });
});
