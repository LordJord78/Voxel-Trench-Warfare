import { describe, expect, it, vi } from 'vitest';
import { HitFeedback, hitFeedbackTunables, type Dropped, type FeedbackMarker } from '../../src/app/hit-feedback';
import type { FeedbackVoice } from '../../src/audio/plan';
import { projectileSpec, type BodyHit } from '../../src/combat/ballistics';
import { frontHarm, harmTunables } from '../../src/combat/harm';
import { BILLBOARD_FLOATS, BLOOD_BILLBOARD, particleSpec } from '../../src/combat/particles';
import type { RangeEvent } from '../../src/combat/range';
import { CHEST, pose, toWorld, type V3 } from '../../src/combat/soldier-rig';
import { loadTunables } from '../../src/core/tunables';
import { encodeShotMark, gunDamage } from '../../src/net/gear';
import { DAMAGE } from '../../src/net/match-rules';
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

/** A HitMarker that records what it is asked, and shows a marker unless told it would not (a greater one showing). */
class FakeMarker implements FeedbackMarker {
  readonly calls: Call[] = [];
  shows = true;
  show(kind: MarkerKind, now: number): boolean {
    this.calls.push(['show', kind, now]);
    return this.shows;
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
    const is = (c: readonly number[]) => b[8] === BLOOD_BILLBOARD && Math.hypot(rgb[0] - c[0], rgb[1] - c[1], rgb[2] - c[2]) < 2e-3;
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

/** The player's chest, as their own body (LOCAL_BODY) stands. */
function ownChest(s: Session): V3 {
  const p = s.player;
  return toWorld(pose({ position: p.position.toArray(), yaw: p.yaw, pitch: p.pitch, height: p.height, speed: 0, bob: p.bobPhase, deadFor: null }).torso, [0, 0.28, 0]);
}

/** A round of `owner`'s into the player's chest along `dir`, as combat would say it (no gun's: 55 to the torso). */
const intoPlayer = (s: Session, owner: number, dir: V3 = [1, 0, 0]): BodyHit & { tick: number } => ({ owner, body: LOCAL_BODY, zone: 'torso', position: ownChest(s), dir, distance: 5, tick: s.ticks });

describe('hit feedback', () => {
  it("[hits] gives the feedback's numbers: the shooter's gush (2.8) and kill (0.3) turned under the gun", () => {
    expect(t.gains).toEqual({ hit: 0.7, head: 0.88, gush: 2.8, kill: 0.3, ding: 1.5, hurt: 0.7 });
    // Another's headshot's gush, heard at the body: the old gain, so a kill nearby in a match is not overpowering (Task 5's ruling).
    expect(t.gushOthersGain).toBe(0.8);
    expect([t.killWindowS, t.hitHeardM, t.gushHeardM, t.flashMin, t.flashS, t.jolt]).toEqual([0.3, 30, 25, 0.25, 0.35, [1.5, 1.5]]);
    expect([t.fallS, t.headFallS, t.flinchS, t.flinchSpan]).toEqual([0.7, 0.45, 0.25, 2]);
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
    expect(voices).toEqual([{ kind: 'hit', at: null, gain: 0.7 }]);
    // The body flinches along the round, kept by its id until it has settled.
    expect(fb.figureOverlay(3, NOW + 100)).toEqual({ flinch: { dir: events.hits[0].dir, age: 0.1, head: false } });
    expect(fb.figureOverlay(3, NOW + 1000 * t.flinchSpan * t.flinchS)).toEqual({});
    expect(fb.figureOverlay(4, NOW + 100)).toEqual({});
    // Nothing more the next frame.
    expect(fb.frame(s, none(), NOW + 16)).toEqual([]);
    expect(fb.state()).toMatchObject({ voices: { hit: 1 }, flashes: 0, markers: { hit: 1, head: 0, kill: 0 } });
  });

  it('a headshot: the head marker, the HEADSHOT pop, and head (0.88) + gush (2.8) at the ear', () => {
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
      { kind: 'head', at: null, gain: 0.88 },
      { kind: 'gush', at: null, gain: 2.8 },
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
    expect(fb.frame(s, events, NOW, [drawn(them)])).toEqual([{ kind: 'hit', at: null, gain: 0.7 }]);
    expect(marker.calls).toEqual([['show', 'hit', NOW]]);
    // A shotgun's pellets over two ticks in one frame are two of each: each tick its own.
    const later = strike(s, grid.slice(0, 3), [0, 0, 1]);
    const both = { ...later, hits: [...events.hits, ...later.hits] };
    const again = new FakeMarker();
    expect(new HitFeedback(t, again).frame(s, both, NOW).map((v) => v.kind)).toEqual(['hit', 'hit']);
    expect(again.calls.map((c) => c[0])).toEqual(['show', 'show']);
  });

  it('a kill 150 ms after the last hit: the kill marker replaces the hit marker, the kill voice plays (at 0.3), and the burst is at that hit', () => {
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
    expect(fb.frame(s, none(), NOW + 166, [drawn(them)])).toEqual([{ kind: 'kill', at: null, gain: 0.3 }]);
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

  it("another's headshot seen 10 m off: a spatial gush at the body at gush_others_gain (0.8, not the shooter's 2.8), no marker", () => {
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
      { kind: 'hit', at: near10.position, gain: 0.7 },
      { kind: 'gush', at: near10.position, gain: 0.8 },
      { kind: 'hit', at: at27.position, gain: 0.7 },
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

  it("a blast felt counts as felt for the room's word of the player's death: a shell that kills flashes once", () => {
    const s = field();
    s.room = true;
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    expect(fb.frame(s, { ...none(), harms: [{ tick: s.ticks, amount: 100, cause: 'shell' }] }, NOW)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    // The room's word of the death by that shell, 0.1 s on: nothing more.
    fb.died(NOW + 100);
    expect(fb.frame(s, none(), NOW + 116)).toEqual([]);
    expect(marker.calls).toEqual([['flash', 1, NOW]]);
    expect(fb.state()).toMatchObject({ voices: { hurt: 1 }, flashes: 1 });
    // Past half of hurt_flash_s from the blast, its flash faded below half, the room's word is felt.
    fb.died(NOW + 400);
    expect(marker.calls.at(-1)).toEqual(['flash', 1, NOW + 400]);
    expect(fb.frame(s, none(), NOW + 416)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
  });

  it("a frame's blasts and a round into the player: one flash at the larger share and one hurt voice; the jolt the round's alone", () => {
    const shelled = (s: Session, amount: number, tick = s.ticks) => ({ tick, amount, cause: 'shell' as const });
    // A blast's 80 and a round's 55 on the same tick: one flash at 0.8, one voice.
    const s = field();
    s.together = true;
    s.room = true;
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    const was = [s.suppression.flinchYaw, s.suppression.flinchPitch];
    expect(fb.frame(s, { ...none(), hits: [intoPlayer(s, 4)], harms: [shelled(s, 80)] }, NOW)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    expect(marker.calls).toEqual([['flash', 0.8, NOW]]);
    expect(fb.state()).toMatchObject({ voices: { hurt: 1 }, flashes: 1 });
    // The round jolts the aim (it came along +x: across the view) by its own share, not the blast's.
    expect(s.suppression.flinchYaw - was[0]).toBeCloseTo(1.5 + 1.5 * 0.55, 3);
    // Two blasts of 15 (30 all told) and the round's 55, the blasts a tick before it: one flash at 0.55, one voice.
    const m2 = new FakeMarker();
    const f2 = new HitFeedback(t, m2);
    expect(f2.frame(s, { ...none(), hits: [intoPlayer(s, 4)], harms: [shelled(s, 15, s.ticks - 1), shelled(s, 15, s.ticks - 1)] }, NOW)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    expect(m2.calls).toEqual([['flash', 0.55, NOW]]);
    // The front's round (owner 1) is felt in a room, so it takes the blasts' share too: 0.9 over 0.55.
    const m3 = new FakeMarker();
    expect(new HitFeedback(t, m3).frame(s, { ...none(), hits: [intoPlayer(s, 1)], harms: [shelled(s, 50), shelled(s, 40)] }, NOW)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    expect(m3.calls).toEqual([['flash', 0.9, NOW]]);
    // Rounds on two ticks and a blast: the blast joins the later tick's flash, which is the one left showing.
    const m4 = new FakeMarker();
    const early = { ...intoPlayer(s, 4), tick: s.ticks - 1 };
    expect(new HitFeedback(t, m4).frame(s, { ...none(), hits: [early, intoPlayer(s, 4)], harms: [shelled(s, 70, s.ticks - 1)] }, NOW)).toEqual([
      { kind: 'hurt', at: null, gain: 0.7 },
      { kind: 'hurt', at: null, gain: 0.7 },
    ]);
    expect(m4.calls).toEqual([
      ['flash', 0.55, NOW],
      ['flash', 0.7, NOW],
    ]);
    // Blasts alone in a frame: added up, one flash and one voice.
    const m5 = new FakeMarker();
    expect(new HitFeedback(t, m5).frame(s, { ...none(), harms: [shelled(s, 30), shelled(s, 20)] }, NOW)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    expect(m5.calls).toEqual([['flash', 0.5, NOW]]);
    // Out of a room the front's round is not felt, so it takes no share: the blast's flash is its own (both given here by hand).
    s.room = false;
    const m6 = new FakeMarker();
    expect(new HitFeedback(t, m6).frame(s, { ...none(), hits: [intoPlayer(s, 1)], harms: [shelled(s, 30)] }, NOW)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    expect(m6.calls).toEqual([['flash', 0.3, NOW]]);
  });

  it("in a room the front's hit on the player flashes as the harm it sends", () => {
    const s = field();
    const p = s.player;
    const chest = toWorld(pose({ position: p.position.toArray(), yaw: p.yaw, pitch: p.pitch, height: p.height, speed: 0, bob: p.bobPhase, deadFor: null }).torso, CHEST);
    // The front's round (owner 1) in the chest, from the line ahead: it has no gun, so its estimate is the zone's damage alone.
    const front = { ...none(), hits: [{ owner: 1, body: LOCAL_BODY, zone: 'torso' as const, position: chest, dir: [0, 0, -1] as V3, distance: 38, tick: s.ticks }] };
    const harmT = harmTunables(tun);
    // In a room: 55 × 0.6 = 33, the harm the page sends (combat/harm.ts frontHarm), flashed at 0.33.
    s.room = true;
    expect(frontHarm('torso', harmT)).toBe(33);
    const room = new FakeMarker();
    expect(new HitFeedback(t, room, harmT.frontDamageScale).frame(s, front, NOW)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    expect(room.calls).toEqual([['flash', 0.33, NOW]]);
    // Not in a room (a test's front at a together session): the front's round is not felt at all,
    // scaled or not (G3's ruling: in solo play it harms no one), so no flash and no voice.
    s.room = false;
    const solo = new FakeMarker();
    expect(new HitFeedback(t, solo, harmT.frontDamageScale).frame(s, front, NOW)).toEqual([]);
    expect(solo.calls).toEqual([]);
    // Another player's round in a room is theirs alone: an AK's chest hit, 55 × 1.05 = 58.
    s.room = true;
    const other = new FakeMarker();
    new HitFeedback(t, other, harmT.frontDamageScale).frame(s, { ...none(), hits: [{ ...front.hits[0], owner: 4, gun: 0 }] }, NOW);
    expect(other.calls).toEqual([['flash', 0.58, NOW]]);
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
  it("pellets into a dummy the range has dropped (killed earlier in their tick, or a tick before) give nothing: no head voice, no HEADSHOT; the kill bursts at the round that killed it", () => {
    const s = field();
    const them = body(200);
    s.targets = [them];
    const chest = chestOf(them);
    const head = headOf(them);
    // An M870's pull from 5 m: five pellets into the chest, the fifth killing it as the range says,
    // then one into the head and one more into the chest, all on one tick; and a round on a later tick.
    const pull = [...[-2, -1, 0, 1, 2].map((k) => [chest[0] + k * 0.05, chest[1], chest[2] - 5]), [head[0], head[1], head[2] - 5], [chest[0], chest[1] - 0.1, chest[2] - 5]];
    const first = strike(s, pull, [0, 0, 1]);
    expect(first.hits.map((h) => [h.body, h.zone])).toEqual([...Array.from({ length: 5 }, () => [200, 'torso']), [200, 'head'], [200, 'torso']]);
    expect(new Set(first.hits.map((h) => h.tick)).size).toBe(1);
    const later = strike(s, [[chest[0], chest[1] + 0.1, chest[2] - 5]], [0, 0, 1]);
    expect(later.hits[0].tick).toBeGreaterThan(first.hits[0].tick);
    const events = { ...first, hits: [...first.hits, ...later.hits] };
    const lethal = first.hits[4];
    // Unknowing, the feedback takes the trailing pellet in the head for a headshot.
    const blind = new FakeMarker();
    new HitFeedback(t, blind).frame(s, events, NOW, [drawn(them)]);
    expect(blind.calls.slice(0, 2)).toEqual([
      ['show', 'head', NOW],
      ['pop', 'HEADSHOT', null, NOW],
    ]);
    // Told the range dropped it at its fifth pellet: the hit marker and the thwack for the pellets
    // that struck it alive, and nothing for those that struck it dead.
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    const dropped: Dropped[] = [{ id: 200, tick: lethal.tick, index: 4 }];
    expect(fb.frame(s, events, NOW, [drawn(them)], dropped)).toEqual([{ kind: 'hit', at: null, gain: 0.7 }]);
    expect(marker.calls).toEqual([['show', 'hit', NOW]]);
    expect(fb.state()).toMatchObject({ voices: { hit: 1 }, markers: { hit: 1, head: 0, kill: 0 } });
    // Its last hit is the round that killed it: it flinches along that, the head unsnapped ...
    expect(fb.figureOverlay(200, NOW)).toEqual({ flinch: { dir: lethal.dir, age: 0, head: false } });
    // ... and the range's kill bursts there.
    const before = bloodOf(s).droplets.length;
    fb.kill(200, true, null, NOW, s, 'torso');
    expect(marker.calls.slice(1)).toEqual([
      ['show', 'kill', NOW],
      ['pop', 'KILL', null, NOW],
    ]);
    const thrown = bloodOf(s).droplets;
    expect(thrown.length - before).toBe(18);
    expect(thrown.filter((b) => near(b, lethal.position) < 1e-4)).toHaveLength(18);
  });

  it("a range kill the range reports as HEAD (an M870 pull with a pellet in the head, folded into one event, whichever pellet killed): the HEADSHOT pop, the faster fall, and no second burst", () => {
    const s = field();
    const them = body(200);
    s.targets = [them];
    const chest = chestOf(them);
    const head = headOf(them);
    // The pull: a pellet into the chest, one into the head, and one more into the chest, which kills.
    const events = strike(s, [[chest[0], chest[1], chest[2] - 5], [head[0], head[1], head[2] - 5], [chest[0] + 0.05, chest[1], chest[2] - 5]], [0, 0, 1]);
    expect(events.hits.map((h) => h.zone)).toEqual(['torso', 'head', 'torso']);
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    fb.frame(s, events, NOW, [drawn(them)], [{ id: 200, tick: events.hits[2].tick, index: 2 }]);
    // combat() bled the head pellet critical as it struck (18 droplets, 3 puffs), and one chest pellet
    // as any hit (6, 1): a body bleeds two of a tick's rounds, its headshots first. And spattered it.
    const before = { blood: bloodOf(s), spatter: bloodied(s, head) };
    expect([before.blood.droplets.length, before.blood.mists.length]).toEqual([18 + 6, 3 + 1]);
    expect(before.spatter).toBeGreaterThan(0);
    // The range's event for the pull: HEAD, as its fold has it (app/range.ts), the zone kill() is given.
    const e: RangeEvent = { kind: 'kill', id: 200, zone: 'head', damage: 88, distanceM: 5, shots: 1 };
    fb.kill(e.id, true, null, NOW, s, e.zone);
    expect(marker.calls).toEqual([
      ['show', 'head', NOW],
      ['pop', 'HEADSHOT', null, NOW],
      ['show', 'kill', NOW],
      ['pop', 'HEADSHOT', null, NOW],
    ]);
    expect(fb.figureOverlay(200, NOW).fallS).toBe(0.45);
    const after = bloodOf(s);
    expect([after.droplets.length, after.mists.length]).toEqual([before.blood.droplets.length, before.blood.mists.length]);
    expect(bloodied(s, head)).toBe(before.spatter);
  });

  it("torso, torso, then a head round that does not kill on its own, then the room's death by a torso round: one critical burst, the headshot's", () => {
    const s = field();
    const them = body(3);
    s.together = true;
    s.bodies = [them];
    const chest = chestOf(them);
    const head = headOf(them);
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    // An AK held on the chest climbs into the head: a round a frame, 100 ms apart. Each bleeds as it
    // strikes (combat()): the chest rounds 6 droplets, the headshot 18, critical.
    const bled: number[] = [];
    const struck = [[chest[0], chest[1] - 0.1, chest[2]], chest, head].map((aim, k) => {
      const was = bloodOf(s).droplets.length;
      const events = strike(s, [[aim[0], aim[1], aim[2] - 5]], [0, 0, 1]);
      bled.push(bloodOf(s).droplets.length - was);
      fb.frame(s, events, NOW + 100 * k, [drawn(them)]);
      return events.hits[0];
    });
    expect(struck.map((h) => h.zone)).toEqual(['torso', 'torso', 'head']);
    expect(bled).toEqual([6, 6, 18]);
    const before = { blood: bloodOf(s), spatter: bloodied(s, head) };
    // The room says the torso rounds killed (its harm, not this page's sight): no burst of the kill's.
    fb.kill(3, true, { name: 'Ann', team: 'blue' }, NOW + 300, s, 'torso');
    const after = bloodOf(s);
    expect([after.droplets.length, after.mists.length]).toEqual([before.blood.droplets.length, before.blood.mists.length]);
    expect(bloodied(s, head)).toBe(before.spatter);
    // It is still the kill: marked, popped and heard; and it falls along the last round.
    expect(marker.calls.slice(-2)).toEqual([
      ['show', 'kill', NOW + 300],
      ['pop', 'KILL', { name: 'Ann', team: 'blue' }, NOW + 300],
    ]);
    expect(fb.frame(s, none(), NOW + 316)).toEqual([{ kind: 'kill', at: null, gain: 0.3 }]);
    expect(fb.figureOverlay(3, NOW + 316)).toMatchObject({ fallYaw: 0, fallS: 0.7 });
  });

  it("the player killed by a round they never felt (a one-shot kill: the room's word before the round): the red flash at full strength and the hurt voice, once, and no jolt; 0.1 s after a felt hit, nothing more", () => {
    const s = field();
    s.together = true;
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    const was = [s.suppression.flinchYaw, s.suppression.flinchPitch];
    fb.died(NOW);
    expect(marker.calls).toEqual([['flash', 1, NOW]]);
    expect([s.suppression.flinchYaw, s.suppression.flinchPitch]).toEqual(was);
    // The room's word comes between frames: its voice with the next frame's, once.
    expect(fb.frame(s, none(), NOW + 16)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    expect(fb.frame(s, none(), NOW + 32)).toEqual([]);
    expect(fb.state()).toMatchObject({ voices: { hurt: 1 }, flashes: 1 });
    // A round felt as it struck, a head's (100: its flash at full), and the room's word 0.1 s on: its
    // flash still shows at 0.71, so the round's flash and voice alone.
    const felt = new FakeMarker();
    const after = new HitFeedback(t, felt);
    expect(after.frame(s, { ...none(), hits: [{ ...intoPlayer(s, 4), zone: 'head' }] }, NOW)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    after.died(NOW + 100);
    expect(after.frame(s, none(), NOW + 116)).toEqual([]);
    expect(felt.calls).toEqual([['flash', 1, NOW]]);
    expect(after.state()).toMatchObject({ voices: { hurt: 1 }, flashes: 1 });
    // Past half of hurt_flash_s, its flash faded below half, the room's word is felt: 0.2 s on (within
    // kill_window_s, which no longer decides it), and again 0.4 s on.
    const again = new FakeMarker();
    const later = new HitFeedback(t, again);
    later.frame(s, { ...none(), hits: [{ ...intoPlayer(s, 4), zone: 'head' }] }, NOW);
    later.died(NOW + 200);
    expect(again.calls.at(-1)).toEqual(['flash', 1, NOW + 200]);
    expect(later.frame(s, none(), NOW + 216)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    after.died(NOW + 400);
    expect(felt.calls.at(-1)).toEqual(['flash', 1, NOW + 400]);
    expect(after.frame(s, none(), NOW + 416)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
  });

  it("the player killed after a round or a blast felt: unless its red flash still shows at half or more (its strength, fading over hurt_flash_s), the death flashes again at full strength, so it reads; with its hurt voice only once half of hurt_flash_s has passed, so a felt round is not followed at once by a second", () => {
    const s = field();
    s.together = true;
    s.room = true;
    // fight.spec's headshot runs: the victim felt a round some 300 ms before the room's word, and its
    // flash, 0.55 fading over 0.35 s, showed at 0.10 to 0.19 as they died. A limb's round or a light
    // blast flashes at the least, 0.25: shown at 0.18 100 ms on.
    const felt = {
      0.25: () => ({ ...none(), harms: [{ tick: s.ticks, amount: 25, cause: 'shell' as const }] }),
      0.55: () => ({ ...none(), hits: [intoPlayer(s, 4)] }),
      1: () => ({ ...none(), hits: [{ ...intoPlayer(s, 4), zone: 'head' as const }] }),
    };
    // [strength felt, ms before the death, flashed again, its voice].
    const rows = [
      [0.25, 100, true, false],
      [0.55, 100, true, false],
      [0.55, 170, true, false],
      [0.55, 180, true, true],
      [0.55, 200, true, true],
      [0.55, 300, true, true],
      [1, 100, false, false],
      [1, 170, false, false],
      [1, 180, true, true],
    ] as const;
    for (const [strength, ago, again, voiced] of rows) {
      const label = `${strength} ${ago} ms before`;
      const marker = new FakeMarker();
      const fb = new HitFeedback(t, marker);
      expect(fb.frame(s, felt[strength](), NOW), label).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
      expect(marker.calls, label).toEqual([['flash', strength, NOW]]);
      fb.died(NOW + ago);
      const voices = fb.frame(s, none(), NOW + ago + 16);
      expect(marker.calls, label).toEqual(again ? [['flash', strength, NOW], ['flash', 1, NOW + ago]] : [['flash', strength, NOW]]);
      expect(voices, label).toEqual(voiced ? [{ kind: 'hurt', at: null, gain: 0.7 }] : []);
      expect(fb.state(), label).toMatchObject({ voices: { hurt: voiced ? 2 : 1 }, flashes: again ? 2 : 1 });
    }
  });

  it("the front's rounds (owner 1) into the player: nothing in solo play (puppets make it together), the flash in a room (the session's, as Together.prepare sets it); others' rounds always", () => {
    const s = field();
    s.together = true;
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    const was = [s.suppression.flinchYaw, s.suppression.flinchPitch];
    expect(s.room).toBe(false);
    expect('room' in fb).toBe(false);
    expect(fb.frame(s, { ...none(), hits: [intoPlayer(s, 1)] }, NOW)).toEqual([]);
    expect(marker.calls).toEqual([]);
    expect([s.suppression.flinchYaw, s.suppression.flinchPitch]).toEqual(was);
    // Another player's round (seat 0's, owner 2), in solo too: a puppet's world is a room's.
    expect(fb.frame(s, { ...none(), hits: [intoPlayer(s, 2)] }, NOW + 16)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    expect(marker.calls).toEqual([['flash', 0.55, NOW + 16]]);
    // In a room the front's rounds are felt (M6 brings its harm into rooms): the session says so.
    s.room = true;
    expect(fb.frame(s, { ...none(), hits: [intoPlayer(s, 1)] }, NOW + 32)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    expect(marker.calls.at(-1)).toEqual(['flash', 0.55, NOW + 32]);
    // Never the player's own.
    expect(fb.frame(s, { ...none(), hits: [intoPlayer(s, 0)] }, NOW + 48)).toEqual([]);
    expect(fb.state().flashes).toBe(2);
  });

  it('a round from straight ahead (along −forward) jolts the aim straight up, by the full 1.5° + 1.5° × its share', () => {
    const s = field();
    s.together = true;
    const p = s.player;
    expect([p.yaw, p.pitch]).toEqual([0, 0]);
    const chest = ownChest(s);
    // Seat 2's AK round (owner 4), from 5 m in front of the player, level, at their chest: along −z.
    const mark = encodeShotMark({ tracer: false, kind: 0, suppressed: false, gun: 'ak74' });
    const from: [number, number, number] = [chest[0], chest[1], chest[2] + 5];
    s.fireRemote(4, from, [0, 0, -1], false, from, mark);
    let events = none();
    for (let k = 0; k < 10 && events.hits.length === 0; k++) {
      s.tick();
      events = s.drainEvents();
    }
    expect(events.hits.map((h) => [h.owner, h.body, h.gun])).toEqual([[4, LOCAL_BODY, 0]]);
    const [hit] = events.hits;
    expect(hit.dir[2]).toBeCloseTo(-1, 6);
    const share = Math.min(1, gunDamage(DAMAGE[hit.zone], hit.gun) / 100);
    const was = [s.suppression.flinchYaw, s.suppression.flinchPitch];
    const marker = new FakeMarker();
    new HitFeedback(t, marker).frame(s, events, NOW);
    expect(marker.calls).toEqual([['flash', Math.max(0.25, share), NOW]]);
    expect(s.suppression.flinchPitch - was[1]).toBeCloseTo(1.5 + 1.5 * share, 3);
    expect(s.suppression.flinchYaw - was[0]).toBeCloseTo(0, 3);
  });

  it("nine of another's pellets into one body on one tick: one spatial hit voice, where the first struck", () => {
    const s = field();
    const them = body(3, 15);
    s.together = true;
    s.bodies = [them];
    const chest = chestOf(them);
    const grid = Array.from({ length: 9 }, (_, k) => [chest[0] + ((k % 3) - 1) * 0.06, chest[1] + (Math.floor(k / 3) - 1) * 0.06, chest[2] - 5]);
    // Seat 2's shotgun (owner 4), from 5 m short of them.
    const events = strike(s, grid, [0, 0, 1], 4);
    expect(events.hits).toHaveLength(9);
    expect(events.hits.every((h) => h.owner === 4 && h.body === 3 && h.zone === 'torso' && h.tick === events.hits[0].tick)).toBe(true);
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    expect(fb.frame(s, events, NOW, [drawn(them)])).toEqual([{ kind: 'hit', at: events.hits[0].position, gain: 0.7 }]);
    expect(marker.calls).toEqual([]);
    expect(fb.state().voices).toEqual({ hit: 1 });
  });

  it('the markers tallied are the markers shown: one that a greater marker still showing keeps from showing is not counted', () => {
    const s = field();
    const them = body(3);
    s.together = true;
    s.bodies = [them];
    const chest = chestOf(them);
    const events = strike(s, [[chest[0], chest[1], chest[2] - 5]], [0, 0, 1]);
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    marker.shows = false;
    expect(fb.frame(s, events, NOW, [drawn(them)])).toEqual([{ kind: 'hit', at: null, gain: 0.7 }]);
    expect(marker.calls).toEqual([['show', 'hit', NOW]]);
    expect(fb.state().markers).toEqual({ hit: 0, head: 0, kill: 0 });
    marker.shows = true;
    fb.kill(3, true, null, NOW + 100, s, 'torso');
    expect(fb.state().markers).toEqual({ hit: 0, head: 0, kill: 1 });
  });

  it("the room's word that another player's round hurt the player (harmed: a moving player's, whose page never struck that round on their body): the red flash at its share and the hurt voice, no jolt; felt once with a round struck here, whichever came first", () => {
    const s = field();
    s.together = true;
    s.room = true;
    const hurt = { kind: 'hurt', at: null, gain: 0.7 };
    const flinch = () => [s.suppression.flinchYaw, s.suppression.flinchPitch];
    // The word alone: the flash at 0.58, its voice with the next frame's; no jolt (it comes 100–250 ms
    // late, and a late jolt would read as the input lagging).
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    const was = flinch();
    fb.harmed(58, NOW);
    expect(marker.calls).toEqual([['flash', 0.58, NOW]]);
    expect(fb.frame(s, none(), NOW + 16)).toEqual([hurt]);
    expect(fb.frame(s, none(), NOW + 32)).toEqual([]);
    expect(flinch()).toEqual(was);
    expect(fb.state()).toMatchObject({ voices: { hurt: 1 }, flashes: 1 });
    // A light word flashes at the least, 0.25.
    const light = new FakeMarker();
    new HitFeedback(t, light).harmed(13, NOW);
    expect(light.calls).toEqual([['flash', 0.25, NOW]]);
    // A shotgun's pellets, the room's words one a pellet between two frames: one flash, at their sum's
    // share as it grows, and one voice.
    const pellets = new FakeMarker();
    const fp = new HitFeedback(t, pellets);
    for (let k = 0; k < 3; k++) fp.harmed(23, NOW);
    expect(pellets.calls).toEqual([['flash', 0.25, NOW], ['flash', 0.46, NOW], ['flash', 0.69, NOW]]);
    expect(fp.frame(s, none(), NOW + 16)).toEqual([hurt]);
    expect(fp.state()).toMatchObject({ voices: { hurt: 1 }, flashes: 1 });
    // The next frame's word is another hit's.
    fp.harmed(23, NOW + 16);
    expect(fp.frame(s, none(), NOW + 32)).toEqual([hurt]);
    expect(fp.state()).toMatchObject({ voices: { hurt: 2 }, flashes: 2 });
    // The round struck here first, the word 100 ms on: the round's flash, jolt and voice alone.
    const m2 = new FakeMarker();
    const f2 = new HitFeedback(t, m2);
    expect(f2.frame(s, { ...none(), hits: [intoPlayer(s, 4)] }, NOW)).toEqual([hurt]);
    f2.harmed(55, NOW + 100);
    expect(f2.frame(s, none(), NOW + 116)).toEqual([]);
    expect(m2.calls).toEqual([['flash', 0.55, NOW]]);
    expect(f2.state()).toMatchObject({ voices: { hurt: 1 }, flashes: 1 });
    // Past kill_window_s, a word is another hit's.
    f2.harmed(55, NOW + 400);
    expect(m2.calls.at(-1)).toEqual(['flash', 0.55, NOW + 400]);
    expect(f2.frame(s, none(), NOW + 416)).toEqual([hurt]);
    // The word first, the round struck here 100 ms on: the word's voice alone; the round still flashes and jolts.
    const m3 = new FakeMarker();
    const f3 = new HitFeedback(t, m3);
    f3.harmed(55, NOW);
    expect(f3.frame(s, none(), NOW + 16)).toEqual([hurt]);
    const before = flinch();
    expect(f3.frame(s, { ...none(), hits: [intoPlayer(s, 4)] }, NOW + 100)).toEqual([]);
    expect(m3.calls).toEqual([['flash', 0.55, NOW], ['flash', 0.55, NOW + 100]]);
    expect(s.suppression.flinchYaw - before[0]).toBeCloseTo(1.5 + 1.5 * 0.55, 3);
    expect(f3.state()).toMatchObject({ voices: { hurt: 1 }, flashes: 2 });
    // A blast felt counts as felt for the word as well: one voice.
    const m4 = new FakeMarker();
    const f4 = new HitFeedback(t, m4);
    expect(f4.frame(s, { ...none(), harms: [{ tick: s.ticks, amount: 40, cause: 'shell' }] }, NOW)).toEqual([hurt]);
    f4.harmed(30, NOW + 100);
    expect(f4.frame(s, none(), NOW + 116)).toEqual([]);
    expect(f4.state()).toMatchObject({ voices: { hurt: 1 }, flashes: 1 });
    // And a word is felt for the room's word of the death: a strong one 0.1 s before keeps it quiet.
    const m5 = new FakeMarker();
    const f5 = new HitFeedback(t, m5);
    f5.harmed(100, NOW);
    f5.died(NOW + 100);
    expect(m5.calls).toEqual([['flash', 1, NOW]]);
  });

  it("on the deploy screen (felt false: main's mode 'ready', a match on and its world running), nothing into the player is felt: no round's flash, jolt or voice, nor a shell's; gone in, the same is", () => {
    const s = field();
    s.together = true;
    s.room = true;
    const flinch = () => [s.suppression.flinchYaw, s.suppression.flinchPitch];
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    const was = flinch();
    const events = { ...none(), hits: [intoPlayer(s, 4)], harms: [{ tick: s.ticks, amount: 80, cause: 'shell' as const }] };
    expect(fb.frame(s, events, NOW, [], [], false)).toEqual([]);
    expect(fb.frame(s, { ...none(), harms: events.harms }, NOW + 16, [], [], false)).toEqual([]);
    expect(marker.calls).toEqual([]);
    expect(flinch()).toEqual(was);
    expect(fb.state()).toMatchObject({ voices: {}, flashes: 0 });
    // Gone in: one flash at the blast's 0.8, the round's jolt, one voice.
    expect(fb.frame(s, events, NOW + 32)).toEqual([{ kind: 'hurt', at: null, gain: 0.7 }]);
    expect(marker.calls).toEqual([['flash', 0.8, NOW + 32]]);
    expect(flinch()).not.toEqual(was);
  });

  it("a shotgun's pellets on one plate in a frame ring it once: one ding and one hit marker; two plates, a ding each; the next frame's ring again", () => {
    const s = field();
    const marker = new FakeMarker();
    const fb = new HitFeedback(t, marker);
    const a: [number, number, number] = [12.8, 1.3, 35];
    const b: [number, number, number] = [14.8, 1.3, 45];
    const plate = (index: number) => ({ kind: 'plate' as const, index, distanceM: 30 });
    fb.frame(s, none(), NOW);
    for (let k = 0; k < 3; k++) fb.plate(plate(0), a, NOW);
    expect(marker.calls).toEqual([['show', 'hit', NOW]]);
    expect(fb.frame(s, none(), NOW + 16)).toEqual([{ kind: 'ding', at: a, gain: 1.5 }]);
    expect(fb.state()).toMatchObject({ voices: { ding: 1 }, markers: { hit: 1, head: 0, kill: 0 } });
    // Two plates in a frame: each rung once.
    for (const [index, at] of [[0, a], [1, b], [1, b], [0, a]] as const) fb.plate(plate(index), at, NOW + 16);
    expect(fb.frame(s, none(), NOW + 32)).toEqual([
      { kind: 'ding', at: a, gain: 1.5 },
      { kind: 'ding', at: b, gain: 1.5 },
    ]);
    expect(fb.state()).toMatchObject({ voices: { ding: 3 }, markers: { hit: 3, head: 0, kill: 0 } });
  });

  it("a match's kill of a body that has moved on since its last hit (the room's word a round trip later): the burst where that round went in, carried on as its chest has moved; the spatter from where the round passed", () => {
    const s = field();
    const them = body(3);
    s.together = true;
    s.bodies = [them];
    const chest = chestOf(them);
    const events = strike(s, [[chest[0], chest[1], chest[2] - 5]], [0, 0, 1]);
    const [hit] = events.hits;
    const fb = new HitFeedback(t, new FakeMarker());
    fb.frame(s, events, NOW, [drawn(them)]);
    // 150 ms on, the runner is drawn 0.5 m to the right of where the round struck it.
    const ran = body(3, 25, 12.8 + 0.5);
    fb.frame(s, none(), NOW + 150, [drawn(ran)]);
    const bleed = vi.spyOn(s, 'bleed');
    const spatter = vi.spyOn(s, 'spatterAt');
    const before = bloodOf(s).droplets.length;
    fb.kill(3, true, null, NOW + 150, s, 'torso');
    const on: V3 = [hit.position[0] + 0.5, hit.position[1], hit.position[2]];
    const thrown = bloodOf(s).droplets;
    expect(thrown.length - before).toBe(18);
    expect(thrown.filter((d) => near(d, on) < 1e-4)).toHaveLength(18);
    expect(bleed).toHaveBeenCalledTimes(1);
    expect(near(bleed.mock.calls[0][0], on)).toBeLessThan(1e-9);
    expect(spatter).toHaveBeenCalledTimes(1);
    expect(spatter.mock.calls[0][0]).toEqual(hit.position);
    // Its fall is along the round, as before.
    expect(fb.figureOverlay(3, NOW + 150).fallYaw).toBeCloseTo(0, 6);
  });
});
