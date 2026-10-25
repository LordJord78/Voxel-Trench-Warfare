import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { Stance, type MoveIntent } from '../../src/physics/character';
import { idleIntent, Session } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P, spoilOf } from '../../src/world/materials';
import type { Impact } from '../../src/combat/ballistics';

const tun = loadTunables();

/** 25.6 × 6.4 × 25.6 m: a floor 0.4 m deep (its top layer timber, a firing step, if asked) and a clay wall at z 15–18 m. */
function arena(step = false): BrickMap {
  const map = new BrickMap({ x: 256, y: 64, z: 256 });
  map.fillBox(0, 0, 0, 256, 4, 256, P.SOD);
  if (step) map.fillBox(0, 3, 0, 256, 4, 256, P.TIMBER);
  map.fillBox(0, 4, 150, 256, 64, 180, P.CLAY);
  return map;
}

/** A session with the player standing at (12.8, 0.4, 5) m facing the wall, settled. */
function stand(map: BrickMap, seed = 7, stance: Stance = Stance.STANDING): Session {
  const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 5] } }, tun, seed, 0);
  s.intent = { ...idleIntent(), stance };
  for (let k = 0; k < 40; k++) s.tick();
  return s;
}

/** `ticks` ticks under `intent`: the impacts and shots they made. */
function hold(s: Session, ticks: number, intent: Partial<MoveIntent>): { impacts: Impact[]; shots: number } {
  const impacts: Impact[] = [];
  let shots = 0;
  s.intent = { ...s.intent, ...intent };
  for (let k = 0; k < ticks; k++) {
    s.tick();
    impacts.push(...s.rounds.impacts);
    shots += s.shots.length;
  }
  return { impacts, shots };
}

describe('firing from the session', () => {
  it('holding the trigger marks the wall in front of the eye', () => {
    const map = arena();
    const s = stand(map);
    const eyeY = s.player.position.y + s.controller.eyeHeight(s.player);
    const { impacts, shots } = hold(s, 30, { fire: true });
    expect([5, 6]).toContain(shots);
    expect(s.weapon.rounds).toBe(30 - shots);
    expect(impacts).toHaveLength(shots);
    for (const i of impacts) {
      expect(i.cell[2]).toBe(150);
      expect(Math.abs((i.cell[1] + 0.5) * 0.1 - eyeY)).toBeLessThanOrEqual(0.3);
      expect(map.get(...i.cell)).toBe(spoilOf(P.CLAY));
    }
  });

  it('a crouched eye fires lower', () => {
    const meanY = (stance: Stance) => {
      const { impacts } = hold(stand(arena(), 7, stance), 30, { fire: true });
      return impacts.reduce((a, i) => a + i.position[1], 0) / impacts.length;
    };
    const p = tun;
    const drop = p.f('player.eye_height_standing') - p.f('player.eye_height_crouched');
    expect(Math.abs(meanY(Stance.STANDING) - meanY(Stance.CROUCHED) - drop)).toBeLessThanOrEqual(0.1);
  });

  it('R reloads after the magazine runs dry', () => {
    const s = stand(arena());
    expect(hold(s, 240, { fire: true }).shots).toBe(30);
    expect(s.weapon.rounds).toBe(0);
    hold(s, 1, { fire: false, reload: true });
    hold(s, 145, { reload: false });
    expect(s.weapon.rounds).toBe(30);
  });

  it('no round leaves in the periscope stance', () => {
    const s = stand(arena(true));
    expect(s.player.stance).toBe(Stance.FIRING_STEP);
    hold(s, 40, { periscope: true });
    expect(s.player.stance).toBe(Stance.PERISCOPE);
    expect(hold(s, 30, { fire: true }).shots).toBe(0);
    expect(s.weapon.rounds).toBe(30);
  });

  it('the same seed and intents mark the same voxels, and another seed others', () => {
    const marks = (seed: number) => hold(stand(arena(), seed), 60, { fire: true }).impacts.map((i) => `${i.cell.join(',')}@${i.position.map((v) => v.toFixed(9)).join(',')}`);
    expect(marks(7)).toEqual(marks(7));
    expect(marks(8)).not.toEqual(marks(7));
  });

  it('five catch-up ticks with 256 rounds in flight take at most 4 ms', () => {
    const map = new BrickMap({ x: 256, y: 64, z: 2560 });
    map.fillBox(0, 0, 0, 256, 4, 2560, P.SOD);
    const runs: number[] = [];
    for (let run = 0; run < 5; run++) {
      const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 5] } }, tun, 7, 0);
      for (let k = 0; k < 256; k++) s.rounds.fire([1 + (k % 64) * 0.37, 1 + (k >> 6) * 1.1, 1], [0, 0, 880], s.weapon.spec.projectile, 1, false);
      expect(s.rounds.count).toBe(256);
      const t0 = performance.now();
      for (let k = 0; k < 5; k++) s.tick();
      runs.push(performance.now() - t0);
    }
    // The least of the runs: other work on the machine (the rest of the suite, in parallel) only adds time.
    // On a shared CI runner (the Pages workflow's) the clock times the runner, not the code: not judged there.
    if (!process.env.CI) expect(Math.min(...runs)).toBeLessThanOrEqual(4);
  });
});
