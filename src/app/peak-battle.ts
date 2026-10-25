/**
 * The battle at its peak, as the battle spec's done table defines it (row 6): the heavy intensity,
 * at night the most flares alight with a barrage in progress and the machine guns' tracers in flight
 * (at dusk a barrage alone: the battle fires flares and tracers only in the dark), and the most fires
 * the battle holds, its cap of twelve: struck about the player, across the eye's view, with the
 * hamlet's two to four at night, which the cap never puts out (so at night eight or so are the
 * player's, and the hamlet's burn where the hamlet is; at the bay and the dugout the struck burn
 * beyond the walls, their light within reach). The moment is sought from two minutes into the heavy battle in
 * steps of 5 s, to 900 s at most (else the best found); the battle is then sought again
 * FIRES_GROW_S before it, timber struck about the player's feet — 8–30 m off, across the eye's view —
 * in rounds until the most fires are burning, and run on to the moment, so that they burn at their
 * full strength. Peak combat (peak-combat.ts's underFire) puts the combat peak on top when asked.
 */

import type { Strike } from '../battle/director';
import { P } from '../world/materials';

/** Seconds into the battle the moment is sought from, in steps of, and to. */
export const PEAK_FROM_S = 120;
export const PEAK_STEP_S = 5;
export const PEAK_TO_S = 900;
/** Flares burning at night's peak: about all of max_alight (16). */
export const PEAK_FLARES = 15;
/** Fires burning at the peak: the battle's max_fires. */
export const PEAK_FIRES = 12;
/** The fires' distance from the feet, metres, and the breadth of the eye's view they are spread across, degrees. */
export const FIRE_RANGE_M: readonly [number, number] = [8, 30];
const FIRE_ARC_DEG = 90;
/** Seconds the fires are struck before the moment: past their growth (grow_s, 20 s) to their full burn. */
export const FIRES_GROW_S = 25;
/** A round of strikes is run on this long: caught in its first step, burning by the next. */
const ROUND_S = 0.1;
/** Points tried in all before the fires are left at what caught. */
const FIRE_POINTS = 256;
const GOLDEN = 0.6180339887498949;

/** The battle as it stands: its seconds, the flares burning, the barrages in progress, the tracers in flight, the fires burning (not dying down), and of those the hamlet's. */
export interface BattleNow {
  seconds: number;
  flares: number;
  barrages: number;
  tracers: number;
  fires: number;
  hamlet: number;
}

/** The peak's moment (seconds into the battle), and what burns, runs and flies at it. */
export type BattlePeak = Omit<BattleNow, 'seconds'> & { at: number };

/** What the driver needs of the game. */
export interface BattleGame {
  setTimeOfDay(hours: number): void;
  setFront(intensity: 'off' | 'heavy'): void;
  /** The yaw the frame is drawn at (degrees): the camera's, spectating, else the player's. */
  eyeYaw(): number;
  feet(): [number, number, number];
  /** The top of the ground at (x, z), metres: where something laid on it stands; null off the map. */
  groundTop(x: number, z: number): number | null;
  /** Whether the battle is in the dark: its flares and machine guns firing. */
  dark(): boolean;
  /** The battle sought to `seconds` from its start, at the inputs of the moment, and running on from there. */
  seekBattle(seconds: number): void;
  /** The battle run on by `seconds` at once, `strikes` struck as it starts. */
  runBattle(seconds: number, strikes?: Strike[]): void;
  battleNow(): BattleNow;
  waitFrames(n: number): Promise<void>;
}

/** The k-th fire's point (x, z, metres) about `feet`: within 45° of the eye's bearing `yawDeg` by the golden ratio's turns, 8–30 m off in four rings. */
export function firePoint(k: number, feet: readonly number[], yawDeg: number): [number, number] {
  const across = ((k * GOLDEN) % 1) - 0.5;
  const bearing = ((yawDeg + across * FIRE_ARC_DEG) * Math.PI) / 180;
  const d = FIRE_RANGE_M[0] + (k % 4) * ((FIRE_RANGE_M[1] - FIRE_RANGE_M[0]) / 3);
  return [feet[0] + Math.sin(bearing) * d, feet[2] + Math.cos(bearing) * d];
}

/** The battle brought to its peak at `hours`, the front heavy; what is at it. */
export async function battlePeak(game: BattleGame, hours: number): Promise<BattlePeak> {
  game.setTimeOfDay(hours);
  game.setFront('heavy');
  const dark = game.dark();
  // A moment short of the peak ranks by its barrage, then its flares, then its tracers.
  const rank = (n: BattleNow) => [n.barrages > 0 ? 1 : 0, n.flares, n.tracers > 0 ? 1 : 0];
  const above = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  let best: { at: number; rank: number[] } | null = null;
  for (let at = PEAK_FROM_S; at <= PEAK_TO_S; at += PEAK_STEP_S) {
    game.seekBattle(at);
    const now = game.battleNow();
    if (now.barrages > 0 && (!dark || (now.flares >= PEAK_FLARES && now.tracers > 0))) {
      best = { at, rank: [] };
      break;
    }
    if (!best || above(rank(now), best.rank)) best = { at, rank: rank(now) };
    // A frame between seeks, so the page answers while the battle is replayed.
    await game.waitFrames(1);
  }
  const at = best!.at;
  game.seekBattle(at - FIRES_GROW_S);
  const feet = game.feet();
  const yaw = game.eyeYaw();
  let k = 0;
  while (game.battleNow().fires < PEAK_FIRES && k < FIRE_POINTS) {
    const round: Strike[] = [];
    for (; round.length < PEAK_FIRES && k < FIRE_POINTS; k++) {
      const [x, z] = firePoint(k, feet, yaw);
      const y = game.groundTop(x, z);
      if (y !== null) round.push({ at: [x, y, z], material: P.TIMBER, crater: null });
    }
    game.runBattle(ROUND_S, round);
  }
  game.runBattle(at - game.battleNow().seconds);
  const { flares, barrages, tracers, fires, hamlet } = game.battleNow();
  return { at, flares, barrages, tracers, fires, hamlet };
}
