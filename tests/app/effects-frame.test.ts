import { describe, expect, it } from 'vitest';
import { CameraRig, rigTunables } from '../../src/app/camera-rig';
import { EffectsFrameBuilder, effectsTunables } from '../../src/app/effects-frame';
import { projectileSpec } from '../../src/combat/ballistics';
import { BILLBOARD_FLOATS } from '../../src/combat/particles';
import { RIFLE_MUZZLE, RIFLE_PORT } from '../../src/combat/rifle-model';
import { loadTunables } from '../../src/core/tunables';
import { RIBBON_FLOATS } from '../../src/render/effects';
import { throughPose, type RiflePose } from '../../src/render/rifle';
import { Session, type CombatEvents } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// A frame's effects, built from the session and the events it drained: each shot's flash star and
// light for flash_s of the world's time, at the drawn rifle's muzzle; the tracers, drawn from the
// muzzle for the player's and joining the round's path; and the particles, the shot's own leaving
// the drawn rifle.
const tun = loadTunables();
const t = effectsTunables(tun);
const none = (): CombatEvents => ({ shots: [], frontShots: [], impacts: [], cracks: [], craters: [], incoming: [], blasts: [] });
type V3 = [number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: readonly number[]): V3 => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
};
const close = (got: readonly number[], want: readonly number[], digits: number, what = '') => [0, 1, 2].forEach((k) => expect(got[k], `${what}[${k}]`).toBeCloseTo(want[k], digits));

/** 25.6 × 6.4 × 51.2 m of open ground. */
function stand(): Session {
  const map = new BrickMap({ x: 256, y: 64, z: 512 });
  map.fillBox(0, 0, 0, 256, 4, 512, P.SOD);
  const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 2] } }, tun, 7, 0);
  for (let k = 0; k < 40; k++) s.tick();
  s.drainEvents();
  return s;
}

function shoot(s: Session): CombatEvents {
  s.intent = { ...s.intent, fire: true };
  s.tick();
  s.intent = { ...s.intent, fire: false };
  return s.drainEvents();
}

/**
 * Walking at 144 frames a second, as the game draws it, until a shot leaves: that frame's events
 * and its drawn rifle (the review's case: the tick's muzzle centimetres from the drawn one).
 */
function walkAndShoot(): { s: Session; events: CombatEvents; rifle: RiflePose } {
  const s = stand();
  const rig = new CameraRig(rigTunables(tun));
  const frame = () => {
    s.advance(1 / 144);
    const rifle = rig.rifle(s, rig.pose(s, 1 / 144));
    return { rifle, events: s.drainEvents() };
  };
  s.intent = { ...s.intent, forward: 1 };
  for (let f = 0; f < 100; f++) frame();
  s.intent = { ...s.intent, fire: true };
  for (let f = 0; f < 30; f++) {
    const { rifle, events } = frame();
    if (events.shots.length > 0) {
      s.intent = { ...s.intent, fire: false };
      return { s, events, rifle };
    }
  }
  throw new Error('no shot');
}

/** The ribbon `i`'s tail and head. */
function ribbon(r: Float32Array, i: number): { tail: number[]; head: number[] } {
  const o = i * RIBBON_FLOATS;
  return { tail: [r[o], r[o + 1], r[o + 2]], head: [r[o + 4], r[o + 5], r[o + 6]] };
}

describe('a frame of effects', () => {
  it("a shot's flash star and light show for flash_s of the world's time, at 30, 60 or 144 frames a second, then not", () => {
    // The review's case: flash_frames frames were 33 ms at 60 Hz and 14 ms at 144 Hz.
    for (const rate of [30, 60, 144]) {
      const s = stand();
      const events = shoot(s);
      expect(events.shots.length).toBe(1);
      const b = new EffectsFrameBuilder(t);
      let built = b.build(s, events);
      // No rifle drawn: where the shot left it.
      expect(built.lights[0].position).toEqual(events.shots[0].muzzle);
      expect(built.lights[0].radiusM).toBe(t.flashLightRadiusM);
      expect(built.lights[0].intensity).toBe(t.flashLightIntensity);
      let frames = 0;
      while (built.lights.length > 0 && frames < 100) {
        expect(built.counts.stars).toBe(3);
        frames++;
        s.advance(1 / rate);
        built = b.build(s, s.drainEvents());
      }
      expect(frames, `${rate} Hz`).toBe(Math.ceil(t.flashS * rate));
      expect(built.counts.stars).toBe(0);
    }
  });

  it('a paused world holds its flash', () => {
    const s = stand();
    const b = new EffectsFrameBuilder(t);
    b.build(s, shoot(s));
    for (let k = 0; k < 10; k++) expect(b.build(s, none()).lights.length).toBe(1);
  });

  it("the flash's star and light are at the drawn rifle's muzzle, along its bore, and follow it while they show", () => {
    const { s, events, rifle } = walkAndShoot();
    const drawn = throughPose(rifle.toWorld, RIFLE_MUZZLE);
    const gap = Math.hypot(...sub(events.shots[0].muzzle, drawn));
    expect(gap).toBeGreaterThan(0.005);
    const b = new EffectsFrameBuilder(t);
    let built = b.build(s, events, rifle);
    expect(built.lights.length).toBe(1);
    close(built.lights[0].position, drawn, 5, 'light');
    const n = built.frame.ribbonCount;
    expect(built.counts.stars).toBe(3);
    for (let i = n - 3; i < n; i++) close(ribbon(built.frame.ribbons, i).tail, drawn, 5, `ray ${i}`);
    const forward = ribbon(built.frame.ribbons, n - 3);
    close(unit(sub(forward.head, forward.tail)), unit([rifle.toWorld[6], rifle.toWorld[7], rifle.toWorld[8]]), 4, 'bore');
    // Drawn elsewhere the next frame, the flash goes with it.
    const moved = new Float32Array(rifle.toWorld);
    moved[9] += 0.05;
    moved[10] -= 0.04;
    moved[11] += 0.03;
    built = b.build(s, none(), { toWorld: moved, prevToWorld: rifle.toWorld });
    expect(built.lights.length).toBe(1);
    close(built.lights[0].position, throughPose(moved, RIFLE_MUZZLE), 5, 'moved');
  });

  it("the shot's flash and brass leave the drawn rifle, joining their own paths over particle_attach_s", () => {
    const { s, events, rifle } = walkAndShoot();
    const loose = new EffectsFrameBuilder(t).build(s, events).frame;
    const free = Array.from(loose.billboards.slice(0, loose.billboardCount * BILLBOARD_FLOATS));
    const held = new EffectsFrameBuilder(t).build(s, events, rifle).frame;
    expect(held.billboardCount).toBe(2);
    // Thrown in the shot's tick and stepped once with it.
    const share = 1 - 1 / 60 / t.particleAttachS;
    const drift = { 1: sub(throughPose(rifle.toWorld, RIFLE_MUZZLE), s.muzzle()), 0: sub(throughPose(rifle.toWorld, RIFLE_PORT), s.port()) };
    for (let i = 0; i < 2; i++) {
      const o = i * BILLBOARD_FLOATS;
      const emissive = held.billboards[o + 8] as 0 | 1;
      const want = drift[emissive].map((d) => d * share);
      expect(Math.hypot(...want), emissive ? 'flash' : 'brass').toBeGreaterThan(0.005);
      close(sub(Array.from(held.billboards.slice(o, o + 3)), free.slice(o, o + 3)), want, 5, emissive ? 'flash' : 'brass');
    }
  });

  it('two shots in one frame show two stars and two lights', () => {
    const s = stand();
    const one = shoot(s);
    const two: CombatEvents = { ...none(), shots: [one.shots[0], { ...one.shots[0], tick: one.shots[0].tick + 1 }] };
    const built = new EffectsFrameBuilder(t).build(s, two);
    expect(built.counts.stars).toBe(6);
    expect(built.lights.length).toBe(2);
  });

  it("the player's tracer leaves the muzzle and joins the round's path by tracer_converge_m", () => {
    const s = stand();
    const origin: [number, number, number] = [12.8, 2.0, 2];
    const from: [number, number, number] = [12.98, 1.79, 3.16];
    s.rounds.fire(origin, [0, 0, 880], projectileSpec(tun, 'assault_rifle'), 0, true, from);
    s.rounds.step(1 / 60);
    const b = new EffectsFrameBuilder(t);
    let built = b.build(s, none());
    expect(built.counts.tracers).toBe(1);
    const path = s.rounds.tracerSegments(t.tracerLengthM);
    const offset = [from[0] - origin[0], from[1] - origin[1], from[2] - origin[2]];
    const drawn = ribbon(built.frame.ribbons, 0);
    const flown = path.flown[0];
    const length = Math.hypot(path.head[0] - path.tail[0], path.head[1] - path.tail[1], path.head[2] - path.tail[2]);
    for (const [end, at] of [['head', flown], ['tail', flown - length]] as const) {
      const share = Math.max(0, 1 - at / t.tracerConvergeM);
      const round = end === 'head' ? path.head : path.tail;
      for (let k = 0; k < 3; k++) expect(drawn[end][k]).toBeCloseTo(round[k] + offset[k] * share, 3);
    }
    // Past the convergence, on the round's path, at most tracer_length_m long.
    for (let k = 0; k < 2; k++) s.rounds.step(1 / 60);
    built = b.build(s, none());
    const late = s.rounds.tracerSegments(t.tracerLengthM);
    const on = ribbon(built.frame.ribbons, 0);
    for (let k = 0; k < 3; k++) {
      expect(on.head[k]).toBeCloseTo(late.head[k], 4);
      expect(on.tail[k]).toBeCloseTo(late.tail[k], 4);
    }
    expect(Math.hypot(on.head[0] - on.tail[0], on.head[1] - on.tail[1], on.head[2] - on.tail[2])).toBeLessThanOrEqual(t.tracerLengthM + 1e-4);
  });

  it("a blast's light flares and dies over blast_light_s of the world's time, a metre over where it landed", () => {
    const s = stand();
    const b = new EffectsFrameBuilder(t);
    const blast: CombatEvents = { ...none(), blasts: [{ tick: s.ticks, at: [12.8, 0.4, 20], radiusM: 3, material: P.SOD }] };
    let built = b.build(s, blast);
    expect(built.blasts).toEqual([{ position: [12.8, 1.4, 20], radiusM: t.blastLightRadiusM, colour: t.blastLightColour, intensity: t.blastLightIntensity }]);
    // Half way, a quarter as bright; at the end, gone.
    const half = Math.round((t.blastLightS / 2) * 60);
    for (let k = 0; k < half; k++) s.tick();
    built = b.build(s, none());
    expect(built.blasts.length).toBe(1);
    expect(built.blasts[0].intensity).toBeCloseTo(t.blastLightIntensity * 0.25, 6);
    for (let k = 0; k < half; k++) s.tick();
    expect(b.build(s, none()).blasts).toEqual([]);
  });

  it("a paused world holds a blast's light", () => {
    const s = stand();
    const b = new EffectsFrameBuilder(t);
    b.build(s, { ...none(), blasts: [{ tick: s.ticks, at: [12.8, 0.4, 20], radiusM: 3, material: P.SOD }] });
    for (let k = 0; k < 10; k++) expect(b.build(s, none()).blasts[0].intensity).toBe(t.blastLightIntensity);
  });

  it("a blast's smoke rises, spreads and thins, and is gone by smoke_s", () => {
    const s = stand();
    const b = new EffectsFrameBuilder(t);
    const crater = 3;
    let built = b.build(s, { ...none(), blasts: [{ tick: s.ticks, at: [12.8, 0.4, 20], radiusM: crater, material: P.SOD }] });
    expect(built.smoke.length).toBe(t.smokePuffs);
    const start = built.smoke.map((p) => ({ ...p, centre: [...p.centre] }));
    for (const p of start) {
      expect(p.radiusM).toBeCloseTo(t.smokeRadiusScale * crater, 9);
      expect(p.density).toBeCloseTo(t.smokeDensity, 9);
      expect(Math.hypot(p.centre[0] - 12.8, p.centre[2] - 20)).toBeLessThanOrEqual(crater / 3 + 1e-9);
    }
    for (let k = 0; k < 5 * 60; k++) s.tick();
    built = b.build(s, none());
    expect(built.smoke.length).toBe(t.smokePuffs);
    built.smoke.forEach((p, i) => {
      expect(p.centre[1] - start[i].centre[1]).toBeCloseTo(t.smokeRiseMS * 5, 6);
      expect(p.radiusM - start[i].radiusM).toBeCloseTo(t.smokeSpreadMS * 5, 6);
      expect(p.density).toBeCloseTo(t.smokeDensity * (1 - 5 / t.smokeS) ** 2, 6);
    });
    for (let k = 0; k < (t.smokeS - 5) * 60; k++) s.tick();
    expect(b.build(s, none()).smoke).toEqual([]);
  });

  it('at most 16 puffs are drawn, the nearest the eye', () => {
    const s = stand();
    const b = new EffectsFrameBuilder(t);
    // Farthest first, so the first sixteen are not the nearest.
    const blasts = Array.from({ length: 10 }, (_, k) => ({ tick: s.ticks, at: [12.8, 0.4, 46 - 4 * k] as [number, number, number], radiusM: 2.5, material: P.SOD }));
    const eye: [number, number, number] = [12.8, 2, 0];
    const built = b.build(s, { ...none(), blasts }, null, eye);
    expect(built.smoke.length).toBe(16);
    const far = (p: { centre: number[] }) => Math.hypot(p.centre[0] - eye[0], p.centre[1] - eye[1], p.centre[2] - eye[2]);
    const drawn = Math.max(...built.smoke.map(far));
    // The nearest blasts' puffs, every one of the first five's.
    expect(drawn).toBeLessThan(10 + 4 * 6);
  });

  it("the session's particles are the frame's billboards", () => {
    const s = stand();
    const built = new EffectsFrameBuilder(t).build(s, shoot(s));
    expect(built.counts.billboards).toBe(s.particles.count);
    expect(built.frame.billboardCount).toBe(s.particles.count);
  });
});
