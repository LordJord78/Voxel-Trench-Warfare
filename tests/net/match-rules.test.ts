import { describe, expect, it } from 'vitest';
import { DAMAGE, DEAD_HANDS_MS, HP, MatchRules, PROTECT_MS, REGEN_DELAY_MS } from '../../src/net/match-rules';

/** A match of four, red 0 and 2, blue 1 and 3, past their spawn protection. */
function match(killTarget = 30) {
  const m = new MatchRules(killTarget, 5000);
  [0, 1, 2, 3].forEach((id) => m.join(id, id % 2 ? 'blue' : 'red', 0));
  return m;
}
const T = PROTECT_MS + 1;

describe("the match's rules", () => {
  it('takes a head in one, the torso in two, a limb in four, and scores the kill', () => {
    const m = match();
    expect(m.hit(0, 1, 'head', T)).toEqual([
      { t: 'death', victim: 1, killer: 0, zone: 'head', teamkill: false, cause: 'round' },
      { t: 'score', red: 1, blue: 0 },
    ]);
    expect(m.hit(0, 3, 'torso', T)).toEqual([{ t: 'hurt', victim: 3, hp: HP - DAMAGE.torso, from: 0 }]);
    expect(m.hit(0, 3, 'torso', T + 1).map((e) => e.t)).toEqual(['death', 'score']);
    const limbs = [1, 2, 3, 4].map(() => m.hit(1, 2, 'limb', T + 2).map((e) => e.t).join());
    expect(limbs).toEqual(['hurt', 'hurt', 'hurt', 'death,score']);
    expect(m.score).toEqual({ red: 2, blue: 1 });
    expect(m.fighters.get(0)!.kills).toBe(2);
    expect(m.fighters.get(2)!.deaths).toBe(1);
  });

  it("makes a team kill cost the killer's team, and the battle's kills score nothing", () => {
    const m = match();
    const tk = m.hit(0, 2, 'head', T);
    expect(tk[0]).toMatchObject({ t: 'death', teamkill: true });
    expect(m.score).toEqual({ red: -1, blue: 0 });
    expect(m.hurt(1, 120, 'shell', T)[0]).toMatchObject({ t: 'death', killer: -1, cause: 'shell' });
    expect(m.score).toEqual({ red: -1, blue: 0 });
  });

  it('protects the newly spawned, ignores the dead and the self, and lets a dead hand fire on briefly', () => {
    const m = match();
    expect(m.hit(0, 1, 'head', PROTECT_MS - 1)).toEqual([]);
    expect(m.hit(1, 1, 'head', T)).toEqual([]);
    m.hit(0, 1, 'head', T);
    expect(m.hit(2, 1, 'head', T + 10)).toEqual([]);
    expect(m.hit(1, 2, 'head', T + DEAD_HANDS_MS - 1).map((e) => e.t)).toContain('death');
    m.hit(0, 3, 'head', T);
    expect(m.hit(3, 0, 'head', T + DEAD_HANDS_MS + 1)).toEqual([]);
  });

  it('heals after a while, and brings the dead back after the respawn time', () => {
    const m = match();
    m.hit(0, 1, 'torso', T);
    m.tick(T + REGEN_DELAY_MS - 10);
    expect(m.health(1)).toBe(HP - DAMAGE.torso);
    m.tick(T + REGEN_DELAY_MS + 2000);
    expect(m.health(1)).toBeCloseTo(HP - DAMAGE.torso + 20, 6);
    m.hit(0, 3, 'head', T);
    expect(m.tick(T + 4999)).toEqual([]);
    const back = m.tick(T + 5000);
    expect(back).toEqual([{ t: 'respawn', id: 3, spawn: expect.any(Number) }]);
    expect(m.fighters.get(3)!.alive).toBe(true);
    expect(m.hit(0, 3, 'head', T + 5001)).toEqual([]);
  });

  it('ends at the kill target, and refuses claims beyond a full-auto rate', () => {
    const m = match(2);
    m.hit(0, 1, 'head', T);
    const end = m.hit(0, 3, 'head', T);
    expect(end).toContainEqual({ t: 'over', winner: 'red' });
    expect(m.winner).toBe('red');
    expect(m.hit(1, 0, 'head', T + 10)).toEqual([]);

    const flood = match();
    let claimed = 0;
    for (let k = 0; k < 40; k++) if (flood.hit(0, 1, 'limb', T + k).length) claimed++;
    expect(claimed).toBeLessThanOrEqual(16);
  });
});
