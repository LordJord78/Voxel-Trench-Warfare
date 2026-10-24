import { describe, expect, it } from 'vitest';
import { CameraRig, rigTunables } from '../../src/app/camera-rig';
import { EffectsFrameBuilder, effectsTunables, NO_BATTLE, type ShownBattle } from '../../src/app/effects-frame';
import { farShellTunables } from '../../src/battle/far-shells';
import { tracerTunables, type TracerState } from '../../src/battle/tracers';
import { flareTunables, type FlareState } from '../../src/battle/flares';
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
const none = (): CombatEvents => ({ shots: [], frontShots: [], impacts: [], cracks: [], cuts: [], craters: [], incoming: [], blasts: [], scoops: [] });
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
  it('a flare climbing is a spark where it is, a burning flare a bright disc by its glow; one out is nothing', () => {
    const ft = flareTunables(tun);
    const b = new EffectsFrameBuilder(t);
    const s = stand();
    const flares: FlareState[] = [
      { id: 1, position: [10, 20, 30], glow: 0, stage: 'climb', colour: [1, 0.88, 0.7] },
      { id: 2, position: [40, 35, 60], glow: 0.5, stage: 'burning', colour: [1, 0.25, 0.15] },
      { id: 3, position: [70, 30, 90], glow: 0, stage: 'out', colour: [1, 0.88, 0.7] },
    ];
    const built = b.build(s, none(), null, undefined, { ...NO_BATTLE, flares });
    const out = built.frame.billboards;
    const all = Array.from({ length: built.frame.billboardCount }, (_, i) => Array.from(out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS)));
    const at = (p: readonly number[]) => all.filter((q) => q[0] === p[0] && q[1] === p[1] && q[2] === p[2]);
    const [spark] = at(flares[0].position);
    expect(spark[3]).toBeCloseTo(ft.sparkSizeM / 2, 6);
    expect(spark[8]).toBe(1);
    expect(spark[4]).toBeCloseTo(ft.sparkGlow, 6);
    const [disc] = at(flares[1].position);
    expect(disc[3]).toBeCloseTo(ft.discSizeM / 2, 6);
    expect(disc[8]).toBe(1);
    expect(disc[4]).toBeCloseTo(ft.discGlow * 0.5, 6);
    expect(disc[5]).toBeCloseTo(ft.discGlow * 0.5 * 0.25, 6);
    expect(at(flares[2].position)).toEqual([]);
  });
  it("a far shell's flash is an emissive disc growing from 6 to 12 m over 0.2 s, gone after; a shell beyond the map draws none", () => {
    const fs = farShellTunables(tun);
    const shown = (seconds: number): ShownBattle => ({
      ...NO_BATTLE,
      seconds,
      flashes: [
        { id: 2, position: [3000, 16, 4000], t: 10.05, power: 1, far: false },
        { id: 1, position: [500, 20, 700], t: 10, power: 1, far: true },
      ],
    });
    const all = (seconds: number) => {
      const built = new EffectsFrameBuilder(t).build(stand(), none(), null, undefined, shown(seconds));
      const out = built.frame.billboards;
      return Array.from({ length: built.frame.billboardCount }, (_, i) => Array.from(out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS)));
    };
    // 0.1 s in, halfway: 9 m across, standing on the ground, emissive, half as bright as it began.
    const half = all(10.1);
    expect(half.filter((q) => q[0] === 3000)).toEqual([]);
    const [flash] = half.filter((q) => q[0] === 500);
    expect(flash[3]).toBeCloseTo(4.5, 5);
    expect(flash[1]).toBeCloseTo(20 + 4.5, 5);
    expect(flash[2]).toBe(700);
    expect(flash[8]).toBe(1);
    for (let c = 0; c < 3; c++) expect(flash[4 + c]).toBeCloseTo(t.distantColour[c] * fs.flashGlow * 0.5, 5);
    expect(all(10.25).filter((q) => q[0] === 500)).toEqual([]);
    expect(fs.flashSizeM).toEqual([6, 12]);
  });

  it("its column's puffs are lit discs, premultiplied by their alpha", () => {
    const fs = farShellTunables(tun);
    const built = new EffectsFrameBuilder(t).build(stand(), none(), null, undefined, { ...NO_BATTLE, smoke: [{ centre: [510, 40, 705], radiusM: 5, alpha: 0.4 }] });
    const out = built.frame.billboards;
    const all = Array.from({ length: built.frame.billboardCount }, (_, i) => Array.from(out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS)));
    const [puff] = all.filter((q) => q[0] === 510);
    expect(puff.slice(0, 4)).toEqual([510, 40, 705, 5]);
    for (let c = 0; c < 3; c++) expect(puff[4 + c]).toBeCloseTo(fs.smokeColour[c] * 0.4, 6);
    expect(puff[7]).toBeCloseTo(0.4, 6);
    expect(puff[8]).toBe(0);
  });

  it("a battle tracer is a ribbon from its trail to its head, as the session's are", () => {
    const tracers: TracerState[] = [
      { id: 1, position: [50, 30, 80], velocity: [400, 0, 300], flown: 100 },
      { id: 2, position: [60, 31, 90], velocity: [0, 0, 500], flown: 3 },
    ];
    const built = new EffectsFrameBuilder(t).build(stand(), none(), null, [50, 20, 70], { ...NO_BATTLE, tracers });
    const r = built.frame.ribbons;
    expect(built.counts.battleTracers).toBe(2);
    const at = (i: number) => Array.from(r.slice(i * RIBBON_FLOATS, (i + 1) * RIBBON_FLOATS));
    // The nearer the eye first: the first, 10.4 m off; its trail the battle's trail_m back along its
    // way (two frames' flight at 60 Hz: a far tracer seen as the streak it makes).
    const tt = tracerTunables(tun);
    expect(tt.trailM).toBe(24);
    const first = at(0);
    close(first.slice(4, 7), [50, 30, 80], 6, 'head');
    close(first.slice(0, 3), [50 - 0.8 * tt.trailM, 30, 80 - 0.6 * tt.trailM], 5, 'tail');
    expect(first[3]).toBeCloseTo(t.tracerWidthM, 6);
    expect(first[7]).toBeCloseTo(t.tracerTailAlpha, 6);
    expect(first[11]).toBe(1);
    for (let c = 0; c < 3; c++) expect(first[8 + c]).toBeCloseTo(t.tracerColour[c] * t.tracerIntensity, 4);
    // One just fired: its trail only as long as its flight.
    close(at(1).slice(0, 3), [60, 31, 87], 5, 'short tail');
  });

  it("at most max_drawn battle tracers, the nearest the eye, after the session's own", () => {
    const tt = tracerTunables(tun);
    const { s, events, rifle } = walkAndShoot();
    const eye: V3 = [0, 20, 0];
    const tracers: TracerState[] = Array.from({ length: 500 }, (_, i) => ({ id: i, position: [10 + i, 30, 0], velocity: [0, 0, 500], flown: 50 }));
    const built = new EffectsFrameBuilder(t).build(s, events, rifle, eye, { ...NO_BATTLE, tracers });
    expect(built.counts.battleTracers).toBe(tt.maxDrawn);
    const own = built.counts.tracers + built.counts.stars;
    expect(own).toBeGreaterThan(0);
    const heads = Array.from({ length: built.counts.battleTracers }, (_, i) => ribbon(built.frame.ribbons, own + i).head[0]);
    expect(Math.max(...heads)).toBeLessThan(10 + tt.maxDrawn);
    expect(tt.maxDrawn).toBe(400);
  });

  it("a flare's spark and disc are dimmed by the sky's flares key, as its light is", () => {
    const ft = flareTunables(tun);
    const b = new EffectsFrameBuilder(t);
    const flares: FlareState[] = [
      { id: 1, position: [10, 20, 30], glow: 0, stage: 'climb', colour: [1, 0.88, 0.7] },
      { id: 2, position: [40, 35, 60], glow: 1, stage: 'burning', colour: [1, 0.88, 0.7] },
    ];
    const built = b.build(stand(), none(), null, undefined, { ...NO_BATTLE, flares }, 0.2);
    const out = built.frame.billboards;
    const all = Array.from({ length: built.frame.billboardCount }, (_, i) => Array.from(out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS)));
    const at = (p: readonly number[]) => all.find((q) => q[0] === p[0] && q[1] === p[1] && q[2] === p[2])!;
    expect(at(flares[0].position)[4]).toBeCloseTo(ft.sparkGlow * 0.2, 6);
    expect(at(flares[1].position)[4]).toBeCloseTo(ft.discGlow * 0.2, 6);
  });
});
