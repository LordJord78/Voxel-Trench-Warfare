import { describe, expect, it } from 'vitest';
import { lineSource, type FrontSource } from '../../src/combat/front';
import { loadTunables } from '../../src/core/tunables';
import { encodeShotMark, TRACER_KIND } from '../../src/net/gear';
import { idleIntent, Session } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

const tun = loadTunables();

/** 25.6 × 6.4 × 25.6 m of sod floor. */
function arena(): BrickMap {
  const map = new BrickMap({ x: 256, y: 64, z: 256 });
  map.fillBox(0, 0, 0, 256, 4, 256, P.SOD);
  return map;
}

/** A session with the player standing at (12.8, 0.4, 5) m, settled. */
function stand(front?: FrontSource): Session {
  const s = Session.create({ map: arena(), plan: null, spawn: { position: [12.8, 0.4, 5] }, front }, tun, 7, 0);
  s.intent = idleIntent();
  for (let k = 0; k < 40; k++) s.tick();
  return s;
}

/** The kinds of the rounds the player's one shotgun shot put in the air. */
function shotgunKinds(team?: 'blue'): { live: number; tracers: boolean[]; kinds: number[] } {
  const s = stand();
  if (team) s.team = team;
  s.equip({ primary: 'm870', secondary: 'm17', fits: {} });
  for (let k = 0; k < 120; k++) s.tick(); // the gun comes up
  s.intent = { ...s.intent, fire: true };
  s.tick();
  s.intent = { ...s.intent, fire: false };
  const live = s.rounds.count;
  return {
    live,
    tracers: Array.from({ length: live }, (_, slot) => s.rounds.isTracer(slot)),
    kinds: Array.from(s.rounds.tracerSegments(7).kind),
  };
}

describe("a session's tracers", () => {
  it("the player's rounds are red in solo, blue on Blue, and every shotgun pellet is a tracer", () => {
    const red = shotgunKinds();
    expect(red.live).toBe(9);
    expect(red.tracers.every(Boolean)).toBe(true);
    expect(red.kinds).toEqual(Array(9).fill(TRACER_KIND.red));
    const blue = shotgunKinds('blue');
    expect(blue.kinds).toEqual(Array(9).fill(TRACER_KIND.blue));
  });

  it("another player's tracer takes the kind it is given; a non-tracer draws nothing", () => {
    const s = stand();
    const o: [number, number, number] = [10, 1.6, 10];
    const d: [number, number, number] = [0, 0, 1];
    s.fireRemote(2, o, d, true, o, undefined, TRACER_KIND.blue);
    expect(Array.from(s.rounds.tracerSegments(7).kind)).toEqual([TRACER_KIND.blue]);
    s.fireRemote(3, o, d, false, o, undefined, TRACER_KIND.red);
    expect(s.rounds.isTracer(1)).toBe(false);
    // Without a kind, today's rule: amber.
    s.fireRemote(4, o, d, true, o);
    expect(s.rounds.isTracer(2)).toBe(true);
    expect(Array.from(s.rounds.tracerSegments(7).kind)).toEqual([TRACER_KIND.blue, TRACER_KIND.amber]);
  });

  it("another player's shotgun: all 9 pellets in the kind given (their seat's), whatever the shot's word says, each lit in as a hip shot's", () => {
    const s = stand();
    const o: [number, number, number] = [10, 1.6, 10];
    const d: [number, number, number] = [0, 0, 1];
    // Their word says red; their seat is Blue's.
    s.fireRemote(2, o, d, true, o, encodeShotMark({ tracer: true, kind: TRACER_KIND.red, suppressed: false, gun: 'm870' }), TRACER_KIND.blue);
    expect(s.rounds.count).toBe(9);
    const seg = s.rounds.tracerSegments(7);
    expect(Array.from(seg.kind)).toEqual(Array(9).fill(TRACER_KIND.blue));
    // A shot's word carries no share aimed: unset (−1), the draw's own, a hip shot's (tracer_ignite_hip_m).
    expect(Array.from(seg.ignite)).toEqual(Array(9).fill(-1));
    expect(Array.from(seg.owner)).toEqual(Array(9).fill(2));
  });

  it("the front fires tracers at light as at heavy, each lit in as a hip shot's", () => {
    const s = stand(lineSource(38, 0.4));
    s.front.intensity = 'light';
    const shots: boolean[] = [];
    const ignites: number[] = [];
    for (let k = 0; k < 60 * 120 && shots.length < 3; k++) {
      s.tick();
      const fired = s.drainEvents().frontShots;
      for (const f of fired) shots.push(f.tracer);
      // Just fired, in the pool: the front's (owner 1), its ignition unset (−1), a hip shot's.
      if (fired.length > 0) {
        const seg = s.rounds.tracerSegments(7);
        for (let i = 0; i < seg.owner.length; i++) if (seg.owner[i] === 1) ignites.push(seg.ignite[i]);
      }
    }
    expect(shots.length).toBeGreaterThanOrEqual(3);
    expect(shots.every(Boolean)).toBe(true);
    expect(ignites.length).toBeGreaterThanOrEqual(3);
    expect(ignites.every((m) => m === -1)).toBe(true);
  });
});
