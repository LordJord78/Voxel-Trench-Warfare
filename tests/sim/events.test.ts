import { describe, expect, it } from 'vitest';
import { lineSource, type FrontSource } from '../../src/combat/front';
import { loadTunables } from '../../src/core/tunables';
import { Session } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// A frame drains what its ticks did: two ticks or none, nothing is lost and nothing is doubled,
// and each event knows its tick (milestone 1's deferred minor: shots and impacts were the last
// tick's only).
const tun = loadTunables();

/** 25.6 × 6.4 × 51.2 m: a floor 0.4 m deep and a clay wall at z 3–6 m. */
function arena(): BrickMap {
  const map = new BrickMap({ x: 256, y: 64, z: 512 });
  map.fillBox(0, 0, 0, 256, 4, 512, P.SOD);
  map.fillBox(0, 4, 50, 256, 64, 80, P.CLAY);
  return map;
}

function stand(seed = 7, front?: FrontSource): Session {
  const s = Session.create({ map: arena(), plan: null, spawn: { position: [12.8, 0.4, 2] }, front }, tun, seed, 0);
  for (let k = 0; k < 40; k++) s.tick();
  s.drainEvents();
  return s;
}

const key = (e: { tick: number; origin?: number[]; position?: number[] }) => `${e.tick}@${(e.origin ?? e.position)!.map((v) => v.toFixed(9)).join()}`;

describe("a frame's combat events", () => {
  it("frames of several ticks keep every tick's shots and impacts, each with its tick", () => {
    const framed = stand();
    const ticked = stand();
    framed.intent = { ...framed.intent, fire: true };
    ticked.intent = { ...ticked.intent, fire: true };
    const drained = { shots: [] as string[], impacts: [] as string[] };
    for (let f = 0; f < 40; f++) {
      expect(framed.advance(2.5 / 60)).toBeGreaterThanOrEqual(2);
      const e = framed.drainEvents();
      drained.shots.push(...e.shots.map(key));
      drained.impacts.push(...e.impacts.map(key));
    }
    const each = { shots: [] as string[], impacts: [] as string[] };
    while (ticked.ticks < framed.ticks) {
      ticked.tick();
      each.shots.push(...ticked.shots.map((s) => key({ tick: ticked.ticks, origin: s.origin })));
      each.impacts.push(...ticked.rounds.impacts.map((i) => key({ tick: ticked.ticks, position: i.position })));
    }
    expect(drained.shots.length).toBeGreaterThan(5);
    expect(drained.impacts.length).toBeGreaterThan(5);
    expect(drained).toEqual(each);
  });

  it('a frame with no tick drains nothing, and a drain empties', () => {
    const s = stand();
    s.intent = { ...s.intent, fire: true };
    expect(s.advance(0.2 / 60)).toBe(0);
    const none = s.drainEvents();
    expect([none.shots.length, none.frontShots.length, none.impacts.length, none.cracks.length]).toEqual([0, 0, 0, 0]);
    s.tick();
    expect(s.drainEvents().shots.length).toBe(1);
    expect(s.drainEvents().shots.length).toBe(0);
  });

  it("the front's shots are recorded where they left, and its rounds' cracks where they passed", () => {
    const s = stand(7, lineSource(38, 0.4));
    s.front.intensity = 'heavy';
    for (let k = 0; k < 120; k++) s.tick();
    const e = s.drainEvents();
    expect(e.frontShots.length).toBeGreaterThan(10);
    for (const shot of e.frontShots) {
      expect(Math.abs(shot.origin[0] - 12.8)).toBeLessThanOrEqual(20);
      expect(shot.origin[1]).toBeGreaterThanOrEqual(0.8);
      expect(shot.origin[1]).toBeLessThanOrEqual(1.6);
      expect(Math.hypot(...shot.dir)).toBeCloseTo(1, 9);
    }
    expect(e.frontShots.filter((f) => f.tracer).length).toBeGreaterThan(0);
    expect(e.cracks.length).toBeGreaterThan(0);
    const eye = [s.player.position.x, s.player.position.y + s.controller.eyeHeight(s.player), s.player.position.z];
    for (const c of e.cracks) expect(Math.hypot(c.at[0] - eye[0], c.at[1] - eye[1], c.at[2] - eye[2])).toBeCloseTo(c.missM, 6);
  });
});
