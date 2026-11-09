import { describe, expect, it } from 'vitest';
import { blastHarm, frontHarm, harmTunables } from '../../src/combat/harm';
import { loadTunables } from '../../src/core/tunables';
import { SHELLING } from '../../src/net/shelling';

// Harm in a room (the shared-battle spec's "Damage"): a blast hurts a body by its distance from it and
// whether a voxel ray from it to the chest is blocked; the front's round by the zone it struck.
const t = harmTunables(loadTunables());

describe('harm in a room', () => {
  it('reads [room_battle]: the blast, its lethal and reach radii, cover, the front', () => {
    expect(t).toEqual({ blastHp: 200, lethalRadii: 0.5, reachRadii: 2.2, coverShare: 0.35, frontDamageScale: 0.6 });
  });

  it('a blast does 200 within half its radius, nothing from 2.2 radii, linearly between', () => {
    expect(blastHarm(0, 3, false, t)).toBe(200);
    expect(blastHarm(1.5, 3, false, t)).toBe(200);
    expect(blastHarm(4.05, 3, false, t)).toBeCloseTo(100, 9);
    expect(blastHarm(6.6, 3, false, t)).toBeCloseTo(0, 9); // 2.2 radii: about 3.5e-14 in doubles
    expect(blastHarm(6.61, 3, false, t)).toBe(0);
    expect(blastHarm(20, 3, false, t)).toBe(0);
  });

  it('cover leaves 0.35 of it', () => {
    expect(blastHarm(1, 3, true, t)).toBeCloseTo(70, 9);
    expect(blastHarm(4.05, 3, true, t)).toBeCloseTo(35, 9);
    expect(blastHarm(7, 3, true, t)).toBe(0);
  });

  it("no shell the room sends reaches anyone at a start: the largest's reach is inside spawn_clear_m", () => {
    // Review Focus: spawn kills.
    expect(SHELLING.radiusM[1] * t.reachRadii).toBeLessThan(SHELLING.spawnClearM);
    expect(blastHarm(SHELLING.spawnClearM, SHELLING.radiusM[1], false, t)).toBe(0);
  });

  it("the front's round does its zone's damage × 0.6", () => {
    expect((['head', 'torso', 'limb'] as const).map((z) => frontHarm(z, t))).toEqual([60, 33, 18]);
  });
});
