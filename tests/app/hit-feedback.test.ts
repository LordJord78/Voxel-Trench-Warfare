import { describe, expect, it } from 'vitest';
import { HitFeedback, hitFeedbackTunables, type FeedbackMarker } from '../../src/app/hit-feedback';
import type { FeedbackVoice } from '../../src/audio/plan';
import { projectileSpec } from '../../src/combat/ballistics';
import { BILLBOARD_FLOATS, particleSpec } from '../../src/combat/particles';
import { pose, toWorld, type V3 } from '../../src/combat/soldier-rig';
import { loadTunables } from '../../src/core/tunables';
import { encodeShotMark } from '../../src/net/gear';
import type { Team } from '../../src/net/protocol';
import type { SoldierDraw } from '../../src/render/soldiers';
import { idleIntent, LOCAL_BODY, Session, type Body, type CombatEvents } from '../../src/sim/session';
import type { MarkerKind, PopText } from '../../src/ui/hit-marker';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// Hit feedback (the shots spec's §4): what a frame's hits, the room's kills and the range's plates
// show and sound. The player's own hits mark the crosshair and sound at the ear, a tick's at most
// once a kind; others' hits on others are heard where they struck, near enough; a round into the
// player flashes the view red, jolts the aim away from it and sounds hurt; a kill marks, pops,
// sounds, bursts critical where the victim was last struck and lays them down along that round.
const tun = loadTunables();
const t = hitFeedbackTunables(tun);
const AK = projectileSpec(tun, 'assault_rifle');
const blood = particleSpec(tun, 'blood');
const mist = particleSpec(tun, 'blood_mist');
const BLOOD_IDS = new Set<number>(
  Object.entries(P)
    .filter(([name]) => name.startsWith('BLOOD_'))
    .map(([, id]) => id),
);
const NOW = 10_000;

type Call = ['show', MarkerKind, number] | ['pop', PopText, { name: string; team: Team } | null, number] | ['flash', number, number] | ['clear'];

/** A HitMarker that records what it is asked. */
class FakeMarker implements FeedbackMarker {
  readonly calls: Call[] = [];
  show(kind: MarkerKind, now: number): void {
    this.calls.push(['show', kind, now]);
  }
  pop(text: PopText, name: { name: string; team: Team } | null, now: number): void {
    this.calls.push(['pop', text, name, now]);
  }
  flash(strength: number, now: number): void {
    this.calls.push(['flash', strength, now]);
  }
  clear(): void {
    this.calls.push(['clear']);
  }
}

/** 25.6 × 6.4 × 51.2 m of sod 0.4 m deep and nothing on it, the player at (12.8, 0.4, 5) facing +z, settled. */
function field(): Session {
  const map = new BrickMap({ x: 256, y: 64, z: 512 });
  map.fillBox(0, 0, 0, 256, 4, 512, P.SOD);
  const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 5] } }, tun, 7, 0);
  s.intent = idleIntent();
  for (let k = 0; k < 40; k++) s.tick();
  s.drainEvents();
  return s;
}

/** Another player's body (their seat `id`) standing on the sod `z` m out, facing back at the player. */
function body(id: number, z = 25, x = 12.8): Body {
  const feet: [number, number, number] = [x, 0.4, z];
  return { id, feet, frames: pose({ position: feet, yaw: 180, pitch: 0, height: 1.8, speed: 0, bob: 0, deadFor: null }) };
}

/** A body as the renderer is given it. */
const drawn = (b: Body, team: Team = 'blue'): SoldierDraw => ({ frames: b.frames, team, seat: b.id, feet: b.feet });

const chestOf = (b: Body) => toWorld(b.frames.torso, [0, 0.28, 0]);
const headOf = (b: Body) => toWorld(b.frames.head, [0, 0.155, 0]);

/** Rounds of `owner` (the AK's), one from each of `from` along unit `dir`, ticked until one strikes a body: what combat did that tick. */
function strike(s: Session, from: readonly (readonly number[])[], dir: readonly number[], owner = 0): CombatEvents {
  for (const o of from) s.rounds.fire([o[0], o[1], o[2]], [dir[0] * AK.muzzleVelocity, dir[1] * AK.muzzleVelocity, dir[2] * AK.muzzleVelocity], AK, owner, false);
  for (let k = 0; k < 10; k++) {
    s.tick();
    const events = s.drainEvents();
    if (events.hits.length > 0) return events;
  }
  throw new Error('nothing struck');
}

/** Nothing happened. */
const none = (): CombatEvents => ({ shots: [], frontShots: [], impacts: [], cracks: [], cuts: [], craters: [], incoming: [], blasts: [], scoops: [], splashes: [], remoteShots: [], hits: [], handling: [], harms: [] });

/** Blood's droplets and mist in the session's particles, by their colour (they only fade). */
function bloodOf(s: Session): { droplets: number[][]; mists: number[][] } {
  const out = new Float32Array(s.particles.capacity * BILLBOARD_FLOATS);
  const n = s.particles.billboards(out);
  const found = { droplets: [] as number[][], mists: [] as number[][] };
  for (let i = 0; i < n; i++) {
    const b = Array.from(out.subarray(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS));
    const rgb = [b[4] / b[7], b[5] / b[7], b[6] / b[7]];
    const is = (c: readonly number[]) => b[8] === 0 && Math.hypot(rgb[0] - c[0], rgb[1] - c[1], rgb[2] - c[2]) < 2e-3;
    if (is(blood.colourStart)) found.droplets.push(b);
    else if (is(mist.colourStart)) found.mists.push(b);
  }
  return found;
}

/** Blood on the world round `at` (metres): its voxels from a metre short of it to 5 m on, 3 m either side, from the bed up. */
function bloodied(s: Session, at: readonly number[]): number {
  const v = s.voxel;
  const [cx, cz] = [Math.floor(at[0] / v), Math.floor(at[2] / v)];
  let n = 0;
  for (let x = cx - 30; x <= cx + 30; x++) for (let y = 0; y < 30; y++) for (let z = cz - 10; z <= cz + 50; z++) if (BLOOD_IDS.has(s.map.get(x, y, z))) n++;
  return n;
}

const near = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('hit feedback', () => {
  it("[hits] gives the feedback's numbers", () => {
    expect(t.gains).toEqual({ hit: 0.75, head: 0.9, gush: 0.8, kill: 0.9, ding: 1.5, hurt: 0.7 });
    expect([t.killWindowS, t.hitHeardM, t.gushHeardM, t.flashMin, t.jolt]).toEqual([0.3, 30, 25, 0.25, [1.5, 1.5]]);
    expect([t.fallS, t.headFallS, t.flinchS]).toEqual([0.7, 0.45, 0.25]);
  });

  it("a body hit of the player's: a hit marker and one hit voice at the ear", () => {
    const s = field();
    const them = body(3);
    s.together = true;
    s.bodies = [them];
    const chest = chestOf(them);
    const events = strike(s, [[chest[0], chest[1], chest[2] - 5]], [0, 0, 1]);
    expect(events.hits.map((h) => [h.owner, h.body, h.zone])).toEqual([[0, 3, 'torso']]);
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    const voices = fb.frame(s, events, NOW, [drawn(them)]);
    expect(marker.calls).toEqual([['show', 'hit', NOW]]);
    expect(voices).toEqual([{ kind: 'hit', at: null, gain: 0.75 }]);
    // The body flinches along the round, kept by its id until it has settled.
    expect(fb.figureOverlay(3, NOW + 100)).toEqual({ flinch: { dir: events.hits[0].dir, age: 0.1, head: false } });
    expect(fb.figureOverlay(3, NOW + 2000 * t.flinchS)).toEqual({});
    expect(fb.figureOverlay(4, NOW + 100)).toEqual({});
    // Nothing more the next frame.
    expect(fb.frame(s, none(), NOW + 16)).toEqual([]);
    expect(fb.state()).toMatchObject({ voices: { hit: 1 }, flashes: 0, markers: { hit: 1, head: 0, kill: 0 } });
  });

  it('a headshot: the head marker, the HEADSHOT pop, and head + gush at the ear', () => {
    const s = field();
    const them = body(200);
    s.targets = [them];
    const head = headOf(them);
    const events = strike(s, [[head[0], head[1], head[2] - 5]], [0, 0, 1]);
    expect(events.hits.map((h) => [h.owner, h.body, h.zone])).toEqual([[0, 200, 'head']]);
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    const voices = fb.frame(s, events, NOW, [drawn(them)]);
    expect(marker.calls).toEqual([
      ['show', 'head', NOW],
      ['pop', 'HEADSHOT', null, NOW],
    ]);
    expect(voices).toEqual([
      { kind: 'head', at: null, gain: 0.9 },
      { kind: 'gush', at: null, gain: 0.8 },
    ]);
    // The head snaps.
    expect(fb.figureOverlay(200, NOW)).toEqual({ flinch: { dir: events.hits[0].dir, age: 0, head: true } });
  });

  it('nine pellets on one tick: one marker, one hit voice', () => {
    const s = field();
    const them = body(200);
    s.targets = [them];
    const chest = chestOf(them);
    const grid = Array.from({ length: 9 }, (_, k) => [chest[0] + ((k % 3) - 1) * 0.06, chest[1] + (Math.floor(k / 3) - 1) * 0.06, chest[2] - 5]);
    const events = strike(s, grid, [0, 0, 1]);
    expect(events.hits).toHaveLength(9);
    expect(new Set(events.hits.map((h) => h.tick)).size).toBe(1);
    expect(events.hits.every((h) => h.body === 200 && h.zone === 'torso')).toBe(true);
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    expect(fb.frame(s, events, NOW, [drawn(them)])).toEqual([{ kind: 'hit', at: null, gain: 0.75 }]);
    expect(marker.calls).toEqual([['show', 'hit', NOW]]);
    // A shotgun's pellets over two ticks in one frame are two of each: each tick its own.
    const later = strike(s, grid.slice(0, 3), [0, 0, 1]);
    const both = { ...later, hits: [...events.hits, ...later.hits] };
    const again = new FakeMarker();
    expect(new HitFeedback(t, again).frame(s, both, NOW).map((v) => v.kind)).toEqual(['hit', 'hit']);
    expect(again.calls.map((c) => c[0])).toEqual(['show', 'show']);
  });

  it('a kill 150 ms after the last hit: the kill marker replaces the hit marker, the kill voice plays, and the burst is at that hit', () => {
    const s = field();
    const them = body(3);
    s.together = true;
    s.bodies = [them];
    const chest = chestOf(them);
    const events = strike(s, [[chest[0], chest[1], chest[2] - 5]], [0, 0, 1]);
    const [hit] = events.hits;
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    fb.frame(s, events, NOW, [drawn(them)]);
    const before = bloodOf(s);
    // A chest hit spatters nothing (critical hits only).
    expect(bloodied(s, hit.position)).toBe(0);
    const ann = { name: 'Ann', team: 'blue' as Team };
    fb.kill(3, true, ann, NOW + 150, s, 'torso');
    expect(marker.calls).toEqual([
      ['show', 'hit', NOW],
      ['show', 'kill', NOW + 150],
      ['pop', 'KILL', ann, NOW + 150],
    ]);
    // The kill's voice comes with the next frame's, at the ear.
    expect(fb.frame(s, none(), NOW + 166, [drawn(them)])).toEqual([{ kind: 'kill', at: null, gain: 0.9 }]);
    // Critical blood thrown from where the round went in (the hit's own, a tick on, has moved off it),
    // not from the feet, and the ground behind spattered.
    const after = bloodOf(s);
    expect(after.droplets.length - before.droplets.length).toBe(18);
    expect(after.mists.length - before.mists.length).toBe(3);
    expect(after.droplets.filter((b) => near(b, hit.position) < 1e-4)).toHaveLength(18);
    expect(after.droplets.filter((b) => near(b, them.feet) < 0.5)).toHaveLength(0);
    expect(bloodied(s, hit.position)).toBeGreaterThan(0);
    // It falls along that round (bearing 0: it went along +z), in fall_s.
    const fall = fb.figureOverlay(3, NOW + 166);
    expect(fall.fallYaw).toBeCloseTo(0, 6);
    expect(fall.fallS).toBe(0.7);
  });

  it('a kill another made: no marker, pop or voice of the player\'s; the burst and the fall still, which a headshot kill takes once and faster', () => {
    const s = field();
    const them = body(3);
    s.together = true;
    s.bodies = [them];
    const head = headOf(them);
    // Seat 2's round (owner 4) into their head, from the side, along −x.
    const events = strike(s, [[head[0] + 5, head[1], head[2]]], [-1, 0, 0], 4);
    expect(events.hits.map((h) => [h.owner, h.body, h.zone])).toEqual([[4, 3, 'head']]);
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    fb.frame(s, events, NOW, [drawn(them)]);
    const before = { blood: bloodOf(s), spatter: bloodied(s, head) };
    expect(before.spatter).toBeGreaterThan(0);
    fb.kill(3, false, { name: 'Ann', team: 'blue' }, NOW + 150, s, 'head');
    expect(marker.calls).toEqual([]);
    expect(fb.frame(s, none(), NOW + 166)).toEqual([]);
    // One critical burst a hit: the headshot bled and spattered as it struck, so the kill adds none.
    const after = bloodOf(s);
    expect([after.droplets.length, after.mists.length]).toEqual([before.blood.droplets.length, before.blood.mists.length]);
    expect(bloodied(s, head)).toBe(before.spatter);
    // Down along the round (bearing −90: it went along −x), in head_fall_s.
    const fall = fb.figureOverlay(3, NOW + 166);
    expect(fall.fallYaw).toBeCloseTo(-90, 6);
    expect(fall.fallS).toBe(0.45);
  });

  it('a kill with no hit seen within 300 ms bursts at their chest as drawn, and they fall back from their feet', () => {
    const s = field();
    const them = body(3);
    s.together = true;
    s.bodies = [them];
    const chest = chestOf(them);
    const events = strike(s, [[chest[0], chest[1], chest[2] - 5]], [0, 0, 1]);
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    fb.frame(s, events, NOW, [drawn(them)]);
    const before = bloodOf(s).droplets.length;
    fb.kill(3, true, null, NOW + 400, s, 'torso');
    const thrown = bloodOf(s).droplets;
    expect(thrown.length - before).toBe(18);
    expect(thrown.filter((b) => near(b, chest) < 1e-4)).toHaveLength(18);
    // No bearing to fall along: back from the feet, in fall_s. (Its flinch springs on as it falls.)
    const fall = fb.figureOverlay(3, NOW + 400);
    expect([fall.fallYaw, fall.fallS]).toEqual([undefined, 0.7]);
    expect(fall.flinch?.age).toBeCloseTo(0.4, 9);
    // The room's word of a death by no round (a shell): no burst, and back from the feet.
    const quiet = bloodOf(s).droplets.length;
    fb.kill(3, false, null, NOW + 500, s, null);
    expect(bloodOf(s).droplets.length).toBe(quiet);
    expect(fb.figureOverlay(3, NOW + 500)).toEqual({ fallS: 0.7 });
  });

  it("another's headshot seen 10 m off: a spatial gush at the body, no marker", () => {
    const s = field();
    // At 10, 27 and 32 m from the player's eye.
    const them = [body(3, 15), body(5, 32), body(6, 37)];
    s.together = true;
    s.bodies = them;
    // Seat 2's rounds (owner 4) into each head on one tick, from the side, along −x.
    const events = strike(s, them.map(headOf).map((h) => [h[0] + 5, h[1], h[2]]), [-1, 0, 0], 4);
    expect(events.hits.map((h) => [h.owner, h.body, h.zone])).toEqual([[4, 3, 'head'], [4, 5, 'head'], [4, 6, 'head']]);
    const p = s.player;
    const eye = [p.position.x, p.position.y + s.controller.eyeHeight(p), p.position.z];
    const [near10, at27, at32] = events.hits;
    expect([near(near10.position, eye), near(at27.position, eye), near(at32.position, eye)].map(Math.round)).toEqual([10, 27, 32]);
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    const voices = fb.frame(s, events, NOW, them.map((b) => drawn(b)));
    expect(marker.calls).toEqual([]);
    // Heard where each struck: within 30 m the thwack, within 25 m the gush; never the crack or the kill, which are the shooter's.
    const at = (v: FeedbackVoice) => v.at;
    expect(voices).toEqual([
      { kind: 'hit', at: near10.position, gain: 0.75 },
      { kind: 'gush', at: near10.position, gain: 0.8 },
      { kind: 'hit', at: at27.position, gain: 0.75 },
    ]);
    expect(voices.map(at).every((a) => a !== null)).toBe(true);
    // Each body flinches, its head snapping.
    events.hits.forEach((h, i) => expect(fb.figureOverlay(them[i].id, NOW)).toEqual({ flinch: { dir: h.dir, age: 0, head: true } }));
  });

  it('being hit by another player: the flash, a jolt of the aim away from the round, the hurt voice', () => {
    const s = field();
    s.together = true;
    const p = s.player;
    const chest = toWorld(pose({ position: p.position.toArray(), yaw: p.yaw, pitch: p.pitch, height: p.height, speed: 0, bob: p.bobPhase, deadFor: null }).torso, [0, 0.28, 0]);
    // Seat 2's AK round (owner 4, its shot's word saying so), from 5 m to the player's left and level:
    // it goes right, across the view (yaw 0 faces +z, and +x is to the right).
    const mark = encodeShotMark({ tracer: false, kind: 0, suppressed: false, gun: 'ak74' });
    const from: [number, number, number] = [chest[0] - 5, chest[1], chest[2]];
    s.fireRemote(4, from, [1, 0, 0], false, from, mark);
    let events = none();
    for (let k = 0; k < 10 && events.hits.length === 0; k++) {
      s.tick();
      events = s.drainEvents();
    }
    expect(events.hits.map((h) => [h.owner, h.body, h.zone, h.gun])).toEqual([[4, LOCAL_BODY, 'torso', 0]]);
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    const was = [s.suppression.flinchYaw, s.suppression.flinchPitch];
    const view = s.viewAt(1);
    const voices = fb.frame(s, events, NOW);
    // An AK's chest hit, 55 × 1.05 = 58: the flash at 0.58, the aim jolted 1.5° + 1.5° × 0.58 to the
    // right, the way the round went.
    expect(marker.calls).toEqual([['flash', 0.58, NOW]]);
    expect(voices).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    // (The round has dropped a few hundredths of a millimetre in its 5 m: its way is level to 1e-4.)
    expect(s.suppression.flinchYaw - was[0]).toBeCloseTo(1.5 + 1.5 * 0.58, 3);
    expect(s.suppression.flinchPitch - was[1]).toBeCloseTo(0, 3);
    // It moves the aim as suppression's flinch does: the view's offsets, which the next shot takes.
    expect(s.viewAt(1).yaw - view.yaw).toBeCloseTo(1.5 + 1.5 * 0.58, 3);
    expect(fb.state().flashes).toBe(1);
    // A light hit still flashes at a quarter: a 9x18 pistol's round in a limb, 30 × 0.72 = 22.
    const light = new FakeMarker();
    new HitFeedback(t, light).frame(s, { ...none(), hits: [{ ...events.hits[0], zone: 'limb', gun: 7 }] }, NOW);
    expect(light.calls).toEqual([['flash', 0.25, NOW]]);
  });

  it("a blast's harm on the player is felt: the hurt flash and thump, scaled by its amount", () => {
    const s = field();
    const harm = (amount: number, cause: 'shell' | 'round' = 'shell') => ({ ...none(), harms: [{ tick: s.ticks, amount, cause }] });
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    const was = [s.suppression.flinchYaw, s.suppression.flinchPitch];
    // A blast's 80: the flash a hit of 80 gives, and the hurt voice at the ear.
    const voices = fb.frame(s, harm(80), NOW);
    expect(marker.calls).toEqual([['flash', 0.8, NOW]]);
    expect(voices).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    expect(fb.state().flashes).toBe(1);
    expect(fb.state().voices).toEqual({ hurt: 1 });
    // No jolt: the blast's own shake and suppression stand for it.
    expect([s.suppression.flinchYaw, s.suppression.flinchPitch]).toEqual(was);
    // Weaker, weaker: 40 at 0.4, 20 at the least, 0.25; 200 at the whole.
    for (const [amount, strength] of [[40, 0.4], [20, 0.25], [200, 1]] as const) {
      const m = new FakeMarker();
      expect(new HitFeedback(t, m).frame(s, harm(amount), NOW)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
      expect(m.calls, `${amount}`).toEqual([['flash', strength, NOW]]);
    }
    // A round's harm alone: nothing here, its body hit is what flashes.
    const round = new FakeMarker();
    const fr = new HitFeedback(t, round);
    expect(fr.frame(s, harm(33, 'round'), NOW)).toEqual([]);
    expect(round.calls).toEqual([]);
    expect(fr.state().flashes).toBe(0);
  });

  it("the player's own round never hurts the player", () => {
    const s = field();
    s.together = true;
    const p = s.player;
    const chest = toWorld(pose({ position: p.position.toArray(), yaw: p.yaw, pitch: p.pitch, height: p.height, speed: 0, bob: p.bobPhase, deadFor: null }).torso, [0, 0.28, 0]);
    // A round of the player's own fired back at them from 5 m: a body's test leaves its owner out, so
    // it goes through to the ground.
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    s.rounds.fire([chest[0], chest[1], chest[2] + 5], [0, 0, -AK.muzzleVelocity], AK, 0, false);
    for (let k = 0; k < 10; k++) {
      s.tick();
      const events = s.drainEvents();
      expect(events.hits).toEqual([]);
      expect(fb.frame(s, events, NOW + k)).toEqual([]);
    }
    // And were the session ever to say so: an owner-0 hit on the player's own body is nothing.
    const was = [s.suppression.flinchYaw, s.suppression.flinchPitch];
    const own = { ...none(), hits: [{ owner: 0, body: LOCAL_BODY, zone: 'head' as const, position: chest, dir: [0, 0, -1] as V3, distance: 5, tick: s.ticks }] };
    expect(fb.frame(s, own, NOW + 20)).toEqual([]);
    expect(marker.calls).toEqual([]);
    expect([s.suppression.flinchYaw, s.suppression.flinchPitch]).toEqual(was);
    expect(fb.state()).toEqual({ voices: {}, flashes: 0, markers: { hit: 0, head: 0, kill: 0 } });
  });

  it('a plate: a hit marker and a ding at the plate', () => {
    const s = field();
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    const plate: [number, number, number] = [12.8, 1.3, 35];
    fb.plate({ kind: 'plate', index: 0, distanceM: 30 }, plate, NOW);
    expect(marker.calls).toEqual([['show', 'hit', NOW]]);
    // Its ring is the next frame's, where the plate is.
    expect(fb.frame(s, none(), NOW + 16)).toEqual([{ kind: 'ding', at: plate, gain: 1.5 }]);
    expect(fb.frame(s, none(), NOW + 32)).toEqual([]);
    expect(fb.state().voices).toEqual({ ding: 1 });
  });
});
