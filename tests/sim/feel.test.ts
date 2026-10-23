import { describe, expect, it } from 'vitest';
import type { Impact } from '../../src/combat/ballistics';
import { lineSource, type FrontSource } from '../../src/combat/front';
import { loadTunables } from '../../src/core/tunables';
import { Stance, type MoveIntent } from '../../src/physics/character';
import { fromYawPitch } from '../../src/physics/vec';
import { idleIntent, Session } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// The rifle and the front in play: recoil climbs a burst, the view kick moves nothing, the
// player's own rifle never suppresses them, and the front's near misses pin them and push them
// off the step (ported from reference/python/tests/test_viewkick.py and test_suppression.py's
// session cases).
const tun = loadTunables();

/** 25.6 × 6.4 × 51.2 m: a floor 0.4 m deep (its top layer a timber firing step, if asked), and a clay wall at z 10–13 m (or none). */
function arena(step = false, wall = true): BrickMap {
  const map = new BrickMap({ x: 256, y: 64, z: 512 });
  map.fillBox(0, 0, 0, 256, 4, 512, P.SOD);
  if (step) map.fillBox(0, 3, 0, 256, 4, 512, P.TIMBER);
  if (wall) map.fillBox(0, 4, 100, 256, 64, 130, P.CLAY);
  return map;
}

function stand(map: BrickMap, seed = 7, front?: FrontSource): Session {
  const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 2] }, front }, tun, seed, 0);
  for (let k = 0; k < 40; k++) s.tick();
  return s;
}

function hold(s: Session, ticks: number, intent: Partial<MoveIntent>): Impact[] {
  const impacts: Impact[] = [];
  s.intent = { ...s.intent, ...intent };
  for (let k = 0; k < ticks; k++) {
    s.tick();
    impacts.push(...s.rounds.impacts.filter((i) => i.owner === 0));
  }
  return impacts;
}

describe('feel in play', () => {
  it('a burst climbs: rounds 20–30 strike higher on the wall than rounds 1–5', () => {
    const impacts = hold(stand(arena()), 180, { fire: true });
    expect(impacts.length).toBeGreaterThanOrEqual(30);
    const mean = (xs: Impact[]) => xs.reduce((a, i) => a + i.position[1], 0) / xs.length;
    expect(mean(impacts.slice(19, 30))).toBeGreaterThan(mean(impacts.slice(0, 5)) + 0.1);
  });

  it('the cosmetic layer cannot move a round', () => {
    const run = (noop: boolean) => {
      const s = stand(arena(), 11);
      if (noop) Object.assign(s.viewKick, { shot() {}, tick() {} });
      return hold(s, 240, { fire: true }).map((i) => `${i.cell.join()}@${i.position.map((v) => v.toFixed(9)).join()}`);
    };
    expect(run(true)).toEqual(run(false));
  });

  it('your own rifle does not suppress you', () => {
    const s = stand(arena());
    let shots = 0;
    s.intent = { ...s.intent, fire: true };
    for (let k = 0; k < 300; k++) {
      s.tick();
      shots += s.shots.length;
    }
    expect(shots).toBeGreaterThan(5);
    expect(s.suppression.level).toBe(0);
    expect(s.suppression.cracks).toBe(0);
  });

  it('incoming fire suppresses a man in the open', () => {
    const s = stand(arena(false, false), 7, lineSource(38, 0.4));
    s.front.intensity = 'heavy';
    let peak = 0;
    for (let k = 0; k < 300; k++) {
      s.tick();
      peak = Math.max(peak, s.suppression.level);
    }
    expect(peak).toBeGreaterThan(0.6);
    expect(s.suppression.cracks).toBeGreaterThan(0);
  });

  it('suppression pushes you off the firing step', () => {
    const s = stand(arena(true, false), 7, lineSource(22, 0.4));
    expect(s.player.stance).toBe(Stance.FIRING_STEP);
    s.front.intensity = 'heavy';
    let pinnedAt = -1;
    for (let k = 0; k < 360 && pinnedAt < 0; k++) {
      s.tick();
      if (s.suppression.pinned) pinnedAt = k;
    }
    expect(pinnedAt).toBeGreaterThanOrEqual(0);
    for (let k = 0; k < 5; k++) s.tick();
    expect(s.player.stance).not.toBe(Stance.FIRING_STEP);
    expect(s.ejected).toBeGreaterThan(0);
  });

  it('a pinned player cannot raise the periscope either', () => {
    const s = stand(arena(true, false), 7, lineSource(22, 0.4));
    s.intent = { ...idleIntent(), periscope: true };
    s.front.intensity = 'heavy';
    for (let k = 0; k < 360 && !s.suppression.pinned; k++) s.tick();
    for (let k = 0; k < 30; k++) s.tick();
    expect(s.suppression.pinned).toBe(true);
    expect(s.player.stance).not.toBe(Stance.PERISCOPE);
  });

  it("a burst while pinned still leaves inside the stance's cone × 4.2, about its aim", () => {
    const s = stand(arena(false, false), 7, lineSource(22, 0.4));
    s.front.intensity = 'heavy';
    for (let k = 0; k < 360 && s.suppression.level < 0.9; k++) s.tick();
    s.intent = { ...s.intent, fire: true };
    const limit = ((3.2 / 60) * tun.f('stance.standing.sway_scale') * tun.f('suppression.sway_at_full') * Math.PI) / 180;
    let checked = 0;
    for (let k = 0; k < 120; k++) {
      s.tick();
      for (const shot of s.shots) {
        const aim = fromYawPitch(shot.aim[0], shot.aim[1]);
        const cos = aim.x * shot.dir[0] + aim.y * shot.dir[1] + aim.z * shot.dir[2];
        expect(Math.acos(Math.min(1, cos))).toBeLessThanOrEqual(limit * 1.0001);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});
