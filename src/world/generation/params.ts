/**
 * Every number generation uses, derived once from tunables.
 *
 * Tunables are metres; generation works in voxels. The conversion lives here so
 * no generation module ever sees a metre or a literal voxel count, the rule the
 * Python game's `grid.vx` set. The checks the Python generator made inline — a
 * crest that gives a peek, a walkway a body fits — run here, so a bad edit to
 * tunables.toml fails before a voxel is written.
 */

import { Tunables } from '../../core/tunables';
import type { Dims } from '../bricks';

/** Voxels spanning `metres`, rounded half up (not to even), as Python's `grid.vx`. */
export function vx(metres: number, voxel: number): number {
  return Math.floor(metres / voxel + 0.5);
}

export interface LineSpec {
  name: string;
  side: 0 | 1;
  /** 0 if the trench runs along x, 2 if along z. */
  longAxis: 0 | 2;
  crossBase: number;
  aStart: number;
  aEnd: number;
  /** +1 if the enemy lies toward +z (or +x for comm trenches), -1 otherwise. */
  facing: 1 | -1;
  firingSteps: boolean;
  dugoutEvery: number;
}

export interface GenParams {
  voxel: number;
  dims: Dims;
  ground: number;
  waterTable: number;
  trench: {
    width: number; depth: number; bench: number; treadDepth: number; treadRise: number; treadsAcross: number;
    parapetMin: number; paradosH: number; crestFlat: number; bayLen: number; offset: number; leg: number;
    stepMin: number; stepMax: number; smooth: number; reach: number; near: number; percentile: number;
    margin: number; crestRise: number; lineMargin: number; floorMin: number; floorMaxBelowTop: number;
  };
  eye: { standing: number; crouched: number };
  stepUp: number;
  bodyRadius: number;
  field: {
    amplitude: number; octaves: number; baseCell: number; persistence: number;
    swaleDepth: number; swaleMargin: number; ditches: number;
  };
  layout: {
    reserve: number; support: number; front: number; enemyFront: number; enemySupport: number; enemyReserve: number;
    comm: number[]; enemyComm: number[]; shelterbelts: number[];
    hamlet: [number, number]; wood: [number, number];
    farm: [number, number]; culvert: [number, number]; hull: [number, number];
  };
  clutter: { fenceLines: number; poles: number };
  /** From [destruction]: what a shell spares, its core, and the rind it shakes loose. */
  destruction: { hardLimit: number; core: number; loosen: number };
  craters: {
    nml: number; rear: number; directPerLine: number; radiusMin: number;
    gammaShape: number; gammaScale: number; radiusCap: number; directCap: number;
  };
  lines: LineSpec[];
}

function sectorCeil(n: number): number {
  return Math.ceil(n / 32) * 32;
}

function numbers(tun: Tunables, key: string): number[] {
  const value = tun.get(key);
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new TypeError(`tunable '${key}' must be a list of numbers`);
  }
  return value as number[];
}

function pair(tun: Tunables, key: string, v: (m: number) => number): [number, number] {
  const list = numbers(tun, key);
  if (list.length !== 2) throw new TypeError(`tunable '${key}' must be a pair`);
  return [v(list[0]), v(list[1])];
}

export function genParams(tun: Tunables, override?: (raw: Record<string, unknown>) => void): GenParams {
  if (override) {
    const raw = tun.raw();
    override(raw);
    tun = new Tunables(raw);
  }
  const voxel = tun.f('world.voxel_size');
  const v = (key: string) => vx(tun.f(key), voxel);
  const m = (metres: number) => vx(metres, voxel);
  const per = (key: string) => tun.f(key) / voxel;

  const dims = { x: sectorCeil(v('world.size_x_m')), y: sectorCeil(v('world.size_y_m')), z: sectorCeil(v('world.size_z_m')) };
  const width = v('world.trench.width_m');
  const treadDepth = Math.max(1, v('world.trench.tread_depth_m'));
  const bench = Math.max(1, v('world.trench.step_bench_m'));
  const bayLen = Math.max(4, v('world.trench.bay_length_m'));
  const stepMin = v('world.trench.firing_step_min_m');
  const eye = { standing: per('player.eye_height_standing'), crouched: per('player.eye_height_crouched') };
  const trench = {
    width,
    depth: v('world.trench.depth_m'),
    bench,
    treadDepth,
    treadRise: Math.max(1, v('world.trench.tread_rise_m')),
    treadsAcross: Math.floor(v('world.trench.step_tread_m') / treadDepth),
    parapetMin: v('world.trench.parapet_min_m'),
    paradosH: Math.max(1, v('world.trench.parados_m')),
    crestFlat: v('world.trench.crest_flat_m'),
    bayLen,
    offset: width + Math.max(1, v('world.trench.traverse_gap_m')),
    leg: Math.max(2, m(1.5)),
    stepMin,
    stepMax: Math.max(stepMin, Math.min(v('world.trench.firing_step_max_m'), bayLen - 4)),
    smooth: Math.max(1, v('world.trench.crest_smoothing_m')),
    reach: Math.max(1, v('world.trench.sight_range_m')),
    near: Math.max(1, v('world.trench.sight_near_m')),
    percentile: tun.f('world.trench.sight_percentile'),
    margin: per('world.trench.sight_margin_m'),
    crestRise: m(tun.f('player.eye_height_standing') - tun.f('world.trench.crest_clearance_m')),
    lineMargin: v('world.trench.line_margin_m'),
    floorMin: v('world.trench.floor_min_m'),
    floorMaxBelowTop: v('world.trench.floor_below_top_m'),
  };
  const stepUp = per('player.step_up');
  const bodyRadius = per('player.radius');

  // The peek, stated as arithmetic: a standing eye over the crest, a crouched
  // one under it. Checked here so a careless eye-height edit fails loudly
  // instead of quietly turning every parapet into a wall.
  if (!(eye.crouched < trench.crestRise && trench.crestRise < eye.standing)) {
    throw new RangeError(
      `no crest gives a peek: a ${trench.crestRise}-voxel crest is not strictly between the crouched eye ` +
        `(${eye.crouched.toFixed(2)} voxels) and the standing eye (${eye.standing.toFixed(2)} voxels)`,
    );
  }
  if (trench.treadRise > stepUp + 1e-9) {
    throw new RangeError(`a ${trench.treadRise}-voxel tread rise needs a step-up at least that; player.step_up is ${stepUp} voxels`);
  }
  const structure = bench + trench.treadsAcross * treadDepth;
  if (width - structure < bodyRadius * 2) {
    throw new RangeError(`a ${width}-voxel trench less a ${structure}-voxel firing step leaves no walkway for a body ${bodyRadius * 2} voxels across`);
  }
  if (bench + treadDepth < bodyRadius * 2) {
    throw new RangeError(`a ${bench}-voxel bench over a ${treadDepth}-voxel tread is too narrow to stand on`);
  }

  const layout = {
    reserve: v('world.layout.reserve_line_m'),
    support: v('world.layout.support_line_m'),
    front: v('world.layout.front_line_m'),
    enemyFront: v('world.layout.enemy_front_m'),
    enemySupport: v('world.layout.enemy_support_m'),
    enemyReserve: v('world.layout.enemy_reserve_m'),
    comm: numbers(tun, 'world.layout.comm_trench_x_m').map(m),
    enemyComm: numbers(tun, 'world.layout.enemy_comm_trench_x_m').map(m),
    shelterbelts: numbers(tun, 'world.layout.shelterbelt_z_m').map(m),
    hamlet: pair(tun, 'world.layout.hamlet_z_m', m),
    wood: pair(tun, 'world.layout.wood_z_m', m),
    farm: pair(tun, 'world.layout.farm_m', m),
    culvert: pair(tun, 'world.layout.culvert_m', m),
    hull: pair(tun, 'world.layout.hull_m', m),
  };

  const along = (name: string, side: 0 | 1, z: number, facing: 1 | -1, firingSteps: boolean, dugoutEvery: number): LineSpec => ({
    name, side, longAxis: 0, crossBase: z, aStart: trench.lineMargin, aEnd: dims.x - trench.lineMargin, facing, firingSteps, dugoutEvery,
  });
  const lines: LineSpec[] = [
    along('front', 0, layout.front, 1, true, 3),
    along('support', 0, layout.support, 1, false, 4),
    along('reserve', 0, layout.reserve, 1, false, 2),
    along('enemy_front', 1, layout.enemyFront, -1, true, 3),
    along('enemy_support', 1, layout.enemySupport, -1, false, 4),
    along('enemy_reserve', 1, layout.enemyReserve, -1, false, 2),
    ...layout.comm.map((x, i): LineSpec => ({
      name: `comm_${i}`, side: 0, longAxis: 2, crossBase: x, aStart: layout.reserve - 1, aEnd: layout.front + m(3.0),
      facing: 1, firingSteps: false, dugoutEvery: 0,
    })),
    ...layout.enemyComm.map((x, i): LineSpec => ({
      name: `enemy_comm_${i}`, side: 1, longAxis: 2, crossBase: x, aStart: layout.enemyFront + m(3.0), aEnd: layout.enemyReserve + 1,
      facing: -1, firingSteps: false, dugoutEvery: 0,
    })),
  ];

  return {
    voxel,
    dims,
    ground: v('world.ground_level_m'),
    waterTable: v('world.water_table_m'),
    trench,
    eye,
    stepUp,
    bodyRadius,
    field: {
      amplitude: per('world.field.relief_amplitude_m'),
      octaves: tun.i('world.field.relief_octaves'),
      baseCell: per('world.field.relief_cell_m'),
      persistence: tun.f('world.field.relief_persistence'),
      swaleDepth: v('world.field.swale_depth_m'),
      swaleMargin: v('world.field.swale_margin_m'),
      ditches: tun.i('world.field.ditches'),
    },
    layout,
    clutter: { fenceLines: tun.i('world.clutter.fence_lines'), poles: tun.i('world.clutter.poles') },
    destruction: {
      hardLimit: tun.f('destruction.resists_above_hardness'),
      core: tun.f('destruction.core_radius_scale'),
      loosen: tun.f('destruction.loosen_radius_scale'),
    },
    craters: {
      nml: tun.i('world.craters.nml_count'),
      rear: tun.i('world.craters.rear_count'),
      directPerLine: tun.i('world.craters.direct_hits_per_line'),
      radiusMin: per('world.craters.radius_min_m'),
      gammaShape: tun.f('world.craters.gamma_shape'),
      gammaScale: per('world.craters.gamma_scale_m'),
      radiusCap: per('world.craters.radius_cap_m'),
      directCap: per('world.craters.direct_cap_m'),
    },
    lines,
  };
}
