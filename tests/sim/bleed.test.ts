import { describe, expect, it } from 'vitest';
import { projectileSpec } from '../../src/combat/ballistics';
import { BILLBOARD_FLOATS, particleSpec } from '../../src/combat/particles';
import { pose, toWorld, type Frame, type PartName, type V3 } from '../../src/combat/soldier-rig';
import { loadTunables } from '../../src/core/tunables';
import { idleIntent, LOCAL_BODY, Session, type Body, type CombatEvents } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P, paletteData } from '../../src/world/materials';

// Blood (the shots spec's §4): every round into another's body bleeds where it struck, beside the
// uniform's khaki dust, and a headshot bleeds critical: more droplets thrown out of the far side,
// more mist, and sparks off the helmet. The session throws it, so it is as deterministic as its
// other particles; a shotgun's pellets bleed a body twice a tick at most. The player's own body
// bleeds none.
const tun = loadTunables();
const AK = projectileSpec(tun, 'assault_rifle');
const blood = particleSpec(tun, 'blood');
const mist = particleSpec(tun, 'blood_mist');
const dust = particleSpec(tun, 'dust');

/** 25.6 × 6.4 × 51.2 m of sod 0.4 m deep and nothing on it, the player at (12.8, 0.4, 5) facing +z, settled. */
function field(): Session {
  const map = new BrickMap({ x: 256, y: 64, z: 512 });
  map.fillBox(0, 0, 0, 256, 4, 512, P.SOD);
  const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 5] } }, tun, 7, 0);
  s.intent = idleIntent();
  for (let k = 0; k < 40; k++) s.tick();
  return s;
}

/** A target (200 on) standing on the sod `z` m out, facing back at the player. */
function target(id = 200, x = 12.8, z = 25): Body {
  const feet: [number, number, number] = [x, 0.4, z];
  return { id, feet, frames: pose({ position: feet, yaw: 180, pitch: 0, height: 1.8, speed: 0, bob: 0, deadFor: null }) };
}

/** The player's own body, posed as the session poses it for rounds to strike (and others draw it). */
function own(s: Session): Record<PartName, Frame> {
  const p = s.player;
  return pose({ position: p.position.toArray(), yaw: p.yaw, pitch: p.pitch, height: p.height, speed: 0, bob: p.bobPhase, deadFor: null });
}

/**
 * Rounds of `owner` (the player's, 0, unless told; the AK's), one from each of `from` along unit
 * `dir`, ticked until they strike: what they struck on that tick, the particles as it left them.
 */
function volley(s: Session, from: readonly (readonly number[])[], dir: readonly number[], owner = 0): CombatEvents['hits'] {
  for (const o of from) s.rounds.fire([o[0], o[1], o[2]], [dir[0] * AK.muzzleVelocity, dir[1] * AK.muzzleVelocity, dir[2] * AK.muzzleVelocity], AK, owner, false);
  for (let k = 0; k < 10; k++) {
    s.tick();
    const { hits } = s.drainEvents();
    if (hits.length > 0) return hits;
  }
  throw new Error('nothing struck');
}

/** Each live particle by what it is, from its colour: blood's droplets and mist, sparks (the emissive), the uniform's dust, anything else. */
function census(s: Session) {
  const palette = paletteData();
  const khaki = [0, 1, 2].map((c) => dust.colourStart[c] * palette[P.SOLDIER_KHAKI * 8 + c]);
  const out = new Float32Array(s.particles.capacity * BILLBOARD_FLOATS);
  const n = s.particles.billboards(out);
  const kinds = { droplets: [] as number[][], mists: [] as number[][], sparks: [] as number[][], dust: [] as number[][], other: [] as number[][] };
  for (let i = 0; i < n; i++) {
    const b = Array.from(out.subarray(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS));
    // Its colour, unpremultiplied: blood's own and the dust's only fade.
    const rgb = [b[4] / b[7], b[5] / b[7], b[6] / b[7]];
    const is = (c: readonly number[]) => Math.hypot(rgb[0] - c[0], rgb[1] - c[1], rgb[2] - c[2]) < 2e-3;
    if (b[8] === 1) kinds.sparks.push(b);
    else if (b[8] === 0 && is(blood.colourStart)) kinds.droplets.push(b);
    else if (b[8] === 0 && is(mist.colourStart)) kinds.mists.push(b);
    else if (b[8] === 0 && is(khaki)) kinds.dust.push(b);
    else kinds.other.push(b);
  }
  return kinds;
}

const counts = (s: Session) => {
  const c = census(s);
  return { droplets: c.droplets.length, mists: c.mists.length, sparks: c.sparks.length };
};

const near = (b: readonly number[], p: readonly number[]) => Math.hypot(b[0] - p[0], b[1] - p[1], b[2] - p[2]);

describe('blood', () => {
  const dir: V3 = [0, 0, 1];

  it('[particles.blood] and [particles.blood_mist] are dark red, lit as dust is', () => {
    expect(blood).toMatchObject({ lifeS: 0.8, gravity: -9.81, drag: 1.2, sizeStartM: 0.03, sizeEndM: 0.02, colourStart: [0.32, 0.02, 0.02, 1.0], emissive: false, count: 6, speed: 3.5, spread: 0.6, speedJitter: 0.3 });
    expect(blood.colourEnd).toEqual([0.32, 0.02, 0.02, 0]);
    expect(mist).toMatchObject({ lifeS: 0.9, gravity: -0.4, drag: 3.0, sizeStartM: 0.15, sizeEndM: 0.6, colourStart: [0.42, 0.04, 0.04, 0.45], emissive: false, count: 1, speed: 0.8, spread: 0.8 });
    expect(mist.colourEnd).toEqual([0.42, 0.04, 0.04, 0]);
    expect(['critical_droplets', 'critical_mist', 'helmet_sparks'].map((k) => tun.i(`hits.${k}`))).toEqual([18, 3, 4]);
  });

  it('a body hit throws 6 blood droplets and a puff of mist beside the dust', () => {
    const s = field();
    const t = target();
    s.targets = [t];
    expect(counts(s)).toEqual({ droplets: 0, mists: 0, sparks: 0 });
    const chest = toWorld(t.frames.torso, [0, 0.28, 0]);
    const [hit, ...more] = volley(s, [[chest[0], chest[1], chest[2] - 5]], dir);
    expect(more).toEqual([]);
    expect(hit).toMatchObject({ owner: 0, body: 200, zone: 'torso' });
    const after = census(s);
    expect(after.droplets).toHaveLength(6);
    expect(after.mists).toHaveLength(1);
    expect(after.sparks).toHaveLength(0);
    // The khaki dust stays, the uniform's puff where it struck.
    expect(after.dust).toHaveLength(dust.count);
    expect(after.other).toEqual([]);
    // All of it where the round went in, a tick on.
    for (const b of [...after.droplets, ...after.mists, ...after.dust]) expect(near(b, hit.position)).toBeLessThan(0.25);
  });

  it('a headshot throws 18 droplets out the far side, 3 mists, and 4 sparks off the helmet', () => {
    const s = field();
    const t = target();
    s.targets = [t];
    const head = toWorld(t.frames.head, [0, 0.155, 0]);
    const [hit] = volley(s, [[head[0], head[1], head[2] - 5]], dir);
    expect(hit).toMatchObject({ owner: 0, body: 200, zone: 'head' });
    const after = census(s);
    expect(after.droplets).toHaveLength(18);
    expect(after.mists).toHaveLength(3);
    expect(after.sparks).toHaveLength(4);
    expect(after.dust).toHaveLength(dust.count);
    // Out of the far side: a tick on, the droplets have gone on along the round, on average most of
    // the way their speed takes them.
    const along = after.droplets.map((b) => (b[0] - hit.position[0]) * hit.dir[0] + (b[1] - hit.position[1]) * hit.dir[1] + (b[2] - hit.position[2]) * hit.dir[2]);
    expect(along.reduce((a, v) => a + v, 0) / along.length).toBeGreaterThan(0.5 * blood.speed * s.clock.dt);
    for (const b of [...after.droplets, ...after.mists, ...after.sparks]) expect(near(b, hit.position)).toBeLessThan(0.4);
  });

  it("bleed() is the app's own burst (a kill's): what a hit throws, its sparks only off a helmet", () => {
    const s = field();
    const at = [12.8, 1.6, 25];
    s.bleed(at, dir, false);
    expect(counts(s)).toEqual({ droplets: 6, mists: 1, sparks: 0 });
    s.bleed(at, dir, true);
    expect(counts(s)).toEqual({ droplets: 6 + 18, mists: 1 + 3, sparks: 0 });
    s.bleed(at, dir, true, true);
    expect(counts(s)).toEqual({ droplets: 6 + 18 + 18, mists: 1 + 3 + 3, sparks: 4 });
    // Thrown from where it is told (billboards are float32).
    for (const b of census(s).droplets) expect(near(b, at)).toBeLessThan(1e-5);
  });

  it('bleeding is deterministic: two sessions, same hits, same particles', () => {
    const run = () => {
      const s = field();
      const t = target();
      s.targets = [t];
      const head = toWorld(t.frames.head, [0, 0.155, 0]);
      const chest = toWorld(t.frames.torso, [0.05, 0.3, 0]);
      volley(s, [[head[0], head[1], head[2] - 5]], dir);
      volley(s, [[chest[0], chest[1], chest[2] - 5]], dir);
      s.bleed(chest, dir, true);
      s.tick();
      const out = new Float32Array(s.particles.capacity * BILLBOARD_FLOATS);
      const n = s.particles.billboards(out);
      return { counts: counts(s), all: Array.from(out.subarray(0, n * BILLBOARD_FLOATS)) };
    };
    const a = run();
    expect(a.counts).toEqual({ droplets: 18 + 6 + 18, mists: 3 + 1 + 3, sparks: 4 });
    const b = run();
    expect(b.all).toEqual(a.all);
  });

  it('nine pellets into one body on one tick: 2 blood bursts', () => {
    const s = field();
    const t = target();
    const other = target(201, 14.8);
    s.targets = [t, other];
    const chest = toWorld(t.frames.torso, [0, 0.28, 0]);
    const theirs = toWorld(other.frames.torso, [0, 0.28, 0]);
    // A shotgun's nine pellets over its chest from 5 m, and three into another body beside it, all on one tick.
    const grid = Array.from({ length: 9 }, (_, k) => [chest[0] + ((k % 3) - 1) * 0.06, chest[1] + (Math.floor(k / 3) - 1) * 0.06, chest[2] - 5]);
    const beside = [-1, 0, 1].map((k) => [theirs[0] + k * 0.06, theirs[1], theirs[2] - 5]);
    const hits = volley(s, [...grid, ...beside], dir);
    expect(hits.map((h) => h.body)).toEqual([...Array(9).fill(200), 201, 201, 201]);
    expect(hits.every((h) => h.zone !== 'head')).toBe(true);
    const after = census(s);
    // Two bursts a body: four in all, not twelve.
    expect(after.droplets).toHaveLength(4 * 6);
    expect(after.mists).toHaveLength(4);
    expect(after.droplets.filter((b) => near(b, chest) < 0.5)).toHaveLength(2 * 6);
    // Each pellet still throws its dust.
    expect(after.dust).toHaveLength(12 * dust.count);
    // The next tick's are bled again.
    volley(s, [[chest[0], chest[1], chest[2] - 5]], dir);
    expect(census(s).droplets.filter((b) => near(b, chest) < 0.5).length).toBeGreaterThan(2 * 6);
  });

  it("a headshot among a tick's pellets is one of its body's two bursts: its critical burst is never capped away", () => {
    const s = field();
    const t = target();
    s.targets = [t];
    const chest = toWorld(t.frames.torso, [0, 0.22, 0]);
    const head = toWorld(t.frames.head, [0, 0.155, 0]);
    // Eight into the chest and the last (the pool's last slot) into the head.
    const grid = Array.from({ length: 8 }, (_, k) => [chest[0] + ((k % 4) - 1.5) * 0.05, chest[1] + (Math.floor(k / 4) - 0.5) * 0.06, chest[2] - 5]);
    const hits = volley(s, [...grid, [head[0], head[1], head[2] - 5]], dir);
    expect(hits.map((h) => h.zone)).toEqual([...Array(8).fill('torso'), 'head']);
    expect(counts(s)).toEqual({ droplets: 18 + 6, mists: 3 + 1, sparks: 4 });
  });

  it("another's rounds into the player's own body bleed nothing, which would be thrown into the eye; into another's body they bleed", () => {
    const s = field();
    s.together = true;
    const me = own(s);
    const p = s.player;
    const eye = [p.position.x, p.position.y + s.controller.eyeHeight(p), p.position.z];
    // Seat 2's rounds (owner 4) on one tick, from 5 m in front of the player and back along −z: one
    // into the face, which an MP5's, a pistol's or a pellet's leaves the player standing through, and
    // one into the chest.
    const head = toWorld(me.head, [0, 0.155, 0]);
    const chest = toWorld(me.torso, [0, 0.28, 0]);
    const hits = volley(s, [[head[0], head[1], head[2] + 5], [chest[0], chest[1], chest[2] + 5]], [0, 0, -1], 4);
    expect(hits.map((h) => [h.owner, h.body, h.zone])).toEqual([[4, LOCAL_BODY, 'head'], [4, LOCAL_BODY, 'torso']]);
    // In first person no body of the player's is drawn, and the face is struck a hand's breadth in
    // front of the eye: a headshot's critical burst would be thrown into the view.
    expect(near(hits[0].position, eye)).toBeLessThan(0.3);
    // Being hit is the red flash, the aim's flinch and the hurt voice (the spec's §4): no blood.
    expect(counts(s)).toEqual({ droplets: 0, mists: 0, sparks: 0 });
    // The same seat's round into another body bleeds, for whoever sees it.
    const them = target(3);
    s.bodies = [them];
    const theirs = toWorld(them.frames.head, [0, 0.155, 0]);
    const [hit, ...more] = volley(s, [[theirs[0], theirs[1], theirs[2] - 5]], dir, 4);
    expect(more).toEqual([]);
    expect(hit).toMatchObject({ owner: 4, body: 3, zone: 'head' });
    expect(counts(s)).toEqual({ droplets: 18, mists: 3, sparks: 4 });
  });
});
