import { describe, expect, it } from 'vitest';
import { FIRE_RANGE_M, FIRES_GROW_S, PEAK_FIRES, battlePeak, firePoint, type BattleGame, type BattleNow } from '../../src/app/peak-battle';
import type { Strike } from '../../src/battle/director';
import { P } from '../../src/world/materials';

const FEET: [number, number, number] = [100, 2, 100];
const YAW = 30;

/**
 * A battle as a script: what burns, runs and flies at each moment of it; a strike catching one time
 * in three, a fire counted from the step after it caught, the cap the newest twelve.
 */
function scripted(script: (t: number) => Omit<BattleNow, 'seconds' | 'fires' | 'hamlet'>, dark: boolean, onMap: (x: number, z: number) => boolean = () => true, hamlet = 0) {
  let t = 0;
  let fires: number[] = [];
  let caught = 0;
  const seeks: number[] = [];
  const strikes: Strike[] = [];
  const game: BattleGame = {
    setTimeOfDay: () => {},
    setFront: () => {},
    eyeYaw: () => YAW,
    feet: () => FEET,
    groundTop: (x, z) => (onMap(x, z) ? 2.5 : null),
    dark: () => dark,
    seekBattle: (s) => {
      t = s;
      fires = [];
      seeks.push(s);
    },
    runBattle: (s, struck = []) => {
      for (const k of struck) {
        strikes.push(k);
        if (caught++ % 3 === 0) fires.push(t);
      }
      // The cap holds the hamlet's too, and never puts theirs out.
      fires = fires.slice(-(PEAK_FIRES - hamlet));
      t += s;
    },
    // The script read at the millisecond, past the steps' rounding.
    battleNow: () => ({ seconds: t, ...script(Math.round(t * 1000) / 1000), fires: fires.filter((t0) => t > t0).length + hamlet, hamlet }),
    waitFrames: async () => {},
  };
  return { game, seeks, strikes, fires: () => fires, now: () => t };
}

// The battle at its peak (the battle spec's done table, row 6): the moment sought from two minutes
// in, in steps of 5 s, to 900 s at most; and the most fires struck about the player, grown to it.
describe('the battle at its peak', () => {
  it('at night, the first moment with fifteen flares burning, a barrage in progress and tracers in flight', async () => {
    const b = scripted((t) => ({ flares: t >= 165 ? 16 : 10, barrages: t >= 150 ? 1 : 0, tracers: t === 170 ? 0 : 20 }), true);
    const peak = await battlePeak(b.game, 21);
    expect(peak).toEqual({ at: 165, flares: 16, barrages: 1, tracers: 20, fires: PEAK_FIRES, hamlet: 0 });
    expect(b.seeks.slice(0, 10)).toEqual([120, 125, 130, 135, 140, 145, 150, 155, 160, 165]);
    // Then sought again before it, the fires struck there and grown to the moment.
    expect(b.seeks.slice(10)).toEqual([165 - FIRES_GROW_S]);
    expect(b.now()).toBeCloseTo(165, 9);
  });

  it('at dusk, the first moment with a barrage in progress, the flares and tracers asked for nothing', async () => {
    const b = scripted((t) => ({ flares: 0, barrages: t >= 135 ? 2 : 0, tracers: 0 }), false);
    const peak = await battlePeak(b.game, 17.5);
    expect(peak).toEqual({ at: 135, flares: 0, barrages: 2, tracers: 0, fires: PEAK_FIRES, hamlet: 0 });
  });

  it("at night the cap holds the hamlet's fires too, never put out for it: the peak tells them apart", async () => {
    const b = scripted(() => ({ flares: 16, barrages: 1, tracers: 9 }), true, () => true, 4);
    const peak = await battlePeak(b.game, 21);
    expect(peak.fires).toBe(PEAK_FIRES);
    expect(peak.hamlet).toBe(4);
    // Eight struck about the player, the rest the hamlet's.
    expect(b.fires().length).toBe(PEAK_FIRES - 4);
  });

  it('none by 900 s: the best found, a barrage first, then the most flares', async () => {
    const b = scripted((t) => ({ flares: t === 400 ? 14 : t === 500 ? 15 : 8, barrages: t === 500 ? 0 : 1, tracers: 5 }), true);
    const peak = await battlePeak(b.game, 21);
    expect(peak.at).toBe(400);
    expect(Math.max(...b.seeks)).toBeLessThanOrEqual(900);
  });

  it('the fires: timber struck on the ground about the feet, 8–30 m off across the eye’s view, grown to their full burn', async () => {
    const b = scripted(() => ({ flares: 16, barrages: 1, tracers: 9 }), true);
    await battlePeak(b.game, 21);
    expect(b.strikes.length).toBeGreaterThanOrEqual(PEAK_FIRES);
    for (const s of b.strikes) {
      expect(s.material).toBe(P.TIMBER);
      expect(s.crater).toBeNull();
      expect(s.at[1]).toBe(2.5);
      const dx = s.at[0] - FEET[0];
      const dz = s.at[2] - FEET[2];
      const d = Math.hypot(dx, dz);
      expect(d).toBeGreaterThanOrEqual(FIRE_RANGE_M[0] - 1e-9);
      expect(d).toBeLessThanOrEqual(FIRE_RANGE_M[1] + 1e-9);
      // Within the view's 90°: no more than 45° off the eye's bearing (x along sin, z along cos).
      const off = ((((Math.atan2(dx, dz) * 180) / Math.PI - YAW) % 360) + 540) % 360 - 180;
      expect(Math.abs(off)).toBeLessThanOrEqual(45 + 1e-9);
    }
    expect(new Set(b.strikes.map((s) => s.at.map((v) => v.toFixed(1)).join(','))).size).toBe(b.strikes.length);
    // Every one burning at the moment caught at least FIRES_GROW_S − 5 s (grow_s, 20 s) before it.
    expect(b.fires().length).toBe(PEAK_FIRES);
    for (const t0 of b.fires()) expect(b.now() - t0).toBeGreaterThanOrEqual(20);
  });

  it('points off the map are passed over; nowhere on it, no fires and no throw', async () => {
    const half = scripted(() => ({ flares: 16, barrages: 1, tracers: 9 }), true, (x) => x < FEET[0] + 4);
    expect((await battlePeak(half.game, 21)).fires).toBe(PEAK_FIRES);
    for (const s of half.strikes) expect(s.at[0]).toBeLessThan(FEET[0] + 4);
    const none = scripted(() => ({ flares: 16, barrages: 1, tracers: 9 }), true, () => false);
    expect((await battlePeak(none.game, 21)).fires).toBe(0);
  });

  it("the fires' points are each their own, on the arc and within its range", () => {
    const seen = new Set<string>();
    for (let k = 0; k < 48; k++) {
      const [x, z] = firePoint(k, FEET, 0);
      const d = Math.hypot(x - FEET[0], z - FEET[2]);
      expect(d).toBeGreaterThanOrEqual(FIRE_RANGE_M[0] - 1e-9);
      expect(d).toBeLessThanOrEqual(FIRE_RANGE_M[1] + 1e-9);
      expect(Math.abs((Math.atan2(x - FEET[0], z - FEET[2]) * 180) / Math.PI)).toBeLessThanOrEqual(45 + 1e-9);
      seen.add(`${x.toFixed(1)},${z.toFixed(1)}`);
    }
    expect(seen.size).toBe(48);
  });
});
