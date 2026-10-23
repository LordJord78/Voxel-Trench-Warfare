import { describe, expect, it } from 'vitest';
import { BILLBOARD_FLOATS } from '../../src/combat/particles';
import { lineSource, type FrontSource } from '../../src/combat/front';
import { loadTunables } from '../../src/core/tunables';
import { Session } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';
import { trenchArena } from '../support/worlds';

// A frame drains what its ticks did: two ticks or none, nothing is lost and nothing is doubled,
// and each event knows its tick (milestone 1's deferred minor: shots and impacts were the last
// tick's only).
const tun = loadTunables();

/** 25.6 × 6.4 × 51.2 m: a floor 0.4 m deep and a wall at z 5–8 m, clay unless asked. */
function arena(wall: number = P.CLAY): BrickMap {
  const map = new BrickMap({ x: 256, y: 64, z: 512 });
  map.fillBox(0, 0, 0, 256, 4, 512, P.SOD);
  map.fillBox(0, 4, 50, 256, 64, 80, wall);
  return map;
}

function stand(seed = 7, front?: FrontSource, wall?: number): Session {
  const s = Session.create({ map: arena(wall), plan: null, spawn: { position: [12.8, 0.4, 2] }, front }, tun, seed, 0);
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

  it("a round past the head is one crack, however many substeps it was near", () => {
    // Heavy fire aimed at the head, nothing in the way: most rounds pass within the crack's reach;
    // none is heard twice.
    const s = stand(7, lineSource(38, 0.4), P.AIR);
    s.front.intensity = 'heavy';
    let shots = 0;
    let cracks = 0;
    for (let k = 0; k < 600; k++) {
      s.tick();
      const e = s.drainEvents();
      shots += e.frontShots.length;
      cracks += e.cracks.length;
    }
    for (let k = 0; k < 60; k++) {
      s.tick();
      cracks += s.drainEvents().cracks.length;
    }
    expect(shots).toBeGreaterThan(50);
    expect(cracks).toBeGreaterThan(shots / 4);
    expect(cracks).toBeLessThanOrEqual(shots);
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

  it("a shell's crater is one event once it lands, with its bricks", () => {
    const s = Session.create({ map: trenchArena(), plan: null, spawn: { position: [12.8, 4.4, 10] }, waterTable: 42 }, tun, 7, 0);
    s.drainEvents();
    const id = s.destruction.shell([128, 76, 150], 30, 11);
    const craters = [];
    for (let k = 0; k < 10; k++) {
      s.tick();
      craters.push(...s.drainEvents().craters);
    }
    expect(craters).toEqual([{ id, centre: [128, 76, 150], radius: 30, bricks: expect.any(Number), tick: expect.any(Number) }]);
    expect(craters[0].bricks).toBeGreaterThan(50);
  });

  it('a shot throws one flash at the muzzle and one brass from the port', () => {
    // No wall: the round's own dust would land in the same tick.
    const s = stand(7, undefined, P.AIR);
    s.intent = { ...s.intent, fire: true };
    const muzzle = s.muzzle();
    const port = s.port();
    s.tick();
    expect(s.drainEvents().shots.length).toBe(1);
    const out = new Float32Array(s.particles.capacity * BILLBOARD_FLOATS);
    const n = s.particles.billboards(out);
    const all = Array.from({ length: n }, (_, i) => out.slice(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS));
    const flashes = all.filter((b) => b[8] === 1);
    const brass = all.filter((b) => b[8] === 0);
    expect([flashes.length, brass.length]).toEqual([1, 1]);
    const near = (b: Float32Array, p: number[], within: number) => expect(Math.hypot(b[0] - p[0], b[1] - p[1], b[2] - p[2])).toBeLessThan(within);
    near(flashes[0], muzzle, 0.05);
    near(brass[0], port, 0.1);
  });

  it('an impact on soil throws dust of its colour, and on a picket sparks too', () => {
    const count = (s: Session) => {
      const out = new Float32Array(s.particles.capacity * BILLBOARD_FLOATS);
      const n = s.particles.billboards(out);
      let dust = 0;
      let sparks = 0;
      for (let i = 0; i < n; i++) {
        const b = out.subarray(i * BILLBOARD_FLOATS, (i + 1) * BILLBOARD_FLOATS);
        if (b[8] === 1 && b[1] > 0.4 && Math.abs(b[2] - 5) < 1) sparks++;
        else if (b[8] === 0 && Math.abs(b[2] - 5) < 1) dust++;
      }
      return { dust, sparks };
    };
    for (const [wall, wantSparks] of [[P.CLAY, false], [P.PICKET, true]] as const) {
      const s = stand(7, undefined, wall);
      s.intent = { ...s.intent, fire: true };
      s.tick();
      const hit = s.drainEvents().impacts;
      expect(hit.length).toBe(1);
      const { dust, sparks } = count(s);
      expect(dust).toBeGreaterThan(3);
      expect(sparks > 0).toBe(wantSparks);
    }
  });
});

