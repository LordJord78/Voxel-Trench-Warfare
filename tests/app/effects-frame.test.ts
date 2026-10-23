import { describe, expect, it } from 'vitest';
import { EffectsFrameBuilder, effectsTunables } from '../../src/app/effects-frame';
import { projectileSpec } from '../../src/combat/ballistics';
import { loadTunables } from '../../src/core/tunables';
import { RIBBON_FLOATS } from '../../src/render/effects';
import { Session, type CombatEvents } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// A frame's effects, built from the session and the events it drained: each shot's flash star and
// light for flash_frames frames, the tracers, drawn from the muzzle for the player's and joining
// the round's path, and the particles.
const tun = loadTunables();
const t = effectsTunables(tun);
const none = (): CombatEvents => ({ shots: [], frontShots: [], impacts: [], cracks: [] });

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

/** The ribbon `i`'s tail and head. */
function ribbon(r: Float32Array, i: number): { tail: number[]; head: number[] } {
  const o = i * RIBBON_FLOATS;
  return { tail: [r[o], r[o + 1], r[o + 2]], head: [r[o + 4], r[o + 5], r[o + 6]] };
}

describe('a frame of effects', () => {
  it("a shot's flash star and light show for flash_frames frames at its muzzle, then not", () => {
    const s = stand();
    const events = shoot(s);
    expect(events.shots.length).toBe(1);
    const b = new EffectsFrameBuilder(t);
    const seen: [number, number][] = [];
    let built = b.build(s, events);
    seen.push([built.counts.stars, built.lights.length]);
    expect(built.lights[0].position).toEqual(events.shots[0].muzzle);
    expect(built.lights[0].radiusM).toBe(t.flashLightRadiusM);
    expect(built.lights[0].intensity).toBe(t.flashLightIntensity);
    for (let k = 1; k < t.flashFrames + 2; k++) {
      built = b.build(s, none());
      seen.push([built.counts.stars, built.lights.length]);
    }
    expect(seen).toEqual([...Array.from({ length: t.flashFrames }, () => [3, 1]), [0, 0], [0, 0]]);
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

  it("the session's particles are the frame's billboards", () => {
    const s = stand();
    const built = new EffectsFrameBuilder(t).build(s, shoot(s));
    expect(built.counts.billboards).toBe(s.particles.count);
    expect(built.frame.billboardCount).toBe(s.particles.count);
  });
});
