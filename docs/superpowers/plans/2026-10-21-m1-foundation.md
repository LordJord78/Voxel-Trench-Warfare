# Milestone 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the repo into a TypeScript/WebGPU project. Keep the Python game running from `reference/python/`. Ship the `core` layer that everything else builds on: deterministic maths, hashing, seeded random streams, the fixed-step clock and tunables. Two tests enforce the boundary and determinism rules.

**Architecture:**
- `src/core/` is pure TypeScript with no DOM and no engine-dependent maths.
- `data/tunables.toml` is compiled to a JSON module by a small Vite plugin, which Vitest also uses.
- The architecture test scans `src/{core,world,physics,sim}` for forbidden imports, globals and `Math` calls.

**Tech stack:**
- Node 22, npm.
- TypeScript 7, Vite 8, Vitest 5.
- smol-toml 1.9 (build and test only).
- @webgpu/types, @types/node 22.

**Spec:** `docs/superpowers/specs/2026-10-21-trenchline-web-world-design.md` (§1 Project shape, and the Build order's milestone 1).

## Global Constraints

- Strict TypeScript (`"strict": true`). ES modules only. No runtime dependencies in `package.json` `dependencies`; everything is a `devDependency`.
- `src/core`, `src/world`, `src/physics` and `src/sim`:
  - import nothing from `src/render`, `src/ui` or `src/app`, and reference no `document`, `window`, `navigator` or `GPU*` globals;
  - never call `Math.sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `exp`, `expm1`, `log`, `log1p`, `log2`, `log10`, `pow`, `cbrt`, `hypot`, `sinh`, `cosh`, `tanh` or `random`. They use `src/core/dmath.ts`, built only from `+ − × ÷`, `Math.sqrt`, `Math.floor`, `Math.round`, `Math.abs`, `Math.min`, `Math.max`, `Math.trunc` and `Math.sign`, plus `Float64Array`/`Uint32Array` bit views.
- Feel and structure numbers live only in `data/tunables.toml`.
- The Python reference keeps passing: `283 passed` from `reference/python/`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commits go on branch `web/world`.

## Review Focus

- `dmath` on non-finite and signed-zero inputs (`NaN`, `±Infinity`, `-0`). Expect `NaN` for `NaN` input; `exp(-Infinity) = 0`; `log(0) = -Infinity`; `log(-1) = NaN`; `sin(-0)` is `-0`. Pinned in Task 2.
- RNG labels that are empty or non-ASCII (`""`, `"é"`). They must hash as UTF-8 bytes, exactly as the Python reference does. Pinned in Task 3.
- `randint(lo, hi)` with `hi <= lo` must throw `RangeError`, not loop forever or return `lo`. Pinned in Task 3.
- `FixedClock.advance` with a negative, `NaN` or huge `realDt` (browser tabs report odd deltas). It must run 0 ticks for negative or `NaN` input, never leave the accumulator negative, and cap a stall at `maxSubsteps`. Pinned in Task 4.
- `Tunables.i()` on a non-integer value (for example `2.5`). It must throw `TypeError` naming the key, not silently truncate. Pinned in Task 5.

---

### Task 1: Move the Python game to `reference/python/`

**Files:**
- Move: `trenchline/` → `reference/python/trenchline/`; `tests/` → `reference/python/tests/`; `tools/` → `reference/python/tools/`; `pyproject.toml` → `reference/python/pyproject.toml`; `README.md` → `reference/python/README.md`
- Create: `README.md` (new root README)

**Interfaces:**
- Consumes: nothing.
- Produces: an empty repo root for the TypeScript project. Python commands now run from `reference/python/` with `../../.venv/bin/python`.

- [ ] **Step 1: Record the baseline.** Run `.venv/bin/python -m pytest 2>&1 | tail -1` at the repo root. Expected: `283 passed`.
- [ ] **Step 2: Move with history.** `mkdir -p reference/python && git mv trenchline tests tools pyproject.toml README.md reference/python/`
- [ ] **Step 3: Verify the reference still passes.** Run `cd reference/python && ../../.venv/bin/python -m pytest 2>&1 | tail -1`. Expected: `283 passed`. Every path in the Python code is relative to its own package, tests or tools folder, so nothing needs editing. If anything fails, fix the path, not the test.
- [ ] **Step 4: Write the root `README.md`.** Four short sections:
  - what TRENCHLINE is, with a one-paragraph pitch;
  - "Web rebuild (in progress)", linking the spec;
  - "Python reference", saying it lives in `reference/python/` and giving the run and test commands from there (`../../.venv/bin/python -m trenchline`, `../../.venv/bin/python -m pytest`);
  - "Development", listing `npm install`, `npm run dev`, `npm test`.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Move the Python game to reference/python, keeping it runnable"` (plus the Co-Authored-By line).

---

### Task 2: Project scaffold and `core/dmath`

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `src/app/main.ts`, `src/vite-env.d.ts`
- Create: `src/core/dmath.ts`
- Test: `tests/core/dmath.test.ts`
- Modify: `.gitignore` (add `node_modules/`, `artifacts/`, `test-results/`, `playwright-report/`)

**Interfaces:**
- Consumes: nothing.
- Produces, from `src/core/dmath.ts`:
  - `sin(x: number): number`, `cos(x: number): number`, `tan(x: number): number`
  - `atan(x: number): number`, `atan2(y: number, x: number): number`
  - `exp(x: number): number`, `log(x: number): number`, `pow(x: number, y: number): number`
  - `hypot(x: number, y: number, z?: number): number`
  - `PI`, `TAU`, `HALF_PI`
  - `radians(deg: number): number`, `degrees(rad: number): number`
  - `copysign(mag: number, sign: number): number`
  - npm scripts: `dev`, `build`, `preview`, `test`, `typecheck`.

- [ ] **Step 1: Scaffold.**
  - `package.json`: `"name": "trenchline"`, `"private": true`, `"type": "module"`.
  - scripts:
    - `"dev": "vite"`, `"build": "vite build"`, `"preview": "vite preview"`;
    - `"test": "vitest run"`;
    - `"typecheck": "tsc --noEmit"`.
  - devDependencies: `typescript@^7.0.2`, `vite@^8.3.5`, `vitest@^5.0.5`, `smol-toml@^1.9.1`, `@webgpu/types@^0.1.74`, `@types/node@^22`.
  - `tsconfig.json`:
    - `strict`, `target`/`lib` `ES2022` + `DOM` + `WebWorker`;
    - `module` `ESNext`, `moduleResolution` `bundler`;
    - `types: ["@webgpu/types", "vite/client", "node"]`;
    - `noEmit`, `isolatedModules`;
    - include `src`, `tests`, `tools`, and the two config files.
  - `vitest.config.ts`: environment `node`, include `tests/**/*.test.ts`, exclude `tests/e2e/**`.
  - `index.html`: a full-window `<canvas id="view">` and a `<div id="status">` that says "TRENCHLINE — building", loading `/src/app/main.ts`.
  - `src/app/main.ts` writes `WebGPU available: yes/no` into `#status`.
  - Then run `npm install`.
- [ ] **Step 2: Write the failing tests** in `tests/core/dmath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as d from '../../src/core/dmath';

const ulpClose = (a: number, b: number, ulps = 2) =>
  Math.abs(a - b) <= ulps * Number.EPSILON * Math.max(1, Math.abs(b));

describe('dmath', () => {
  it('sin and cos track Math within 2 ulp over [-1e4, 1e4]', () => {
    for (let i = 0; i <= 20000; i++) {
      const x = -1e4 + i * 1.000123;
      expect(ulpClose(d.sin(x), Math.sin(x))).toBe(true);
      expect(ulpClose(d.cos(x), Math.cos(x))).toBe(true);
    }
  });
  it('exp, log and pow track Math within 4 ulp', () => {
    for (let i = 0; i <= 5000; i++) {
      const x = -700 + i * 0.2801;
      expect(ulpClose(d.exp(x), Math.exp(x), 4)).toBe(true);
      const y = 1e-300 * Math.pow(1.15, i);
      expect(ulpClose(d.log(y), Math.log(y), 4)).toBe(true);
    }
    expect(ulpClose(d.pow(2.5, 3.25), Math.pow(2.5, 3.25), 64)).toBe(true);
    expect(d.pow(0.3, 1 / 0.7)).toBeCloseTo(Math.pow(0.3, 1 / 0.7), 13);
  });
  it('atan and atan2 cover all quadrants', () => {
    for (const [y, x] of [[1, 1], [1, -1], [-1, -1], [-1, 1], [0, -1], [3, 0], [-3, 0]]) {
      expect(ulpClose(d.atan2(y, x), Math.atan2(y, x))).toBe(true);
    }
    expect(ulpClose(d.atan(0.5), Math.atan(0.5))).toBe(true);
  });
  it('handles non-finite and signed-zero inputs', () => {
    expect(d.sin(NaN)).toBeNaN();
    expect(Object.is(d.sin(-0), -0)).toBe(true);
    expect(d.exp(-Infinity)).toBe(0);
    expect(d.exp(Infinity)).toBe(Infinity);
    expect(d.log(0)).toBe(-Infinity);
    expect(d.log(-1)).toBeNaN();
    expect(d.log(Infinity)).toBe(Infinity);
    expect(d.pow(-8, 1 / 3)).toBeNaN();
    expect(d.pow(5, 0)).toBe(1);
  });
  it('hypot is sqrt of the sum of squares, with 2 or 3 arguments', () => {
    expect(d.hypot(3, 4)).toBe(5);
    expect(d.hypot(2, 3, 6)).toBe(7);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails.** Run `npx vitest run tests/core/dmath.test.ts`. Expected: FAIL, cannot resolve `../../src/core/dmath`.
- [ ] **Step 4: Implement `src/core/dmath.ts`.** Use fdlibm's algorithms with fdlibm's own published coefficients:
  - `sin`/`cos`: Cody–Waite reduction by π/2 with the three-part `pio2_1/pio2_1t/pio2_2/pio2_2t`, then `__kernel_sin`/`__kernel_cos`. This is valid for |x| < 2^20·π/2; beyond that, reduce in a loop, which is fine because the game never passes such angles.
  - `exp`: `e_exp` (ln2 hi/lo split, P1–P5), scaling by 2^k built through a `Float64Array`/`Uint32Array` view.
  - `log`: `e_log` (Lg1–Lg7, exponent extracted through the bit view).
  - `atan`: `s_atan` (atanhi/atanlo, aT[0..10]); `atan2` from `atan` with fdlibm's quadrant rules.
  - `pow(x, y)`:
    - `exp(y * log(x))` for x > 0;
    - 1 for y = 0;
    - 0 for x = 0 and y > 0, `Infinity` for x = 0 and y < 0;
    - for x < 0, an integer y gives the signed result and a non-integer y gives `NaN`.
  - `hypot`: `Math.sqrt` of the sum of squares.
  - `tan`: `sin(x)/cos(x)`.
- [ ] **Step 5: Run it to confirm it passes.** Run `npx vitest run tests/core/dmath.test.ts`. Expected: PASS, 5 tests.
- [ ] **Step 6: Check types and build.** Run `npm run typecheck && npm run build`. Expected: no errors, and `dist/index.html` exists.
- [ ] **Step 7: Commit.** `git add -A && git commit -m "Scaffold the TypeScript project, with deterministic maths for the simulation"`

---

### Task 3: `core/hash` and `core/rng` — named, reproducible streams

**Files:**
- Create: `src/core/hash.ts`, `src/core/rng.ts`
- Test: `tests/core/rng.test.ts`

**Interfaces:**
- Consumes: `log`, `sqrt` (via `Math.sqrt`) and `pow` from `src/core/dmath.ts`.
- Produces, from `src/core/hash.ts`:
  - `fnv1a64(text: string): bigint`, hashing the UTF-8 bytes;
  - `splitmix64(x: bigint): bigint`, a 64-bit finaliser with the increment folded in;
  - `hash32(...ints: number[]): number`, a fast integer hash for noise lattices, returning a uint32.
- Produces, from `src/core/rng.ts`, `class Rng`:
  - `static root(seed: number): Rng`
  - `derive(label: string): Rng`
  - `readonly label: string`, `readonly key: bigint`
  - `nextU32(): number`
  - `float(): number`, in [0, 1) with 53 bits
  - `uniform(lo = 0, hi = 1): number`
  - `randint(lo: number, hi: number): number`, inclusive `lo`, exclusive `hi`
  - `chance(p: number): boolean`
  - `choice<T>(xs: readonly T[]): T`
  - `shuffled<T>(xs: readonly T[]): T[]`
  - `jitter(m: number): number`
  - `normal(mean = 0, sigma = 1): number`
  - `gamma(shape: number, scale = 1): number`
  - `beta(a: number, b: number): number`
  - `stateString(): string`

**Algorithm, as the independent Python reference computed the goldens below:**
- `fnv1a64`: offset `0xcbf29ce484222325`, prime `0x100000001b3`, mod 2⁶⁴.
- `splitmix64(x)`:
  - `z = x + 0x9e3779b97f4a7c15`;
  - `z = (z ^ z>>30) * 0xbf58476d1ce4e5b9`;
  - `z = (z ^ z>>27) * 0x94d049bb133111eb`;
  - return `z ^ z>>31`;
  - all mod 2⁶⁴.
- Keys:
  - `root(seed)` has key `splitmix64(BigInt(seed))`;
  - `derive(label)` has key `splitmix64(parent.key ^ fnv1a64(label))`, and its label is `${parent.label}.${label}`;
  - the root's label is `"root"`.
- State from a key: `a = splitmix64(key)`, `b = splitmix64(a)`, then `s = [hi32(a), lo32(a), hi32(b), lo32(b)]`. If all four are zero, set `s[0] = 1`.
- `nextU32`: xoshiro128\*\*. Result is `rotl(s1*5, 7)*9`, then the standard update, using `Math.imul` and `>>> 0`.
- `float()`: `((nextU32() >>> 5) * 67108864 + (nextU32() >>> 6)) / 9007199254740992`.
- `randint`:
  - `n = hi - lo`;
  - throw `RangeError` if `n < 1` or `n > 2**32`;
  - `limit = Math.floor(2**32 / n) * n`;
  - redraw while `u >= limit`;
  - return `lo + u % n`.
- `normal`: Marsaglia polar method, discarding the second value.
- `gamma`: Marsaglia–Tsang, with the `shape < 1` boost `gamma(shape+1) * pow(float(), 1/shape)`.
- `beta`: `x/(x+y)` from two gammas.
- `stateString()`: `JSON.stringify({ label, s: [s0, s1, s2, s3] })`.

- [ ] **Step 1: Write the failing tests** in `tests/core/rng.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fnv1a64 } from '../../src/core/hash';
import { Rng } from '../../src/core/rng';

describe('hash', () => {
  it('fnv1a64 hashes UTF-8 bytes like the Python reference', () => {
    expect(fnv1a64('')).toBe(0xcbf29ce484222325n);
    expect(fnv1a64('field.relief')).toBe(0x0793195090d9f6een);
    expect(fnv1a64('é')).toBe(0x0ac21707b7181e01n);
  });
});

describe('Rng', () => {
  it('reproduces the reference sequence for seed 7', () => {
    const r = Rng.root(7);
    expect(r.key).toBe(0x63cbe1e459320dd7n);
    expect([1, 2, 3, 4, 5].map(() => r.nextU32())).toEqual([429986460, 2845665001, 65897732, 2744170619, 2858337122]);
    const one = Rng.root(1);
    expect([one.nextU32(), one.nextU32(), one.nextU32()]).toEqual([185148466, 3601325357, 3163576498]);
  });
  it('derives children by label, independent of draws', () => {
    const fresh = Rng.root(7).derive('field.relief');
    const parent = Rng.root(7);
    parent.nextU32(); parent.float();
    const late = parent.derive('field.relief');
    expect(fresh.key).toBe(0xb5274747e1926506n);
    expect(fresh.label).toBe('root.field.relief');
    expect([fresh.nextU32(), fresh.nextU32(), fresh.nextU32()]).toEqual([3428254541, 1183113148, 1614887826]);
    expect(late.nextU32()).toBe(3428254541);
    const ab = Rng.root(7).derive('a').derive('b');
    expect([ab.nextU32(), ab.nextU32()]).toEqual([1994525300, 1615552073]);
    expect(ab.label).toBe('root.a.b');
  });
  it('float and randint match the reference', () => {
    const r = Rng.root(7);
    expect([r.float(), r.float(), r.float()]).toEqual([0.10011402266143266, 0.01534301518594472, 0.6655084767333013]);
    const q = Rng.root(7);
    expect(Array.from({ length: 10 }, () => q.randint(0, 10))).toEqual([0, 1, 2, 9, 2, 5, 0, 3, 7, 4]);
  });
  it('rejects empty integer ranges', () => {
    expect(() => Rng.root(7).randint(5, 5)).toThrow(RangeError);
    expect(() => Rng.root(7).randint(5, 4)).toThrow(RangeError);
  });
  it('has sane distributions', () => {
    const r = Rng.root(99);
    const n = 100_000;
    let sum = 0, sq = 0, g = 0, b = 0;
    for (let i = 0; i < n; i++) {
      const x = r.normal(); sum += x; sq += x * x;
      g += r.gamma(2.4, 1.15);
      b += r.beta(0.7, 0.7);
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.02);
    expect(Math.abs(sq / n - 1)).toBeLessThan(0.03);
    expect(Math.abs(g / n - 2.76)).toBeLessThan(0.05);
    expect(Math.abs(b / n - 0.5)).toBeLessThan(0.01);
  });
  it('stateString moves with every draw', () => {
    const r = Rng.root(7);
    const before = r.stateString();
    r.nextU32();
    expect(r.stateString()).not.toBe(before);
    expect(JSON.parse(before).label).toBe('root');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/core/rng.test.ts`. Expected: FAIL, the modules don't exist.
- [ ] **Step 3: Implement `src/core/hash.ts` and `src/core/rng.ts`** with the interfaces and algorithm above. `hash32` is the probe's `hash3` generalised: fold each int with `Math.imul` by `0x45d9f3b` and xor-shift by 16, then finish.
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/core/rng.test.ts`. Expected: PASS, 7 tests.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Add named random streams derived by label, matching an independent reference"`

---

### Task 4: `core/clock` — fixed 60 Hz tick

**Files:**
- Create: `src/core/clock.ts`
- Test: `tests/core/clock.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, from `src/core/clock.ts`:
  - `TICK_HZ = 60`, `TICK_DT = 1/60`;
  - `class FixedClock`:
    - `constructor(tickHz = 60, maxSubsteps = 5)`
    - `advance(realDt: number): number`
    - `readonly tick: number`, `readonly alpha: number`, `readonly dt: number`, `readonly simTime: number`, `readonly droppedTicks: number`
  - `class FrameStats`:
    - `constructor(window = 240)`
    - `record(seconds: number): void`
    - `summary(): { mean: number; p50: number; p95: number; max: number; fps: number }`

`advance` follows Python's `FixedClock.advance`:
- clamp `realDt` to at most 0.25 s;
- treat negative or `NaN` input as 0.

- [ ] **Step 1: Write the failing tests** in `tests/core/clock.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FixedClock, FrameStats } from '../../src/core/clock';

describe('FixedClock', () => {
  it('turns wall time into whole ticks with an interpolation fraction', () => {
    const c = new FixedClock();
    expect(c.advance(1 / 60)).toBe(1);
    expect(c.advance(0.5 / 60)).toBe(0);
    expect(c.alpha).toBeCloseTo(0.5, 9);
    expect(c.advance(0.5 / 60)).toBe(1);
    expect(c.tick).toBe(2);
    expect(c.simTime).toBeCloseTo(2 / 60, 12);
  });
  it('caps catch-up at maxSubsteps and counts the dropped ticks', () => {
    const c = new FixedClock(60, 5);
    expect(c.advance(0.2)).toBe(5);
    expect(c.droppedTicks).toBe(7);
  });
  it('clamps stalls to 0.25 s', () => {
    const c = new FixedClock(60, 100);
    expect(c.advance(10)).toBe(15);
  });
  it('runs nothing for negative or NaN deltas', () => {
    const c = new FixedClock();
    expect(c.advance(-1)).toBe(0);
    expect(c.advance(NaN)).toBe(0);
    expect(c.alpha).toBe(0);
    expect(c.advance(1 / 60)).toBe(1);
  });
});

describe('FrameStats', () => {
  it('summarises a rolling window in milliseconds', () => {
    const s = new FrameStats(4);
    for (const t of [0.010, 0.020, 0.030, 0.040, 0.050]) s.record(t);
    const r = s.summary();
    expect(r.mean).toBeCloseTo(35, 9);
    expect(r.max).toBeCloseTo(50, 9);
    expect(r.p50).toBeCloseTo(40, 9);
    expect(new FrameStats().summary().fps).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/core/clock.test.ts`. Expected: FAIL, the module doesn't exist.
- [ ] **Step 3: Implement `src/core/clock.ts`** as a port of Python's `core/loop.py`, with the negative and `NaN` rule added.
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/core/clock.test.ts`. Expected: PASS, 5 tests.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Port the fixed-step clock and frame statistics"`

---

### Task 5: Tunables — `data/tunables.toml`, the TOML plugin and `core/tunables`

**Files:**
- Create: `data/tunables.toml` (a copy of `reference/python/trenchline/data/tunables.toml`, edited as below)
- Create: `tools/vite-plugin-toml.ts`
- Create: `src/core/tunables.ts`
- Modify: `vite.config.ts` and `vitest.config.ts` (register the plugin), `src/vite-env.d.ts` (declare `*.toml` modules as `Record<string, unknown>`)
- Test: `tests/core/tunables.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `tomlPlugin(): Plugin` from `tools/vite-plugin-toml.ts`. It transforms `*.toml` imports to `export default <json>` and throws an `Error` whose message contains the file name and the parser's line on bad TOML.
  - From `src/core/tunables.ts`, `class Tunables`:
    - `constructor(raw: Record<string, unknown>)`
    - `get(key: string): unknown`
    - `f(key: string): number`
    - `i(key: string): number`
    - `section(key: string): Record<string, unknown>`
    - `sections(key: string): string[]`
    - `has(key: string): boolean`
  - `loadTunables(): Tunables` wraps `import raw from '../../data/tunables.toml'`.

**Behaviour:**
- `get` on a missing key throws `Error("tunable 'a.b.c' not found (missing 'c')")`, Python's wording.
- `f` requires a finite number.
- `i` requires an integer and throws `TypeError` naming the key otherwise.

**`data/tunables.toml` edits, everything else verbatim:**
- In `[world]`, set `voxel_size = 0.10`, `size_x_m = 256.0`, `size_z_m = 256.0`.
- Delete the mesh-only keys (`chunk_voxels`, `rebuild_budget_ms`, `rebuild_min_per_frame`, `rebuild_near_m`, `lod_full_m`, `lod_half_m`, `lod_hysteresis_m`) with their comment blocks.
- Replace that block with one comment saying the ray tracer has no meshes or chunks, so the rebuild and level-of-detail settings went with them.

- [ ] **Step 1: Write the failing tests** in `tests/core/tunables.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Tunables, loadTunables } from '../../src/core/tunables';
import { tomlPlugin } from '../../tools/vite-plugin-toml';

describe('Tunables', () => {
  const t = new Tunables({ a: { b: { c: 2.5, n: 7 } }, s: { x: 1, y: 2 } });
  it('reads dotted keys', () => {
    expect(t.f('a.b.c')).toBe(2.5);
    expect(t.i('a.b.n')).toBe(7);
    expect(t.sections('s')).toEqual(['x', 'y']);
    expect(t.has('a.b.z')).toBe(false);
  });
  it('names the missing part', () => {
    expect(() => t.get('a.b.z')).toThrow("tunable 'a.b.z' not found (missing 'z')");
  });
  it('refuses to truncate a float into an int', () => {
    expect(() => t.i('a.b.c')).toThrow(TypeError);
    expect(() => t.i('a.b.c')).toThrow(/a\.b\.c/);
  });
  it('loads the real file at 10 cm and 256 m', () => {
    const real = loadTunables();
    expect(real.f('world.voxel_size')).toBe(0.1);
    expect(real.f('world.size_x_m')).toBe(256);
    expect(real.f('player.eye_height_standing')).toBe(1.62);
    expect(real.has('world.rebuild_budget_ms')).toBe(false);
  });
});

describe('tomlPlugin', () => {
  it('reports the file and line of bad TOML', () => {
    const plugin = tomlPlugin() as { transform: (code: string, id: string) => unknown };
    expect(() => plugin.transform('a = [', '/x/tunables.toml')).toThrow(/tunables\.toml/);
    expect(plugin.transform('a = 1', '/x/other.ts')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/core/tunables.test.ts`. Expected: FAIL, the modules don't exist.
- [ ] **Step 3: Implement.** Copy and edit the TOML file. Write the plugin with `smol-toml`'s `parse`. Write `Tunables` and `loadTunables`. Register the plugin in both config files.
- [ ] **Step 4: Run it to confirm it passes.** Run `npx vitest run tests/core/tunables.test.ts`. Expected: PASS, 5 tests. Also run `npm run build`; expected: it succeeds.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Load tunables from TOML at build time, at 10 cm voxels and a 256 m map"`

---

### Task 6: Architecture and determinism rules

**Files:**
- Create: `tests/support/arch.ts`
- Test: `tests/architecture.test.ts`

**Interfaces:**
- Consumes: the `src/` tree.
- Produces, from `tests/support/arch.ts`:
  - `type Violation = { file: string; line: number; rule: 'import' | 'global' | 'math'; text: string }`
  - `checkSource(file: string, source: string): Violation[]`
  - `checkTree(root: string, dirs: string[]): Violation[]`

**Rules, applied to code with comments and string literals blanked out first, so a comment that mentions `Math.sin` doesn't trip them:**
- **import:** an `import`/`export … from` or dynamic `import()` whose specifier resolves, relative to the file, into `src/render`, `src/ui` or `src/app`.
- **global:** a bare identifier `document`, `window`, `navigator` or `requestAnimationFrame`, or an identifier starting with `GPU`.
- **math:** `Math.` followed by one of the banned names in Global Constraints.

- [ ] **Step 1: Write the failing tests** in `tests/architecture.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { checkSource, checkTree } from './support/arch';

describe('architecture rules', () => {
  it('flags imports from render, ui and app', () => {
    const v = checkSource('src/world/x.ts', "import { a } from '../render/gpu';\nexport * from '../ui/hud';");
    expect(v.map((x) => x.rule)).toEqual(['import', 'import']);
    expect(v[0].line).toBe(1);
  });
  it('flags DOM and WebGPU globals', () => {
    const v = checkSource('src/sim/x.ts', 'const c = document.body;\nconst u: GPUDevice = null!;');
    expect(v.map((x) => x.rule)).toEqual(['global', 'global']);
  });
  it('flags engine-dependent maths but not comments or strings', () => {
    const v = checkSource('src/core/x.ts', "// Math.sin is banned\nconst s = 'Math.cos';\nconst y = Math.exp(1) + Math.sqrt(2) + Math.floor(3);");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: 'math', line: 3 });
  });
  it('the real simulation tree is clean', () => {
    expect(checkTree('src', ['core', 'world', 'physics', 'sim'])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run `npx vitest run tests/architecture.test.ts`. Expected: FAIL, `./support/arch` doesn't exist.
- [ ] **Step 3: Implement `tests/support/arch.ts`.**
  - Blank comments and strings with a small character scanner, keeping newlines so line numbers survive.
  - Find violations with per-rule regexes over the blanked text.
  - Resolve relative specifiers with `node:path`.
  - `checkTree` walks `.ts` files with `node:fs`. Missing dirs are skipped, because `world`, `physics` and `sim` don't exist yet.
- [ ] **Step 4: Run the whole suite.** Run `npm test && npm run typecheck`. Expected: all tests in `tests/core/*` and `tests/architecture.test.ts` PASS, and the typecheck is clean.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Enforce the simulation's import boundary and deterministic maths in a test"`

---

### Milestone check

- [ ] Run `npm test && npm run typecheck && npm run build`. Expected: all green.
- [ ] Run `cd reference/python && ../../.venv/bin/python -m pytest 2>&1 | tail -1`. Expected: `283 passed`.
