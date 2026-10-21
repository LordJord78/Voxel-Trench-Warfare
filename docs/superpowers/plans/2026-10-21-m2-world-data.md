# Milestone 2 — World Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 10 cm world's data layer:
- the material palette;
- the sparse brick map with edits, compaction, dirty tracking and sector occupancy;
- dense region scratch buffers;
- the compressed GPU brick encoding, with its CPU-side heap bookkeeping;
- the destruction primitives that generation and later combat share (irregular carve, collapse, flood);
- the world fingerprint.

**Architecture:**
- Everything lives in `src/world/`. It is pure TypeScript under the boundary and determinism rules: no DOM, no WebGPU, `dmath` instead of `Math` transcendentals.
- The brick map is the CPU truth.
- `HeapMirror` turns its dirty bricks into GPU-ready records and table entries, without touching WebGPU. The renderer (milestone 4) only copies what the mirror queues.
- Destruction works on dense `Region` copies of the map and writes back only the voxels that changed.

**Tech stack:** TypeScript 7, Vitest 5, Node 22 (`node:crypto` in tests only).

**Spec:** `docs/superpowers/specs/2026-10-21-trenchline-web-world-design.md` (§2: storage, palette, edits, destruction primitives, checks).

## Global Constraints

- `src/world/**` obeys `tests/architecture.test.ts`:
  - no imports from `src/render|ui|app`;
  - no `document`, `window`, `navigator`, `requestAnimationFrame` or `GPU*` identifiers (so no class or variable may be named `GPU…`);
  - no `Math.sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `exp`, `expm1`, `log`, `log1p`, `log2`, `log10`, `pow`, `cbrt`, `hypot`, `sinh`, `cosh`, `tanh` or `random`. Use `src/core/dmath.ts` and `src/core/rng.ts`.
- **Voxels** are 10 cm. A voxel holds one byte, a palette id (0 = air).
- **Bricks** are 8³ voxels. A brick table entry is one of:
  - `0`: empty;
  - `0x80000000 | paletteId`: uniform;
  - `slot + 1`: dense, a pool slot of 512 raw bytes.
- **Sectors** are 32³ voxels. World dims must be multiples of 32 in every axis.
- **GPU record** = 4 words of local palette + 16 words of occupancy mask + data words, at 0/1/2/4/8 bits per voxel. The format is chosen by the brick's count of distinct solid palette ids: 1 / 2 / ≤4 / ≤16 / more.
- **GPU table entry:**
  - `0`: empty;
  - `0x80000000 | paletteId`: uniform;
  - `(format << 28) | unitOffset`: a record, where a unit is 16 bytes, `format` is 0–4, and unit 0 is reserved so no record entry is ever `0`.
- Commits on branch `web/world`. Each message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **`BrickMap.set` with a palette id outside 0–255 or not an integer.** A `Uint8Array` would silently wrap 256 to air. It must throw `RangeError`. Pinned in Task 2.
- **`fillBox` with an inverted, empty or partly out-of-bounds box.** Generation passes these routinely. It must clamp to the world, treat an empty box as a no-op and never throw. Pinned in Task 3.
- **Pool churn.** Repeatedly filling and clearing the same bricks must reuse freed slots, not grow the pool. Pinned in Task 2.
- **`collapseRegion` on a box touching the world's edges or top.**
  - It must not read or write out of bounds.
  - It must conserve material: the count of each granular palette id is unchanged.
  - Pinned in Task 6.
- **A brick whose GPU format changes, for example from 1-bit to 8-bit.**
  - The old record is freed and reused by a later allocation of the same size class.
  - The table entry is updated.
  - No two live records overlap.
  - Pinned in Task 4.

---

### Task 1: Materials and palette

**Files:**
- Create: `src/world/materials.ts`
- Test: `tests/world/materials.test.ts`

**Interfaces:**
- Consumes: `pow` from `src/core/dmath.ts`.
- Produces, from `src/world/materials.ts`:
  - `K`: kind ids as `const`. These are Python's 18 plus three new ones:
    - `AIR 0`, `SOD 1`, `MUD 2`, `CLAY 3`, `SUBSOIL 4`, `SPOIL 5`, `SANDBAG 6`, `DUCKBOARD 7`, `TIMBER 8`, `CORRUGATE 9`;
    - `CONCRETE 10`, `BRICK 11`, `TRUNK 12`, `BRANCH 13`, `WATER 14`, `RUBBLE 15`, `WIRE 16`, `HULL 17`;
    - `MORTAR 18`, `PICKET 19`, `CLOTH 20`.
  - `KIND_COUNT = 21`.
  - `KIND_SOLID`, `KIND_OPAQUE`, `KIND_BLOCKS_SIGHT`, `KIND_GRANULAR`, `KIND_LOOSE`, each a `Uint8Array(21)` of 0/1.
  - `KIND_HARDNESS: Float32Array(21)`; `KIND_SPOIL: Uint8Array(21)`, mapping kind to kind.
  - `interface PaletteEntry { name: string; kind: number; srgb: readonly [number, number, number]; roughness: number; emission: number }`.
  - `PALETTE: readonly PaletteEntry[]` (index = palette id, `PALETTE[0]` is air).
  - `P`: palette ids by name, as `const`.
  - `PALETTE_KIND: Uint8Array(256)`.
  - `isSolid(p)`, `isOpaque(p)`, `blocksSight(p)`, `isGranular(p)`, `isLoose(p)`, all `(p: number) => boolean`.
  - `kindOf(p: number): number`, `hardness(p: number): number`.
  - `spoilOf(p: number): number`: the palette id of the base entry of `KIND_SPOIL[kindOf(p)]`.
  - `baseOf(kind: number): number`: the first palette entry of a kind.
  - `paletteData(): Float32Array`: 256 × 8 floats per entry, `[r, g, b (linear), roughness, emissionR, emissionG, emissionB, kind]`, with linear = `pow(srgb/255, 2.2)` and emission = linear albedo × `emission`.

**Kind rules.** These carry over Python's `world/voxel.py` exactly for kinds 0–17, plus:

| Kind | solid | opaque | blocks sight | granular | loose | hardness | spoils to |
|---|---|---|---|---|---|---|---|
| `MORTAR` | 1 | 1 | 1 | 0 | 0 | 2.6 | `RUBBLE` |
| `PICKET` | 1 | 1 | 1 | 0 | 0 | 3.0 | `RUBBLE` |
| `CLOTH` | 0 | 1 | 1 | 0 | 0 | 0.3 | `AIR` |

**Palette, in this order (name, kind, sRGB, roughness, emission):**
- `AIR` (AIR, 0,0,0, 1, 0)
- `SOD` (104,102,72), `SOD_DRY` (122,114,78), `SOD_TUFT` (92,96,62)
- `MUD` (112,90,68), `MUD_WET` (86,70,56), `MUD_DARK` (96,76,58), `MUD_TURNED` (100,80,60)
- `CLAY` (142,122,96), `CLAY_WET` (122,104,84)
- `SUBSOIL` (118,104,88)
- `SPOIL` (92,72,54), `SPOIL_DRY` (106,86,64)
- `SANDBAG` (152,144,114), `SANDBAG_SEAM` (124,116,92), `SANDBAG_WORN` (138,128,100), `SANDBAG_DARK` (110,104,82)
- `DUCKBOARD` (130,108,76), `DUCKBOARD_WORN` (112,94,68)
- `TIMBER` (106,86,64), `TIMBER_WEATHERED` (128,116,96), `TIMBER_DARK` (84,68,52)
- `CORRUGATE` (132,132,126), `CORRUGATE_RUST` (128,92,64)
- `CONCRETE` (160,158,150), `CONCRETE_STAINED` (134,132,124)
- `BRICK` (140,92,74), `BRICK_DARK` (118,74,60), `BRICK_BURNT` (82,60,52)
- `MORTAR` (170,164,150)
- `TRUNK` (68,56,46), `TRUNK_BARK` (84,70,56), `TRUNK_SPLINTER` (150,130,100)
- `BRANCH` (86,74,58)
- `WATER` (92,106,104)
- `RUBBLE` (118,112,98), `RUBBLE_BRICK` (130,90,72)
- `WIRE` (100,98,90), `WIRE_RUST` (110,80,60)
- `HULL` (54,50,48), `HULL_RUST` (90,62,46)
- `PICKET` (88,84,78), `PICKET_RUST` (112,78,56)
- `CLOTH` (120,112,90), `CLOTH_DARK` (80,74,60)
- `LANTERN_GLOW` (kind PICKET, 255,190,110, roughness 0.3, emission 6)
- `EMBER` (kind RUBBLE, 200,80,30, roughness 1, emission 2)

Every other entry has emission 0. Roughness is 0.95 for earth, cloth and timber, 0.6 for corrugate, hull, wire and picket, 0.3 for water, and 0.85 for everything else. The base entry of each kind is the first one listed for it.

- [ ] **Step 1: Write the failing tests** in `tests/world/materials.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as m from '../../src/world/materials';

describe('materials', () => {
  it('keeps the Python rules for the original kinds', () => {
    const solid = [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1];
    const granular = [0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0];
    const loose = [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0];
    const spoil = [0, 5, 5, 5, 5, 5, 5, 15, 15, 15, 15, 15, 13, 0, 14, 15, 0, 15];
    const hard = [0, 1, 1, 1.1, 1.2, 0.8, 1.4, 0.9, 1, 1.3, 4, 2.6, 1.6, 0.7, 0, 1.2, 0.5, 3.4];
    for (let k = 0; k < 18; k++) {
      expect(m.KIND_SOLID[k], `solid ${k}`).toBe(solid[k]);
      expect(m.KIND_GRANULAR[k], `granular ${k}`).toBe(granular[k]);
      expect(m.KIND_LOOSE[k], `loose ${k}`).toBe(loose[k]);
      expect(m.KIND_SPOIL[k], `spoil ${k}`).toBe(spoil[k]);
      expect(m.KIND_HARDNESS[k]).toBeCloseTo(hard[k], 6);
    }
    expect(m.KIND_SOLID[m.K.CLOTH]).toBe(0);
    expect(m.KIND_BLOCKS_SIGHT[m.K.CLOTH]).toBe(1);
    expect(m.KIND_SPOIL[m.K.MORTAR]).toBe(m.K.RUBBLE);
  });
  it('has a palette whose shades belong to their kinds', () => {
    expect(m.PALETTE[0].name).toBe('AIR');
    expect(m.PALETTE.length).toBeLessThanOrEqual(256);
    expect(m.kindOf(m.P.MUD_WET)).toBe(m.K.MUD);
    expect(m.kindOf(m.P.LANTERN_GLOW)).toBe(m.K.PICKET);
    expect(m.baseOf(m.K.SANDBAG)).toBe(m.P.SANDBAG);
    expect(m.spoilOf(m.P.SOD_TUFT)).toBe(m.P.SPOIL);
    expect(m.spoilOf(m.P.BRICK_BURNT)).toBe(m.P.RUBBLE);
    expect(m.isSolid(m.P.WATER)).toBe(false);
    expect(m.isLoose(m.P.SANDBAG_SEAM)).toBe(true);
    for (const name of Object.keys(m.P) as (keyof typeof m.P)[]) expect(m.PALETTE[m.P[name]].name).toBe(name);
  });
  it('packs linear colour, roughness and emission for the GPU', () => {
    const d = m.paletteData();
    expect(d.length).toBe(256 * 8);
    const mud = m.P.MUD * 8;
    expect(d[mud]).toBeCloseTo(Math.pow(112 / 255, 2.2), 6);
    expect(d[mud + 7]).toBe(m.K.MUD);
    const glow = m.P.LANTERN_GLOW * 8;
    expect(d[glow + 4]).toBeCloseTo(6 * Math.pow(255 / 255, 2.2), 5);
    expect(d[m.P.MUD * 8 + 4]).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/materials.test.ts`. Expected: FAIL, the module doesn't exist.
- [ ] **Step 3: Implement `src/world/materials.ts`.**
  - Declare the palette as one array of tuples in the order above.
  - Build `P` as an explicit `const` object with the same names and indices, and assert at module load (throw) that `P` and the array agree.
  - Fill `PALETTE_KIND` once.
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/materials.test.ts`. Expected: PASS, 3 tests.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Define the 10 cm palette: Python's material rules, authored shades, GPU colour data"`

---

### Task 2: `BrickMap` — sparse storage, edits, compaction, dirty bricks, sectors

**Files:**
- Create: `src/world/bricks.ts`
- Test: `tests/world/bricks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, from `src/world/bricks.ts`:
  - `BRICK = 8`, `SECTOR = 32`, `UNIFORM = 0x80000000`
  - `interface Dims { x: number; y: number; z: number }`
  - `class BrickMap`:
    - `constructor(dims: Dims)`; throws `RangeError` unless each axis is a positive multiple of 32.
    - `readonly dims`, `readonly bricks: Dims`, `readonly sectors: Dims`, `readonly table: Uint32Array`
    - `inBounds(x, y, z): boolean`
    - `get(x, y, z): number`: 0 out of bounds.
    - `set(x, y, z, p): void`: ignores out of bounds; throws `RangeError` for p not an integer in 0..255.
    - `brickIndex(bx, by, bz): number`, laid out as `(bz * bricks.y + by) * bricks.x + bx`
    - `readBrick(bi: number, out: Uint8Array): void`: 512 bytes, voxel `lx + ly*8 + lz*64`
    - `writeBrick(bi: number, raw: Uint8Array): void`
    - `setUniform(bi: number, p: number): void`: 0 empties the brick.
    - `denseView(bi: number): Uint8Array | null`: a live 512-byte view of a dense brick.
    - `compact(bi: number): void`
    - `takeDirty(): number[]`: compacts each dirty brick, returns them ascending, clears the set.
    - `readonly denseCount: number`, `readonly poolCapacity: number` (slots allocated so far)
    - `sectorCount(si: number): number`: non-empty bricks in that sector.
    - `sectorMask(): Uint32Array`: 1 per non-empty sector, laid out like the table.

**Storage.**
- The pool is chunked into `Uint8Array` chunks of 8192 bricks (4 MiB each), grown on demand.
- Freed slots go on a stack and are reused first.
- A dirty flag per brick (`Uint8Array`) plus a list.
- A sector count per sector (`Uint16Array`), updated on every table transition between empty and non-empty.

- [ ] **Step 1: Write the failing tests** in `tests/world/bricks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BrickMap, UNIFORM } from '../../src/world/bricks';

const D = { x: 64, y: 32, z: 64 };

describe('BrickMap', () => {
  it('refuses dims that are not whole sectors', () => {
    expect(() => new BrickMap({ x: 40, y: 32, z: 32 })).toThrow(RangeError);
  });
  it('round-trips voxels and reads outside as air', () => {
    const w = new BrickMap(D);
    w.set(3, 4, 5, 7);
    expect(w.get(3, 4, 5)).toBe(7);
    expect(w.get(3, 4, 6)).toBe(0);
    expect(w.get(-1, 0, 0)).toBe(0);
    w.set(99, 0, 0, 7);
    expect(w.denseCount).toBe(1);
  });
  it('rejects palette ids a byte cannot hold', () => {
    const w = new BrickMap(D);
    expect(() => w.set(0, 0, 0, 256)).toThrow(RangeError);
    expect(() => w.set(0, 0, 0, 1.5)).toThrow(RangeError);
  });
  it('splits a uniform brick on write and compacts it back', () => {
    const w = new BrickMap(D);
    const bi = w.brickIndex(1, 1, 1);
    w.setUniform(bi, 4);
    expect(w.table[bi]).toBe((UNIFORM | 4) >>> 0);
    w.set(9, 9, 9, 2);
    expect(w.denseCount).toBe(1);
    expect(w.get(10, 10, 10)).toBe(4);
    w.set(9, 9, 9, 4);
    expect(w.takeDirty()).toEqual([bi]);
    expect(w.table[bi]).toBe((UNIFORM | 4) >>> 0);
    expect(w.denseCount).toBe(0);
  });
  it('reuses freed slots instead of growing', () => {
    const w = new BrickMap(D);
    for (let round = 0; round < 50; round++) {
      for (let x = 0; x < 64; x += 8) w.set(x, 0, 0, 3);
      w.takeDirty();
      for (let x = 0; x < 64; x += 8) w.set(x, 0, 0, 0);
      w.takeDirty();
    }
    expect(w.denseCount).toBe(0);
    expect(w.poolCapacity).toBeLessThanOrEqual(8192);
  });
  it('counts non-empty bricks per sector', () => {
    const w = new BrickMap(D);
    w.set(33, 1, 1, 5);
    w.set(40, 1, 1, 5);
    expect(w.sectorCount(1)).toBe(2);
    expect(Array.from(w.sectorMask())).toEqual([0, 1, 0, 0]);
    w.set(33, 1, 1, 0);
    w.set(40, 1, 1, 0);
    w.takeDirty();
    expect(w.sectorCount(1)).toBe(0);
  });
  it('reads and writes whole bricks', () => {
    const w = new BrickMap(D);
    const raw = new Uint8Array(512);
    raw[0] = 9; raw[511] = 9;
    const bi = w.brickIndex(0, 0, 0);
    w.writeBrick(bi, raw);
    expect(w.get(0, 0, 0)).toBe(9);
    expect(w.get(7, 7, 7)).toBe(9);
    const out = new Uint8Array(512);
    w.readBrick(bi, out);
    expect(out).toEqual(raw);
    w.setUniform(bi, 0);
    expect(w.table[bi]).toBe(0);
    expect(w.denseCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/bricks.test.ts`. Expected: FAIL, the module doesn't exist.
- [ ] **Step 3: Implement `src/world/bricks.ts`** to the interface and storage notes above.
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/bricks.test.ts`. Expected: PASS, 7 tests.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Store the world as a sparse brick map with compaction, dirty bricks and sector counts"`

---

### Task 3: Boxes, `fillBox` and dense `Region` scratch copies

**Files:**
- Create: `src/world/region.ts`
- Modify: `src/world/bricks.ts` (add `fillBox`)
- Test: `tests/world/region.test.ts`

**Interfaces:**
- Consumes: `BrickMap`, `BRICK` from Task 2.
- Produces:
  - `BrickMap.fillBox(x0, y0, z0, x1, y1, z1, p): void`, with a half-open box.
    - It clamps to the world and does nothing when empty.
    - Bricks wholly inside become uniform or empty through `setUniform`, freeing their dense slots. Partial bricks are written per voxel.
  - From `src/world/region.ts`:
    - `interface Box { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }` (half-open)
    - `clampBox(box: Box, dims: Dims): Box | null`
    - `class Region`:
      - `static extract(map: BrickMap, box: Box): Region`: clamps first, and throws `RangeError` if empty.
      - `readonly box: Box`, `readonly sx: number`, `readonly sy: number`, `readonly sz: number`, `readonly data: Uint8Array`
      - `index(x, y, z): number`, in world coordinates, laid out `((z - z0) * sy + (y - y0)) * sx + (x - x0)`
      - `get(x, y, z): number`: 0 outside the region.
      - `set(x, y, z, p): void`
      - `commit(map: BrickMap): number`: writes back only the voxels that differ from the extracted copy and returns how many.

`extract` copies brick by brick: uniform bricks are filled and dense bricks copy their rows, so a 2 m³ region costs microseconds, not a call per voxel.

- [ ] **Step 1: Write the failing tests** in `tests/world/region.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BrickMap } from '../../src/world/bricks';
import { Region, clampBox } from '../../src/world/region';

const D = { x: 64, y: 64, z: 64 };

describe('fillBox', () => {
  it('fills whole bricks as uniform and partial ones per voxel', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 20, 16, 16, 4);
    expect(w.get(19, 15, 15)).toBe(4);
    expect(w.get(20, 0, 0)).toBe(0);
    w.takeDirty();
    expect(w.denseCount).toBe(4);
  });
  it('clamps, and ignores empty or inverted boxes', () => {
    const w = new BrickMap(D);
    w.fillBox(-10, -10, -10, 4, 4, 4, 2);
    expect(w.get(0, 0, 0)).toBe(2);
    expect(() => w.fillBox(10, 10, 10, 5, 5, 5, 2)).not.toThrow();
    expect(() => w.fillBox(100, 0, 0, 200, 8, 8, 2)).not.toThrow();
    expect(w.get(3, 3, 3)).toBe(2);
  });
});

describe('Region', () => {
  it('copies a box out and writes back only what changed', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 64, 10, 64, 3);
    const r = Region.extract(w, { x0: 5, y0: 5, z0: 5, x1: 30, y1: 20, z1: 30 });
    expect(r.get(5, 9, 5)).toBe(3);
    expect(r.get(5, 10, 5)).toBe(0);
    r.set(6, 9, 6, 0);
    r.set(6, 15, 6, 8);
    expect(r.commit(w)).toBe(2);
    expect(w.get(6, 9, 6)).toBe(0);
    expect(w.get(6, 15, 6)).toBe(8);
  });
  it('clamps boxes to the world', () => {
    expect(clampBox({ x0: -5, y0: 0, z0: 0, x1: 10, y1: 99, z1: 4 }, D)).toEqual({ x0: 0, y0: 0, z0: 0, x1: 10, y1: 64, z1: 4 });
    expect(clampBox({ x0: 70, y0: 0, z0: 0, x1: 80, y1: 1, z1: 1 }, D)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/region.test.ts`. Expected: FAIL, `region` doesn't exist and `fillBox` isn't a function.
- [ ] **Step 3: Implement `fillBox` and `src/world/region.ts`.**
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/region.test.ts tests/world/bricks.test.ts`. Expected: PASS, 11 tests.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Fill boxes brick-at-a-time and edit dense region copies"`

---

### Task 4: GPU brick records and `HeapMirror`

**Files:**
- Create: `src/world/encode.ts`
- Test: `tests/world/encode.test.ts`

**Interfaces:**
- Consumes: `BrickMap`, `UNIFORM` (Task 2).
- Produces, from `src/world/encode.ts`:
  - `FORMAT_BITS = [0, 1, 2, 4, 8] as const`; `RECORD_UNITS = [5, 9, 13, 21, 37] as const` (16-byte units per format)
  - `encodeBrick(raw: Uint8Array): Uint32Array`, with length `RECORD_UNITS[f] * 4`:
    - words 0–3 are the local palette, up to 16 palette ids in first-appearance order, 4 per word, low byte first;
    - words 4–19 are the occupancy mask, bit `i & 31` of word `4 + (i >> 5)` for voxel `i`;
    - then the data. Voxel `i`'s local index is at bit `i*b` (b = 1, 2 or 4). For 8 bits it is the global palette id, 4 per word, low byte first.
    - Air voxels store 0 in the data.
  - `formatOfLength(words: number): number`
  - `decodeBrick(record: Uint32Array, out: Uint8Array): void`
  - `tableEntry(format: number, unit: number): number`, which is `((format << 28) | unit) >>> 0`. It throws `RangeError` if `unit` is 0 or ≥ 2^28.
  - `class HeapMirror`:
    - `static fromMap(map: BrickMap): HeapMirror`. It encodes every dense brick into one contiguous heap image, in table order, starting at unit 1.
    - `readonly gpuTable: Uint32Array`
    - `heapImage(): Uint32Array`: everything allocated so far, from unit 0.
    - `readonly usedUnits: number`, `readonly capacityUnits: number`
    - `update(bricks: readonly number[]): void`. It re-encodes the listed bricks:
      - frees each old record onto its size class's free list;
      - takes a new record from that size class's free list first, otherwise bumps;
      - writes `gpuTable`;
      - queues the record and the table entry.
    - `takeWrites(): { unit: number; words: Uint32Array }[]`
    - `takeTableWrites(): number[]`, the brick indices whose `gpuTable` entry changed, ascending.

`capacityUnits` doubles whenever bumping would pass it. It starts at `usedUnits` rounded up to a power of two, and is at least 1024.

- [ ] **Step 1: Write the failing tests** in `tests/world/encode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { BrickMap, UNIFORM } from '../../src/world/bricks';
import { HeapMirror, RECORD_UNITS, decodeBrick, encodeBrick, formatOfLength, tableEntry } from '../../src/world/encode';

function brickWith(distinct: number, seed: number): Uint8Array {
  const r = Rng.root(seed);
  const raw = new Uint8Array(512);
  for (let i = 0; i < 512; i++) raw[i] = r.chance(0.3) ? 0 : 1 + r.randint(0, distinct);
  for (let k = 0; k < distinct; k++) raw[k] = 1 + k;
  return raw;
}

describe('encodeBrick', () => {
  it('picks the smallest format and round-trips', () => {
    for (const [distinct, format] of [[1, 0], [2, 1], [3, 2], [4, 2], [5, 3], [16, 3], [17, 4], [200, 4]] as const) {
      const raw = brickWith(distinct, distinct);
      const rec = encodeBrick(raw);
      expect(rec.length, `${distinct} distinct`).toBe(RECORD_UNITS[format] * 4);
      expect(formatOfLength(rec.length)).toBe(format);
      const out = new Uint8Array(512);
      decodeBrick(rec, out);
      expect(out).toEqual(raw);
    }
  });
  it('lays out the mask one bit per voxel', () => {
    const raw = new Uint8Array(512);
    raw[0] = 5; raw[33] = 5;
    const rec = encodeBrick(raw);
    expect(rec[4]).toBe(1);
    expect(rec[5]).toBe(2);
    expect(rec[0] & 0xff).toBe(5);
  });
  it('builds table entries that are never zero', () => {
    expect(tableEntry(3, 1)).toBe(((3 << 28) | 1) >>> 0);
    expect(() => tableEntry(0, 0)).toThrow(RangeError);
  });
});

describe('HeapMirror', () => {
  it('packs the initial heap and re-encodes changed bricks, reusing freed records', () => {
    const w = new BrickMap({ x: 32, y: 32, z: 32 });
    w.set(0, 0, 0, 3);
    w.set(8, 0, 0, 3);
    const c = w.brickIndex(2, 0, 0);
    w.setUniform(c, 6);
    w.takeDirty();
    const h = HeapMirror.fromMap(w);
    const a = w.brickIndex(0, 0, 0);
    const b = w.brickIndex(1, 0, 0);
    expect(h.gpuTable[c]).toBe((UNIFORM | 6) >>> 0);
    expect(h.gpuTable[a]).toBe(tableEntry(0, 1));
    expect(h.usedUnits).toBe(1 + 2 * RECORD_UNITS[0]);
    for (let i = 0; i < 20; i++) w.set(i % 8, 1 + (i >> 3), 1, 10 + i);
    h.update(w.takeDirty());
    expect(h.gpuTable[a] >>> 28).toBe(4);
    expect(h.takeTableWrites()).toEqual([a]);
    expect(h.takeWrites()).toHaveLength(1);
    w.set(16, 0, 0, 0);
    h.update(w.takeDirty());
    expect(h.gpuTable[c]).toBe(tableEntry(0, 1));
    const live = [a, b, c]
      .map((bi) => { const e = h.gpuTable[bi]; const u = e & 0x0fffffff; return [u, u + RECORD_UNITS[e >>> 28]]; })
      .sort((p, q) => p[0] - q[0]);
    for (let i = 1; i < live.length; i++) expect(live[i - 1][1]).toBeLessThanOrEqual(live[i][0]);
    const out = new Uint8Array(512);
    const ea = h.gpuTable[a];
    const ua = ea & 0x0fffffff;
    decodeBrick(h.heapImage().subarray(ua * 4, (ua + RECORD_UNITS[ea >>> 28]) * 4), out);
    expect(out[1 + 8 + 64]).toBe(11);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/encode.test.ts`. Expected: FAIL, the module doesn't exist.
- [ ] **Step 3: Implement `src/world/encode.ts`.**
  - `heapImage()` returns a copy of the mirror's own `Uint32Array` heap, which the mirror keeps in step with every write so tests and the renderer's initial upload can read it.
  - Keep a size-class free list per format.
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/encode.test.ts`. Expected: PASS, 4 tests.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Encode bricks for the GPU at 0-8 bits per voxel, with an occupancy mask and heap bookkeeping"`

---

### Task 5: `carveSphere` — the irregular crater cut

**Files:**
- Create: `src/world/destruction.ts`
- Test: `tests/world/carve.test.ts`

**Interfaces:**
- Consumes: `Region`, `Box`, `clampBox` (Task 3); `BrickMap` (Task 2); `Rng` (`src/core/rng.ts`); `Math.sqrt` only.
- Produces, from `src/world/destruction.ts`:
  - `interface CarveOptions { material?: number; roughness?: number; protect?: Uint8Array }`. Defaults: material 0, roughness 0.16. `protect` is indexed by palette id, and a 1 means "survives".
  - `carveSphere(map: BrickMap, cx: number, cy: number, cz: number, radius: number, rng: Rng, opts?: CarveOptions): Box | null`. It returns the clamped box it touched, or `null` when entirely outside.

**Algorithm.** This is a port of Python's `shapes.carve_sphere`, in voxel units:
- `rOut = radius*(1+roughness) + 1`.
- The box is `[floor(c - rOut), ceil(c + rOut) + 1)` per axis, clamped.
- The wobble field has `n = max(2, floor(extent/3))`, where `extent` is the box's largest side. It is an `n³` grid of `rng.normal()` drawn in order with z slowest and x fastest, trilinearly interpolated with smoothstep to each voxel's position `t = (i / max(1, extent - 1)) * (n - 1)`, then scaled by `roughness * radius`.
- A voxel is cut when `distance(centre, voxel centre) < radius + wobble` and it is not protected.

- [ ] **Step 1: Write the failing tests** in `tests/world/carve.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { BrickMap } from '../../src/world/bricks';
import { carveSphere } from '../../src/world/destruction';
import { P } from '../../src/world/materials';

function ground(): BrickMap {
  const w = new BrickMap({ x: 64, y: 64, z: 64 });
  w.fillBox(0, 0, 0, 64, 32, 64, P.MUD);
  return w;
}

describe('carveSphere', () => {
  it('cuts an irregular bowl and reports its box', () => {
    const w = ground();
    const box = carveSphere(w, 32, 30, 32, 10, Rng.root(7).derive('crater'))!;
    expect(w.get(32, 30, 32)).toBe(P.AIR);
    expect(w.get(32, 10, 32)).toBe(P.MUD);
    expect(box.x0).toBeGreaterThanOrEqual(32 - 14);
    expect(box.x1).toBeLessThanOrEqual(32 + 15);
  });
  it('is the same cut for the same stream', () => {
    const a = ground();
    const b = ground();
    carveSphere(a, 30, 31, 33, 9, Rng.root(1).derive('x'));
    carveSphere(b, 30, 31, 33, 9, Rng.root(1).derive('x'));
    for (let i = 0; i < 2000; i++) {
      const x = 20 + (i % 20), y = 22 + ((i / 20) % 10 | 0), z = 23 + ((i / 200) | 0);
      expect(a.get(x, y, z)).toBe(b.get(x, y, z));
    }
  });
  it('leaves protected materials standing', () => {
    const w = ground();
    w.fillBox(28, 25, 28, 36, 33, 36, P.CONCRETE);
    const protect = new Uint8Array(256);
    protect[P.CONCRETE] = 1;
    carveSphere(w, 32, 30, 32, 10, Rng.root(7), { protect, roughness: 0 });
    expect(w.get(32, 30, 32)).toBe(P.CONCRETE);
    expect(w.get(24, 30, 32)).toBe(P.AIR);
    expect(w.get(21, 30, 32)).toBe(P.MUD);
  });
  it('returns null when the sphere misses the world', () => {
    expect(carveSphere(ground(), -100, 10, 10, 5, Rng.root(7))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/carve.test.ts`. Expected: FAIL, the module doesn't exist.
- [ ] **Step 3: Implement `carveSphere`** in `src/world/destruction.ts`. It extracts a `Region`, cuts, and commits.
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/carve.test.ts`. Expected: PASS, 4 tests.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Carve irregular spheres, the cut shared by generation and shelling"`

---

### Task 6: `collapseRegion` and `floodRegion`

**Files:**
- Modify: `src/world/destruction.ts`
- Test: `tests/world/collapse.test.ts`

**Interfaces:**
- Consumes: `Region`, `clampBox`, `Box` (Task 3); `isGranular`, `isLoose`, `isSolid`, `P` (Task 1).
- Produces, from `src/world/destruction.ts`:
  - `collapseRegion(map: BrickMap, box: Box, opts?: { maxPasses?: number; repose?: boolean }): number` (defaults 64 and true). It returns the number of voxel moves.
  - `floodRegion(map: BrickMap, box: Box, waterTable: number): void`.

**Algorithm.** The rules are Python's (`destruction.py`), restated per column so a pass is linear in the region's size:
- **Work region.**
  - Widen the box sideways by `pad = repose ? clamp(box.y1 - box.y0, 4, 24) : 0`.
  - Extend it down to the support: per column, lower `y0` while the voxel below is air or water, and take the minimum over the columns.
  - Clamp it, then extract it.
  - The work region's sides and bottom act as walls.
- **Vertical pass.** Fixed solids are solid and not granular. In each column, split at fixed solids into segments. Within a segment, rewrite bottom-up: its granular voxels in their original order, then its water, then air. Dirt sinks through water and displaces it upward.
- **Repose pass** (only if `repose`).
  - Visit in fixed order: y ascending from `y0 + 1`, then z, then x, then directions `(+1,0) (−1,0) (0,+1) (0,−1)`.
  - A loose voxel resting on a solid voxel moves to `(x+dx, y−1, z+dz)` when both `(x+dx, y)` and `(x+dx, y−1)` are air and inside the region.
- **Passes.** Alternate the vertical pass and the repose pass until a pass moves nothing, or `maxPasses`. Then commit.
- **`floodRegion`.**
  - Extract the box, extended down by one voxel when possible.
  - Every air voxel at `y ≤ waterTable` becomes `P.WATER`.
  - Then, column by column bottom-up, water whose voxel below is neither solid nor water becomes air. A voxel below the world counts as solid.
  - Commit.

- [ ] **Step 1: Write the failing tests** in `tests/world/collapse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BrickMap } from '../../src/world/bricks';
import { collapseRegion, floodRegion } from '../../src/world/destruction';
import { P, isLoose } from '../../src/world/materials';

const D = { x: 64, y: 64, z: 64 };
const count = (w: BrickMap, p: number) => {
  let n = 0;
  for (let z = 0; z < 64; z++) for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (w.get(x, y, z) === p) n++;
  return n;
};

describe('collapseRegion', () => {
  it('drops hanging soil onto the ground below, and leaves timber standing', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 64, 10, 64, P.CLAY);
    w.fillBox(20, 20, 20, 24, 24, 24, P.MUD);
    w.fillBox(40, 20, 40, 44, 24, 44, P.TIMBER);
    collapseRegion(w, { x0: 16, y0: 16, z0: 16, x1: 48, y1: 30, z1: 48 }, { repose: false });
    expect(w.get(21, 10, 21)).toBe(P.MUD);
    expect(w.get(21, 13, 21)).toBe(P.MUD);
    expect(w.get(21, 14, 21)).toBe(P.AIR);
    expect(w.get(41, 22, 41)).toBe(P.TIMBER);
  });
  it('lets dirt displace standing water upward', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 64, 10, 64, P.CLAY);
    w.fillBox(30, 10, 30, 31, 12, 31, P.WATER);
    w.set(30, 15, 30, P.MUD);
    collapseRegion(w, { x0: 28, y0: 10, z0: 28, x1: 33, y1: 16, z1: 33 }, { repose: false });
    expect([w.get(30, 10, 30), w.get(30, 11, 30), w.get(30, 12, 30)]).toEqual([P.MUD, P.WATER, P.WATER]);
  });
  it('slumps loose spoil to its angle of repose and conserves it', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 64, 10, 64, P.CLAY);
    w.fillBox(31, 10, 31, 33, 22, 33, P.SPOIL);
    const before = count(w, P.SPOIL);
    collapseRegion(w, { x0: 28, y0: 10, z0: 28, x1: 36, y1: 22, z1: 36 });
    expect(count(w, P.SPOIL)).toBe(before);
    for (let z = 1; z < 63; z++) for (let y = 11; y < 40; y++) for (let x = 1; x < 63; x++) {
      if (!isLoose(w.get(x, y, z))) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const steep = w.get(x + dx, y, z + dz) === P.AIR && w.get(x + dx, y - 1, z + dz) === P.AIR;
        expect(steep, `loose voxel at ${x},${y},${z} past repose`).toBe(false);
      }
    }
  });
  it('stays inside the world at its edges and top', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 40, 0, 4, 64, 4, P.SPOIL);
    const before = count(w, P.SPOIL);
    expect(() => collapseRegion(w, { x0: -5, y0: 30, z0: -5, x1: 6, y1: 70, z1: 6 })).not.toThrow();
    expect(count(w, P.SPOIL)).toBe(before);
    expect(w.get(0, 0, 0)).toBe(P.SPOIL);
  });
});

describe('floodRegion', () => {
  it('fills open voxels at or below the table and drains water left hanging', () => {
    const w = new BrickMap(D);
    w.fillBox(0, 0, 0, 64, 10, 64, P.CLAY);
    w.fillBox(10, 5, 10, 14, 10, 14, P.AIR);
    w.set(40, 30, 40, P.WATER);
    floodRegion(w, { x0: 0, y0: 0, z0: 0, x1: 64, y1: 40, z1: 64 }, 7);
    expect(w.get(11, 5, 11)).toBe(P.WATER);
    expect(w.get(11, 7, 11)).toBe(P.WATER);
    expect(w.get(11, 8, 11)).toBe(P.AIR);
    expect(w.get(40, 30, 40)).toBe(P.AIR);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/collapse.test.ts`. Expected: FAIL, `collapseRegion` is not exported.
- [ ] **Step 3: Implement `collapseRegion` and `floodRegion`.**
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/collapse.test.ts`. Expected: PASS, 5 tests.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Collapse soil by columns with repose, and flood to the water table"`

---

### Task 7: World fingerprint

**Files:**
- Create: `src/world/fingerprint.ts`
- Test: `tests/world/fingerprint.test.ts`

**Interfaces:**
- Consumes: `BrickMap`, `UNIFORM` (Task 2).
- Produces, from `src/world/fingerprint.ts`:
  - `canonicalChunks(map: BrickMap, chunkBytes?: number): Generator<Uint8Array>`. Default chunk 1 MiB.
    - The canonical stream, brick by brick in table order:
      - `0` for an empty brick;
      - `1, p` for a uniform one;
      - `2` followed by the 512 raw bytes for a dense one.
    - A dense brick whose voxels are all equal is emitted as uniform or empty, so compaction state never changes the stream.
    - Chunks are cut at exactly `chunkBytes`; the last one may be shorter.
  - `fingerprint(map: BrickMap): Promise<string>`. It is lowercase hex SHA-256 over the concatenation of each chunk's SHA-256 digest, computed with `globalThis.crypto.subtle`, which works the same in Node 22 and browsers.

- [ ] **Step 1: Write the failing tests** in `tests/world/fingerprint.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BrickMap } from '../../src/world/bricks';
import { canonicalChunks, fingerprint } from '../../src/world/fingerprint';

function sample(): BrickMap {
  const w = new BrickMap({ x: 64, y: 32, z: 64 });
  w.fillBox(0, 0, 0, 64, 9, 64, 4);
  w.set(5, 9, 5, 7);
  return w;
}

describe('fingerprint', () => {
  it('is SHA-256 over per-chunk SHA-256 digests of the canonical stream', async () => {
    const w = sample();
    const outer = createHash('sha256');
    for (const chunk of canonicalChunks(w)) outer.update(createHash('sha256').update(chunk).digest());
    expect(await fingerprint(w)).toBe(outer.digest('hex'));
  });
  it('changes with one voxel and ignores compaction state', async () => {
    const a = sample();
    const b = sample();
    expect(await fingerprint(a)).toBe(await fingerprint(b));
    b.set(5, 9, 6, 7);
    expect(await fingerprint(b)).not.toBe(await fingerprint(a));
    const c = sample();
    c.set(1, 1, 1, 9);
    c.set(1, 1, 1, 4);
    expect(await fingerprint(c)).toBe(await fingerprint(a));
  });
  it('cuts chunks at the requested size', () => {
    const sizes = [...canonicalChunks(sample(), 100)].map((c) => c.length);
    expect(sizes.slice(0, -1).every((n) => n === 100)).toBe(true);
    // 64 uniform bricks (2 bytes), 64 dense (1 + 512), 128 empty (1)
    expect(sizes.reduce((s, n) => s + n, 0)).toBe(64 * 2 + 64 * 513 + 128);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/world/fingerprint.test.ts`. Expected: FAIL, the module doesn't exist.
- [ ] **Step 3: Implement `src/world/fingerprint.ts`.**
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/world/fingerprint.test.ts`. Expected: PASS, 3 tests.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Fingerprint the world by its canonical brick content"`

---

### Milestone check

- [ ] Run `npm test && npm run typecheck && npm run build`. Expected: all green, including `tests/architecture.test.ts` now scanning `src/world`.
