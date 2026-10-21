# Milestone 3 — World Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate the 256 × 32 × 256 m world at 10 cm, settled by construction, identical whatever the worker count or browser. The world contains:
- the field: relief, the swale, ditches, ploughing;
- four fire and support lines, two reserve lines and communication trenches, each with the Python game's per-bay sightline guarantee;
- re-detailed props at 10 cm;
- craters;
- dugouts;
- direct hits;
- the far field to the horizon.

**Architecture.** Generation runs in three phases.
1. **Plan:** a small, serialisable `WorldPlan` built once from `GenParams` and the seed.
2. **Fill:** `fillBand(plan, band)`, a pure function of the plan for each 32-voxel x-band, so any number of workers produce the same bytes.
3. **Events:** direct hits through the shared destruction primitives, applied in plan order to the assembled map.

Terrain, crater bowls and trench geometry are pure functions of the plan, so any band can ask what any column holds. Per-voxel variety comes from `hash32` of coordinates, never from sequential random draws.

**Tech stack:** TypeScript 7, Vitest 5, Web Workers (module workers via Vite). Everything under `src/world/` obeys the architecture test.

**Spec:** `docs/superpowers/specs/2026-10-21-trenchline-web-world-design.md`, §2 (size and layout, generation, the two rule changes, far field, checks).

## Global Constraints

- `src/world/**` follows the boundary and determinism rules:
  - no imports from render, ui or app;
  - no DOM or `GPU*` identifiers;
  - no engine-dependent `Math` (use `dmath`);
  - no `Math.random`;
  - sort comparators must be total, so ties are broken explicitly.
- Voxel size is 0.10 m. The world is 2560 × 320 × 2560 voxels, in bands of 32 voxels in x (80 bands).
- Metres-to-voxels uses Python's `grid.vx`: `floor(metres / 0.1 + 0.5)`. Every distance lives in `data/tunables.toml` in metres.
- Python's generation design rules are kept:
  - per-bay crest guarantee;
  - bays crenellated by the traverse offset;
  - firing step mounted by across-bay treads and an along-bay flight;
  - parapet crest smoothing only ever raises;
  - revetted faces;
  - named random streams (`rng.derive(label)`).
- **Settled by construction.** After generation, no granular voxel has a non-solid voxel directly below it, except water below water. No loose voxel has air both beside it and below that.
- Water exists only at or below the water table, except one-voxel ditch puddles resting on solid ground.
- Commits go on `web/world` and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A prop or crater straddling a band boundary.**
  - It must stamp the same voxels whichever band draws it, and whatever the band count. This includes carves whose clamped box differs per band.
  - Pinned in Task 9 (band-split equality for props) and Task 8 (carve lattice from the unclamped box).
- **Bays at the map's ends and comm trenches crossing other lines.**
  - Trench footprints from later lines must clear earlier parapets.
  - Parapets must never pile into an existing trench.
  - A line must end in a closed wall 6 m inside the edge.
  - Pinned in Task 5.
- **Terrain beyond the map.** The far field and the voxel edge share the terrain function, so heights at the boundary agree within one voxel. Pinned in Task 10.
- **Spawn when the middle bays are wrecked by direct hits.**
  - The spawn search must move outward to an intact bay, with intact duckboards, 2 m of headroom and at least half its bench standing.
  - It must fall back to the middle bay rather than throw.
  - Pinned in Task 10.
- **Deep craters next to trench walls.**
  - The loose-material substitution must stop rims and spoil from sitting past repose on a steep edge.
  - The invariant scan must hold over the full map.
  - Pinned in Task 6 (column rule) and Task 10 (full-map invariants).

---

### Task 1: `GenParams` — every generation number from tunables, in voxels

**Files:**
- Modify: `data/tunables.toml`:
  - `[world.trench]`, `[world.field]`, `[world.clutter]`, `[world.layout]`;
  - add `[world.craters]`.
- Create: `src/world/generation/params.ts`
- Test: `tests/world/generation/params.test.ts`

**Interfaces:**
- Consumes: `Tunables` (`src/core/tunables.ts`); `Dims` (`src/world/bricks.ts`).
- Produces, from `src/world/generation/params.ts`:
  - `vx(metres: number, voxel: number): number`, which is `floor(m/v + 0.5)`.
  - `interface LineSpec { name: string; side: 0 | 1; longAxis: 0 | 2; crossBase: number; aStart: number; aEnd: number; facing: 1 | -1; firingSteps: boolean; dugoutEvery: number }`
  - `interface GenParams`:
    - `voxel: number`, `dims: Dims`, `ground: number`, `waterTable: number` (all voxels)
    - `trench`: `width`, `depth`, `bench`, `treadDepth`, `treadRise`, `treadsAcross`, `parapetMin`, `paradosH`, `crestFlat`, `bayLen`, `offset`, `leg`, `stepMin`, `stepMax`, `smooth`, `reach`, `near`, `percentile`, `margin`, `crestRise`, `lineMargin`, `floorMin`, `floorMaxBelowTop`
    - `eye: { standing: number; crouched: number }` and `stepUp: number`, all voxels as floats
    - `field: { amplitude: number; octaves: number; baseCell: number; persistence: number; swaleDepth: number; swaleMargin: number; ditches: number }`
    - `layout`:
      - `reserve`, `support`, `front`, `enemyFront`, `enemySupport`, `enemyReserve` (z, voxels);
      - `comm: number[]`, `enemyComm: number[]` (x);
      - `shelterbelts: number[]` (z);
      - `hamlet: [number, number]`, `wood: [number, number]` (z ranges);
      - `farm: [number, number]`, `culvert: [number, number]`, `hull: [number, number]` (x and z of each landmark).
    - `clutter: { fenceLines: number; poles: number }`
    - `craters: { nml: number; rear: number; directPerLine: number; radiusMin: number; gammaShape: number; gammaScale: number; radiusCap: number; directCap: number }` (voxels)
    - `lines: LineSpec[]`
  - `genParams(tun: Tunables, override?: (raw: Record<string, unknown>) => void): GenParams`. `override` edits a deep copy of the raw TOML before derivation, so tests can shrink the world.

**Tunables edits** (keep every existing comment; new keys get one-line comments):
- **`[world.trench]` additions:**
  - `crest_clearance_m = 0.12`. The parapet height is set by eye height minus this clearance; at 0.5 m voxels the grid rounding happened to give the same 0.12 m.
  - `tread_depth_m = 0.30`, `tread_rise_m = 0.30`.
  - `crest_flat_m = 1.00`. The flat top of a parapet before it falls away at 45°.
  - `line_margin_m = 6.0`.
  - `floor_min_m = 1.5`, `floor_below_top_m = 3.0`.
- **`[world.field]`:** replace `relief_base_cells` with `relief_cell_m = 42.7` (the base octave's cell, so a bigger map keeps the same ground) and add `ditches = 3`.
- **`[world.clutter]`:** `fence_lines = 6`, `poles = 14`.
- **`[world.layout]`:** replace the block with these values, in metres:
  - z positions:
    - `reserve_line_m = 52.0`, `support_line_m = 84.0`, `front_line_m = 106.0`;
    - `enemy_front_m = 158.0`, `enemy_support_m = 180.0`, `enemy_reserve_m = 206.0`;
    - `shelterbelt_z_m = [44.0, 132.0, 214.0]`;
    - `hamlet_z_m = [8.0, 40.0]`, `wood_z_m = [220.0, 252.0]`.
  - x positions: `comm_trench_x_m = [44.0, 128.0, 212.0]`, `enemy_comm_trench_x_m = [70.0, 186.0]`.
  - landmarks as `[x, z]`: `farm_m = [66.0, 123.0]`, `culvert_m = [180.0, 95.0]`, `hull_m = [141.0, 137.0]`.
- **`[world.craters]`:**
  - counts: `nml_count = 300`, `rear_count = 120`, `direct_hits_per_line = 6`;
  - radius distribution: `radius_min_m = 0.70`, `gamma_shape = 2.4`, `gamma_scale_m = 0.575`;
  - caps: `radius_cap_m = 3.25`, `direct_cap_m = 2.10`.

**Lines** (`lines`, in this order):

| Line | Axis | Cross base | Facing | Firing steps | Dugout every |
|---|---|---|---|---|---|
| `front` | x | front | +1 | yes | 3 |
| `support` | x | support | +1 | no | 4 |
| `reserve` | x | reserve | +1 | no | 2 |
| `enemy_front` | x | enemyFront | −1 | yes | 3 |
| `enemy_support` | x | enemySupport | −1 | no | 4 |
| `enemy_reserve` | x | enemyReserve | −1 | no | 2 |

- The x lines run `aStart = lineMargin` to `aEnd = dims.x − lineMargin`.
- `comm_i` lines run along z at `comm[i]`, from `reserve − 1` to `front + vx(3.0)`, facing +1, with no steps or dugouts.
- `enemy_comm_i` lines run along z at `enemyComm[i]`, from `enemyFront − vx(3.0)` to `enemyReserve + 1`, facing −1.

**Derived values:**
- `crestRise = vx(eyeStanding − crestClearance)`.
- `treadsAcross = floor(vx(step_tread_m) / treadDepth)`.
- `offset = width + max(1, vx(traverse_gap_m))`.
- `leg = max(2, vx(1.5))`.

**Validation.** These throw `RangeError` with Python's wording:
- the crest must lie strictly between the crouched and standing eye heights;
- `treadRise` must be at most `stepUp`;
- the walkway must be at least the body's width;
- the bench plus one tread must hold a body.

- [ ] **Step 1: Write the failing tests** in `tests/world/generation/params.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../../src/core/tunables';
import { genParams, vx } from '../../../src/world/generation/params';

describe('genParams', () => {
  const p = genParams(loadTunables());
  it('derives the 10 cm world from metres', () => {
    expect(vx(2.25, 0.1)).toBe(23);
    expect(p.dims).toEqual({ x: 2560, y: 320, z: 2560 });
    expect(p.ground).toBe(160);
    expect(p.waterTable).toBe(125);
    expect(p.trench.width).toBe(25);
    expect(p.trench.depth).toBe(25);
    expect(p.trench.crestRise).toBe(15);
    expect(p.trench.treadsAcross).toBe(3);
    expect(p.trench.offset).toBe(35);
    expect(p.layout.front).toBe(1060);
  });
  it('keeps the peek: crest between the crouched and standing eye', () => {
    expect(p.eye.crouched).toBeLessThan(p.trench.crestRise);
    expect(p.trench.crestRise).toBeLessThan(p.eye.standing);
  });
  it('lists every line, with comm trenches along z', () => {
    expect(p.lines.map((l) => l.name)).toEqual([
      'front', 'support', 'reserve', 'enemy_front', 'enemy_support', 'enemy_reserve',
      'comm_0', 'comm_1', 'comm_2', 'enemy_comm_0', 'enemy_comm_1',
    ]);
    const comm = p.lines[6];
    expect(comm.longAxis).toBe(2);
    expect(comm.aStart).toBe(p.layout.reserve - 1);
    expect(p.lines[0].aStart).toBe(60);
    expect(p.lines[0].aEnd).toBe(2500);
  });
  it('refuses a crest that gives no peek', () => {
    expect(() => genParams(loadTunables(), (raw: any) => { raw.world.trench.crest_clearance_m = 0.6; })).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/generation/params.test.ts`. Expected: FAIL, the module doesn't exist.
- [ ] **Step 3: Implement.** Edit `data/tunables.toml`, then write `params.ts` to the interface.
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/generation/params.test.ts tests/core/tunables.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Derive every generation number from tunables in metres, for the 256 m map"`

---

### Task 2: Noise and the terrain function

**Files:**
- Create: `src/world/generation/noise.ts`, `src/world/generation/terrain.ts`
- Test: `tests/world/generation/terrain.test.ts`

**Interfaces:**
- Consumes: `GenParams` (Task 1); `Rng`; `hash32`; `cos` and `PI` from dmath.
- Produces:
  - From `noise.ts`:
    - `lattice01(ix: number, iz: number, octave: number, salt: number): number`, which is `hash32(ix, iz, octave, salt) / 2^32`.
    - `valueNoise(x: number, z: number, cell: number, octave: number, salt: number): number`: smoothstep-bilinear in [0, 1), with the lattice at multiples of `cell`.
    - `fbm(x: number, z: number, baseCell: number, octaves: number, persistence: number, salt: number): number`. Octave `o` has cell `baseCell / 2^o` and amplitude `persistence^o`; the result is the amplitude-weighted mean.
  - From `terrain.ts`:
    - `interface Ditch { z: number; drift: number }`
    - `interface TerrainModel { salt: number; reliefMin: number; reliefMax: number; ditches: Ditch[] }`
    - `buildTerrain(p: GenParams, rng: Rng): TerrainModel`:
      - `salt` is `rng.derive('field.relief').nextU32()`;
      - the normalisation is the min and max of `fbm` sampled every 16 voxels over the playable map;
      - there are `p.field.ditches` ditches from `rng.derive('field.ditches')`, each with `z = randint(vx(4), dims.z − vx(4))` and `drift = uniform(−0.03, 0.03)`.
    - `fieldHeight(t: TerrainModel, p: GenParams, x: number, z: number): number`, a float in voxels: `ground + (relief01 − 0.5)·2·amplitude + swale(z)`. Here `relief01 = (fbm − min)/(max − min)`, which is not clamped, so the far field keeps rolling.
    - `swale(p: GenParams, z: number): number`, Python's `_swale` with `dmath.cos`, written `0 − round(dip·hump)` so a flat field returns +0.
    - `surfaceAt(t: TerrainModel, p: GenParams, x: number, z: number): number`:
      - integer, the first air voxel above the field;
      - `floor(fieldHeight + 0.5)` clamped to `[waterTable + 2, dims.y − 80]`;
      - lowered by `vx(1.5)` inside a ditch, i.e. when `|z − (d.z + d.drift·(x − dims.x/2))| ≤ max(1, vx(0.5))` and `0 ≤ x < dims.x`.
    - `ditchAt(t: TerrainModel, p: GenParams, x: number, z: number): boolean`

- [ ] **Step 1: Write the failing tests** in `tests/world/generation/terrain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { loadTunables } from '../../../src/core/tunables';
import { fbm, valueNoise } from '../../../src/world/generation/noise';
import { genParams } from '../../../src/world/generation/params';
import { buildTerrain, ditchAt, fieldHeight, surfaceAt, swale } from '../../../src/world/generation/terrain';

const p = genParams(loadTunables());
const t = buildTerrain(p, Rng.root(7));

describe('noise', () => {
  it('is continuous across lattice cells and stays in [0, 1)', () => {
    const a = valueNoise(99.999, 50, 100, 0, 3);
    const b = valueNoise(100.001, 50, 100, 0, 3);
    expect(Math.abs(a - b)).toBeLessThan(1e-3);
    for (let i = 0; i < 1000; i++) {
      const v = fbm(i * 37.1, i * 11.3, 427, 4, 0.34, 9);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('terrain', () => {
  it('is a pure function of the seed', () => {
    const again = buildTerrain(p, Rng.root(7));
    expect(again).toEqual(t);
    expect(surfaceAt(t, p, 1234, 567)).toBe(surfaceAt(again, p, 1234, 567));
  });
  it('rolls within the configured relief and sags into the swale', () => {
    let lo = Infinity, hi = -Infinity;
    for (let x = 0; x < 2560; x += 40) for (let z = 0; z < 600; z += 40) {
      const h = fieldHeight(t, p, x, z);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    expect(lo).toBeGreaterThanOrEqual(p.ground - 21);
    expect(hi).toBeLessThanOrEqual(p.ground + 21);
    const mid = (p.layout.front + p.layout.enemyFront) / 2;
    expect(swale(p, mid)).toBe(-15);
    expect(swale(p, 300)).toBe(0);
  });
  it('continues past the map edge', () => {
    const inside = fieldHeight(t, p, 2559.5, 1500);
    const outside = fieldHeight(t, p, 2560.5, 1500);
    expect(Math.abs(inside - outside)).toBeLessThan(0.5);
    expect(Number.isFinite(fieldHeight(t, p, -15000, 30000))).toBe(true);
  });
  it('cuts ditches with a lowered floor', () => {
    const d = t.ditches[0];
    const z = Math.round(d.z + d.drift * (1000 - 1280));
    expect(ditchAt(t, p, 1000, z)).toBe(true);
    expect(surfaceAt(t, p, 1000, z)).toBeLessThan(Math.floor(fieldHeight(t, p, 1000, z) + 0.5));
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/generation/terrain.test.ts`. Expected: FAIL, the modules don't exist.
- [ ] **Step 3: Implement `noise.ts` and `terrain.ts`.**
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/generation/terrain.test.ts`. Expected: PASS, 5 tests.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Make the field a pure function: hashed fBm relief, the swale, ditches"`

---

### Task 3: Craters as bowls and rims in the terrain

**Files:**
- Create: `src/world/generation/craters.ts`
- Test: `tests/world/generation/craters.test.ts`

**Interfaces:**
- Consumes: `GenParams`, `TerrainModel`, `surfaceAt` (Tasks 1–2); `Rng`.
- Produces, from `craters.ts`:
  - `interface Crater { x: number; z: number; r: number }`, with `r` in voxels.
  - `interface DirectHit { x: number; y: number; z: number; r: number; seed: number }`
  - `planCraters(p: GenParams, t: TerrainModel, rng: Rng, frontLines: { z: number; facing: 1 | -1 }[]): { open: Crater[]; direct: DirectHit[] }`:
    - **No man's land:** `nml` craters with `x = randint(vx(1.5), dims.x − vx(1.5))`, and `z = front + vx(2) + beta(0.7, 0.7)·(enemyFront − vx(2) − front − vx(2))`.
    - **Rear areas:** `rear` craters with uniform z, outside both front-to-front bands, over the whole map depth.
    - **Radius:** `min(radiusCap, radiusMin + gamma(gammaShape, gammaScale))`.
    - **Direct hits:** `directPerLine` per front line, each with `x` uniform along the line and `z` within `[lineZ − vx(1), lineZ + vx(6.5)]` toward the enemy (mirrored for the enemy line), `y = surfaceAt − round(0.55·r)`, radius capped at `directCap`, and `seed = rng.nextU32()`.
    - Each stream uses its own `rng.derive` label: `craters.nml`, `craters.rear`, `craters.direct.<line>`.
  - `class CraterField`:
    - `constructor(craters: readonly Crater[])`: a uniform grid of 64-voxel cells for lookup.
    - `bowl(x: number, z: number, base: number): number`. It returns the lowest bowl height over every crater covering the column, and `Infinity` when no crater covers it. The bowl is a paraboloid with `depth = 0.75·r`: `base − depth·(1 − (d/r)²)` for `d < r`.
    - `rim(x: number, z: number): number`. It returns the highest rim over the column's craters, `H·0.5·(1 + cos(PI·(d − 1.2r)/(0.2r)))` for `|d − 1.2r| < 0.2r`, with `H = 0.12·r`. The rim is zero at the bowl's edge and its maximum slope is about 0.94, below the 45° that loose spoil holds.
    - `covered(x: number, z: number): boolean`: inside some bowl.
  - `craterSurface(field: CraterField, base: number, x: number, z: number): number`, which is `floor(min(base + rim, bowl) + 0.5)`. The rim is added on the original ground and the bowls then cut it.

- [ ] **Step 1: Write the failing tests** in `tests/world/generation/craters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { loadTunables } from '../../../src/core/tunables';
import { CraterField, craterSurface, planCraters } from '../../../src/world/generation/craters';
import { genParams } from '../../../src/world/generation/params';
import { buildTerrain } from '../../../src/world/generation/terrain';

const p = genParams(loadTunables());
const t = buildTerrain(p, Rng.root(7));
const fronts = [{ z: p.layout.front, facing: 1 as const }, { z: p.layout.enemyFront, facing: -1 as const }];

describe('craters', () => {
  it('plans the configured counts, in bounds and within radius limits', () => {
    const c = planCraters(p, t, Rng.root(7).derive('craters'), fronts);
    expect(c.open).toHaveLength(p.craters.nml + p.craters.rear);
    expect(c.direct).toHaveLength(2 * p.craters.directPerLine);
    for (const k of c.open) {
      expect(k.r).toBeGreaterThanOrEqual(p.craters.radiusMin);
      expect(k.r).toBeLessThanOrEqual(p.craters.radiusCap);
      expect(k.x).toBeGreaterThanOrEqual(0);
      expect(k.x).toBeLessThan(p.dims.x);
    }
    const nml = c.open.slice(0, p.craters.nml);
    expect(nml.every((k) => k.z > p.layout.front && k.z < p.layout.enemyFront)).toBe(true);
  });
  it('digs a bowl 0.75 r deep with a gentle spoil rim', () => {
    const f = new CraterField([{ x: 100, z: 100, r: 20 }]);
    expect(craterSurface(f, 160, 100, 100)).toBe(145);
    expect(craterSurface(f, 160, 120, 100)).toBe(160);
    expect(craterSurface(f, 160, 124, 100)).toBe(162);
    expect(craterSurface(f, 160, 140, 100)).toBe(160);
    for (let x = 120; x < 135; x++) {
      expect(Math.abs(craterSurface(f, 160, x + 1, 100) - craterSurface(f, 160, x, 100))).toBeLessThanOrEqual(1);
    }
  });
  it('lets a later bowl cut an earlier rim', () => {
    const f = new CraterField([{ x: 100, z: 100, r: 20 }, { x: 125, z: 100, r: 10 }]);
    expect(craterSurface(f, 160, 125, 100)).toBe(153);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/generation/craters.test.ts`. Expected: FAIL, the module doesn't exist.
- [ ] **Step 3: Implement `craters.ts`.**
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/generation/craters.test.ts`. Expected: PASS, 3 tests.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Plan craters across the field and shape them as settled bowls with spoil rims"`

---

### Task 4: Trench planner — the per-bay sightline guarantee

**Files:**
- Create: `src/world/generation/trenches.ts`
- Test: `tests/world/generation/trenches.test.ts`

**Interfaces:**
- Consumes: `GenParams`, `LineSpec` (Task 1); a `surface: (x: number, z: number) => number` callback (the terrain's `surfaceAt` without craters, as Python plans before cutting craters); `Rng`.
- Produces, from `trenches.ts`:
  - `type RevetStyle = 'planks' | 'corrugated' | 'hurdles'`
  - `interface BayPlan`:
    - `line: string`, `index: number`
    - `a0`, `a1`, `b0`, `b1` (along/cross voxels)
    - `x0`, `x1`, `z0`, `z1` (the world box)
    - `groundY`, `floorY`, `stepTopY`, `crestY`
    - `stepLo`, `stepSpan`
    - `walkX`, `walkZ`
    - `longAxis: 0 | 2`, `facing: 1 | -1`, `firingSteps: boolean`
    - `revet: RevetStyle`, `seed: number`
  - `interface LegPlan { a0: number; a1: number; b0: number; b1: number; floorY: number; longAxis: 0 | 2 }`
  - `interface DugoutPlan { line: string; lo: [number, number, number]; hi: [number, number, number]; entrance: [number, number, number]; floorY: number; dugFloor: number; roofY: number; longAxis: 0 | 2; away: 1 | -1; seed: number }`
  - `interface LinePlan { spec: LineSpec; bays: BayPlan[]; legs: LegPlan[]; dugouts: DugoutPlan[] }`
  - `corridorHeight(surface, spec: LineSpec, a0: number, a1: number, frontEdge: number, reach: number, near: number, percentile: number): number`. It ports `_corridor_height`, with numpy's linear-interpolation percentile over the far strip and the maximum over the near strip, then `ceil`.
  - `planLine(p: GenParams, spec: LineSpec, surface: (x: number, z: number) => number, rng: Rng): LinePlan`. It ports `_carve_trench_line`'s *plan*:
    - `groundY` is `int(median)` over the bay box (the mean of the two middle values when the count is even, then truncated).
    - `floorY` is `groundY − depth`, clamped to within `treadRise` of the previous bay and to `[floorMin, dims.y − depth − floorMaxBelowTop]`.
    - `duckY = floorY + 1`.
    - The firing step: `needed = ceil(ahead + margin − eye.standing)`, then `stepTop = clamp(max(duckY + stepMin, groundY + parapetMin − crestRise, needed), …, duckY + stepMax)`, and `crestY = stepTop + crestRise`.
    - Lines without firing steps: `stepTop = duckY`, `crestY = groundY + parapetMin`.
    - Two smoothing passes that only raise, then the clamp, then the crest is recomputed.
    - Legs between consecutive bays.
    - A dugout when `dugoutEvery > 0 && index % dugoutEvery === 1`, sized as Python's `_carve_dugout` in metres. It is skipped when the chamber would leave the map; `dugFloor = max(floorY − vx(1.0), waterTable + 1)`.
    - The revet style comes from `rng.derive('revet').choice(['planks', 'planks', 'corrugated', 'hurdles'])` per bay, and the bay seed from `rng.nextU32()`.

- [ ] **Step 1: Write the failing tests** in `tests/world/generation/trenches.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { loadTunables } from '../../../src/core/tunables';
import { genParams } from '../../../src/world/generation/params';
import { buildTerrain, surfaceAt } from '../../../src/world/generation/terrain';
import { corridorHeight, planLine } from '../../../src/world/generation/trenches';

const p = genParams(loadTunables());
const t = buildTerrain(p, Rng.root(7));
const surface = (x: number, z: number) => surfaceAt(t, p, x, z);
const front = planLine(p, p.lines[0], surface, Rng.root(7).derive('trench.front'));

describe('trench planner', () => {
  it('guarantees every fire bay its peek, from its own ground', () => {
    const vs = p.voxel;
    for (const bay of front.bays) {
      const ahead = corridorHeight(surface, front.spec, bay.a0, bay.a1, bay.b1, p.trench.reach, p.trench.near, p.trench.percentile);
      const eye = bay.stepTopY + p.eye.standing;
      if (bay.stepTopY < bay.floorY + 1 + p.trench.stepMax) expect(eye + 1e-9).toBeGreaterThanOrEqual(ahead + p.trench.margin);
      expect(bay.crestY - bay.stepTopY).toBe(p.trench.crestRise);
      expect((bay.stepTopY + p.eye.crouched) * vs).toBeLessThan(bay.crestY * vs);
    }
  });
  it('steps floors at most one tread between bays and only raises crests when smoothing', () => {
    for (let i = 1; i < front.bays.length; i++) {
      expect(Math.abs(front.bays[i].floorY - front.bays[i - 1].floorY)).toBeLessThanOrEqual(p.trench.treadRise);
      expect(front.bays[i - 1].stepTopY - front.bays[i].stepTopY).toBeLessThanOrEqual(p.trench.smooth);
    }
  });
  it('crenellates by the traverse offset and ends inside the margin', () => {
    expect(front.bays[1].b0 - front.bays[0].b0).toBe(p.trench.offset);
    expect(front.bays[0].a0).toBe(60);
    expect(front.bays.at(-1)!.a1).toBeLessThanOrEqual(2500);
    expect(front.legs).toHaveLength(front.bays.length - 1);
  });
  it('places dugouts every third bay on the front, above the water table', () => {
    expect(front.dugouts.length).toBeGreaterThan(5);
    for (const d of front.dugouts) expect(d.dugFloor).toBeGreaterThan(p.waterTable);
  });
  it('plans comm trenches along z without firing steps', () => {
    const comm = planLine(p, p.lines[6], surface, Rng.root(7).derive('trench.comm_0'));
    expect(comm.bays.every((b) => b.longAxis === 2 && !b.firingSteps && b.stepTopY === b.floorY + 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/generation/trenches.test.ts`. Expected: FAIL, the module doesn't exist.
- [ ] **Step 3: Implement `trenches.ts`.**
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/generation/trenches.test.ts`. Expected: PASS, 5 tests.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Port the trench planner: crenellated bays, each guaranteeing its own peek"`

---

### Task 5: `WorldPlan` and the column model

**Files:**
- Create: `src/world/generation/plan.ts`, `src/world/generation/columns.ts`
- Test: `tests/world/generation/columns.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - From `plan.ts`:
    - `interface PropPlan { kind: string; x: number; z: number; seed: number; a?: number; b?: number; c?: number }`.
    - `interface WorldPlan`:
      - `seed`, `params: GenParams`, `terrain: TerrainModel`;
      - `craters: Crater[]`, `direct: DirectHit[]`;
      - `lines: LinePlan[]`;
      - `props: PropPlan[]`. This is filled in Task 8, and is empty until then.
    - `planWorld(params: GenParams, seed: number): WorldPlan`. Every random stream derives from `Rng.root(seed)` by label: `field.*`, `trench.<line>`, `craters`, `props.*`. The planner's `surface` callback is `surfaceAt` (ditches, no craters).
    - `bayIndex(plan: WorldPlan): BayLookup`. It returns `{ at(x, z): { line: number; bay: number } | null }` over bay and leg footprints, through a 2D grid of 64-voxel cells.
  - From `columns.ts`:
    - `interface ColumnModel`:
      - `x0: number`, `x1: number` (band plus halo), `nz: number`;
      - `ground: Int16Array`, the pre-crater field surface (strata reference);
      - `surface: Int16Array`, the ground with crater bowls and rims and ditches;
      - `floor: Int16Array`, −1 or the duckboard layer y;
      - `solidTop: Int16Array`, −1 or the top of bench, tread or flight timber;
      - `spoilTop: Int16Array`, −1 or a parapet or parados target;
      - `revetTop: Int16Array` and `revetFrom: Int16Array`, −1 or the revetment span on face columns;
      - `bay: Int32Array`, the global bay id (an index into a flattened bay list), or −1;
      - `top: Int16Array`, the first air voxel above the column's ground mass, for the repose rule;
      - `flags: Uint8Array`: `DITCH 1`, `CRATER 2`, `TRENCH 4`, `PARAPET 8`, `PARADOS 16`, `REVET 32`.
    - `columnModel(plan: WorldPlan, x0: number, x1: number): ColumnModel`. It covers `[x0−1, x1+1)` with a one-column halo, and builds:
      - `surface`: terrain with ditches. Craters come later, so they can cut parapets as Python's craters did.
      - Lines in plan order:
        - **Bay and leg footprints:** set `floor`, clear `spoilTop`/`revetTop`/`flags` on those columns, and mark them `TRENCH`.
        - **Firing steps:**
          - the bench spans `[stepLo, stepLo + bench)` across the bay up to `stepTopY`;
          - `treadsAcross` treads of `treadDepth` columns fall away toward the walkway, tread `k` reaching `duckY + min((treadsAcross − k)·treadRise, stepH)`;
          - when `stepH − treadsAcross·treadRise > 0`, an along-bay flight starts at the bay's `a0` end, with each `treadDepth` columns of `[stepLo, stepLo + bench)` climbing one more `treadRise`.
        - **Parapets:** courses outward from the parapet face, each spanning `[a0, a1 + leg)`. Course `k` has target `crestY − max(0, k − crestFlat)` while that is above `groundY`, so the bank falls at 45° until it meets the field. The face column itself is revetted.
        - **Parados:** behind the bay, `crestFlat` courses at `groundY + paradosH`, then falling at 45°. Its face is revetted to `groundY + paradosH`.
        - **Revetment:** each face column spans from `duckY` to its target.
        - **Combining:** targets `max` with what is there. They never apply to a `TRENCH` column, and a parados target never applies where a parapet target exists.
      - **Craters**, outside trench footprints: a bowl lowers `surface` and `spoilTop` alike (`min` with the bowl), and a rim then adds to whichever is on top. Mark them `CRATER`.
      - `top`, computed per column:
        - a trench column's top is `max(floor + 1, solidTop)`;
        - otherwise it is `max(surface, spoilTop, revetTop)`.

- [ ] **Step 1: Write the failing tests** in `tests/world/generation/columns.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../../src/core/tunables';
import { columnModel } from '../../../src/world/generation/columns';
import { genParams } from '../../../src/world/generation/params';
import { planWorld } from '../../../src/world/generation/plan';

const p = genParams(loadTunables());
const plan = planWorld(p, 7);
const front = plan.lines[0];
const bay = front.bays[10];
const m = columnModel(plan, bay.x0, bay.x1);
const at = (x: number, z: number) => (x - m.x0) * m.nz + z;

describe('column model', () => {
  it('opens the walkway down to the duckboards', () => {
    const c = at(Math.floor(bay.walkX), Math.floor(bay.walkZ));
    expect(m.floor[c]).toBe(bay.floorY);
    expect(m.flags[c] & 4).toBe(4);
  });
  it('raises the bench to the step top and the parapet face to the crest', () => {
    const x = Math.floor((bay.x0 + bay.x1) / 2);
    expect(m.solidTop[at(x, bay.stepLo)]).toBe(bay.stepTopY);
    expect(m.revetTop[at(x, bay.b1)]).toBe(bay.crestY);
  });
  it('falls away from the crest at 45 degrees until it meets the field', () => {
    const x = Math.floor((bay.x0 + bay.x1) / 2);
    let prev = m.spoilTop[at(x, bay.b1 + 1)];
    for (let z = bay.b1 + 2; m.spoilTop[at(x, z)] > m.surface[at(x, z)]; z++) {
      const h = m.spoilTop[at(x, z)];
      expect(prev - h).toBeLessThanOrEqual(1);
      prev = h;
    }
  });
  it('lets a comm trench cut through the support line parapet', () => {
    const comm = plan.lines[6];
    const cross = comm.bays.find((b) => b.z0 <= p.layout.support + 30 && b.z1 >= p.layout.support + 30)!;
    const mm = columnModel(plan, cross.x0, cross.x1);
    const c = (Math.floor(cross.walkX) - mm.x0) * mm.nz + Math.floor(cross.walkZ);
    expect(mm.spoilTop[c]).toBe(-1);
    expect(mm.floor[c]).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/generation/columns.test.ts`. Expected: FAIL, the modules don't exist.
- [ ] **Step 3: Implement `plan.ts` and `columns.ts`.**
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/generation/columns.test.ts`. Expected: PASS, 4 tests.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Plan the whole world and rasterise its columns per band"`

---

### Task 6: `fillBand` — columns to voxels, settled and flooded

**Files:**
- Create: `src/world/generation/fill.ts`, `src/world/generation/invariants.ts`
- Test: `tests/world/generation/fill.test.ts`

**Interfaces:**
- Consumes: `columnModel` (Task 5); `BrickMap`, `P`, `isLoose`, `isGranular`, `isSolid`; `hash32`.
- Produces:
  - From `fill.ts`:
    - `interface BandResult { band: number; table: Uint32Array; dense: Uint8Array; denseBricks: Uint32Array }`. `denseBricks` lists band-local brick indices ascending, and `dense` holds 512 bytes per entry in the same order.
    - `fillBand(plan: WorldPlan, band: number): BandResult`. It covers x `[band·32, band·32 + 32)`, all of y and z.
    - `bandMap(plan: WorldPlan, band: number): BrickMap`, the same fill returned as a 32-wide map, for props and tests.
    - `columnMaterial(m: ColumnModel, plan: WorldPlan, x: number, y: number, z: number): number`, exported for tests.
  - From `invariants.ts`:
    - `interface InvariantReport { hangingGranular: number; looseSteep: number; waterAboveTable: number; samples: string[] }`
    - `checkInvariants(map: BrickMap, waterTable: number, opts?: { ditchWater?: boolean }): InvariantReport`.
      - It scans only dense bricks and the boundaries of uniform ones, so the full map takes seconds.
      - A ditch puddle is one water voxel resting on solid and is allowed when `ditchWater`.

**The voxel rule, in order:**
- **Below the original ground**, strata by `depth = ground − y`:
  - depth 1: `SOD` (or `SOD_DRY`/`SOD_TUFT` by hash);
  - depth up to `vx(1.5)`: `MUD`;
  - depth up to `vx(4.0)`: `CLAY`;
  - deeper: `SUBSOIL`.
  - Ploughed stripes turn depth-1 `SOD` into `MUD_TURNED` on z-stripes of period `vx(3.5)` (Python's period 7 at 0.5 m) outside no man's land.
- **Crater bowls** expose the strata. The bowl's top voxel is `MUD_WET`, or `MUD_DARK` above the water table.
- **A rim** above `ground` is `SPOIL` (`SPOIL_DRY` by hash).
- **Trench columns:**
  - earth up to `floor`;
  - `DUCKBOARD` at `floor`, where slats are 2 voxels with a 1-voxel gap along the trench's long axis and the gaps are air;
  - `TIMBER` from `floor + 1` up to `solidTop`;
  - air above.
- **Face columns:** revetment in `[revetFrom, revetTop)`, styled by the bay:
  - planks: `TIMBER`/`TIMBER_WEATHERED` alternating every 2 voxels in y, with `TIMBER_DARK` posts every `vx(1.2)` along the face;
  - corrugated: `CORRUGATE` with `CORRUGATE_RUST` by hash;
  - hurdles: `BRANCH`/`TRUNK_BARK` in a woven checker of 2-voxel cells.
- **Parapet and parados** are `SPOIL` from `surface` up to `spoilTop`.
- **Water:**
  - any air at `y ≤ waterTable` with solid or water below becomes `WATER`;
  - a ditch column's first air voxel above its lowered surface is `WATER`.
- **The repose rule:** a loose voxel whose 4-neighbour column has `top ≤ y − 1` becomes `MUD_DARK`.
- **Speed:**
  - bricks wholly below every column's `min(ground, floor) − vx(4.0)` are uniform `SUBSOIL`;
  - bricks wholly above every column's `max(top, water)` are empty;
  - everything else is built in a 512-byte scratch and stored with `writeBrick`.

- [ ] **Step 1: Write the failing tests** in `tests/world/generation/fill.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../../src/core/tunables';
import { P } from '../../../src/world/materials';
import { columnModel } from '../../../src/world/generation/columns';
import { bandMap, fillBand } from '../../../src/world/generation/fill';
import { checkInvariants } from '../../../src/world/generation/invariants';
import { genParams } from '../../../src/world/generation/params';
import { planWorld } from '../../../src/world/generation/plan';

const p = genParams(loadTunables());
const plan = planWorld(p, 7);
const bay = plan.lines[0].bays[10];
const band = Math.floor((bay.x0 + bay.x1) / 2 / 32);
const map = bandMap(plan, band);
const lx = Math.floor((bay.x0 + bay.x1) / 2) - band * 32;

describe('fillBand', () => {
  it('builds a walkable bay: duckboards, open air, timber bench, revetted face', () => {
    const wz = Math.floor(bay.walkZ);
    const floorRow = [0, 1, 2].map((k) => map.get(lx + k, bay.floorY, wz));
    expect(floorRow.filter((v) => v === P.DUCKBOARD || v === P.DUCKBOARD_WORN).length).toBeGreaterThanOrEqual(2);
    for (let y = bay.floorY + 1; y < bay.floorY + 21; y++) expect(map.get(lx, y, wz)).toBe(P.AIR);
    expect([P.TIMBER, P.TIMBER_WEATHERED, P.TIMBER_DARK]).toContain(map.get(lx, bay.stepTopY - 1, bay.stepLo));
    expect(map.get(lx, bay.crestY - 1, bay.b1)).not.toBe(P.AIR);
    expect(map.get(lx, bay.crestY + 1, bay.b1 + 1)).toBe(P.AIR);
  });
  it('lays strata under the field', () => {
    const cm = columnModel(plan, band * 32, band * 32 + 32);
    let z = 600;
    while (cm.flags[(lx + band * 32 - cm.x0) * cm.nz + z] !== 0) z++;
    let y = 319;
    while (map.get(lx, y, z) === P.AIR) y--;
    expect([P.SOD, P.SOD_DRY, P.SOD_TUFT, P.MUD_TURNED]).toContain(map.get(lx, y, z));
    expect(map.get(lx, y - 10, z)).toBe(P.MUD);
    expect(map.get(lx, y - 30, z)).toBe(P.CLAY);
    expect(map.get(lx, 10, z)).toBe(P.SUBSOIL);
  });
  it('leaves nothing hanging or past repose, and no water above the table', () => {
    const r = checkInvariants(map, p.waterTable, { ditchWater: true });
    expect(r.hangingGranular, r.samples.join('\n')).toBe(0);
    expect(r.looseSteep, r.samples.join('\n')).toBe(0);
    expect(r.waterAboveTable).toBe(0);
  });
  it('returns the band as transferable bricks', () => {
    const res = fillBand(plan, band);
    expect(res.table.length).toBe(4 * 40 * 320);
    expect(res.dense.length).toBe(res.denseBricks.length * 512);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/generation/fill.test.ts`. Expected: FAIL, the modules don't exist.
- [ ] **Step 3: Implement `fill.ts` and `invariants.ts`.**
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/generation/fill.test.ts`. Expected: PASS, 4 tests.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Fill bands from the column model: strata, trenches, revetment, water, settled"`

---

### Task 7: Trench furniture — sandbag crests and dugouts

**Files:**
- Create: `src/world/sink.ts`, `src/world/generation/furniture.ts`
- Modify: `src/world/generation/fill.ts` (stamp furniture after the columns, clipped to the band)
- Test: `tests/world/generation/furniture.test.ts`

**Interfaces:**
- Consumes: `BayPlan`, `DugoutPlan`, `WorldPlan`; `BrickMap.set`/`fillBox`; `P`; `Rng`.
- Produces, from `src/world/sink.ts`:
  - `interface Clip { x0: number; x1: number }`: the band's world x range. Stamps write only inside it, through a `VoxelSink`.
  - `interface VoxelSink { set(x: number, y: number, z: number, p: number): void; get(x: number, y: number, z: number): number }`: world coordinates, with writes outside the clip ignored.
  - `bandSink(map: BrickMap, x0: number): VoxelSink`: a band map seen in world coordinates.
- Produces, from `furniture.ts`:
  - `stampSandbags(sink: VoxelSink, bay: BayPlan, p: GenParams): void`.
    - For bays on firing lines, runs of bags lie along the crest's top 2 voxels, on the inner two parapet courses. The crest height is unchanged, so the sightline guarantee holds.
    - Each bag is 6 voxels along, 3 across and 2 high, laid in stretcher bond. Runs cover 28% of the crest (Python's figure), chosen per 6-voxel slot by `hash32(bay.seed, slot) / 2^32 < 0.28`.
    - The bag's edge voxels are `SANDBAG_SEAM` and the rest `SANDBAG` or `SANDBAG_WORN` by hash.
  - `stampDugout(sink: VoxelSink, d: DugoutPlan, p: GenParams): void`. Python's `_carve_dugout` in metres:
    - a 3.0 × 3.0 m chamber, reached by a 1.0 m passage;
    - 2.0 m headroom;
    - a `DUCKBOARD` floor;
    - a `TIMBER` roof with `CORRUGATE` above it;
    - one 0.3 m timber step per tread rise down the passage;
    - a `CLOTH` gas curtain across the passage's inner end;
    - one `LANTERN_GLOW` voxel on the back wall at 1.6 m.
    - The burster spoil over the roof is part of the column model's `spoilTop`, with a 1.0 m cover falling at 45°. Add it in `columns.ts` from the dugout plan.

- [ ] **Step 1: Write the failing tests** in `tests/world/generation/furniture.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../../src/core/tunables';
import { P, isSolid } from '../../../src/world/materials';
import { bandMap } from '../../../src/world/generation/fill';
import { checkInvariants } from '../../../src/world/generation/invariants';
import { genParams } from '../../../src/world/generation/params';
import { planWorld } from '../../../src/world/generation/plan';

const p = genParams(loadTunables());
const plan = planWorld(p, 7);
const front = plan.lines[0];

describe('trench furniture', () => {
  it('lays sandbags on crests without raising them', () => {
    let bags = 0;
    for (const bay of front.bays.slice(5, 15)) {
      const band = Math.floor(bay.x0 / 32);
      const map = bandMap(plan, band);
      for (let x = Math.max(bay.x0, band * 32); x < Math.min(bay.x1, band * 32 + 32); x++) {
        const lx = x - band * 32;
        const top = map.get(lx, bay.crestY - 1, bay.b1 + 1);
        if (top === P.SANDBAG || top === P.SANDBAG_SEAM || top === P.SANDBAG_WORN) bags++;
        expect(map.get(lx, bay.crestY, bay.b1 + 1)).toBe(P.AIR);
      }
    }
    expect(bags).toBeGreaterThan(10);
  });
  it('digs dugouts with headroom, a roof, a curtain and a lantern', () => {
    const d = front.dugouts[0];
    const band = Math.floor(((d.lo[0] + d.hi[0]) >> 1) / 32);
    const map = bandMap(plan, band);
    const cx = ((d.lo[0] + d.hi[0]) >> 1) - band * 32;
    const cz = (d.lo[2] + d.hi[2]) >> 1;
    for (let y = d.dugFloor + 1; y < d.dugFloor + 20; y++) expect(map.get(cx, y, cz)).toBe(P.AIR);
    expect(isSolid(map.get(cx, d.roofY, cz))).toBe(true);
    let lantern = 0, cloth = 0;
    for (let x = 0; x < 32; x++) for (let y = d.dugFloor; y < d.roofY; y++) for (let z = d.lo[2] - 12; z < d.hi[2] + 12; z++) {
      const v = map.get(x, y, z);
      if (v === P.LANTERN_GLOW) lantern++;
      if (v === P.CLOTH) cloth++;
    }
    expect(lantern).toBeGreaterThanOrEqual(1);
    expect(cloth).toBeGreaterThan(0);
    expect(checkInvariants(map, p.waterTable, { ditchWater: true }).hangingGranular).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/generation/furniture.test.ts`. Expected: FAIL, no sandbags or dugouts yet.
- [ ] **Step 3: Implement `furniture.ts`, stamp it from `fillBand`, and add the dugout burster to `columns.ts`.**
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/generation/furniture.test.ts tests/world/generation/fill.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Lay sandbag courses on the crests and dig dugouts with curtains and lanterns"`

---

### Task 8: Band-stable carves through sinks, `detonate`, and the event phase

**Files:**
- Modify: `src/world/destruction.ts`:
  - carving moves onto a `VoxelSink`, with the wobble lattice taken from the unclamped box;
  - add `loosenRim` and `detonate`.
- Create: `src/world/generation/events.ts`
- Test: `tests/world/generation/events.test.ts`

**Interfaces:**
- Consumes: `carveSphere`, `collapseRegion`, `floodRegion`, `spoilOf`, `hardness`; `DirectHit`; `WorldPlan`.
- Produces:
  - The wobble field's `extent` and lattice coordinates always come from the *unclamped* box `[floor(c − rOut), ceil(c + rOut) + 1)`. A carve cut short by the world's edge, or by a band's, therefore cuts exactly the voxels the whole carve would. This changes milestone 2's behaviour only at the world's edge.
  - `carveWith(sink: VoxelSink, clip: Clip, cx: number, cy: number, cz: number, radius: number, rng: Rng, opts?: CarveOptions): void`. The same cut, through a sink in world coordinates, writing only inside `clip`. `carveSphere(map, …)` keeps its signature and still returns the clamped box.
  - `loosenRim(map: BrickMap, cx: number, cy: number, cz: number, outer: number, inner: number): Box | null`. Non-air voxels with `inner² ≤ d² < outer²` become `spoilOf(voxel)` (Python's `_loosen_rim`).
  - `interface DetonateOptions { hardLimit: number; core: number; loosen: number; waterTable: number }`. The values come from `[destruction]`: `resists_above_hardness`, `core_radius_scale` and `loosen_radius_scale`.
  - `detonate(map: BrickMap, cx: number, cy: number, cz: number, radius: number, rng: Rng, o: DetonateOptions): Box | null`. A port of Python's `detonate`:
    - carve with `protect = hardness > hardLimit`;
    - carve the core at `radius·core` unprotected;
    - loosen the rim out to `radius·loosen`;
    - `collapseRegion` over the reach box;
    - `floodRegion` over it.
  - `applyEvents(map: BrickMap, plan: WorldPlan): number`. It detonates every `plan.direct` in plan order with `Rng.root(hit.seed)` and returns the count.

- [ ] **Step 1: Write the failing tests** in `tests/world/generation/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { BrickMap } from '../../../src/world/bricks';
import { carveSphere, detonate } from '../../../src/world/destruction';
import { P } from '../../../src/world/materials';
import { checkInvariants } from '../../../src/world/generation/invariants';

function slab(): BrickMap {
  const w = new BrickMap({ x: 96, y: 64, z: 96 });
  w.fillBox(0, 0, 0, 96, 30, 96, P.MUD);
  w.fillBox(40, 30, 40, 56, 40, 42, P.TIMBER);
  w.fillBox(40, 30, 42, 56, 38, 50, P.SPOIL);
  return w;
}

describe('band-stable carving', () => {
  it('cuts the same voxels when the world edge clamps the box', () => {
    const wide = new BrickMap({ x: 128, y: 64, z: 64 });
    const narrow = new BrickMap({ x: 64, y: 64, z: 64 });
    wide.fillBox(0, 0, 0, 128, 40, 64, P.MUD);
    narrow.fillBox(0, 0, 0, 64, 40, 64, P.MUD);
    carveSphere(wide, 64, 38, 32, 12, Rng.root(5));
    carveSphere(narrow, 64, 38, 32, 12, Rng.root(5));
    for (let x = 40; x < 64; x++) for (let y = 20; y < 40; y++) for (let z = 15; z < 50; z++) {
      expect(narrow.get(x, y, z), `${x},${y},${z}`).toBe(wide.get(x, y, z));
    }
  });
});

describe('detonate', () => {
  it('blows a crater, loosens the rim, brings the parapet down and stays settled', () => {
    const w = slab();
    const box = detonate(w, 48, 34, 41, 7, Rng.root(9), { hardLimit: 2, core: 0.55, loosen: 1.45, waterTable: 5 });
    expect(box).not.toBeNull();
    expect(w.get(48, 34, 41)).toBe(P.AIR);
    const r = checkInvariants(w, 5);
    expect(r.hangingGranular).toBe(0);
    expect(r.looseSteep).toBe(0);
  });
  it('leaves concrete standing outside the core', () => {
    const w = new BrickMap({ x: 64, y: 64, z: 64 });
    w.fillBox(0, 0, 0, 64, 30, 64, P.MUD);
    w.fillBox(20, 30, 20, 44, 34, 44, P.CONCRETE);
    detonate(w, 32, 33, 32, 10, Rng.root(2), { hardLimit: 2, core: 0.55, loosen: 1.45, waterTable: 5 });
    expect(w.get(32, 33, 40)).toBe(P.CONCRETE);
    expect(w.get(32, 33, 32)).toBe(P.AIR);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/generation/events.test.ts`. Expected: FAIL, `detonate` is not exported.
- [ ] **Step 3: Implement** the unclamped lattice, `carveWith`, `loosenRim`, `detonate` and `events.ts`.
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/generation/events.test.ts tests/world/carve.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Port detonate for direct hits, with carves that stay the same across band edges"`

---

### Task 9: Landscape props — trees and the wood, wire, poles, fences, hull, farm, culvert, hamlet

**Files:**
- Create: `src/world/generation/props.ts`
- Modify: `src/world/generation/plan.ts` (plan the props); `src/world/generation/fill.ts` (stamp props per band)
- Test: `tests/world/generation/props.test.ts`

**Interfaces:**
- Consumes: `VoxelSink`, `Clip` (Task 7); `WorldPlan`; `columnTopAt` (below); `carveWith` (Task 8); `Rng`; `P`.
- Produces:
  - `columnTopAt(plan: WorldPlan, x: number, z: number): number`, exported from `columns.ts`: the pure `top` of any column (`columnModel` for one column), so props stand on the real ground wherever they are drawn.
  - `planProps(plan: WorldPlan, rng: Rng): PropPlan[]`. Each kind gets its own `rng.derive('props.<kind>')`:
    - `tree`: shelterbelt trees per Python's `_shelterbelt` in metres, with a gap of 1–3 m and two rows ±1 m. The kinds are `stump` (62%, 1.0–2.5 m) and `trunk` (3.5–7.5 m). A trunk has a second trunk 55% of the time and a fallen trunk 22% of the time. There is also 1 tree per 9 m² across the wood's z range.
    - `wire`: two belts per front line at ±8.5 m toward the enemy. Pickets run every 3 m in two rows 1 m apart, and the strands are part of the prop.
    - `pole`: `clutter.poles` poles of 4–7.5 m with a crossbar 50% of the time, in no man's land.
    - `fence`: `clutter.fenceLines` lines with posts every 2–4 m, 72% standing, leaning ±1 voxel per metre.
    - `hull`: one hull at `layout.hull`.
    - `farm`: one farm at `layout.farm`.
    - `culvert`: one culvert at `layout.culvert`.
    - `hamlet`: 6 buildings spread over the `layout.hamlet` z range, avoiding the reserve line by `vx(8)`, plus one `church` tower of 3 × 3 m and 9–12 m tall, with a broken top.
  - `stampProp(sink: VoxelSink, clip: Clip, plan: WorldPlan, prop: PropPlan): void`. It dispatches by kind, and every random choice comes from `Rng.root(prop.seed)`.

**The kinds at 10 cm:**
- **Trunks:** 3 × 3 voxels, `TRUNK` with `TRUNK_BARK` by hash, and a `TRUNK_SPLINTER` jagged top 0.3–0.6 m.
- **Branches:** diagonal `BRANCH` runs of 0.8–2 m.
- **Pickets:** 1 × 1 `PICKET` posts of 1.2–1.5 m.
- **Strands:** `WIRE` on Bresenham lines between pickets at 0.3, 0.7 and 1.1 m, sagging by 1 voxel mid-span, plus diagonal cross strands.
- **Hull:** 7.0 × 3.5 × 2.5 m of `HULL` with `HULL_RUST` by hash, a 2.5 × 2.5 × 1.5 m turret and a drooping 3 m barrel. Four `carveWith` holes of 0.6–1.2 m, and a 1-voxel `RUBBLE` skirt.
- **Farm:** an 8.0 × 5.5 × 4.5 m building with 0.3 m `BRICK` walls, a `MORTAR` course every 3rd layer and `BRICK_DARK` by hash. Two walls are cut to 1.0–2.5 m, there are six holes of 0.75–1.6 m, a `CONCRETE` slab and a 0.2 m `RUBBLE` floor.
- **Culvert:** a 9 × 2.5 × 2.5 m `CONCRETE` box with a 1.5 m bore. The road embankment is spoil falling at 45°, and the middle of the culvert is collapsed (a carve and a `RUBBLE` slab).
- **Hamlet buildings:** each is a farm with its own size of 5–9 × 4–7 m and 3.5–6 m, and 40% keep two charred `TIMBER_DARK` roof beams.
- **Every prop's base** is `columnTopAt` at its anchor, and loose material it adds obeys the repose rule (rubble skirts are one voxel high).

- [ ] **Step 1: Write the failing tests** in `tests/world/generation/props.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../../src/core/tunables';
import { BrickMap } from '../../../src/world/bricks';
import { P } from '../../../src/world/materials';
import { bandMap } from '../../../src/world/generation/fill';
import { genParams } from '../../../src/world/generation/params';
import { planWorld } from '../../../src/world/generation/plan';
import { stampProp } from '../../../src/world/generation/props';

const p = genParams(loadTunables());
const plan = planWorld(p, 7);

function stampSplit(prop: (typeof plan.props)[number], split: number): BrickMap {
  const w = new BrickMap({ x: 256, y: 320, z: 256 });
  const ox = Math.floor(prop.x) - 128, oz = Math.floor(prop.z) - 128;
  const sink = (lo: number, hi: number) => ({
    set: (x: number, y: number, z: number, v: number) => { if (x >= lo && x < hi) w.set(x - ox, y, z - oz, v); },
    get: (x: number, y: number, z: number) => w.get(x - ox, y, z - oz),
  });
  stampProp(sink(-1e9, ox + split), { x0: -1e9, x1: ox + split }, plan, prop);
  stampProp(sink(ox + split, 1e9), { x0: ox + split, x1: 1e9 }, plan, prop);
  return w;
}

describe('props', () => {
  it('plans every kind', () => {
    const kinds = new Set(plan.props.map((q) => q.kind));
    for (const k of ['tree', 'wire', 'pole', 'fence', 'hull', 'farm', 'culvert', 'hamlet', 'church']) expect(kinds.has(k), k).toBe(true);
  });
  it('stamps the same voxels however the band boundary cuts a prop', () => {
    for (const kind of ['hull', 'farm', 'culvert', 'church', 'tree']) {
      const prop = plan.props.find((q) => q.kind === kind)!;
      const a = stampSplit(prop, 128), b = stampSplit(prop, 100);
      for (let i = 0; i < 4000; i++) {
        const x = 64 + (i * 7) % 128, y = 150 + (i * 13) % 100, z = 64 + (i * 29) % 128;
        expect(a.get(x, y, z), `${kind} at ${x},${y},${z}`).toBe(b.get(x, y, z));
      }
    }
  });
  it('builds the hull out of hull plate, standing in no man\'s land', () => {
    const hull = plan.props.find((q) => q.kind === 'hull')!;
    const band = Math.floor(hull.x / 32);
    const map = bandMap(plan, band);
    let plate = 0;
    for (let x = 0; x < 32; x++) for (let y = 120; y < 220; y++) for (let z = Math.floor(hull.z) - 20; z < hull.z + 20; z++) {
      const v = map.get(x, y, z);
      if (v === P.HULL || v === P.HULL_RUST) plate++;
    }
    expect(plate).toBeGreaterThan(500);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/generation/props.test.ts`. Expected: FAIL, `props` doesn't exist.
- [ ] **Step 3: Implement `props.ts`, `columnTopAt`, the prop planning in `planWorld`, and the stamping in `fillBand`.**
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/generation/`. Expected: PASS, every generation test so far.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Re-detail the landscape at 10 cm: trees and a wood, wire, poles, fences, hull, farm, culvert, hamlet"`

---

### Task 10: Assembly, spawn, the far field, workers, and the golden world

**Files:**
- Create:
  - `src/world/generation/assemble.ts`, `src/world/generation/spawn.ts`, `src/world/generation/farfield.ts`, `src/world/generation/generate.ts`;
  - `src/app/workers/gen-worker.ts`, `src/app/generate-in-workers.ts`.
- Test: `tests/world/generation/world.test.ts`, which runs the full map once in a `beforeAll` with a 120 s timeout.

**Interfaces:**
- Consumes: everything above; `fingerprint`; `HeapMirror` is not needed here.
- Produces:
  - `assemble(plan: WorldPlan, bands: BandResult[]): BrickMap`. It writes each band's bricks into a full-size map: uniform entries through `setUniform`, dense ones through `writeBrick`.
  - `interface Spawn { position: [number, number, number]; bay: BayPlan }`. The position is in metres, the foot centre.
  - `pickSpawn(map: BrickMap, plan: WorldPlan): Spawn`. It ports `_pick_spawn` on the front line in metres:
    - a duckboard at `floorY` under the walk point;
    - air for `vx(2.0)` above it;
    - at least 50% of the bench timber;
    - the bays are searched outward from the middle, with the middle as the fallback.
  - `interface FarField { size: number; cell: number; originX: number; originZ: number; height: Float32Array; material: Uint8Array }`:
    - 2048 × 2048 cells of `vx(2.0)` voxels, centred on the map;
    - `height` is in voxels;
    - `material` codes are: 0 for inside the playable map (the tracer ignores it), 1 field, 2 ploughed, 3 wood, 4 roof, 5 wall, 6 spire.
  - `farFieldRows(plan: WorldPlan, row0: number, row1: number, out: FarField): void`.
    - The height is the terrain function, plus broad hills of 0–12 m that fade in from 0 at the map edge to full at 300 m out.
    - There are wood patches on a low-frequency mask, with canopy +6 m.
    - There are three villages of roof and wall blocks, one with a 25 m spire, placed by `rng.derive('farfield')`.
    - The shelterbelt bands continue as wood strips beyond the map's x edges.
  - `buildFarField(plan: WorldPlan): FarField`
  - `interface GeneratedWorld { plan: WorldPlan; map: BrickMap; spawn: Spawn; farField: FarField; timings: Record<string, number> }`
  - `generateWorld(plan: WorldPlan, runBands: (bands: number[]) => Promise<BandResult[]>, farField?: () => Promise<FarField>): Promise<GeneratedWorld>`. Phases: run the bands, then `assemble`, `applyEvents`, `takeDirty`, `pickSpawn` and the far field, recording `timings`.
  - `src/app/workers/gen-worker.ts` is a module worker:
    - `{ type: 'bands', plan, bands }` → `{ type: 'bands', results }`, posted with each result's buffers transferred;
    - `{ type: 'farfield', plan, row0, row1 }` → its rows.
  - `src/app/generate-in-workers.ts`: `generateInWorkers(seed: number, onProgress?: (phase: string, done: number, total: number) => void): Promise<GeneratedWorld>`. It uses `min(8, max(1, navigator.hardwareConcurrency − 1))` workers and hands bands out round-robin.

- [ ] **Step 1: Write the failing tests** in `tests/world/generation/world.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { loadTunables } from '../../../src/core/tunables';
import { fingerprint } from '../../../src/world/fingerprint';
import { P } from '../../../src/world/materials';
import { fillBand } from '../../../src/world/generation/fill';
import { generateWorld, type GeneratedWorld } from '../../../src/world/generation/generate';
import { checkInvariants } from '../../../src/world/generation/invariants';
import { genParams } from '../../../src/world/generation/params';
import { planWorld } from '../../../src/world/generation/plan';
import { buildFarField } from '../../../src/world/generation/farfield';
import { fieldHeight } from '../../../src/world/generation/terrain';

const p = genParams(loadTunables());
const plan = planWorld(p, 7);
let world: GeneratedWorld;
const inProcess = async (bands: number[]) => bands.map((b) => fillBand(plan, b));

beforeAll(async () => {
  world = await generateWorld(plan, inProcess);
  console.log('generation timings (ms):', JSON.stringify(world.timings));
}, 120_000);

describe('the generated world', () => {
  it('is settled, dry above the table, and spawns on intact duckboards', () => {
    const r = checkInvariants(world.map, p.waterTable, { ditchWater: true });
    expect(r.hangingGranular, r.samples.join('\n')).toBe(0);
    expect(r.looseSteep, r.samples.join('\n')).toBe(0);
    expect(r.waterAboveTable).toBe(0);
    const [x, y, z] = world.spawn.position.map((m) => Math.floor(m / 0.1));
    expect([P.DUCKBOARD, P.DUCKBOARD_WORN, P.AIR]).toContain(world.map.get(x, y - 1, z));
    for (let k = 0; k < 20; k++) expect(world.map.get(x, y + k, z)).toBe(P.AIR);
  });
  it('is the same world however the bands are split across workers', async () => {
    const reversed = await generateWorld(plan, async (bands) => [...bands].reverse().map((b) => fillBand(plan, b)).reverse());
    expect(await fingerprint(reversed.map)).toBe(await fingerprint(world.map));
  }, 120_000);
  it('matches the golden fingerprint for seed 7', async () => {
    expect(await fingerprint(world.map)).toBe('<recorded in Step 4>');
  });
  it('meets the far field at the map edge, from the same terrain function', () => {
    const ff = world.farField ?? buildFarField(plan);
    for (const z of [300, 1280, 2200]) {
      const col = Math.floor((0 - ff.originX) / ff.cell) - 1;
      const row = Math.floor((z - ff.originZ) / ff.cell);
      const cx = ff.originX + (col + 0.5) * ff.cell;
      const cz = ff.originZ + (row + 0.5) * ff.cell;
      expect(Math.abs(ff.height[row * ff.size + col] - fieldHeight(plan.terrain, p, cx, cz))).toBeLessThanOrEqual(1);
    }
    const inside = (Math.floor((1280 - ff.originZ) / ff.cell)) * ff.size + Math.floor((1280 - ff.originX) / ff.cell);
    expect(ff.material[inside]).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/generation/world.test.ts`. Expected: FAIL, the modules don't exist.
- [ ] **Step 3: Implement** the modules, the worker and the in-browser driver.
- [ ] **Step 4: Run it, then pin the golden.** Run `npx vitest run tests/world/generation/world.test.ts`. Expected: every assertion passes except the golden, which prints the actual fingerprint. Paste that value into the test as the golden and re-run. Expected: PASS, 4 tests. Note the printed timings in the commit message.
- [ ] **Step 5: Wire a dev preview.** `src/app/main.ts` calls `generateInWorkers(7, …)` and writes each phase's progress and the final timings to `#status`. Run `npm run build`; expected: success.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "Assemble the 10 cm world from parallel bands, pick the spawn, build the far field"`

---

### Milestone check

- [ ] Run `npm test && npm run typecheck && npm run build`. Expected: all green.
- [ ] Add `@playwright/test@^1.64.1` to devDependencies. Run `npm run dev`, and load `/` in headless Chrome (`channel: 'chrome'`, `--enable-unsafe-webgpu`) through a one-off `tools/preview-gen.mjs`. Expected: `#status` reports generation finished, and the per-phase timings show fill, assemble and events in under 4 s total on this machine.
