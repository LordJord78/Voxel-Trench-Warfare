import { beforeAll, describe, expect, it } from 'vitest';
import { standardViews } from '../../src/app/views';
import { FIRST_DUMMY, plateVoxels, Range, rangeGround, rangeLayout, rangeTunables, type RangeSpot } from '../../src/combat/range';
import { loadTunables } from '../../src/core/tunables';
import { GUNS, type GunKey } from '../../src/net/gear';
import { MatchRules } from '../../src/net/match-rules';
import { BrickMap } from '../../src/world/bricks';
import { fillBand } from '../../src/world/generation/fill';
import { generateWorld, type GeneratedWorld } from '../../src/world/generation/generate';
import { MAP_SEEDS, genParams, type MapId } from '../../src/world/generation/params';
import { planWorld, type WorldPlan } from '../../src/world/generation/plan';
import { blocksSight, isGranular, isSolid, K, kindOf, P } from '../../src/world/materials';
import { groundTop, raycast } from '../../src/world/raycast';

// The range (the shots spec's §5): dummies and steel plates out along the spawn bay's facing, each
// on dry, level ground across the bay's frontage; the dummies take a match's damage, lie 4 s, and
// stand again; two of them walk.
const tun = loadTunables();
const t = rangeTunables(tun);
const gun = (key: GunKey) => GUNS.indexOf(key);

type Spawn = { position: readonly [number, number, number]; bay: { longAxis: 0 | 2; facing: 1 | -1 } };

/** How far out along the bay's facing a point is from the spawn, and how far right of it as one faces out (metres). */
function along(spawn: Spawn, p: readonly [number, number, number]): { out: number; right: number } {
  const { longAxis, facing } = spawn.bay;
  const dx = p[0] - spawn.position[0];
  const dz = p[2] - spawn.position[2];
  return longAxis === 0 ? { out: dz * facing, right: dx * facing } : { out: dx * facing, right: -dz * facing };
}

/** Each kind's distances, as laid. */
function distances(spots: readonly RangeSpot[]): Record<string, number[]> {
  const out: Record<string, number[]> = { dummy: [], mover: [], torso: [], head: [] };
  for (const s of spots) out[s.kind].push(s.distanceM);
  return out;
}

/** Every bay's and leg's footprint in a plan, as [x0, x1, z0, z1) in voxels. */
function footprints(w: GeneratedWorld): [string, number, number, number, number][] {
  return w.plan.lines.flatMap((l) => [
    ...l.bays.map((b): [string, number, number, number, number] => [l.spec.name, b.x0, b.x1, b.z0, b.z1]),
    ...l.legs.map((g): [string, number, number, number, number] => (g.longAxis === 0 ? [l.spec.name, g.a0, g.a1, g.b0, g.b1] : [l.spec.name, g.b0, g.b1, g.a0, g.a1])),
  ]);
}

const MAPS: readonly MapId[] = ['ravine', 'corridor'];

/** What hides a target from an eye (raycast's stops): anything that blocks sight, whether or not it stops a round. */
const HIDES = Uint8Array.from({ length: 256 }, (_, p) => (p !== P.AIR && blocksSight(p) ? 1 : 0));

describe('the range over the generated worlds', () => {
  const worlds = new Map<MapId, GeneratedWorld>();
  const layouts = new Map<MapId, RangeSpot[]>();
  const world = (map: MapId) => worlds.get(map)!;
  /** The eye the app sights the range from: a player's standing on the spawn bay's firing step (the step view, app/views.ts). */
  const eyeOf = (map: MapId): [number, number, number] => {
    const [x, y, z] = standardViews(world(map).plan, world(map).spawn).step.position;
    return [x, y, z];
  };
  /** The layout as the app lays it: with the world's plan, sighted from the step. */
  const laid = (map: MapId): RangeSpot[] => {
    let spots = layouts.get(map);
    if (!spots) {
      const w = world(map);
      spots = rangeLayout(w.map, w.plan.params.voxel, w.spawn, t, w.plan, eyeOf(map));
      layouts.set(map, spots);
    }
    return spots;
  };

  // Both maps, generated once for the file: generation is slow.
  beforeAll(async () => {
    for (const map of MAPS) {
      const plan = planWorld(genParams(tun, undefined, map), MAP_SEEDS[map]);
      worlds.set(map, await generateWorld(plan, async (bands) => bands.map((b) => fillBand(plan, b))));
    }
  }, 300_000);

  it("lays out 4 dummies, a mover and 4 plates in front of the Ravine spawn bay, each within 1 m of its distance: the 150 m dummy's spot is past the map's far edge, and the enemy's parapet hides the rest from the step", () => {
    const w = world('ravine');
    const v = w.plan.params.voxel;
    const spots = laid('ravine');
    expect(distances(spots)).toEqual({ dummy: [25, 40, 60, 80], mover: [50], torso: [30, 55], head: [45, 70] });
    for (const s of spots) {
      const a = along(w.spawn, s.at);
      expect(Math.abs(a.out - s.distanceM), `${s.kind} ${s.distanceM} m`).toBeLessThanOrEqual(1);
      expect(Math.abs(a.right), `${s.kind} ${s.distanceM} m`).toBeLessThanOrEqual(t.frontageM);
    }
    // Unsighted, the 110 m dummy, the 90 m mover and the 85 m plate have ground: from the step they
    // are behind the enemy's parapet, some 54 m out, wherever they are tried.
    expect(distances(rangeLayout(w.map, v, w.spawn, t, w.plan))).toEqual({ dummy: [25, 40, 60, 80, 110], mover: [50, 90], torso: [30, 55, 85], head: [45, 70] });
    // The bay faces +z, and the map ends 149.05 m out from the spawn: there is no ground at 150 m.
    expect([w.spawn.bay.longAxis, w.spawn.bay.facing]).toEqual([0, 1]);
    expect(w.map.dims.z * v - w.spawn.position[2]).toBeLessThan(150);
  });

  it('the same on the Corridor: its 5 plates, and 5 dummies and a mover; unsighted, the 150 m dummy and the 90 m mover with them', () => {
    const w = world('corridor');
    const spots = laid('corridor');
    // Sighted from the step, the Corridor keeps its five plates and six dummies at the least. The
    // 150 m dummy is behind rising spoil 32 m out wherever it is tried; the 90 m mover's one dry,
    // clear walk has an end behind a picket of the bay's own wire.
    const kinds = distances(spots);
    expect(kinds.torso.length + kinds.head.length).toBe(5);
    expect(kinds.dummy.length + kinds.mover.length).toBeGreaterThanOrEqual(6);
    expect(kinds).toEqual({ dummy: [25, 40, 60, 80, 110], mover: [50], torso: [30, 55, 85], head: [45, 70] });
    expect(distances(rangeLayout(w.map, w.plan.params.voxel, w.spawn, t, w.plan))).toEqual({ dummy: [25, 40, 60, 80, 110, 150], mover: [50, 90], torso: [30, 55, 85], head: [45, 70] });
    for (const s of spots) {
      const a = along(w.spawn, s.at);
      expect(Math.abs(a.out - s.distanceM), `${s.kind} ${s.distanceM} m`).toBeLessThanOrEqual(1);
      expect(Math.abs(a.right), `${s.kind} ${s.distanceM} m`).toBeLessThanOrEqual(t.frontageM);
    }
  });

  it('every spot stands on dry ground: not water, wire, a trench or a crater bowl, on a slope under 30°', () => {
    for (const map of MAPS) {
      const w = world(map);
      const v = w.plan.params.voxel;
      const dug = footprints(w);
      const inTrench = (x: number, z: number) => dug.some(([, x0, x1, z0, z1]) => x >= x0 && x < x1 && z >= z0 && z < z1);
      const top = (x: number, z: number) => groundTop(w.map, x + 0.5, z + 0.5)!;
      /** The ground's top, checked: soil on top, not water, not in a trench, and no wire within 2 m over it half a metre about. */
      const dry = (x: number, z: number, where: string) => {
        const y = top(x, z);
        const p = w.map.get(x, y - 1, z);
        expect(kindOf(p), where).not.toBe(K.WATER);
        expect(isGranular(p), `${where}: ${p}`).toBe(true);
        expect(inTrench(x, z), where).toBe(false);
        for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) for (let k = 0; k < 20; k++) expect(kindOf(w.map.get(x + dx, y + k, z + dz)), where).not.toBe(K.WIRE);
        return y;
      };
      for (const s of laid(map)) {
        const where = `${map}: the ${s.kind} at ${s.distanceM} m`;
        const x = Math.floor(s.at[0] / v);
        const z = Math.floor(s.at[2] / v);
        const y = dry(x, z, where);
        // On the ground's top.
        expect(s.at[1], where).toBeCloseTo(y * v, 9);
        // Not in a bowl: no lower than the mean of 8 points on a 3 m ring by bowl_m.
        let ring = 0;
        for (let k = 0; k < 8; k++) ring += top(x + Math.round(30 * Math.cos((k * Math.PI) / 4)), z + Math.round(30 * Math.sin((k * Math.PI) / 4)));
        expect((ring / 8 - y) * v, where).toBeLessThanOrEqual(t.bowlM);
        // Level: no steeper than 30° over half a metre either way.
        for (const [dx, dz] of [[5, 0], [-5, 0], [0, 5], [0, -5]]) {
          expect((Math.atan2(Math.abs(top(x + dx, z + dz) - y) * v, 0.5) * 180) / Math.PI, where).toBeLessThan(30);
        }
        // A mover walks on dry ground at every column of its walk, and knows the ground's height
        // every half metre along it.
        if (s.kind === 'mover') {
          const { longAxis, facing } = w.spawn.bay;
          const right = longAxis === 0 ? [facing, 0] : [0, -facing];
          const column = (o: number) => [Math.floor((s.at[0] + right[0] * o) / v), Math.floor((s.at[2] + right[1] * o) / v)];
          for (let i = 0; i <= 80; i++) {
            const [wx, wz] = column(-4 + i * 0.1);
            dry(wx, wz, `${where}, ${(-4 + i * 0.1).toFixed(1)} m along its walk`);
          }
          expect(s.walk, where).toHaveLength(17);
          s.walk!.forEach((h, k) => {
            const [wx, wz] = column(-4 + k * 0.5);
            expect(h, `${where}, ${-4 + k * 0.5} m along its walk`).toBeCloseTo(top(wx, wz) * v, 9);
          });
        }
      }
    }
  });

  it("from the spawn bay's firing step every target laid is in sight, its plates standing in the world: a dummy's chest, a mover's at both ends of its walk and its middle, a plate's centre", () => {
    const eyeM = tun.f('player.eye_height_standing');
    // Whatever stops a round hides what is behind it too: a line that nothing hides is clear of anything solid.
    for (let p = 0; p < 256; p++) if (isSolid(p)) expect(HIDES[p], `palette ${p}`).toBe(1);
    for (const map of MAPS) {
      const w = world(map);
      const v = w.plan.params.voxel;
      const bay = w.spawn.bay;
      const eye = eyeOf(map);
      // A standing eye over the step's top, in the air: on the step across the bay, and along it
      // where the spawn is, to within a voxel or two (the step view stands at the bay's middle).
      expect(eye[1], map).toBeCloseTo(bay.stepTopY * v + eyeM, 9);
      expect(w.map.get(Math.floor(eye[0] / v), Math.floor(eye[1] / v), Math.floor(eye[2] / v)), map).toBe(P.AIR);
      const [along, across] = bay.longAxis === 0 ? [eye[0], eye[2]] : [eye[2], eye[0]];
      expect(across / v, map).toBeGreaterThanOrEqual(bay.stepLo);
      expect(across / v, map).toBeLessThan(bay.stepLo + bay.stepSpan);
      expect(Math.abs(along - w.spawn.position[bay.longAxis]), map).toBeLessThanOrEqual(0.2);
      const spots = laid(map);
      // The plates written in as the app raises them, what they replace kept to put back.
      const plates = spots.map((s) => plateVoxels(s, v, t, bay));
      const kept = plates.flat().map(([x, y, z]): [number, number, number, number] => [x, y, z, w.map.get(x, y, z)]);
      for (const [x, y, z, p] of plates.flat()) w.map.set(x, y, z, p);
      try {
        const right = bay.longAxis === 0 ? [bay.facing, 0] : [0, -bay.facing];
        const hidden: string[] = [];
        let rays = 0;
        spots.forEach((s, i) => {
          const chest = t.dummyChestM;
          const points: [string, number[]][] = [];
          if (s.kind === 'dummy') points.push(['chest', [s.at[0], s.at[1] + chest, s.at[2]]]);
          else if (s.kind === 'mover') {
            const half = t.moverSpanM / 2;
            const walk = s.walk!;
            points.push(['left end', [s.at[0] - right[0] * half, walk[0] + chest, s.at[2] - right[1] * half]]);
            points.push(['middle', [s.at[0], s.at[1] + chest, s.at[2]]]);
            points.push(['right end', [s.at[0] + right[0] * half, walk[walk.length - 1] + chest, s.at[2] + right[1] * half]]);
          } else {
            const steel = plates[i].filter((q) => q[3] === P.TARGET_STEEL);
            const lo = [0, 1, 2].map((k) => Math.min(...steel.map((q) => q[k])));
            const hi = [0, 1, 2].map((k) => Math.max(...steel.map((q) => q[k])) + 1);
            points.push(['centre', [0, 1, 2].map((k) => ((lo[k] + hi[k]) / 2) * v)]);
          }
          for (const [label, p] of points) {
            const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
            const len = Math.hypot(d[0], d[1], d[2]);
            const hit = raycast(w.map, [eye[0] / v, eye[1] / v, eye[2] / v], [d[0] / len, d[1] / len, d[2] / len], len / v, undefined, HIDES);
            rays++;
            // Nothing on the way that hides it, solid or a tree's leaves, but the target's own steel
            // and post: so nothing solid either, the rule as the brief has it.
            const own = hit !== null && plates[i].some(([x, y, z]) => x === hit.cell[0] && y === hit.cell[1] && z === hit.cell[2]);
            if (hit && !own) hidden.push(`the ${s.kind} at ${s.distanceM} m, its ${label}: palette ${hit.material} at ${(hit.t * v).toFixed(2)} m of ${len.toFixed(2)}`);
          }
        });
        expect(hidden, map).toEqual([]);
        expect(rays, map).toBeGreaterThanOrEqual(spots.length);
      } finally {
        for (const [x, y, z, p] of kept.reverse()) w.map.set(x, y, z, p);
      }
    }
  });

  it('no two spots stand within 3 m of each other, and none within 2 m of the parapet', () => {
    for (const map of MAPS) {
      const w = world(map);
      const v = w.plan.params.voxel;
      const spots = laid(map);
      for (let i = 0; i < spots.length; i++) {
        for (let j = i + 1; j < spots.length; j++) {
          const [a, b] = [spots[i].at, spots[j].at];
          expect(Math.hypot(a[0] - b[0], a[2] - b[2]), `${map}: ${spots[i].kind} ${spots[i].distanceM} m, ${spots[j].kind} ${spots[j].distanceM} m`).toBeGreaterThanOrEqual(3);
        }
      }
      // The spawn bay's parapet, measured: out from its front face, as far as its ground stands over
      // the field's anywhere along the bay.
      const bay = w.spawn.bay;
      let reach = 0;
      for (let a = bay.a0; a < bay.a1; a++) {
        let k = 0;
        for (; k < 100; k++) {
          const b = bay.facing > 0 ? bay.b1 + k : bay.b0 - 1 - k;
          const [x, z] = bay.longAxis === 0 ? [a, b] : [b, a];
          if (groundTop(w.map, x + 0.5, z + 0.5)! <= bay.groundY) break;
        }
        reach = Math.max(reach, k);
      }
      expect(reach, map).toBeGreaterThan(10);
      const [lo, hi] = bay.facing > 0 ? [bay.b1 * v, (bay.b1 + reach) * v] : [(bay.b0 - reach) * v, bay.b0 * v];
      for (const s of spots) {
        const [a, b] = bay.longAxis === 0 ? [s.at[0], s.at[2]] : [s.at[2], s.at[0]];
        const da = Math.max(bay.a0 * v - a, 0, a - bay.a1 * v);
        const db = Math.max(lo - b, 0, b - hi);
        expect(Math.hypot(da, db), `${map}: ${s.kind} ${s.distanceM} m`).toBeGreaterThanOrEqual(2);
        expect(along(w.spawn, s.at).out, `${map}: ${s.kind} ${s.distanceM} m`).toBeGreaterThan(0);
      }
    }
  });

  it('no standing spot is in line behind another, as seen from the spawn', () => {
    for (const map of MAPS) {
      const w = world(map);
      const seen = laid(map)
        .filter((s) => s.kind !== 'mover')
        .map((s) => {
          const a = along(w.spawn, s.at);
          return { s, bearing: Math.atan2(a.right, a.out), half: Math.atan2(0.5, Math.hypot(a.out, a.right)) };
        });
      for (let i = 0; i < seen.length; i++) {
        for (let j = i + 1; j < seen.length; j++) {
          const [a, b] = [seen[i], seen[j]];
          expect(Math.abs(a.bearing - b.bearing), `${map}: ${a.s.kind} ${a.s.distanceM} m, ${b.s.kind} ${b.s.distanceM} m`).toBeGreaterThanOrEqual(a.half + b.half);
        }
      }
    }
  });

  it("without the plan, the ground alone tells a trench: no column of a bay or a leg near the range is ground a spot may stand on, ours or the enemy's, and the layout is the same", () => {
    // Every footprint column from 30 m behind the spawn to 160 m out and 30 m either side of it: the
    // range's reach and more, the spawn's own lines with it.
    for (const map of MAPS) {
      const w = world(map);
      const v = w.plan.params.voxel;
      let columns = 0;
      const open: string[] = [];
      for (const [line, x0, x1, z0, z1] of footprints(w)) {
        for (let x = x0; x < x1; x++) {
          for (let z = z0; z < z1; z++) {
            const a = along(w.spawn, [(x + 0.5) * v, 0, (z + 0.5) * v]);
            if (a.out < -30 || a.out > 160 || Math.abs(a.right) > 30) continue;
            columns++;
            if (rangeGround(w.map, v, x, z, t) !== null && open.length < 20) open.push(`${line} (${x}, ${z})`);
          }
        }
      }
      expect(open, map).toEqual([]);
      expect(columns, map).toBeGreaterThan(10_000);
      expect(rangeLayout(w.map, v, w.spawn, t, null, eyeOf(map)), map).toEqual(laid(map));
    }
  });

  it("a plate's voxels are all air where it is laid, on both maps: writing it in replaces nothing", () => {
    for (const map of MAPS) {
      const w = world(map);
      const v = w.plan.params.voxel;
      const plates = laid(map).filter((s) => s.kind === 'torso' || s.kind === 'head');
      expect(plates, map).toHaveLength(map === 'ravine' ? 4 : 5);
      for (const s of plates) {
        const vox = plateVoxels(s, v, t, w.spawn.bay);
        expect(vox.length, map).toBeGreaterThan(20);
        for (const [x, y, z] of vox) expect(w.map.get(x, y, z), `${map}: the ${s.kind} plate at ${s.distanceM} m, (${x}, ${y}, ${z})`).toBe(P.AIR);
      }
    }
  });
});

/** 51.2 × 6.4 × 204.8 m of sod 1.6 m deep, the spawn on it at (25.65, 1.6, 5.05) in a bay facing +z. */
function field(): { map: BrickMap; spawn: Spawn } {
  const map = new BrickMap({ x: 512, y: 64, z: 2048 });
  map.fillBox(0, 0, 0, 512, 16, 2048, P.SOD);
  return { map, spawn: { position: [25.65, 1.6, 5.05], bay: { longAxis: 0, facing: 1 } } };
}

/** Water for the top voxel of columns [x0, x1] × [z0, z1]. */
function puddle(map: BrickMap, x0: number, x1: number, z0: number, z1: number): void {
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) map.set(x, 15, z, P.WATER);
}

/** A standing eye over the field's spawn (1.62 m over its feet), which open ground hides nothing from. */
const EYE: [number, number, number] = [25.65, 1.6 + 1.62, 5.05];

/** Columns [x0, x1) of something solid, 1.6 to 3.6 m up (2 m over the field), at z 175: 12.45 m out from the field's spawn. */
function wall(map: BrickMap, x0: number, x1: number, p: number = P.BRICK): void {
  map.fillBox(x0, 16, 175, x1, 36, 176, p);
}

describe('the range on open ground', () => {
  it('reads [range]', () => {
    expect(t).toEqual({
      dummiesM: [25, 40, 60, 80, 110, 150],
      moversM: [50, 90],
      moverSpeedMps: 1.4,
      moverSpanM: 8,
      torsoPlatesM: [30, 55, 85],
      headPlatesM: [45, 70],
      torsoPlateM: [0.45, 0.6],
      headPlateM: [0.25, 0.3],
      plateCentreM: [1.3, 1.6],
      frontageM: 12,
      shiftM: 3,
      maxSlopeDeg: 30,
      bowlM: 0.6,
      downS: 4,
      readoutS: 1.5,
      dummyChestM: 1.3,
    });
  });

  it('a spot stands on the ground\'s top; it is blocked over water, duckboards or timber, wire or anything else within 2 m over it, a slope over 30°, a bowl over 0.6 m deep, a trench\'s floor, or off the map', () => {
    // 12.8 × 6.4 × 12.8 m of sod 3.2 m deep: the spot is column (64, 64), whose ground's top is y 32.
    const ground = (edit?: (map: BrickMap) => void, x = 64, z = 64, with_ = t) => {
      const map = new BrickMap({ x: 128, y: 64, z: 128 });
      map.fillBox(0, 0, 0, 128, 32, 128, P.SOD);
      edit?.(map);
      return rangeGround(map, 0.1, x, z, with_);
    };
    expect(ground()).toBe(32);
    // Its top voxel water, a trench's duckboards, or a post's timber.
    expect(ground((m) => m.set(64, 31, 64, P.WATER))).toBeNull();
    expect(ground((m) => m.set(64, 31, 64, P.DUCKBOARD))).toBeNull();
    expect(ground((m) => m.set(64, 32, 64, P.TIMBER))).toBeNull();
    // Wire, a picket, a bush or a trunk within 2 m over it and half a metre of it, high or low; but
    // not 2 m up, nor 0.6 m aside, nor a canopy 2.5 m up beside it. (None of these columns is one
    // the slope is taken at, but the one 0.5 m along -z, where it stands one voxel high.)
    for (const p of [P.WIRE, P.PICKET, P.LEAF, P.TRUNK]) {
      expect(ground((m) => m.set(68, 51, 66, p)), `${p}`).toBeNull();
      expect(ground((m) => m.set(64, 32, 59, p)), `${p}`).toBeNull();
    }
    expect(ground((m) => m.set(68, 52, 66, P.WIRE))).toBe(32);
    expect(ground((m) => m.set(70, 40, 64, P.WIRE))).toBe(32);
    expect(ground((m) => m.set(66, 57, 64, P.LEAF))).toBe(32);
    // Ground rising beside it is ground, not something standing on it.
    expect(ground((m) => m.fillBox(66, 32, 64, 67, 34, 65, P.SOD))).toBe(32);
    // Steeper than 30° over half a metre: 0.3 m up (31°) is, 0.2 m (22°) is not; either way, along x or z.
    expect(ground((m) => m.fillBox(69, 32, 64, 70, 35, 65, P.SOD))).toBeNull();
    expect(ground((m) => m.fillBox(64, 29, 59, 65, 32, 60, P.AIR))).toBeNull();
    expect(ground((m) => m.fillBox(69, 32, 64, 70, 34, 65, P.SOD))).toBe(32);
    // A pit 2 m across: 0.7 m deep is a bowl; 0.6 m, bowl_m itself, is not (6 × 0.1 is over 0.6 in
    // floating point, and 0.6 / 0.1 under 6: the depth is reckoned in voxels, to within a millionth).
    expect(ground((m) => m.fillBox(54, 25, 54, 75, 32, 75, P.AIR))).toBeNull();
    expect(ground((m) => m.fillBox(54, 26, 54, 75, 32, 75, P.AIR))).toBe(26);
    // A trench's floor, shot through to the earth: 2.5 m wide and deep along x. Sunk more than 1 m
    // under its ring, it is blocked even where a bowl would not be.
    const trench = (m: BrickMap) => m.fillBox(0, 7, 52, 128, 32, 77, P.AIR);
    expect(ground(trench)).toBeNull();
    expect(ground(trench, 64, 64, { ...t, bowlM: 5 })).toBeNull();
    // Off the map, or its ring off it.
    expect(ground(undefined, -1, 64)).toBeNull();
    expect(ground(undefined, 64, 128)).toBeNull();
    expect(ground(undefined, 10, 64)).toBeNull();
  });

  it('each spot has its own place across the frontage: the movers in the middle, the rest 9 m out either side for the nearest, left and right in turn, nearer the middle the farther out', () => {
    const { map, spawn } = field();
    const spots = rangeLayout(map, 0.1, spawn, t);
    // Listed as [range] lists them: the dummies, the movers, the torso plates, the head plates.
    expect(spots.map((s) => `${s.kind} ${s.distanceM}`)).toEqual([
      'dummy 25', 'dummy 40', 'dummy 60', 'dummy 80', 'dummy 110', 'dummy 150', 'mover 50', 'mover 90',
      'torso 30', 'torso 55', 'torso 85', 'head 45', 'head 70',
    ]);
    const statics = spots.filter((s) => s.kind !== 'mover').sort((a, b) => a.distanceM - b.distanceM);
    statics.forEach((s, k) => {
      const a = along(spawn, s.at);
      // Each on a voxel column's middle, so within half a voxel of where it was laid.
      expect(Math.abs(a.out - s.distanceM), `${s.kind} ${s.distanceM}`).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(Math.abs(a.right - (k % 2 === 0 ? -1 : 1) * 9 * (1 - k / statics.length)), `${s.kind} ${s.distanceM}`).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(s.at[1]).toBeCloseTo(1.6, 9);
      expect(s.walk).toBeUndefined();
    });
    for (const s of spots.filter((q) => q.kind === 'mover')) {
      expect(Math.abs(along(spawn, s.at).right)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(s.walk).toEqual(Array(17).fill(1.6));
    }
  });

  it('a blocked spot moves sideways, half a metre right first, then left, on up to 3 m; past that it is left out', () => {
    // The 25 m dummy is the nearest: 9 m left of the spawn, on column x 166, z 300.
    const at25 = (spots: RangeSpot[]) => spots.find((s) => s.kind === 'dummy' && s.distanceM === 25);
    const right = (spots: RangeSpot[], spawn: Spawn) => along(spawn, at25(spots)!.at).right;
    {
      const { map, spawn } = field();
      puddle(map, 165, 167, 299, 301);
      expect(right(rangeLayout(map, 0.1, spawn, t), spawn)).toBeCloseTo(-8.5, 6);
    }
    {
      const { map, spawn } = field();
      puddle(map, 163, 172, 299, 301);
      expect(right(rangeLayout(map, 0.1, spawn, t), spawn)).toBeCloseTo(-9.5, 6);
    }
    {
      const { map, spawn } = field();
      puddle(map, 135, 198, 299, 301);
      const spots = rangeLayout(map, 0.1, spawn, t);
      expect(at25(spots)).toBeUndefined();
      expect(spots).toHaveLength(12);
    }
  });

  it('a standing spot in line behind another moves aside', () => {
    // Water across 55 m from 9 to 3.5 m left of the spawn: the torso plate there moves 2.5 m right,
    // into line with the 70 m head plate's own place, so the head plate moves on 1.5 m right.
    const { map, spawn } = field();
    puddle(map, 166, 221, 597, 603);
    const spots = rangeLayout(map, 0.1, spawn, t);
    const torso = spots.find((s) => s.kind === 'torso' && s.distanceM === 55)!;
    const head = spots.find((s) => s.kind === 'head' && s.distanceM === 70)!;
    expect(along(spawn, torso.at).right).toBeCloseTo(-3.2, 6);
    expect(along(spawn, head.at).right).toBeCloseTo(-2.6, 6);
  });

  it('a mover walks only on dry ground: water across its walk moves it aside', () => {
    // The 50 m mover's walk is 4 m either side of the spawn's line; water 2.25-2.55 m right of it,
    // there. It walks into it from every try between 1.5 m left and 3 m right; 2 m left, it turns
    // short of it.
    const { map, spawn } = field();
    puddle(map, 279, 281, 549, 552);
    const mover = rangeLayout(map, 0.1, spawn, t).find((s) => s.kind === 'mover' && s.distanceM === 50)!;
    expect(along(spawn, mover.at).right).toBeCloseTo(-2, 6);
  });

  it("given the plan, a spot in a trench's footprint moves aside though its ground looks sound, and a mover whose walk crosses one", () => {
    // A bay over the 25 m dummy's place (column 166, 300) and a leg across the 50 m mover's walk
    // (columns 280-282 at z 550, 2.35-2.65 m right of its middle), the ground in both untouched.
    const plan = {
      lines: [{ bays: [{ x0: 160, x1: 172, z0: 295, z1: 305 }], legs: [{ longAxis: 2, a0: 545, a1: 556, b0: 280, b1: 283 }] }],
    } as unknown as WorldPlan;
    const { map, spawn } = field();
    const find = (spots: RangeSpot[], kind: RangeSpot['kind'], d: number) => along(spawn, spots.find((s) => s.kind === kind && s.distanceM === d)!.at).right;
    const without = rangeLayout(map, 0.1, spawn, t);
    expect(find(without, 'dummy', 25)).toBeCloseTo(-9, 6);
    expect(find(without, 'mover', 50)).toBeCloseTo(0, 6);
    const given = rangeLayout(map, 0.1, spawn, t, plan);
    // Tried at -9, -8.5 and -9.5 m, all in the bay; laid at -8. The mover's walk reaches the leg
    // from every try until 2 m left.
    expect(find(given, 'dummy', 25)).toBeCloseTo(-8, 6);
    expect(find(given, 'mover', 50)).toBeCloseTo(-2, 6);
    // The rest are as they were.
    expect(given.filter((s) => !(s.kind === 'dummy' && s.distanceM === 25) && !(s.kind === 'mover' && s.distanceM === 50))).toEqual(
      without.filter((s) => !(s.kind === 'dummy' && s.distanceM === 25) && !(s.kind === 'mover' && s.distanceM === 50)),
    );
  });

  it("a mover's walk is kept clear: wire or a bush within 2 m over it and half a metre beside it moves it aside", () => {
    // The 50 m mover's walk ends at column 296 (z 550). Something 0.5 m up at column 297, 0.3 m to
    // the side of its line, stands by its end: from half a metre right too; half a metre left, it
    // turns 0.6 m short of it.
    for (const p of [P.WIRE, P.LEAF]) {
      const { map, spawn } = field();
      map.set(297, 21, 553, p);
      const mover = rangeLayout(map, 0.1, spawn, t).find((s) => s.kind === 'mover' && s.distanceM === 50)!;
      expect(along(spawn, mover.at).right, `${p}`).toBeCloseTo(-0.5, 6);
    }
  });

  it('a spot the eye cannot see moves aside to where it can, and where it never can it is left out: a wall before the 25 m dummy', () => {
    const at25 = (spots: RangeSpot[]) => spots.find((s) => s.kind === 'dummy' && s.distanceM === 25);
    const not25 = (spots: RangeSpot[]) => spots.filter((s) => !(s.kind === 'dummy' && s.distanceM === 25));
    // Open ground hides nothing: sighted, the layout is as it is unsighted.
    const open = field();
    const plain = rangeLayout(open.map, 0.1, open.spawn, t, null, EYE);
    expect(plain).toEqual(rangeLayout(open.map, 0.1, open.spawn, t));
    expect(along(open.spawn, at25(plain)!.at).right).toBeCloseTo(-9, 6);
    // A wall on the line from the eye to the 25 m dummy's chest (9 m left, 1.3 m over its feet), half
    // way out: tried half a metre right, its line runs past the wall's end, and it is laid there.
    {
      const { map, spawn } = field();
      wall(map, 210, 212);
      const spots = rangeLayout(map, 0.1, spawn, t, null, EYE);
      expect(along(spawn, at25(spots)!.at).right).toBeCloseTo(-8.5, 6);
      expect(not25(spots)).toEqual(not25(plain));
    }
    // A wall across the lines to every place it is tried, 3 m either way: it is left out, the rest as
    // they were.
    {
      const { map, spawn } = field();
      wall(map, 190, 230);
      const spots = rangeLayout(map, 0.1, spawn, t, null, EYE);
      expect(at25(spots)).toBeUndefined();
      expect(spots).toEqual(not25(plain));
    }
    // Leaves hide it as the wall does, though a round goes through them (a tree's crown, a hedge).
    {
      const { map, spawn } = field();
      wall(map, 210, 212, P.LEAF);
      const spots = rangeLayout(map, 0.1, spawn, t, null, EYE);
      expect(along(spawn, at25(spots)!.at).right).toBeCloseTo(-8.5, 6);
      expect(not25(spots)).toEqual(not25(plain));
    }
  });

  it('a mover is seen at both ends of its walk and at its middle: a post on the line to either moves it aside', () => {
    const mover = (spots: RangeSpot[], d: number) => spots.find((s) => s.kind === 'mover' && s.distanceM === d)!;
    const standing = (spots: RangeSpot[]) => spots.filter((s) => s.kind !== 'mover');
    const open = field();
    const plain = rangeLayout(open.map, 0.1, open.spawn, t, null, EYE);
    for (const d of [50, 90]) expect(along(open.spawn, mover(plain, d).at).right).toBeCloseTo(0, 6);
    // A post half way out on the line to the 50 m mover's left end (4 m left of its middle): half a
    // metre right, its left end turns short of that line.
    {
      const { map, spawn } = field();
      wall(map, 246, 247, P.TIMBER);
      const spots = rangeLayout(map, 0.1, spawn, t, null, EYE);
      expect(along(spawn, mover(spots, 50).at).right).toBeCloseTo(0.5, 6);
      expect(mover(spots, 90)).toEqual(mover(plain, 90));
      expect(standing(spots)).toEqual(standing(plain));
    }
    // One straight out, on the line to both movers' middles: both move half a metre right.
    {
      const { map, spawn } = field();
      wall(map, 256, 257, P.TIMBER);
      const spots = rangeLayout(map, 0.1, spawn, t, null, EYE);
      expect(along(spawn, mover(spots, 50).at).right).toBeCloseTo(0.5, 6);
      expect(along(spawn, mover(spots, 90).at).right).toBeCloseTo(0.5, 6);
      expect(standing(spots)).toEqual(standing(plain));
    }
  });

  it('a plate laid nearer hides what is behind it: a mover walking behind one moves aside', () => {
    // One torso plate at 85 m in the middle of a 3 m frontage, and a mover at 90 m walking 2 m across
    // behind it: from the eye the plate's steel covers the mover's middle.
    const lone = { ...t, dummiesM: [], moversM: [90], torsoPlatesM: [85], headPlatesM: [], frontageM: 3, moverSpanM: 2 };
    const { map, spawn } = field();
    const unsighted = rangeLayout(map, 0.1, spawn, lone);
    expect(unsighted.map((s) => s.kind)).toEqual(['mover', 'torso']);
    for (const s of unsighted) expect(along(spawn, s.at).right, s.kind).toBeCloseTo(0, 6);
    const sighted = rangeLayout(map, 0.1, spawn, lone, null, EYE);
    expect(sighted.map((s) => s.kind)).toEqual(['mover', 'torso']);
    expect(along(spawn, sighted[0].at).right).toBeCloseTo(0.5, 6);
    expect(sighted[1]).toEqual(unsighted[1]);
  });

  it("a mover's walk is dry at every column it crosses, not only every half metre: a puddle between its steps moves it aside", () => {
    // The 50 m mover's half-metre steps, where its height is kept, fall on columns 216, 221, … 296
    // from x 21.65 m, and still on every fifth column from 216 as it moves aside by half metres. A
    // puddle on columns 218 and 219 lies between them; only half a metre right does its walk start
    // past it.
    const { map, spawn } = field();
    puddle(map, 218, 219, 550, 550);
    const mover = rangeLayout(map, 0.1, spawn, t).find((s) => s.kind === 'mover' && s.distanceM === 50)!;
    expect(along(spawn, mover.at).right).toBeCloseTo(0.5, 6);
  });
});

const BAY = { longAxis: 0, facing: 1 } as const;
const dummy = (z: number, x = 10.05): RangeSpot => ({ kind: 'dummy', at: [x, 1.6, z], distanceM: z });

describe("the range's dummies", () => {
  it('are figures 200 on, the standing ones first and then the movers, facing the bay', () => {
    expect(FIRST_DUMMY).toBe(200);
    const spots: RangeSpot[] = [
      { kind: 'torso', at: [12.05, 1.6, 30.05], distanceM: 30 },
      { kind: 'mover', at: [10.05, 1.6, 50.05], distanceM: 50 },
      dummy(25.05, 8.05),
      { kind: 'head', at: [9.05, 1.6, 45.05], distanceM: 45 },
      dummy(40.05, 11.05),
    ];
    const f = new Range(spots, t, BAY).figures(0);
    expect(f.map((d) => d.id)).toEqual([200, 201, 202]);
    expect(f.map((d) => d.position)).toEqual([[8.05, 1.6, 25.05], [11.05, 1.6, 40.05], [10.05, 1.6, 50.05]]);
    // The standing ones face back at the bay, which faces +z; they stand still, and nobody is down.
    expect(f.slice(0, 2).map((d) => [d.yaw, d.velocity, d.deadFor])).toEqual([[180, [0, 0, 0], null], [180, [0, 0, 0], null]]);
    // A bay facing -x: they face +x.
    expect(new Range([dummy(25)], t, { longAxis: 2, facing: -1 }).figures(0)[0].yaw).toBe(90);
  });

  it("a dummy takes a match's damage: an AK to the torso twice kills (58 + 58), the SVD once (105)", () => {
    const ak = new Range([dummy(40)], t, BAY);
    expect(ak.hit(200, 'torso', gun('ak74'), 40.2, 1, 0)).toEqual({ kind: 'hit', id: 200, zone: 'torso', damage: 58, distanceM: 40.2 });
    expect(ak.health(200, 0)).toBe(42);
    expect(ak.hit(200, 'torso', gun('ak74'), 40.2, 2, 0.1)).toEqual({ kind: 'kill', id: 200, zone: 'torso', damage: 58, distanceM: 40.2, shots: 2 });
    const svd = new Range([dummy(40)], t, BAY);
    expect(svd.hit(200, 'torso', gun('svd'), 40.2, 1, 0)).toEqual({ kind: 'kill', id: 200, zone: 'torso', damage: 105, distanceM: 40.2, shots: 1 });
    // A round of no gun's does its zone's damage alone; no dummy, nothing.
    expect(new Range([dummy(40)], t, BAY).hit(200, 'limb', undefined, 40, 1, 0)).toMatchObject({ kind: 'hit', damage: 30 });
    expect(new Range([dummy(40)], t, BAY).hit(201, 'torso', gun('ak74'), 40, 1, 0)).toBeNull();
  });

  it("a headshot kills from the AK (105), M4 (100), SVD (190) and M249 (100); from the MP5 (75), M17 (80) and PM (72) it leaves the dummy standing; a shotgun pellet's is 42", () => {
    const kills: [GunKey, number][] = [['ak74', 105], ['m4', 100], ['svd', 190], ['m249', 100]];
    for (const [key, damage] of kills) {
      const r = new Range([dummy(40)], t, BAY);
      expect(r.hit(200, 'head', gun(key), 40, 1, 0), key).toEqual({ kind: 'kill', id: 200, zone: 'head', damage, distanceM: 40, shots: 1 });
      expect(r.figures(0)[0].deadFor, key).toBe(0);
    }
    const standing: [GunKey, number][] = [['mp5', 75], ['m17', 80], ['pm', 72], ['m870', 42]];
    for (const [key, damage] of standing) {
      const r = new Range([dummy(40)], t, BAY);
      expect(r.hit(200, 'head', gun(key), 40, 1, 0), key).toEqual({ kind: 'hit', id: 200, zone: 'head', damage, distanceM: 40 });
      expect(r.figures(0)[0].deadFor, key).toBeNull();
      expect(r.health(200, 0), key).toBe(100 - damage);
    }
  });

  it("the shotgun's pellets on one shot sum; the kill comes once, and shots counts 1", () => {
    // Nine pellets of 23 into the torso, all of shot 7 and on one tick: four leave it at 8, the
    // fifth takes it down, and the four after it find it down.
    const r = new Range([dummy(20)], t, BAY);
    const events = Array.from({ length: 9 }, () => r.hit(200, 'torso', gun('m870'), 20, 7, 3));
    const hit = { kind: 'hit', id: 200, zone: 'torso', damage: 23, distanceM: 20 };
    expect(events).toEqual([hit, hit, hit, hit, { ...hit, kind: 'kill', shots: 1 }, null, null, null, null]);
    // Two shots' pellets: shots counts 2.
    const two = new Range([dummy(20)], t, BAY);
    for (let k = 0; k < 3; k++) two.hit(200, 'torso', gun('m870'), 20, 1, 0);
    expect(two.hit(200, 'torso', gun('m870'), 20, 2, 0.8)).toMatchObject({ kind: 'hit' });
    expect(two.hit(200, 'torso', gun('m870'), 20, 2, 0.8)).toMatchObject({ kind: 'kill', shots: 2 });
  });

  it('a dummy down takes nothing more, and stands after 4 s at full health', () => {
    const r = new Range([dummy(40)], t, BAY);
    expect(r.hit(200, 'torso', gun('svd'), 40, 1, 10)).toMatchObject({ kind: 'kill', shots: 1 });
    expect(r.hit(200, 'head', gun('svd'), 40, 2, 10)).toBeNull();
    expect(r.hit(200, 'torso', gun('ak74'), 40, 3, 12)).toBeNull();
    expect(r.figures(13.5)[0].deadFor).toBeCloseTo(3.5, 9);
    expect(r.health(200, 13.5)).toBe(0);
    r.step(14);
    expect(r.figures(14)[0]).toMatchObject({ position: [10.05, 1.6, 40], deadFor: null });
    expect(r.health(200, 14)).toBe(100);
    // Up at full health: an AK round to the torso leaves it at 42, and the next kill counts its own shots.
    expect(r.hit(200, 'torso', gun('ak74'), 40, 4, 14)).toMatchObject({ kind: 'hit', damage: 58 });
    expect(r.health(200, 14)).toBe(42);
    expect(r.hit(200, 'torso', gun('ak74'), 40, 5, 14.2)).toMatchObject({ kind: 'kill', shots: 2 });
  });

  it('health comes back 10 a second from 6 s after the last hit', () => {
    const r = new Range([dummy(40)], t, BAY);
    r.hit(200, 'torso', gun('ak74'), 40, 1, 0);
    const at = (s: number) => r.health(200, s);
    const want = [42, 42, 42, 47, 52, 67, 92, 100, 100];
    [0, 3, 6, 6.5, 7, 8.5, 11, 11.8, 20].forEach((s, k) => expect(at(s), `${s} s`).toBeCloseTo(want[k], 9));
    // Health back to full, the shots that took it down are counted from there.
    expect(r.hit(200, 'torso', gun('ak74'), 40, 2, 20)).toMatchObject({ kind: 'hit' });
    expect(r.hit(200, 'torso', gun('ak74'), 40, 3, 20)).toMatchObject({ kind: 'kill', shots: 2 });
    // Another hit puts it off again: 52 at 7 s, less a limb's 30, then nothing back until 13 s.
    const again = new Range([dummy(40)], t, BAY);
    again.hit(200, 'torso', gun('ak74'), 40, 1, 0);
    again.hit(200, 'limb', gun('m4'), 40, 2, 7);
    expect([7, 12.9, 13, 14].map((s) => again.health(200, s))).toEqual([22, 22, 22, 32]);
    // As the match's rules have it (net/match-rules.ts).
    const rules = new MatchRules(99, 5000);
    rules.join(1, 'red', -10_000);
    rules.join(2, 'blue', -10_000);
    rules.tick(0);
    rules.hit(1, 2, 'torso', 0, gun('ak74'));
    const r2 = new Range([dummy(40)], t, BAY);
    r2.hit(200, 'torso', gun('ak74'), 40, 1, 0);
    for (const s of [0.5, 3, 6, 6.5, 7, 8.5, 11, 11.8, 15]) {
      rules.tick(s * 1000);
      expect(r2.health(200, s), `${s} s`).toBeCloseTo(rules.health(2), 9);
    }
  });

  it('a mover walks 1.4 m/s back and forth over 8 m, facing its way', () => {
    const r = new Range([{ kind: 'mover', at: [20.05, 1.6, 50.05], distanceM: 50 }], t, BAY);
    const DT = 0.01;
    const xs: number[] = [];
    for (let k = 0; k <= 2400; k++) {
      const f = r.figures(k * DT)[0];
      xs.push(f.position[0]);
      expect([f.position[1], f.position[2], f.deadFor]).toEqual([1.6, 50.05, null]);
      // Across the bay's facing, at 1.4 m/s; facing +x as it walks +x, -x as it walks -x.
      expect(Math.abs(f.velocity[0])).toBeCloseTo(1.4, 9);
      expect([f.velocity[1], f.velocity[2]]).toEqual([0, 0]);
      expect(f.yaw).toBe(f.velocity[0] > 0 ? 90 : -90);
    }
    // From its spot, heading right (+x) first; 4 m either way; 1.4 m/s between the turns.
    expect(xs[0]).toBeCloseTo(20.05, 9);
    expect(xs[1]).toBeGreaterThan(xs[0]);
    expect(Math.min(...xs)).toBeCloseTo(16.05, 1);
    expect(Math.max(...xs)).toBeCloseTo(24.05, 1);
    // Each step's way: a step with a turn in it is any whose neighbours go opposite ways.
    const ways = xs.slice(1).map((x, k) => Math.sign(x - xs[k]));
    let clean = 0;
    for (let k = 1; k < ways.length - 1; k++) {
      if (ways[k - 1] !== ways[k + 1]) continue;
      clean++;
      expect(Math.abs(xs[k + 1] - xs[k]) / DT, `${k * DT} s`).toBeCloseTo(1.4, 6);
    }
    expect(clean).toBeGreaterThan(2300);
    // Back where it was each 16 m of walking (11.43 s).
    const period = (2 * 8) / 1.4;
    const again = new Range([{ kind: 'mover', at: [20.05, 1.6, 50.05], distanceM: 50 }], t, BAY);
    const before = again.figures(3)[0].position[0];
    expect(again.figures(3 + period)[0].position[0]).toBeCloseTo(before, 9);
    // Two movers walk opposite ways; across a bay facing +x, along z.
    const two = new Range([{ kind: 'mover', at: [20, 1.6, 50], distanceM: 50 }, { kind: 'mover', at: [20, 1.6, 90], distanceM: 90 }], t, BAY).figures(1);
    expect(two.map((f) => Math.sign(f.velocity[0]))).toEqual([1, -1]);
    const turned = new Range([{ kind: 'mover', at: [50, 1.6, 20], distanceM: 50 }], t, { longAxis: 2, facing: 1 }).figures(1)[0];
    // Facing +x, the right hand is -z.
    expect(turned.position[0]).toBe(50);
    expect(turned.position[2]).toBeCloseTo(20 - 1.4, 9);
    expect([turned.velocity[0], turned.velocity[2], turned.yaw]).toEqual([0, -1.4, 180]);
  });

  it('a mover follows the ground along its walk, and lies where it fell', () => {
    // Level for its left half and the middle, then up 0.1 m every half metre.
    const walk = [...Array(9).fill(1.6), 1.7, 1.8, 1.9, 2.0, 2.1, 2.2, 2.3, 2.4];
    const spot: RangeSpot = { kind: 'mover', at: [20, 1.6, 50], distanceM: 50, walk };
    const r = new Range([spot], t, BAY);
    const at = (s: number) => r.figures(s)[0];
    expect(at(0).position).toEqual([20, 1.6, 50]);
    expect(at(3 / 1.4).position[0]).toBeCloseTo(23, 9);
    expect(at(3 / 1.4).position[1]).toBeCloseTo(2.2, 9);
    expect(at(3.25 / 1.4).position[1]).toBeCloseTo(2.25, 9);
    expect(at(3.25 / 1.4).velocity[1]).toBeCloseTo(0.28, 9);
    // Shot down 3 m along, it lies there 4 s, then walks on from there.
    const shot = new Range([spot], t, BAY);
    const fell = (s: number) => shot.figures(s)[0];
    expect(shot.hit(200, 'head', gun('svd'), 50, 1, 3 / 1.4)).toMatchObject({ kind: 'kill' });
    const down = fell(3 / 1.4 + 2);
    expect(down.position[0]).toBeCloseTo(23, 9);
    expect(down.position[1]).toBeCloseTo(2.2, 9);
    expect(down.velocity).toEqual([0, 0, 0]);
    expect(down.deadFor).toBeCloseTo(2, 9);
    expect(fell(3 / 1.4 + 4).deadFor).toBeNull();
    expect(fell(3 / 1.4 + 4.5).position[0]).toBeCloseTo(23 + 0.5 * 1.4, 9);
  });

  it('a plate hit is its event', () => {
    expect(new Range([], t, BAY).plate(2, 55.4)).toEqual({ kind: 'plate', index: 2, distanceM: 55.4 });
  });
});

describe('plateVoxels', () => {
  it("plateVoxels gives a 5 × 6 plate of TARGET_STEEL over a timber post, square to the bay's facing", () => {
    // On column (123, 400), whose ground's top is at y 15 (1.5 m).
    const spot: RangeSpot = { kind: 'torso', at: [12.35, 1.5, 40.05], distanceM: 30 };
    const parts = (facing: { longAxis: 0 | 2; facing: 1 | -1 }, s = spot) => {
      const vox = plateVoxels(s, 0.1, t, facing);
      const steel = vox.filter((p) => p[3] === P.TARGET_STEEL);
      const post = vox.filter((p) => p[3] !== P.TARGET_STEEL);
      const span = (i: number, of = steel) => [...new Set(of.map((p) => p[i]))].sort((a, b) => a - b);
      return { vox, steel, post, span };
    };
    const across = parts({ longAxis: 0, facing: 1 });
    expect(across.steel).toHaveLength(30);
    expect(across.span(0)).toEqual([121, 122, 123, 124, 125]);
    expect(across.span(1)).toEqual([25, 26, 27, 28, 29, 30]);
    expect(across.span(2)).toEqual([400]);
    // Its middle 1.3 m over the ground.
    expect((across.steel.reduce((sum, p) => sum + p[1] + 0.5, 0) / 30 - 15) * 0.1).toBeCloseTo(1.3, 9);
    // A post of timber from the ground up to it, under its middle.
    expect(across.post.every((p) => kindOf(p[3]) === K.TIMBER)).toBe(true);
    expect(across.post.map((p) => [p[0], p[1], p[2]])).toEqual(Array.from({ length: 10 }, (_, k) => [123, 15 + k, 400]));
    // Its sign does not matter; a bay along z turns it.
    expect(parts({ longAxis: 0, facing: -1 }).vox).toEqual(across.vox);
    const turned = parts({ longAxis: 2, facing: -1 });
    expect([turned.span(0), turned.span(2)]).toEqual([[123], [398, 399, 400, 401, 402]]);
    // A head plate: 3 × 3, its middle row from 1.6 m.
    const head = parts({ longAxis: 0, facing: 1 }, { kind: 'head', at: [12.35, 1.5, 40.05], distanceM: 45 });
    expect([head.span(0), head.span(1), head.span(2), head.steel.length]).toEqual([[122, 123, 124], [30, 31, 32], [400], 9]);
    expect(head.post.map((p) => p[1])).toEqual(Array.from({ length: 15 }, (_, k) => 15 + k));
    // A dummy is no plate.
    expect(plateVoxels(dummy(25), 0.1, t, BAY)).toEqual([]);
  });
});
