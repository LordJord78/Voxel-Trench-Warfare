/**
 * A fire (the battle spec's §5): started where a shell struck timber, cloth, duckboards (a third of
 * the time) or a hull (a fifth), or in the hamlet's ruins at night. It grows over `grow_s`, burns its
 * `burn_s` (the hamlet's burn on until put out), and dies down over `die_s`; its size sets its light's
 * reach. Its flames rise and fade over their cycle, its embers rise and drift with the wind, and its
 * plume of six puffs leans downwind. All pure functions of the fire, the time and the wind: the
 * director keeps the fires, and any moment of them is had without stepping.
 */

import { cos, sin } from '../core/dmath';
import type { Rng } from '../core/rng';
import type { Tunables } from '../core/tunables';
import { K, kindOf } from '../world/materials';
import type { WorldPlan } from '../world/generation/plan';
import { structureFootprints } from '../world/generation/props';
import type { Wind } from './wind';

type V3 = [number, number, number];

export interface FireTunables {
  chanceTimber: number;
  chanceHull: number;
  growS: number;
  burnS: [number, number];
  dieS: number;
  size: [number, number];
  radiusM: [number, number];
  intensity: number;
  colour: V3;
  flicker: number;
  flickerRate: number;
  liftM: number;
  flames: number;
  flameS: number;
  flameRiseM: number;
  /** Its size as it leaves the fire, and at the top of its rise. */
  flameSizeM: [number, number];
  flameGlow: number;
  flameColour: V3;
  embers: number;
  emberS: number;
  emberRiseMps: number;
  emberSizeM: number;
  emberGlow: number;
  plumePuffs: number;
  plumeM: number;
  plumeRiseMps: number;
  plumeRadiusM: [number, number];
  plumeDensity: number;
  plumeAlpha: number;
  cracklePerS: number;
  maxFires: number;
  hamletFires: [number, number];
  charM: number;
}

export function fireTunables(tun: Tunables): FireTunables {
  const f = (k: string) => tun.f(`battle.fires.${k}`);
  const pair = (k: string) => tun.pair(`battle.fires.${k}`);
  const two = (k: string): [number, number] => {
    const v = tun.get(`battle.fires.${k}`);
    if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new TypeError(`tunable 'battle.fires.${k}' is not two finite numbers: ${JSON.stringify(v)}`);
    return [v[0], v[1]];
  };
  return {
    chanceTimber: f('chance_timber'),
    chanceHull: f('chance_hull'),
    growS: f('grow_s'),
    burnS: pair('burn_s'),
    dieS: f('die_s'),
    size: pair('size'),
    radiusM: pair('radius_m'),
    intensity: f('intensity'),
    colour: tun.triple('battle.fires.colour'),
    flicker: f('flicker'),
    flickerRate: f('flicker_rate'),
    liftM: f('lift_m'),
    flames: tun.i('battle.fires.flames'),
    flameS: f('flame_s'),
    flameRiseM: f('flame_rise_m'),
    flameSizeM: two('flame_size_m'),
    flameGlow: f('flame_glow'),
    flameColour: tun.triple('battle.fires.flame_colour'),
    embers: tun.i('battle.fires.embers'),
    emberS: f('ember_s'),
    emberRiseMps: f('ember_rise_mps'),
    emberSizeM: f('ember_size_m'),
    emberGlow: f('ember_glow'),
    plumePuffs: tun.i('battle.fires.plume_puffs'),
    plumeM: f('plume_m'),
    plumeRiseMps: f('plume_rise_mps'),
    plumeRadiusM: pair('plume_radius_m'),
    plumeDensity: f('plume_density'),
    plumeAlpha: f('plume_alpha'),
    cracklePerS: f('crackle_per_s'),
    maxFires: tun.i('battle.fires.max_fires'),
    hamletFires: pair('hamlet_fires'),
    charM: f('char_m'),
  };
}

/** A fire: where it stands (metres, at its fuel), when it started, its burn and size (0 to 1), whether it is the hamlet's, and when it began to die down early (at dawn, or put out under the cap). */
export interface Fire {
  id: number;
  at: V3;
  t0: number;
  burnS: number;
  size: number;
  hamlet: boolean;
  out?: number;
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
const frac = (x: number) => x - Math.floor(x);

/** How hard it burns at `t`, 0 to 1: growing, burning, dying down. */
export function fireStrength(f: Fire, t: number, ft: FireTunables): number {
  if (t < f.t0) return 0;
  const down = f.out ?? (f.hamlet ? Infinity : f.t0 + ft.growS + f.burnS);
  // Put out while it grows, it grows no more.
  const grow = smooth((Math.min(t, down) - f.t0) / ft.growS);
  return t <= down ? grow : grow * (1 - smooth((t - down) / ft.dieS));
}

/** The chance a shell striking `material` starts a fire: timber, cloth and duckboards a third, a hull a fifth, the rest never. */
export function fireChance(material: number, ft: FireTunables): number {
  const kind = kindOf(material);
  if (kind === K.TIMBER || kind === K.CLOTH || kind === K.DUCKBOARD) return ft.chanceTimber;
  if (kind === K.HULL) return ft.chanceHull;
  return 0;
}

/** A flame or an ember: where (metres), its size across, its glow over its colour, and which. */
export interface FlameQuad {
  centre: V3;
  sizeM: number;
  glow: number;
  ember: boolean;
}

/** Where on the fire a flame or ember of index `i` leaves from: within 0.4 m of its middle by its size, its own place for the fire. */
function spot(f: Fire, i: number): [number, number] {
  const a = f.id * 7.31 + i * 2.17;
  const r = 0.4 * f.size * frac(f.id * 0.61803 + i * 0.381966);
  return [f.at[0] + r * cos(a), f.at[2] + r * sin(a)];
}

/** Its flames, rising `flame_rise_m` × its size over their cycle, shrinking and fading; and its embers, rising and carried by the wind since they left; none at no strength. */
export function fireFlames(f: Fire, t: number, wind: Wind, ft: FireTunables): FlameQuad[] {
  const strength = fireStrength(f, t, ft);
  if (strength <= 0) return [];
  const out: FlameQuad[] = [];
  const age = t - f.t0;
  for (let i = 0; i < ft.flames; i++) {
    const c = frac(age / ft.flameS + i / ft.flames);
    const [x, z] = spot(f, i);
    out.push({
      centre: [x, f.at[1] + c * ft.flameRiseM * f.size, z],
      sizeM: (ft.flameSizeM[0] + (ft.flameSizeM[1] - ft.flameSizeM[0]) * c) * f.size,
      glow: ft.flameGlow * (1 - c) * strength,
      ember: false,
    });
  }
  for (let j = 0; j < ft.embers; j++) {
    const c = frac(age / ft.emberS + j / ft.embers);
    const left = t - c * ft.emberS;
    const [dx, dz] = wind.drift(left, t);
    const [x, z] = spot(f, ft.flames + j);
    out.push({
      centre: [x + dx, f.at[1] + ft.emberRiseMps * c * ft.emberS, z + dz],
      sizeM: ft.emberSizeM,
      glow: ft.emberGlow * (1 - c) * strength,
      ember: true,
    });
  }
  return out;
}

/** A puff of a fire's plume: middle (metres), radius, density per metre at its middle in the haze, and how much it covers drawn. */
export interface PlumePuff {
  centre: V3;
  radiusM: number;
  density: number;
  alpha: number;
}

/** Its plume: `plume_puffs` puffs up to `plume_m`, each leaning downwind by the wind's speed over the time smoke takes to rise to it, growing as it rises, thinning with the fire's strength. */
export function firePlume(f: Fire, t: number, wind: Wind, ft: FireTunables): PlumePuff[] {
  const strength = fireStrength(f, t, ft);
  if (strength <= 0) return [];
  const [wx, wz] = wind.at(t);
  const out: PlumePuff[] = [];
  for (let k = 0; k < ft.plumePuffs; k++) {
    const share = (k + 1) / ft.plumePuffs;
    const h = ft.plumeM * share;
    const lean = h / ft.plumeRiseMps;
    out.push({
      centre: [f.at[0] + wx * lean, f.at[1] + h, f.at[2] + wz * lean],
      radiusM: (ft.plumeRadiusM[0] + (ft.plumeRadiusM[1] - ft.plumeRadiusM[0]) * share) * f.size,
      density: ft.plumeDensity * strength,
      alpha: ft.plumeAlpha * strength,
    });
  }
  return out;
}

/** The hamlet's fires: 2–4 of its buildings, each fire on its rubble floor, within its walls. */
export function hamletFireSites(plan: WorldPlan, rng: Rng, ft: FireTunables): V3[] {
  const v = plan.params.voxel;
  const buildings = structureFootprints(plan).filter((b) => b.kind === 'hamlet');
  const count = Math.min(buildings.length, rng.randint(ft.hamletFires[0], ft.hamletFires[1] + 1));
  const picked = rng.shuffled(buildings).slice(0, count);
  return picked.map((b) => {
    // Inside the walls (3 voxels) and the rubble's border, on the rubble a voxel over the slab.
    const inset = 4;
    const x = b.x0 + inset + rng.uniform(0, Math.max(1, b.x1 - b.x0 - 2 * inset));
    const z = b.z0 + inset + rng.uniform(0, Math.max(1, b.z1 - b.z0 - 2 * inset));
    return [x * v, ((b.underY ?? 0) + 3) * v, z * v];
  });
}
