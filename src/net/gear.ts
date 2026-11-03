/**
 * What a player carries, as the room and the others need to know it (the loadout): the guns in
 * the order every client and the room number them, what each one's round does to a body against
 * the zones' damage (match-rules.ts), and the gear a player shows, packed into an integer: the
 * gun in their hands (or the shovel), what is fitted to it, their tracers' colour and whether
 * their light is on. It rides above the eight bits of their state's flags, and a shot's own word
 * says which gun fired it, its tracer's colour and whether it was suppressed: the room relays both
 * as they are, so none of this changes what it is sent.
 *
 * Pure and small, because the room imports it.
 */

export const GUNS = ['ak74', 'm4', 'mp5', 'svd', 'm249', 'm870', 'm17', 'pm'] as const;
export type GunKey = (typeof GUNS)[number];

/** Each gun's round against the zones' damage: a marksman's rifle kills with a chest shot; each of a shotgun's pellets does a share. */
export const DAMAGE_SCALE: Record<GunKey, number> = { ak74: 1.05, m4: 1, mp5: 0.75, svd: 1.9, m249: 1, m870: 0.42, m17: 0.8, pm: 0.72 };

export const OPTICS = ['iron', 'reddot', 'holo', 'scope'] as const;
export const MUZZLES = ['none', 'suppressor', 'compensator'] as const;
export const UNDERS = ['none', 'vertical', 'angled'] as const;
export const SIDES = ['none', 'flashlight', 'laser'] as const;
export const TRACERS = ['off', 'red', 'green'] as const;
export type Optic = (typeof OPTICS)[number];
export type Muzzle = (typeof MUZZLES)[number];
export type Under = (typeof UNDERS)[number];
export type Side = (typeof SIDES)[number];
export type Tracer = (typeof TRACERS)[number];

/** What is fitted to a gun, a slot each. */
export interface Fit {
  optic: Optic;
  muzzle: Muzzle;
  under: Under;
  side: Side;
}

export const BARE: Fit = { optic: 'iron', muzzle: 'none', under: 'none', side: 'none' };

/** What a player shows: the gun in their hands (null: the shovel) and its fit, their tracers, their light (or laser) on. */
export interface Gear {
  gun: GunKey | null;
  fit: Fit;
  tracer: Tracer;
  light: boolean;
}

/** A round's tracer, as the pool keeps it: none, the battle's amber, or a loadout's red or green. */
export const TRACER_KIND = { none: 0, amber: 1, red: 2, green: 3 } as const;

export function tracerKind(t: Tracer): number {
  return t === 'red' ? TRACER_KIND.red : t === 'green' ? TRACER_KIND.green : TRACER_KIND.none;
}

/** The four bits of the gun in hand for the shovel. */
const SHOVEL = 15;

/** Gear as 15 bits: the gun (4), the optic, muzzle, underbarrel and side (2 each), the tracers (2), the light (1). */
export function encodeGear(g: Gear): number {
  const gun = g.gun === null ? SHOVEL : GUNS.indexOf(g.gun);
  return (
    (gun & 15) |
    (OPTICS.indexOf(g.fit.optic) << 4) |
    (MUZZLES.indexOf(g.fit.muzzle) << 6) |
    (UNDERS.indexOf(g.fit.under) << 8) |
    (SIDES.indexOf(g.fit.side) << 10) |
    (TRACERS.indexOf(g.tracer) << 12) |
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
    tracer: pick(TRACERS, (bits >> 12) & 3, 'off'),
    light: ((bits >> 14) & 1) === 1,
  };
}

/** A shot's word: whether a tracer and its kind (TRACER_KIND), whether suppressed, and which gun. */
export interface ShotMark {
  tracer: boolean;
  kind: number;
  suppressed: boolean;
  gun: GunKey;
}

/** Bit 0 a tracer (as the word was before it said more), bits 1–2 its kind, bit 3 suppressed, bits 4–7 the gun. */
export function encodeShotMark(m: ShotMark): number {
  return (m.tracer ? 1 : 0) | ((m.kind & 3) << 1) | ((m.suppressed ? 1 : 0) << 3) | (Math.max(0, GUNS.indexOf(m.gun)) << 4);
}

export function decodeShotMark(n: number): ShotMark {
  const bits = Number.isInteger(n) && n >= 0 ? n : 0;
  const tracer = (bits & 1) === 1;
  // A word from before kinds were sent says only "a tracer": the battle's amber.
  const kind = (bits >> 1) & 3;
  return { tracer, kind: tracer && kind === 0 ? TRACER_KIND.amber : kind, suppressed: ((bits >> 3) & 1) === 1, gun: GUNS[(bits >> 4) & 15] ?? 'ak74' };
}

/** A hit's damage: the zone's, times the gun's scale (none given: the zone's alone). */
export function gunDamage(zoneDamage: number, gun: number | undefined): number {
  const key = gun === undefined ? undefined : GUNS[gun];
  return key ? Math.round(zoneDamage * DAMAGE_SCALE[key]) : zoneDamage;
}
