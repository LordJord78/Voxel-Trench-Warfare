import { describe, expect, it } from 'vitest';
import { lineSource, type FrontSource } from '../../src/combat/front';
import { loadTunables } from '../../src/core/tunables';
import { TRACER_KIND } from '../../src/net/gear';
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

  it('the front fires tracers at light as at heavy', () => {
    const s = stand(lineSource(38, 0.4));
    s.front.intensity = 'light';
    const shots: boolean[] = [];
    for (let k = 0; k < 60 * 120 && shots.length < 3; k++) {
      s.tick();
      for (const f of s.drainEvents().frontShots) shots.push(f.tracer);
    }
    expect(shots.length).toBeGreaterThanOrEqual(3);
    expect(shots.every(Boolean)).toBe(true);
  });
});
