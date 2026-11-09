/**
 * What a player carries, as the room and the others need to know it (the loadout): the guns in
 * the order every client and the room number them, what each one's round does to a body against
 * the zones' damage (match-rules.ts), and the gear a player shows, packed into an integer: the
 * gun in their hands (or the shovel), what is fitted to it and whether their light is on. It rides
 * above the eight bits of their state's flags, and a shot's own word says which gun fired it, its
 * tracer's colour, whether it was suppressed, whether a compensator is fitted and a pellet gun's
 * pattern: the room relays both as they are, so none of this changes what it is sent.
 *
 * Pure and small, because the room imports it.
 */

import type { Team } from './protocol';

export const GUNS = ['ak74', 'm4', 'mp5', 'svd', 'm249', 'm870', 'm17', 'pm'] as const;
export type GunKey = (typeof GUNS)[number];

/** Each gun's round against the zones' damage: a marksman's rifle kills with a chest shot; each of a shotgun's pellets does a share. */
export const DAMAGE_SCALE: Record<GunKey, number> = { ak74: 1.05, m4: 1, mp5: 0.75, svd: 1.9, m249: 1, m870: 0.42, m17: 0.8, pm: 0.72 };

export const OPTICS = ['iron', 'reddot', 'holo', 'scope'] as const;
export const MUZZLES = ['none', 'suppressor', 'compensator'] as const;
export const UNDERS = ['none', 'vertical', 'angled'] as const;
export const SIDES = ['none', 'flashlight', 'laser'] as const;
export type Optic = (typeof OPTICS)[number];
export type Muzzle = (typeof MUZZLES)[number];
export type Under = (typeof UNDERS)[number];
export type Side = (typeof SIDES)[number];

/** What is fitted to a gun, a slot each. */
export interface Fit {
  optic: Optic;
  muzzle: Muzzle;
  under: Under;
  side: Side;
}

export const BARE: Fit = { optic: 'iron', muzzle: 'none', under: 'none', side: 'none' };

/** What a player shows: the gun in their hands (null: the shovel) and its fit, their light (or laser) on. */
export interface Gear {
  gun: GunKey | null;
  fit: Fit;
  light: boolean;
}

/** A round's tracer, as the pool keeps it: none, the battle's amber, or a team's red or blue. */
export const TRACER_KIND = { none: 0, amber: 1, red: 2, blue: 3 } as const;

/** The tracer a team's players fire: every round, in the team's colour. */
export function teamTracer(team: Team): number {
  return team === 'blue' ? TRACER_KIND.blue : TRACER_KIND.red;
}

/** The four bits of the gun in hand for the shovel. */
const SHOVEL = 15;

/** Gear as 15 bits: the gun (4), the optic, muzzle, underbarrel and side (2 each), two spare (12-13: zero, and ignored), the light (1). */
export function encodeGear(g: Gear): number {
  const gun = g.gun === null ? SHOVEL : GUNS.indexOf(g.gun);
  return (
    (gun & 15) |
    (OPTICS.indexOf(g.fit.optic) << 4) |
    (MUZZLES.indexOf(g.fit.muzzle) << 6) |
    (UNDERS.indexOf(g.fit.under) << 8) |
    (SIDES.indexOf(g.fit.side) << 10) |
    ((g.light ? 1 : 0) << 14)
  );
}

/** Gear from its bits; anything out of range is the bare AK. */
export function decodeGear(n: number): Gear {
  const pick = <T>(list: readonly T[], i: number, fallback: T) => list[i] ?? fallback;
  const bits = Number.isInteger(n) && n >= 0 ? n : 0;
  const gun = bits & 15;
  return {
    gun: gun === SHOVEL ? null : pick(GUNS, gun, 'ak74'),
    fit: {
      optic: pick(OPTICS, (bits >> 4) & 3, 'iron'),
      muzzle: pick(MUZZLES, (bits >> 6) & 3, 'none'),
      under: pick(UNDERS, (bits >> 8) & 3, 'none'),
      side: pick(SIDES, (bits >> 10) & 3, 'none'),
    },
    light: ((bits >> 14) & 1) === 1,
  };
}

/**
 * A pellet gun's pattern, as a share of its gun's cone: the product the cone was always scaled by (the
 * sights' share aimed or the hip's, the stance's sway, suppression's), put to the nearest of eight
 * steps, which its shot's word carries (bits 9–11). The shooter spreads its pellets by the step, and
 * so does every client that hears the shot, so they fly alike everywhere. Step 0 is the hip's 1, so a
 * word without these bits (a bullet's, or one from before) reads as a hip shot; the other seven run
 * from 0.25 to 2.8, each about √2 from the next.
 */
export const SHOT_SHARES: readonly number[] = [1, 0.25, 0.35, 0.5, 0.7, 1.4, 2.0, 2.8];

/** The narrowest and widest steps' shares. */
const SHARE_LEAST = Math.min(...SHOT_SHARES);
const SHARE_MOST = Math.max(...SHOT_SHARES);

/** The step (an index into SHOT_SHARES) nearest `share` in proportion; past either end (infinite too), that end; NaN, the hip's. */
export function shareStep(share: number): number {
  if (Number.isNaN(share)) return 0;
  const x = Math.min(SHARE_MOST, Math.max(SHARE_LEAST, share));
  let best = 0;
  let bestRatio = Infinity;
  for (let k = 0; k < SHOT_SHARES.length; k++) {
    const s = SHOT_SHARES[k];
    const ratio = x > s ? x / s : s / x;
    if (ratio < bestRatio) {
      best = k;
      bestRatio = ratio;
    }
  }
  return best;
}

/** The share a pellet gun's pattern is thrown at: its step's (shareStep), the one value its shot's word carries. */
export function stepShare(share: number): number {
  return SHOT_SHARES[shareStep(share)];
}

/**
 * A shot's word: whether a tracer and its kind (TRACER_KIND), whether suppressed, which gun, whether a
 * compensator is fitted (its flash's side prongs; none said, none), and a pellet gun's pattern's share
 * (SHOT_SHARES: put to its step as it is written; none, the hip's 1).
 */
export interface ShotMark {
  tracer: boolean;
  kind: number;
  suppressed: boolean;
  gun: GunKey;
  comp?: boolean;
  share?: number;
}

/**
 * Bit 0 a tracer (as the word was before it said more), bits 1–2 its kind, bit 3 suppressed, bits 4–7
 * the gun, bit 8 a compensator, bits 9–11 the share's step.
 */
export function encodeShotMark(m: ShotMark): number {
  return (
    (m.tracer ? 1 : 0) |
    ((m.kind & 3) << 1) |
    ((m.suppressed ? 1 : 0) << 3) |
    (Math.max(0, GUNS.indexOf(m.gun)) << 4) |
    ((m.comp ? 1 : 0) << 8) |
    ((m.share === undefined ? 0 : shareStep(m.share)) << 9)
  );
}

export function decodeShotMark(n: number): Required<ShotMark> {
  const bits = Number.isInteger(n) && n >= 0 ? n : 0;
  const tracer = (bits & 1) === 1;
  // A word from before kinds were sent says only "a tracer": the battle's amber.
  const kind = (bits >> 1) & 3;
  return {
    tracer,
    kind: tracer && kind === 0 ? TRACER_KIND.amber : kind,
    suppressed: ((bits >> 3) & 1) === 1,
    gun: GUNS[(bits >> 4) & 15] ?? 'ak74',
    comp: ((bits >> 8) & 1) === 1,
    share: SHOT_SHARES[(bits >> 9) & 7],
  };
}

/** A hit's damage: the zone's, times the gun's scale (none given: the zone's alone). */
export function gunDamage(zoneDamage: number, gun: number | undefined): number {
  const key = gun === undefined ? undefined : GUNS[gun];
  return key ? Math.round(zoneDamage * DAMAGE_SCALE[key]) : zoneDamage;
}
