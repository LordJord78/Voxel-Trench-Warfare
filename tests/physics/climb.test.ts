import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { boxHitsSolid } from '../../src/physics/collision';
import { CharacterController, controllerTunables, newCharacter, Stance, type CharacterState, type MoveIntent } from '../../src/physics/character';
import { brickGrid } from '../../src/physics/grid';
import { Vec3 } from '../../src/physics/vec';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// Climbing onto the firing step: the bench stands 1.0–2.2 m over the treads that lead to it, out of
// any step-up's reach, so a player on the step who walks into it climbs it (milestone 2's review).
const DT = 1 / 60;
const tun = loadTunables();
const T = controllerTunables(tun);
const intent = (over: Partial<MoveIntent> = {}): MoveIntent => ({ forward: 0, strafe: 0, jump: false, sprint: false, stance: Stance.STANDING, periscope: false, fire: false, reload: false, ...over });

/** A timber tread 0.4 m deep, a bench `rise` m over it at z 3.0–3.5 m (timber, or clay), and a clay parapet behind it to 2.8 m. */
function bay(rise = 1.0, bench: number = P.TIMBER) {
  const map = new BrickMap({ x: 64, y: 64, z: 64 });
  map.fillBox(0, 0, 0, 64, 4, 64, P.TIMBER);
  const top = 4 + Math.round(rise * 10);
  map.fillBox(0, 4, 30, 64, top, 35, bench);
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

describe('climbing onto the firing step', () => {
  it('walking into the bench from the step climbs onto it', () => {
    const { c, s, top } = bay();
    expect(s.stance).toBe(Stance.FIRING_STEP);
    walk(c, s, 180);
    expect(s.position.y).toBeCloseTo(top, 6);
    expect(s.onGround).toBe(true);
    expect(s.stance).toBe(Stance.FIRING_STEP);
    expect(s.position.z).toBeGreaterThan(2.9);
  });

  it('the climb is a rise, not a jump', () => {
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

  it('clay of the same height is not climbed', () => {
    const { c, s } = bay(1.0, P.CLAY);
    walk(c, s, 180);
    expect(s.position.y).toBeCloseTo(0.4, 6);
  });

  it('pinned, crouched or prone, nothing is climbed', () => {
    for (const over of [{ pinned: true }, { stance: Stance.CROUCHED }, { stance: Stance.PRONE }]) {
      const { c, s } = bay();
      if ('pinned' in over) s.pinned = true;
      walk(c, s, 240, 'stance' in over ? { stance: over.stance } : {});
      expect(s.position.y, JSON.stringify(over)).toBeCloseTo(0.4, 6);
    }
  });

  it('letting go of forward mid-climb drops you back to the step', () => {
    const { c, s } = bay(1.6);
    let k = 0;
    while (s.position.y < 1.0 && k++ < 240) c.tick(s, intent({ forward: 1 }), DT);
    expect(s.climbTo).not.toBeNull();
    for (let t = 0; t < 90; t++) c.tick(s, intent(), DT);
    expect(s.climbTo).toBeNull();
    expect(s.position.y).toBeCloseTo(0.4, 6);
    expect(s.onGround).toBe(true);
  });

  it('turning away mid-climb, or at the top, never leaves the body in the air', () => {
    // Looking round while climbing (the review's case: a 180° turn at the top carried the body 2.3 m
    // back over the step, held at the bench's height; a 90° turn mid-rise floated it along the face).
    for (const [at, turn] of [[1.0, 180], [1.0, 90], [1.99, 180], [1.99, 90]] as const) {
      const { c, s } = bay(1.6);
      let k = 0;
      while (s.position.y < at && k++ < 300) c.tick(s, intent({ forward: 1 }), DT);
      expect(s.climbTo, `${at} ${turn}`).not.toBeNull();
      s.yaw += turn;
      // It lets go at once, then falls: never holding its height, and down within a free fall's time.
      c.tick(s, intent({ forward: 1 }), DT);
      expect(s.climbTo, `${at} ${turn}`).toBeNull();
      const fall = Math.ceil(Math.sqrt((2 * (s.position.y - 0.4)) / -T.gravity) / DT) + 6;
      let y = s.position.y;
      let aloft = 0;
      for (let t = 0; t < 120 && !s.onGround; t++) {
        c.tick(s, intent({ forward: 1 }), DT);
        if (s.onGround) break;
        aloft++;
        if (t > 0) expect(s.position.y, `${at} ${turn} tick ${t}`).toBeLessThan(y);
        y = s.position.y;
      }
      expect(s.onGround, `${at} ${turn}`).toBe(true);
      expect(aloft, `${at} ${turn}`).toBeLessThanOrEqual(fall);
    }
  });

  it('from the bench, a parapet faced with timber is not climbed', () => {
    // The generator's parapets are faced with a voxel of wattle (timber) over sandbags and spoil.
    const { c, s, map, top } = bay();
    map.fillBox(0, 4, 35, 64, 28, 36, P.TIMBER);
    walk(c, s, 180);
    expect(s.position.y).toBeCloseTo(top, 6);
    walk(c, s, 180);
    expect(s.position.y).toBeCloseTo(top, 6);
  });

  it('a bench over climb_m is not climbed', () => {
    const { c, s } = bay(T.climbM + 0.1);
    walk(c, s, 240);
    expect(s.position.y).toBeCloseTo(0.4, 6);
  });
});
