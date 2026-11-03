/**
 * The loadout's guns and what fits them: each gun's name and role, its slot (a long gun, or the
 * pistol on the hip), the attachments each of its four slots takes (the first of each, its own
 * bare), and where on it they go — its mounts, in its model's metres (gun-models.ts): x right, y
 * up, z forward from the receiver's rear on the bore. Its numbers (rate, magazine, cone, round,
 * recoil, kick) are its tunables' tables, `[weapon.<table>]` and the rest, and each attachment's
 * are `[attachment.<key>]`: a gun in the hands is the two together (`armSpec`).
 *
 * Mounts are on the model's lattice: z at a voxel's face (a multiple of 1.5 cm), x and y at a
 * face too (odd multiples of 7.5 mm), except a side mount's y and the bore's, at a voxel's middle.
 */

import type { Tunables } from '../core/tunables';
import { BARE, GUNS, MUZZLES, OPTICS, SIDES, TRACER_KIND, TRACERS, UNDERS, tracerKind, type Fit, type Gear, type GunKey, type Muzzle, type Optic, type Side, type Tracer, type Under } from '../net/gear';
import { recoilProfile, type RecoilProfile } from './recoil';
import type { Hold } from './soldier-rig';
import { viewKickProfile, type ViewKickProfile } from './viewkick';
import { weaponSpec, type WeaponSpec } from './weapon';

type V3 = [number, number, number];

export interface Mounts {
  /** The top of the rail an optic stands on, and the optic's middle along it. */
  railY: number;
  opticZ: number;
  /** The iron sights' line, over the bore. */
  ironY: number;
  /** Where the barrel ends (a muzzle device starts), and where the gun's own device ends. */
  muzzleZ: number;
  bareMuzzleZ: number;
  /** The underside a grip clamps to: its height and its middle along the gun. */
  underY: number;
  underZ: number;
  /** The left face a light or laser clamps to (x), the bore-height it sits at (y), its rear (z); `below`, hung under the frame (a pistol's). */
  side: { x: number; y: number; z: number; below?: boolean };
  port: V3;
  /** The hands: the pistol grip, and the support hand forward (a grip fitted moves it). */
  grip: V3;
  fore: V3;
  /** Aimed with the irons: how far before the eye the model's origin is. */
  adsZ: number;
}

export interface GunDef {
  key: GunKey;
  /** Its tunables' tables: [weapon.<table>], [recoil.<table>], [viewkick.<table>]. */
  table: string;
  name: string;
  role: string;
  slot: 'primary' | 'secondary';
  fits: { optic: readonly Optic[]; muzzle: readonly Muzzle[]; under: readonly Under[]; side: readonly Side[] };
  mounts: Mounts;
}

const ALL = { optic: OPTICS, muzzle: MUZZLES, under: UNDERS, side: SIDES };

export const GUN_DEFS: Record<GunKey, GunDef> = {
  ak74: {
    key: 'ak74', table: 'assault_rifle', name: 'AK-74', role: 'Assault rifle', slot: 'primary', fits: ALL,
    mounts: {
      railY: 0.0525, opticZ: 0.195, ironY: 0.0675, muzzleZ: 0.66, bareMuzzleZ: 0.72, underY: -0.0375, underZ: 0.435,
      side: { x: -0.0225, y: 0, z: 0.39 }, port: [0.0225, 0.012, 0.17], grip: [0, -0.07, 0.04], fore: [0, -0.03, 0.42], adsZ: 0.1,
    },
  },
  m4: {
    key: 'm4', table: 'm4', name: 'M4A1', role: 'Carbine', slot: 'primary', fits: ALL,
    mounts: {
      railY: 0.0525, opticZ: 0.105, ironY: 0.0825, muzzleZ: 0.615, bareMuzzleZ: 0.66, underY: -0.0375, underZ: 0.36,
      side: { x: -0.0225, y: 0, z: 0.375 }, port: [0.0225, 0.015, 0.12], grip: [0, -0.08, 0.05], fore: [0, -0.045, 0.36], adsZ: 0.07,
    },
  },
  mp5: {
    key: 'mp5', table: 'mp5', name: 'MP5', role: 'Submachine gun', slot: 'primary',
    fits: { optic: ['iron', 'reddot', 'holo'], muzzle: ['none', 'suppressor'], under: UNDERS, side: SIDES },
    mounts: {
      railY: 0.0525, opticZ: 0.135, ironY: 0.06, muzzleZ: 0.45, bareMuzzleZ: 0.45, underY: -0.0525, underZ: 0.3,
      side: { x: -0.0225, y: -0.015, z: 0.24 }, port: [0.0225, 0.015, 0.18], grip: [0, -0.075, 0.09], fore: [0, -0.05, 0.29], adsZ: 0.08,
    },
  },
  svd: {
    key: 'svd', table: 'svd', name: 'SVD', role: 'Marksman rifle', slot: 'primary',
    fits: { optic: ['scope', 'iron', 'reddot'], muzzle: ['none', 'suppressor'], under: ['none'], side: SIDES },
    mounts: {
      railY: 0.0675, opticZ: 0.135, ironY: 0.0675, muzzleZ: 0.84, bareMuzzleZ: 0.915, underY: -0.0375, underZ: 0.45,
      side: { x: -0.0225, y: 0, z: 0.42 }, port: [0.0225, 0.015, 0.12], grip: [0, -0.085, -0.04], fore: [0, -0.04, 0.39], adsZ: 0.15,
    },
  },
  m249: {
    key: 'm249', table: 'm249', name: 'M249', role: 'Light machine gun', slot: 'primary', fits: ALL,
    mounts: {
      railY: 0.0675, opticZ: 0.15, ironY: 0.0825, muzzleZ: 0.81, bareMuzzleZ: 0.855, underY: -0.0525, underZ: 0.405,
      side: { x: -0.0225, y: -0.015, z: 0.345 }, port: [0.0375, 0, 0.15], grip: [0, -0.095, 0.09], fore: [0, -0.06, 0.4], adsZ: 0.07,
    },
  },
  m870: {
    key: 'm870', table: 'm870', name: 'M870', role: 'Shotgun', slot: 'primary',
    fits: { optic: ['iron', 'reddot', 'holo'], muzzle: ['none'], under: ['none'], side: SIDES },
    mounts: {
      railY: 0.0525, opticZ: 0.09, ironY: 0.0375, muzzleZ: 0.69, bareMuzzleZ: 0.69, underY: -0.0825, underZ: 0.33,
      side: { x: -0.0225, y: -0.03, z: 0.45 }, port: [0.0225, 0, 0.1], grip: [0, -0.045, -0.03], fore: [0, -0.06, 0.33], adsZ: 0.1,
    },
  },
  m17: {
    key: 'm17', table: 'm17', name: 'M17', role: 'Pistol', slot: 'secondary',
    fits: { optic: ['iron', 'reddot'], muzzle: ['none', 'suppressor'], under: ['none'], side: SIDES },
    mounts: {
      railY: 0.0375, opticZ: 0.06, ironY: 0.0525, muzzleZ: 0.18, bareMuzzleZ: 0.18, underY: -0.0375, underZ: 0.12,
      side: { x: 0, y: -0.0375, z: 0.105, below: true }, port: [0.0225, 0.0225, 0.09], grip: [0, -0.08, 0], fore: [-0.012, -0.09, 0.006], adsZ: 0.36,
    },
  },
  pm: {
    key: 'pm', table: 'pm', name: 'PM', role: 'Pistol', slot: 'secondary',
    fits: { optic: ['iron'], muzzle: ['none', 'suppressor'], under: ['none'], side: ['none'] },
    mounts: {
      railY: 0.0225, opticZ: 0.06, ironY: 0.0375, muzzleZ: 0.15, bareMuzzleZ: 0.15, underY: -0.0375, underZ: 0.1,
      side: { x: 0, y: -0.0375, z: 0.09, below: true }, port: [0.0225, 0.0075, 0.06], grip: [0, -0.07, 0], fore: [-0.012, -0.08, 0.006], adsZ: 0.36,
    },
  },
};

export const PRIMARY_GUNS: readonly GunKey[] = GUNS.filter((g) => GUN_DEFS[g].slot === 'primary');
export const SECONDARY_GUNS: readonly GunKey[] = GUNS.filter((g) => GUN_DEFS[g].slot === 'secondary');

/** The attachments' names as the loadout shows them. */
export const ATTACHMENT_NAMES: Record<Optic | Muzzle | Under | Side, string> = {
  iron: 'Iron sights', reddot: 'Red dot', holo: 'Holographic', scope: '4x scope',
  none: 'None', suppressor: 'Suppressor', compensator: 'Compensator',
  vertical: 'Vertical grip', angled: 'Angled grip',
  flashlight: 'Flashlight', laser: 'Laser',
};
export const TRACER_NAMES: Record<Tracer, string> = { off: 'No tracers', red: 'Red tracers', green: 'Green tracers' };

/** What a player takes in: a long gun and a pistol, each with its own fit, and their tracers' colour. */
export interface Loadout {
  primary: GunKey;
  secondary: GunKey;
  fits: Partial<Record<GunKey, Fit>>;
  tracer: Tracer;
}

export function defaultLoadout(): Loadout {
  return { primary: 'ak74', secondary: 'm17', fits: {}, tracer: 'red' };
}

const isGun = (v: unknown): v is GunKey => typeof v === 'string' && (GUNS as readonly string[]).includes(v);

/** A fit for `gun`, each slot what it takes (anything else its first: bare). */
export function cleanFit(gun: GunKey, raw: unknown): Fit {
  const f = GUN_DEFS[gun].fits;
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(list: readonly T[], v: unknown): T => (list.includes(v as T) ? (v as T) : list[0]);
  return { optic: pick(f.optic, r.optic), muzzle: pick(f.muzzle, r.muzzle), under: pick(f.under, r.under), side: pick(f.side, r.side) };
}

/** A loadout from anything (local storage, hand-edited): what is not one, the default's. */
export function cleanLoadout(raw: unknown): Loadout {
  const d = defaultLoadout();
  if (typeof raw !== 'object' || raw === null) return d;
  const r = raw as Record<string, unknown>;
  const primary = isGun(r.primary) && GUN_DEFS[r.primary].slot === 'primary' ? r.primary : d.primary;
  const secondary = isGun(r.secondary) && GUN_DEFS[r.secondary].slot === 'secondary' ? r.secondary : d.secondary;
  const fits: Partial<Record<GunKey, Fit>> = {};
  const given = (typeof r.fits === 'object' && r.fits !== null ? r.fits : {}) as Record<string, unknown>;
  for (const g of GUNS) if (g in given) fits[g] = cleanFit(g, given[g]);
  const tracer = (TRACERS as readonly string[]).includes(r.tracer as string) ? (r.tracer as Tracer) : d.tracer;
  return { primary, secondary, fits, tracer };
}

export function fitOf(l: Loadout, gun: GunKey): Fit {
  return cleanFit(gun, l.fits[gun] ?? BARE);
}

/** Where the eye is aimed through: the sight's line over the bore, and how far before the eye the model's origin is. */
export function sightOf(gun: GunKey, fit: Fit): { y: number; z: number } {
  const m = GUN_DEFS[gun].mounts;
  if (fit.optic === 'iron') return { y: m.ironY, z: m.adsZ };
  const y = m.railY + 0.0525;
  if (GUN_DEFS[gun].slot === 'secondary') return { y, z: m.adsZ };
  // A dot's window some 12 cm from the eye; a scope's eyepiece 7.5 cm.
  return fit.optic === 'scope' ? { y, z: 0.075 - (m.opticZ - 0.18) } : { y, z: 0.12 - (m.opticZ - 0.045) };
}

/** A gun's muzzle with its fit (where the round's flash and tracer start), model metres. */
export function muzzleOf(gun: GunKey, fit: Fit): V3 {
  const m = GUN_DEFS[gun].mounts;
  const pistol = GUN_DEFS[gun].slot === 'secondary';
  const z = fit.muzzle === 'suppressor' ? m.muzzleZ + (pistol ? 0.12 : 0.165) : fit.muzzle === 'compensator' ? m.muzzleZ + 0.06 : m.bareMuzzleZ;
  return [0, 0, z];
}

/** Where a fitted light's beam (or a laser's) leaves, model metres; null with neither. */
export function beamOf(gun: GunKey, fit: Fit): V3 | null {
  const s = GUN_DEFS[gun].mounts.side;
  if (fit.side === 'none') return null;
  const reach = fit.side === 'flashlight' ? (s.below ? 0.075 : 0.12) : s.below ? 0.06 : 0.075;
  // Both lie along the gun a voxel and a half out from the face they clamp to (gun-models.ts).
  return s.below ? [0, s.y - 0.0225, s.z + reach] : [s.x - 0.0225, s.y, s.z + reach];
}

/** The support hand with the fit: on a fitted grip, or the gun's own place for it. */
export function foreOf(gun: GunKey, fit: Fit): V3 {
  const m = GUN_DEFS[gun].mounts;
  if (fit.under === 'vertical') return [0, m.underY - 0.06, m.underZ];
  if (fit.under === 'angled') return [0, m.underY - 0.035, m.underZ - 0.015];
  return m.fore;
}

/** The shovel's grips: the D at the handle's end, and a hand down the shaft. */
const SHOVEL_GRIP: V3 = [0, -0.015, -0.2];
const SHOVEL_FORE: V3 = [0, -0.008, 0.15];

/** How another player holds what they show (net/gear.ts), for their pose: its grips, a pistol, or the shovel through `stroke` (turns) while digging. */
export function holdOf(g: Gear, stroke?: number): Hold {
  if (g.gun === null) return stroke === undefined ? { kind: 'shovel', grip: SHOVEL_GRIP, fore: SHOVEL_FORE } : { kind: 'shovel', grip: SHOVEL_GRIP, fore: SHOVEL_FORE, stroke };
  const def = GUN_DEFS[g.gun];
  return { kind: def.slot === 'secondary' ? 'pistol' : 'rifle', grip: def.mounts.grip, fore: foreOf(g.gun, g.fit) };
}

/** An attachment's terms (`[attachment.<key>]`): each multiplies the gun's, 1 where it gives none. */
export interface AttachmentTerms {
  hipSpread: number;
  adsSpread: number;
  kick: number;
  climb: number;
  adsTime: number;
  zoom: number;
  flash: number;
  reportGain: number;
  velocity: number;
  move: number;
}

const TERM_KEYS: readonly [keyof AttachmentTerms, string][] = [
  ['hipSpread', 'hip_spread'], ['adsSpread', 'ads_spread'], ['kick', 'kick'], ['climb', 'climb'], ['adsTime', 'ads_time'],
  ['zoom', 'zoom'], ['flash', 'flash'], ['reportGain', 'report_gain'], ['velocity', 'velocity'], ['move', 'move'],
];

export function attachmentTerms(tun: Tunables, key: string): AttachmentTerms {
  let table: Record<string, unknown> = {};
  try {
    table = tun.section(`attachment.${key}`);
  } catch {
    // An attachment with nothing of its own (none): every term 1.
  }
  return Object.fromEntries(TERM_KEYS.map(([field, k]) => [field, typeof table[k] === 'number' ? (table[k] as number) : 1])) as unknown as AttachmentTerms;
}

/** A gun in the hands: its weapon's, recoil's and kick's numbers with the fit's terms in, and what the fit makes of it. */
export interface ArmSpec {
  gun: GunDef;
  fit: Fit;
  weapon: WeaponSpec;
  recoil: RecoilProfile;
  viewKick: ViewKickProfile;
  /** The cone's share from the hip, and aimed down the sights; and a laser's, switched on, from the hip. */
  hipSpread: number;
  adsSpread: number;
  laserSpread: number;
  /** Seconds to raise the sights; the sight's magnification; the carrier's speed. */
  adsTimeS: number;
  zoom: number;
  move: number;
  /** The muzzle's flash and report, as shares of a bare gun's. */
  flash: number;
  report: number;
  suppressed: boolean;
  /** Its rounds' tracer (TRACER_KIND), every `weapon.tracerEvery`-th. */
  tracerKind: number;
  sight: { y: number; z: number };
  muzzle: V3;
  port: V3;
  beam: V3 | null;
}

/**
 * `gun` with `fit`, its tracers `tracer` (a loadout's colour, or the battle's amber where no
 * loadout says: the session's own default). Bare, every term is the gun's own, exactly.
 */
export function armSpec(tun: Tunables, gun: GunKey, fit: Fit, tracer: Tracer | 'amber'): ArmSpec {
  const def = GUN_DEFS[gun];
  const terms = [fit.optic, fit.muzzle, fit.under, fit.side].filter((k) => k !== 'none').map((k) => attachmentTerms(tun, k));
  const product = (k: keyof AttachmentTerms) => terms.reduce((p, t) => p * t[k], 1);
  const base = weaponSpec(tun, def.table);
  const kind = tracer === 'amber' ? TRACER_KIND.amber : tracerKind(tracer);
  const velocity = product('velocity');
  const weapon: WeaponSpec = {
    ...base,
    tracerEvery: kind === TRACER_KIND.none ? 0 : base.tracerEvery,
    projectile: velocity === 1 ? base.projectile : { ...base.projectile, muzzleVelocity: base.projectile.muzzleVelocity * velocity },
  };
  const kick = product('kick');
  const climb = product('climb');
  const r = recoilProfile(tun, def.table);
  const recoil: RecoilProfile = kick === 1 && climb === 1 ? r : { ...r, kickPitchDeg: r.kickPitchDeg * kick, kickYawDeg: r.kickYawDeg * kick, climbPerShotDeg: r.climbPerShotDeg * climb, climbCeilingDeg: r.climbCeilingDeg * climb, driftYawDeg: r.driftYawDeg * climb };
  const laser = fit.side === 'laser' ? attachmentTerms(tun, 'laser').hipSpread : 1;
  return {
    gun: def,
    fit,
    weapon,
    recoil,
    viewKick: viewKickProfile(tun, def.table),
    // A laser's share holds only while it is on: the session applies it then.
    hipSpread: product('hipSpread') / laser,
    adsSpread: base.adsSpread * product('adsSpread'),
    laserSpread: laser,
    adsTimeS: base.adsTimeS * product('adsTime'),
    zoom: product('zoom'),
    move: base.moveScale * product('move'),
    flash: product('flash'),
    report: product('reportGain'),
    suppressed: fit.muzzle === 'suppressor',
    tracerKind: kind,
    sight: sightOf(gun, fit),
    muzzle: muzzleOf(gun, fit),
    port: def.mounts.port,
    beam: beamOf(gun, fit),
  };
}

/** The loadout's two guns in the hands, the long gun first. */
export function loadoutArms(tun: Tunables, l: Loadout): ArmSpec[] {
  return [l.primary, l.secondary].map((g) => armSpec(tun, g, fitOf(l, g), l.tracer));
}

/** A gun's numbers as the loadout compares them, each 0 to 1 against the arsenal's best. */
export interface GunStats {
  damage: number;
  rate: number;
  accuracy: number;
  control: number;
  range: number;
  handling: number;
  mobility: number;
}

export function gunStats(a: ArmSpec, damageScale: number): GunStats {
  const w = a.weapon;
  const clamp = (v: number) => Math.max(0.04, Math.min(1, v));
  const aimedMoa = w.dispersionMoa * a.adsSpread * (w.pellets > 1 ? 0.25 : 1);
  return {
    damage: clamp((damageScale * w.pellets) / 2.2),
    rate: clamp(w.rpm / 900),
    accuracy: clamp(1 - aimedMoa / 8),
    control: clamp(1 - (a.recoil.kickPitchDeg + a.recoil.climbPerShotDeg * 2) / 4.5),
    range: clamp(w.projectile.muzzleVelocity / 950),
    handling: clamp(1 - (a.adsTimeS - 0.1) / 0.45 - (w.reloadS - 1.5) / 12),
    mobility: clamp((a.move - 0.75) / 0.35),
  };
}
