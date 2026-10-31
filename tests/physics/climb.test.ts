import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { boxHitsSolid } from '../../src/physics/collision';
import { CharacterController, controllerTunables, newCharacter, Stance, type CharacterState, type MoveIntent } from '../../src/physics/character';
import { brickGrid } from '../../src/physics/grid';
import { Vec3 } from '../../src/physics/vec';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// The mantle (the multiplayer spec's M1): walking into a firing step's bench climbs it, as the
// bench stands 1.0–2.6 m over the treads that lead to it, out of any step-up's reach; with jump
// held, anything in reach is climbed, so nobody is ever trapped in a trench. Once begun it is
// not let go of for looking round or letting go of forward.
const DT = 1 / 60;
const tun = loadTunables();
const T = controllerTunables(tun);
const intent = (over: Partial<MoveIntent> = {}): MoveIntent => ({ forward: 0, strafe: 0, jump: false, sprint: false, stance: Stance.STANDING, periscope: false, fire: false, reload: false, dig: false, ...over });

/**
 * A timber tread 0.4 m deep, a ledge `rise` m over it at z 3.0–3.5 m (a bench: timber with its
 * top a bench's, or clay), and a clay parapet behind it to 2.8 m or a metre over the ledge.
 */
function bay(rise = 1.0, ledge: 'bench' | number = 'bench') {
  const map = new BrickMap({ x: 64, y: 64, z: 64 });
  map.fillBox(0, 0, 0, 64, 4, 64, P.TIMBER);
  const top = 4 + Math.round(rise * 10);
  map.fillBox(0, 4, 30, 64, top, 35, ledge === 'bench' ? P.TIMBER : ledge);
  if (ledge === 'bench') map.fillBox(0, top - 1, 30, 64, top, 35, P.BENCH);
  map.fillBox(0, 4, 35, 64, Math.max(28, top + 10), 64, P.CLAY);
  const c = new CharacterController(brickGrid(map, 0.1), T);
  const s = newCharacter(new Vec3(3.2, 0.4, 1.5), 0, 0);
  for (let t = 0; t < 10; t++) c.tick(s, intent(), DT);
  return { c, s, map, top: top * 0.1 };
}

function walk(c: CharacterController, s: CharacterState, ticks: number, over: Partial<MoveIntent> = {}, each?: () => void): void {
  for (let t = 0; t < ticks; t++) {
    c.tick(s, intent({ forward: 1, ...over }), DT);
    each?.();
  }
}

/** Push on (forward, and `over`) until a climb has begun and ended, then stand still a moment: whether one did. */
function mantle(c: CharacterController, s: CharacterState, ticks: number, over: Partial<MoveIntent> = {}): boolean {
  let began = false;
  for (let t = 0; t < ticks; t++) {
    c.tick(s, intent({ forward: 1, ...over }), DT);
    if (s.climbTo !== null) began = true;
    else if (began) break;
  }
  for (let t = 0; t < 10; t++) c.tick(s, intent(), DT);
  return began;
}

describe('the mantle', () => {
  it('walking into the bench climbs onto it, and the bench is the firing step (the tread is not)', () => {
    const { c, s, top } = bay();
    expect(s.stance).toBe(Stance.STANDING);
    walk(c, s, 180);
    expect(s.position.y).toBeCloseTo(top, 6);
    expect(s.onGround).toBe(true);
    expect(s.stance).toBe(Stance.FIRING_STEP);
    expect(s.position.z).toBeGreaterThan(2.9);
  });

  it('the climb is a rise, not a jump, and never inside anything', () => {
    const { c, s } = bay(1.6);
    let y = s.position.y;
    let rose = 0;
    walk(c, s, 240, {}, () => {
      expect(s.position.y - y).toBeLessThanOrEqual(T.climbSpeed * DT + 1e-6);
      rose = Math.max(rose, s.position.y);
      y = s.position.y;
      expect(boxHitsSolid(c.grid, s.position, T.radius, s.height)).toBe(false);
    });
    expect(rose).toBeCloseTo(2.0, 6);
  });

  it('clay of the same height is climbed only with jump held', () => {
    const walked = bay(1.0, P.CLAY);
    walk(walked.c, walked.s, 180);
    expect(walked.s.position.y).toBeCloseTo(0.4, 6);
    const jumped = bay(1.0, P.CLAY);
    expect(mantle(jumped.c, jumped.s, 180, { jump: true })).toBe(true);
    expect(jumped.s.position.y).toBeCloseTo(jumped.top, 6);
    expect(jumped.s.onGround).toBe(true);
  });

  it('from the bench, the parapet behind it is never climbed by walking, and is with jump held', () => {
    // The generator's parapets are faced with a voxel of wattle (timber) over sandbags and spoil:
    // leaning into the parapet on the step must not throw anyone over the top.
    const { c, s, map, top } = bay();
    map.fillBox(0, 4, 35, 64, 28, 36, P.TIMBER);
    walk(c, s, 180);
    expect(s.position.y).toBeCloseTo(top, 6);
    walk(c, s, 180);
    expect(s.position.y).toBeCloseTo(top, 6);
    expect(mantle(c, s, 180, { jump: true })).toBe(true);
    expect(s.position.y).toBeCloseTo(2.8, 6);
    expect(s.onGround).toBe(true);
    expect(s.position.z).toBeGreaterThan(3.5 - T.radius);
  });

  it('lying down nothing is climbed; crouched or pinned, it is with jump held', () => {
    const prone = bay();
    walk(prone.c, prone.s, 240, { stance: Stance.PRONE, jump: true });
    expect(prone.s.position.y).toBeCloseTo(0.4, 6);
    for (const over of [{ pinned: true }, { stance: Stance.CROUCHED }]) {
      const { c, s, top } = bay();
      if ('pinned' in over) s.pinned = true;
      expect(mantle(c, s, 240, { jump: true, ...('stance' in over ? { stance: over.stance } : {}) }), JSON.stringify(over)).toBe(true);
      expect(s.position.y, JSON.stringify(over)).toBeCloseTo(top, 6);
    }
  });

  it('once begun, letting go of forward does not drop you, and backing off does', () => {
    const held = bay(1.6);
    let k = 0;
    while (held.s.position.y < 1.0 && k++ < 240) held.c.tick(held.s, intent({ forward: 1 }), DT);
    expect(held.s.climbTo).not.toBeNull();
    for (let t = 0; t < 90; t++) held.c.tick(held.s, intent(), DT);
    expect(held.s.position.y).toBeCloseTo(held.top, 6);
    expect(held.s.onGround).toBe(true);

    const backed = bay(1.6);
    k = 0;
    while (backed.s.position.y < 1.0 && k++ < 240) backed.c.tick(backed.s, intent({ forward: 1 }), DT);
    backed.c.tick(backed.s, intent({ forward: -1 }), DT);
    expect(backed.s.climbTo).toBeNull();
    for (let t = 0; t < 90; t++) backed.c.tick(backed.s, intent(), DT);
    expect(backed.s.position.y).toBeCloseTo(0.4, 6);
    expect(backed.s.onGround).toBe(true);
  });

  it('looking round mid-climb, or at the top, does not stop it, and it ends on the ledge', () => {
    for (const [at, turn] of [[1.0, 180], [1.0, 90], [1.99, 180], [1.99, 90]] as const) {
      const { c, s, top } = bay(1.6);
      let k = 0;
      while (s.position.y < at && k++ < 300) c.tick(s, intent({ forward: 1 }), DT);
      expect(s.climbTo, `${at} ${turn}`).not.toBeNull();
      s.yaw += turn;
      for (let t = 0; t < 60 && s.climbTo !== null; t++) c.tick(s, intent({ forward: 1 }), DT);
      for (let t = 0; t < 10; t++) c.tick(s, intent(), DT);
      expect(s.climbTo, `${at} ${turn}`).toBeNull();
      expect(s.onGround, `${at} ${turn}`).toBe(true);
      expect(s.position.y, `${at} ${turn}`).toBeCloseTo(top, 6);
    }
  });

  it('a ledge over climb_m is not climbed from the ground, and a jump reaches it', () => {
    const walked = bay(T.climbM + 0.1);
    walk(walked.c, walked.s, 240);
    expect(walked.s.position.y).toBeCloseTo(0.4, 6);
    const jumped = bay(T.climbM + 0.4, P.CLAY);
    expect(mantle(jumped.c, jumped.s, 300, { jump: true })).toBe(true);
    expect(jumped.s.position.y).toBeCloseTo(jumped.top, 6);
  });

  it('a ledge with no room to stand on it is not climbed', () => {
    const { c, s, map } = bay(1.0, P.CLAY);
    map.fillBox(0, 15, 30, 64, 64, 35, P.CLAY);
    map.fillBox(0, 15, 30, 64, 16, 35, P.AIR);
    walk(c, s, 180, { jump: true });
    expect(s.position.y).toBeLessThan(1.0);
  });
});

describe('stepping and getting free', () => {
  it("a tread is stepped up under a lintel that leaves room only over the tread's top (a dugout's stairs)", () => {
    // A 0.3 m tread with a roof 2.2 m over it: no room for the full 0.55 m step-up at standing
    // height, which used to make every dugout one way.
    const map = new BrickMap({ x: 64, y: 64, z: 64 });
    map.fillBox(0, 0, 0, 64, 4, 64, P.CLAY);
    map.fillBox(0, 4, 30, 64, 7, 64, P.TIMBER);
    map.fillBox(0, 29, 20, 64, 30, 64, P.TIMBER);
    const c = new CharacterController(brickGrid(map, 0.1), T);
    const s = newCharacter(new Vec3(3.2, 0.4, 2.0), 0, 0);
    for (let t = 0; t < 10; t++) c.tick(s, intent(), DT);
    walk(c, s, 120);
    expect(s.position.y).toBeCloseTo(0.7, 6);
    expect(s.position.z).toBeGreaterThan(3.5 - T.radius);
  });

  it('a jump catches a lip just over its height', () => {
    // A 0.85 m lip: over a step-up, under a jump's 0.68 m and the air step's 0.3 m. Jump is
    // pressed once, so this is the air step, not the mantle.
    const map = new BrickMap({ x: 64, y: 64, z: 64 });
    map.fillBox(0, 0, 0, 64, 4, 64, P.CLAY);
    map.fillBox(0, 4, 30, 64, 12, 64, P.CLAY);
    map.fillBox(0, 12, 30, 64, 13, 33, P.CLAY);
    const c = new CharacterController(brickGrid(map, 0.1), T);
    const s = newCharacter(new Vec3(3.2, 0.4, 2.6), 0, 0);
    for (let t = 0; t < 10; t++) c.tick(s, intent(), DT);
    c.tick(s, intent({ forward: 1, jump: true }), DT);
    walk(c, s, 120);
    expect(s.position.y).toBeGreaterThanOrEqual(1.2 - 1e-6);
    expect(s.onGround).toBe(true);
  });

  it('a buried body is moved up to the nearest free space', () => {
    const map = new BrickMap({ x: 64, y: 64, z: 64 });
    map.fillBox(0, 0, 0, 64, 4, 64, P.CLAY);
    map.fillBox(0, 4, 0, 64, 9, 64, P.SPOIL);
    const c = new CharacterController(brickGrid(map, 0.1), T);
    const s = newCharacter(new Vec3(3.2, 0.4, 3.2), 0, 0);
    s.onGround = true;
    for (let t = 0; t < (T.unstickTicks ?? 0) + 2; t++) c.tick(s, intent(), DT);
    expect(boxHitsSolid(c.grid, s.position, T.radius, s.height)).toBe(false);
    expect(s.position.y).toBeCloseTo(0.9, 6);
    expect(s.position.x).toBeCloseTo(3.2, 6);
    expect(s.position.z).toBeCloseTo(3.2, 6);
    for (let t = 0; t < 30; t++) c.tick(s, intent(), DT);
    expect(s.onGround).toBe(true);
  });

  it('a body a voxel into a face steps back off it, and stays standing where it was', () => {
    const map = new BrickMap({ x: 64, y: 64, z: 64 });
    map.fillBox(0, 0, 0, 64, 4, 64, P.BENCH);
    map.fillBox(0, 4, 35, 64, 30, 64, P.CLAY);
    const c = new CharacterController(brickGrid(map, 0.1), T);
    const s = newCharacter(new Vec3(3.2, 0.4, 3.25), 0, 0);
    for (let t = 0; t < (T.unstickTicks ?? 0) + 2; t++) c.tick(s, intent(), DT);
    expect(boxHitsSolid(c.grid, s.position, T.radius, s.height)).toBe(false);
    expect(s.position.y).toBeCloseTo(0.4, 6);
    expect(s.position.z).toBeCloseTo(3.15, 6);
    expect(s.onGround).toBe(true);
    expect(s.stance).toBe(Stance.FIRING_STEP);
  });
});
