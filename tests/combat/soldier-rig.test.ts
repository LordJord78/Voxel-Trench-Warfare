import { describe, expect, it } from 'vitest';
import { bodySphere, hitParts, PART_BOX, PARTS, pose, toLocal, toWorld, type Frame, type PartName, type PoseInput, type V3 } from '../../src/combat/soldier-rig';
import { SETTLE_CONSTANT } from '../../src/combat/spring';
import { loadTunables } from '../../src/core/tunables';

// The body struck (the shots spec's §4): a round's flinch leans the torso along it, and a headshot
// snaps the head, both springing back over [hits] flinch_s; a killed body falls toward the killing
// round's bearing (fallYaw), in its fallS. The rounds strike the same frames the renderer draws.
const tun = loadTunables();

const at = (over: Partial<PoseInput> = {}): PoseInput => ({ position: [10, 2, 20], yaw: 0, pitch: 0, height: 1.8, speed: 0, bob: 0, deadFor: null, ...over });

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** Degrees between two unit vectors. */
function degreesBetween(a: readonly number[], b: readonly number[]): number {
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return (Math.atan2(Math.hypot(c[0], c[1], c[2]), dot(a, b)) * 180) / Math.PI;
}
const bearingOf = (yawDeg: number): V3 => [Math.sin((yawDeg * Math.PI) / 180), 0, Math.cos((yawDeg * Math.PI) / 180)];

/** A part's frame in the torso's: where it sits on the body, whatever the torso does. */
function onTorso(frames: Record<PartName, Frame>, part: PartName): number[] {
  const t = frames.torso;
  const f = frames[part];
  const axis = (v: V3) => [dot(v, t.x), dot(v, t.y), dot(v, t.z)];
  return [...toLocal(t, f.t), ...axis(f.x), ...axis(f.y), ...axis(f.z)];
}

const expectClose = (a: readonly number[], b: readonly number[], label: string) => a.forEach((v, k) => expect(v, `${label} [${k}]`).toBeCloseTo(b[k], 9));

/** Every corner of every part a round can strike, in the world. */
function corners(frames: Record<PartName, Frame>): V3[] {
  const out: V3[] = [];
  for (const part of PARTS) {
    if (part === 'rifle') continue;
    const { min, max } = PART_BOX[part];
    for (let c = 0; c < 8; c++) out.push(toWorld(frames[part], [c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]]));
  }
  return out;
}

describe('a body struck', () => {
  // Struck from in front: the round goes −z, into a body facing +z, which leans back, away from it.
  const dir: V3 = [0, 0, -1];

  it('a flinch leans the torso 12° along the round at once and is back within 0.25 s', () => {
    expect([tun.f('hits.flinch_deg'), tun.f('hits.flinch_s')]).toEqual([12, 0.25]);
    const rest = pose(at());
    const struck = (age: number) => pose(at({ flinch: { dir, age, head: false } }));
    const now = struck(0);
    expect(degreesBetween(now.torso.y, rest.torso.y)).toBeCloseTo(12, 6);
    // Along the round: the top of the torso goes the round's way.
    expect(dot(sub(now.torso.y, rest.torso.y), dir)).toBeGreaterThan(0.15);
    // From the waist: the hips and legs stay; the head, arms and rifle go with the torso, as they sit on it.
    for (const part of ['pelvis', 'thighL', 'thighR', 'shinL', 'shinR'] as const) expect(now[part], part).toEqual(rest[part]);
    expect(now.torso.t).toEqual(rest.torso.t);
    for (const part of ['head', 'upperArmL', 'upperArmR', 'forearmL', 'forearmR', 'rifle'] as const) expectClose(onTorso(now, part), onTorso(rest, part), part);
    // It springs back as a critically damped spring released (combat/spring.ts): 12° (1 + ωt)e^−ωt,
    // ω settling it to 2% in flinch_s.
    const w = SETTLE_CONSTANT / 0.25;
    for (const age of [0.05, 0.1, 0.2]) expect(degreesBetween(struck(age).torso.y, rest.torso.y), `${age} s`).toBeCloseTo(12 * (1 + w * age) * Math.exp(-w * age), 6);
    expect(degreesBetween(struck(0.25).torso.y, rest.torso.y)).toBeLessThan(12 * 0.021);
    expect(degreesBetween(struck(3).torso.y, rest.torso.y)).toBeLessThan(1e-6);
  });

  it('a flinch leans the torso along the round whichever way it comes, and frames stay square', () => {
    for (const [yaw, from] of [[0, [1, 0, 0]], [0, [0.6, -0.2, 0.775]], [123, [-0.3, 0.1, -0.95]], [-40, [0, 0, 1]]] as const) {
      const d = from.map((v) => v / Math.hypot(from[0], from[1], from[2])) as V3;
      const level = [d[0], 0, d[2]].map((v) => v / Math.hypot(d[0], d[2]));
      const rest = pose(at({ yaw }));
      const now = pose(at({ yaw, flinch: { dir: d, age: 0, head: true } }));
      // The torso's top goes the round's way, over the ground, as far as its 12° takes it.
      const moved = sub(toWorld(now.torso, [0, 0.56, 0]), toWorld(rest.torso, [0, 0.56, 0]));
      expect(dot(moved, level), `yaw ${yaw}`).toBeGreaterThan(0.56 * Math.sin((12 * Math.PI) / 180) * 0.9);
      expect(Math.abs(dot(moved, [level[2], 0, -level[0]])), `yaw ${yaw}`).toBeLessThan(0.02);
      for (const part of PARTS) {
        const f = now[part];
        for (const [a, b, want] of [[f.x, f.x, 1], [f.y, f.y, 1], [f.z, f.z, 1], [f.x, f.y, 0], [f.y, f.z, 0], [f.x, f.z, 0]] as const) expect(dot(a, b), part).toBeCloseTo(want, 9);
      }
    }
  });

  it('a headshot flinch snaps the head 25°', () => {
    expect(tun.f('hits.head_snap_deg')).toBe(25);
    const rest = pose(at());
    const shot = (age: number, head = true) => pose(at({ flinch: { dir, age, head } }));
    // The head's up, as it sits on the torso.
    const onNeck = (f: Record<PartName, Frame>) => onTorso(f, 'head').slice(6, 9);
    const now = shot(0);
    expect(degreesBetween(onNeck(now), onNeck(rest))).toBeCloseTo(25, 6);
    // On its neck, the round's way: it turns where it joins the torso, and its top goes along the round.
    expectClose(onTorso(now, 'head').slice(0, 3), onTorso(rest, 'head').slice(0, 3), 'neck');
    expect(dot(sub(now.head.y, rest.head.y), dir)).toBeGreaterThan(0.2);
    // The torso leans as for any hit, so in the world the head is turned 12° + 25°.
    expect(degreesBetween(now.torso.y, rest.torso.y)).toBeCloseTo(12, 6);
    expect(degreesBetween(now.head.y, rest.head.y)).toBeCloseTo(37, 6);
    // A body hit leaves the head as it sits on the torso.
    expect(degreesBetween(onNeck(shot(0, false)), onNeck(rest))).toBeLessThan(1e-6);
    // It springs back with the torso, over flinch_s.
    const w = SETTLE_CONSTANT / 0.25;
    expect(degreesBetween(onNeck(shot(0.1)), onNeck(rest))).toBeCloseTo(25 * (1 + w * 0.1) * Math.exp(-w * 0.1), 6);
    expect(degreesBetween(onNeck(shot(0.25)), onNeck(rest))).toBeLessThan(25 * 0.021);
  });

  it('a killed body falls toward fallYaw, and in fallS', () => {
    expect([tun.f('hits.fall_s'), tun.f('hits.head_fall_s')]).toEqual([0.7, 0.45]);
    const { centre, radius } = bodySphere([10, 2, 20]);
    /** Falling and down, every part a round can strike stays in the body's sphere, and none goes under the ground (at 2 m), or deeper than the body's lowest as it stood. */
    const lies = (p: PoseInput, label: string) => {
      const floor = Math.min(2, ...corners(pose({ ...p, deadFor: null })).map((c) => c[1]));
      for (const deadFor of [0.2, 0.35, 5]) {
        for (const c of corners(pose({ ...p, deadFor }))) {
          expect(Math.hypot(c[0] - centre[0], c[1] - centre[1], c[2] - centre[2]), `${label} at ${deadFor} s`).toBeLessThan(radius);
          expect(c[1], `${label} at ${deadFor} s`).toBeGreaterThan(floor - 1e-9);
        }
      }
    };
    for (const yaw of [0, 75]) {
      for (const fallYaw of [yaw + 180, yaw, yaw + 90, -60, 217]) {
        const label = `yaw ${yaw}, falling toward ${fallYaw}`;
        const down = pose(at({ yaw, deadFor: 0.45, fallYaw, fallS: 0.45 }));
        // Down by fallS: the torso's up axis lies along the bearing, over the ground (short of flat by
        // the spine's own lean and the 0.12 rad the body is held off it).
        expect(dot(down.torso.y, bearingOf(fallYaw)), label).toBeGreaterThan(0.97);
        expect(Math.abs(down.torso.y[1]), label).toBeLessThan(0.2);
        expect(dot(down.head.y, bearingOf(fallYaw)), label).toBeGreaterThan(0.9);
        // And it lies there.
        expect(pose(at({ yaw, deadFor: 5, fallYaw, fallS: 0.45 })), label).toEqual(down);
        // Short of fallS it is still falling.
        expect(pose(at({ yaw, deadFor: 0.3, fallYaw, fallS: 0.45 })).torso.y[1], label).toBeGreaterThan(0.4);
        lies(at({ yaw, fallYaw }), label);
      }
    }
    // Killed running or crouched, whichever way it falls, it pivots on its leading boot (or knee):
    // nothing is driven into the ground.
    for (const gait of [{ speed: 4, bob: 1.5 }, { speed: 4, bob: 4.55 }, { height: 1.25, speed: 2, bob: 5.95 }, { height: 1.0, speed: 1.4, bob: 0.6 }]) {
      for (const fallYaw of [0, 30, 90, 180, 250, 330]) lies(at({ ...gait, fallYaw }), `${JSON.stringify(gait)} toward ${fallYaw}`);
    }
    // Without a fallS: in [hits] fall_s, 0.7 s, so still falling at a headshot's 0.45 s.
    expect(pose(at({ deadFor: 0.45, fallYaw: 90 })).torso.y[1]).toBeGreaterThan(0.4);
    expect(pose(at({ deadFor: 0.7, fallYaw: 90 }))).toEqual(pose(at({ deadFor: 5, fallYaw: 90 })));
    // Without a fallYaw: back from its feet, as a body has always fallen.
    expect(pose(at({ yaw: 30, deadFor: 5 }))).toEqual(pose(at({ yaw: 30, deadFor: 5, fallYaw: 210 })));
    expect(dot(pose(at({ yaw: 30, deadFor: 5 })).torso.y, bearingOf(210))).toBeGreaterThan(0.97);
    // A body lying prone when killed is down already: it does not fall again.
    expect(pose(at({ height: 0.55, deadFor: 5, fallYaw: 90 })).torso).toEqual(pose(at({ height: 0.55, deadFor: 5 })).torso);
  });

  it('hit boxes follow the pose: a flinching torso is struck where it is drawn', () => {
    const rest = pose(at());
    const leaning = pose(at({ flinch: { dir, age: 0, head: false } }));
    // A short segment sideways through a point: what it strikes there.
    const through = (frames: Record<PartName, Frame>, w: readonly number[]) => {
      const x = rest.torso.x;
      return hitParts(frames, [w[0] - x[0] * 0.01, w[1] - x[1] * 0.01, w[2] - x[2] * 0.01], x, 0.02);
    };
    // Leaning back, its upper back is where the torso is drawn now, and was not before.
    const back = toWorld(leaning.torso, [0, 0.5, -0.12]);
    expect(through(leaning, back)?.part).toBe('torso');
    expect(through(rest, back)).toBeNull();
    // The front of its chest as it stood (under the arms, which reach across it for the rifle) is clear of it now.
    const front = toWorld(rest.torso, [0, 0.3, 0.13]);
    expect(through(rest, front)?.part).toBe('torso');
    expect(through(leaning, front)).toBeNull();
    // A round level through the chest from in front, under the arms, strikes it further back by the lean.
    const across = (frames: Record<PartName, Frame>) => hitParts(frames, [10, 2 + 0.92 + 0.35, 25], dir, 10);
    expect(across(rest)?.part).toBe('torso');
    expect(across(leaning)?.part).toBe('torso');
    expect(across(leaning)!.t - across(rest)!.t).toBeGreaterThan(0.06);
  });
});
