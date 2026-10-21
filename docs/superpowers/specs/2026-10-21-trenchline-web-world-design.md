# TRENCHLINE for the web — sub-project 1: the world

- **Date:** 2026-10-21
- **Status:** design approved for building.
  - Sections 1 and 2 were approved in conversation.
  - The larger map and sections 3 and 4 were written afterwards under the user's instruction: "approved, continue build out … if you need to stop and ask me something make sure it's super necessary".

## Why

The Python/Ursina game proved the mechanics but cannot look the part.
- Its 0.5 m voxels are far too coarse.
- Its lighting is baked into vertex colours, because macOS OpenGL rejects Panda's shaders.

The game is going on the user's portfolio, so it must:
- run in a browser;
- have Teardown-scale voxels (10 cm);
- look its best at dusk and into the night.

A throwaway WebGPU probe (October 2026) showed that a hand-written voxel ray tracer meets that bar in Chrome and Safari 26 on the user's M1 Pro, and the user signed off on its look.

The rebuild is split into five sub-projects, each with its own spec, plan and build:

1. **World (this document):**
   - the TypeScript/WebGPU project;
   - a 10 cm world, larger than today's;
   - the generator, ported and re-detailed;
   - rendering with sun or moon shadows, sky occlusion, a few point lights, fog, denoising and anti-aliasing;
   - distant terrain;
   - walking, with every stance.
2. **Light:**
   - many shadow-casting lights with reuse between pixels and frames;
   - light shafts in fog;
   - a physically based sky with moon and stars;
   - a full day-to-night cycle;
   - bloom, automatic exposure, grain and quality polish.
3. **Combat and destruction:** weapons, ballistics, recoil, view kick, suppression, shelling and soil collapse at 10 cm, entrenching, HUD and effects.
4. **The battle around you:** drifting flares, distant artillery, tracers, fires, water.
5. **Showcase:** portfolio integration, loading experience, quality tiers, a video fallback, deployment.

## What "done" means for this sub-project

A visitor opens the page and sees a loading screen while the world generates. They then stand in a front-line fire bay at dusk and can walk the whole map, at a steady 60 frames a second.

| # | Criterion | Measured by |
|---|---|---|
| 1 | From navigation to the "click to play" prompt: ≤ 4 s in Chrome, ≤ 8 s in Safari 26, on the M1 Pro from a local server. | e2e timing (Chrome); Safari report run |
| 2 | GPU frame ≤ 14 ms on the M1 Pro, in both browsers, for each of the standard views listed under Testing. Measured at the "high" preset's internal resolution (1.5 MP) with dynamic resolution off; in play, dynamic resolution holds the budget on slower machines. | e2e perf run; Safari report run |
| 3 | No visible grain while moving. Distant terrain reaches the horizon and there is no cliff at the map edge. | screenshot set, reviewed by eye |
| 4 | The movement port matches Python on the parity fixtures, within 1 mm per tick. | Vitest |
| 5 | The same seed gives the same world bytes with 1 or N workers, and in Chrome and Safari. | Vitest + e2e + Safari report |
| 6 | All TypeScript tests pass, and the Python reference still passes its own suite. | `npm test`, `npm run e2e`, `pytest` |

## 1. Project shape (approved)

**Stack**
- Strict TypeScript, Vite, raw WebGPU and WGSL.
- No runtime dependencies.
- The HUD, menus and loading screen are HTML/CSS over the canvas.
- Development tools: Vitest, Playwright's test runner driving the installed Google Chrome, `tsc --noEmit`, and `smol-toml`, which is used at build time only.

**Repository**
- The TypeScript project lives at the repo root.
- The Python game moves unchanged to `reference/python/` (`trenchline/`, `tests/`, `tools/`, `pyproject.toml`) and keeps passing its tests using the existing root `.venv`.
- It is deleted once every sub-project has ported what it needs. Git history keeps it.

**Layout**

```
data/tunables.toml        the one home for feel and structure numbers
src/core/                 rng, dmath, clock, hashing, tunables access
src/world/                materials, brick map, region edits, destruction
                          primitives, generation/, trench network, far field
src/physics/              vectors, voxel collision, character controller
src/sim/                  session: owns the world, player, clock, streams
src/render/               WebGPU device, buffers, passes, WGSL shaders
src/ui/                   loading screen, menus, HUD, debug overlay (DOM)
src/app/                  bootstrap, frame loop, input, generation workers
tests/                    Vitest unit and integration tests; tests/e2e/ for Playwright
tools/                    fixture exporters, perf and Safari report runners
reference/python/         the original game, frozen
```

**Two rules, both enforced by `tests/architecture.test.ts`**
- *Boundary.* `core`, `world`, `physics` and `sim` import nothing from `render`, `ui` or `app`, and touch no DOM or WebGPU globals. This is the same boundary `test_architecture.py` enforces today.
- *Determinism.*
  - The same four folders never call engine-dependent maths: `Math.sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `exp`, `expm1`, `log`, `log1p`, `log2`, `log10`, `pow`, `cbrt`, `hypot`, `sinh`, `cosh` or `tanh`, nor `Math.random`.
  - They use `core/dmath.ts` instead. It is built only from `+ − × ÷ √`, `floor` and `round`, all of which IEEE rounds identically everywhere.
  - Without this rule, Chrome and Safari would generate different worlds from the same seed.

**Tuning**
- `data/tunables.toml` starts as a copy of the Python file, with its comments intact.
- A Vite plugin compiles it to a JSON module, and Vitest loads the same file through the same parser.
- `Tunables` keeps the Python accessors: `f`, `i`, `section`, and dotted keys.

**Determinism**
- *Random numbers.*
  - Every stream is xoshiro128\*\*.
  - A child stream is derived from its parent's key and a label, through a 64-bit FNV-1a hash and SplitMix64 done in 32-bit halves. A stream therefore never depends on how much its parent has drawn.
  - `stateString()` exposes the exact stream position, as Python's `state_json` does.
- *Fingerprints.*
  - The world fingerprint is SHA-256 over the canonical brick content: table order, a type byte, then the material or the 512 raw bytes.
  - Node's `crypto` computes it in tests and `crypto.subtle` in the browser.
  - It is new, because the world is new.
- *Movement parity.*
  - `reference/python/tools/export_parity.py` exports a small 0.5 m test world, scripted inputs and the Python controller's per-tick states.
  - The TypeScript controller runs at any voxel size, replays the fixture and must match within 1 mm.

## 2. The world (approved, map enlarged at the user's request)

### Size and layout

The playable map grows from 128 × 128 m to **256 × 256 m, 32 m tall**: 2560 × 320 × 2560 voxels at 10 cm.

The layout keeps the Python logic and adds depth to the rear areas. Metres along z run from the friendly rear (0) to the enemy rear (256):

| z (m) | Feature |
|---|---|
| 8–40 | Friendly rear: a ruined hamlet of five to seven buildings, a road, a church tower stump |
| 44 | Shelterbelt |
| 52 | Friendly reserve line, with dugouts and no firing steps |
| 84 | Friendly support line |
| 106 | Friendly front line, with firing steps, dugouts and wire 8.5 m out |
| 106–158 | No man's land: the Sukhyi Yar swale, about 300 craters, the farm, a hull, poles and fences |
| 132 | Shattered shelterbelt across no man's land |
| 158 | Enemy front line |
| 180 | Enemy support line |
| 206 | Enemy reserve line |
| 214 | Shelterbelt |
| 220–252 | Shattered wood |

Further features:
- **Communication trenches:**
  - friendly at x = 44, 128 and 212 m, running from the reserve line to the front line;
  - enemy at x = 70 and 186 m.
- **Culvert:** a collapsed culvert under the road, on the friendly side of no man's land.
- **Rear craters:** about 120 harassing-fire craters behind both lines.
- **Direct hits:** six on each front line.

All of these are tunables in metres under `[world.layout]`, so the map can shrink back to 128 m, or grow, without touching code.

### Storage

**Bricks.** The world is a sparse brick map of 8³-voxel (0.8 m) bricks, 320 × 40 × 320 of them.
- A 32-bit table entry per brick says whether it is:
  - empty;
  - uniform (one material, stored in the entry);
  - dense (an index into a pool of 512-byte bricks, one byte per voxel).
- A sector layer marks which 32³-voxel (3.2 m) sectors hold anything, so the tracer skips empty space in 3.2 m strides.

**CPU and GPU copies.**
- The CPU copy (simulation, collision, edits) keeps dense bricks raw. The pool is chunked, so it can grow without reallocating.
- The GPU copy stores dense bricks as compressed records:
  - a 16-byte local palette;
  - a 64-byte occupancy bitmask, one bit per voxel;
  - material indices at 0, 1, 2, 4 or 8 bits per voxel, whichever is smallest for that brick's distinct solid materials.
  - Air is never stored, because the mask says it.
- A typical surface brick (air, sod, mud) is 208 bytes instead of 512. A buried strata brick is 144.
- Expected footprint at 256 × 256 m:
  - CPU about 200–260 MB;
  - GPU about 70–110 MB, including a 16 MB table;
  - far-field data about 17 MB.

**Edits.**
- Every write marks its brick dirty.
- Dirty bricks are recompacted: a brick that is uniform again becomes uniform, and one that is empty again is freed.
- They are re-encoded and uploaded, with a per-frame byte budget and nearest-to-the-camera first.
- The GPU heap has size classes with free lists and grows by reallocate-and-copy.

### What a voxel holds

One byte that selects one of 256 palette entries. Each entry carries:
- its **material kind**, which brings the Python rules:
  - solid, opaque, blocks-sight, granular, loose, hardness, and what it becomes when carved;
  - the Python game has 18 kinds; this adds `MORTAR`, `PICKET` (steel) and `CLOTH` (sandbag hessian is its own entry, not a kind);
- an **albedo** in sRGB;
- a **roughness**;
- an **emission** (a lantern glass, an ember).

**Shades.** The generator picks shades within a kind on purpose:
- wet mud near water, darker mud in trench floors;
- worn sandbag seams, weathered planks;
- dead grass tufts, ploughed stripes;
- brick against mortar.

The shader adds only a small per-voxel hash variation on top, as the probe did.

### Generation

Generation keeps the Python generator's design rules: the crest guarantee, the revetment rule, spoil that rests where it fell, and named random streams. It runs in three phases.

**1. Plan** (global, small, deterministic)
- **Terrain:**
  - the field relief is a *pure function* of (x, z): fBm value noise from seeded lattices, plus the swale, plus drainage-ditch cuts;
  - any worker can evaluate it anywhere, and it continues seamlessly into the far field.
- **Trenches:** the trench planner ports `_carve_trench_line`'s planning step:
  - crenellated bays, floors stepped by at most one tread between bays;
  - per-bay corridor heights;
  - firing-step heights from the sightline guarantee, then crest smoothing;
  - dugout placement and the trench graph.
- **Everything else:** landmarks, crater lists, belts, poles and fences are placed with their base heights taken from the terrain function.
- The plan is a few hundred kilobytes, and every worker receives it.

**2. Fill** (parallel, one Web Worker per core, up to 8)
- **Regions.** Regions are interleaved bands of 32-voxel sector columns. Each is a pure function of the plan, so the result is identical whatever the worker count.
- **Per column:**
  - strata (sod, mud to 1.5 m, clay to 4 m, subsoil);
  - plough stripes;
  - trench and leg cuts;
  - duckboards, firing steps, treads and flights;
  - parapet and parados profiles, and revetment;
  - dugouts;
  - open-field craters, as bowls and rims in the terrain function;
  - flooding below the water table.
- **Props** are stamped and clipped to the region:
  - sandbag courses;
  - revetment boards, corrugated iron and wicker hurdles, varied by bay;
  - screw pickets with sagging wire;
  - shattered trees and the wood;
  - the farm, hamlet and church, with brick and mortar courses;
  - the culvert, the hull, poles and fences.
- **Outputs.** Workers return raw bricks, table slices and GPU-encoded records as transferred buffers, so nothing is copied.

**3. Events** (sequential, on the assembled world)
- These are the few things that are honestly three-dimensional: the direct hits on trench lines and craters overlapping structures.
- They go through the *runtime destruction primitives*, which live in `world/` from this sub-project on, so a crater cut at load behaves like one cut in battle:
  - `carveSphere` (irregular radius);
  - `collapseRegion`: granular columns compact downward, water is displaced upward, and loose material relaxes to 45°;
  - `floodRegion`: fill below the water table, drain hanging water.

**Two Python rules change at 10 cm**

*The world is generated already settled.*
- Python lets all soil collapse once across the whole map. At 10 cm that is 125 times the voxels and far too slow.
- Instead, terrain, bowls, rims, parapets and spoil heaps are built at rest. Loose material never steps more than one voxel per voxel, which is 45°.
- Only the event phase runs collapse, and only in its own regions.
- A test checks that no granular voxel hangs and no loose voxel exceeds its angle of repose.

*Grid-derived dimensions become explicit metres.*
- Python derived several sizes from the 0.5 m grid:
  - the crest height, `step_top + floor(standing_eye / voxel)`, which leaves a standing eye 0.12 m clear and gives 0.02 m at 10 cm;
  - a stair tread, one voxel deep and one step-up high, which becomes a ladder at 10 cm.
- These become tunables:
  - crest clearance 0.12 m;
  - tread depth 0.30 m and rise 0.25 m, with the across-bay flight continued along the bay as Python does;
  - bench depth, duckboard slat and gap;
  - revetment board height;
  - sandbag size 0.6 × 0.3 × 0.2 m (6 × 3 × 2 voxels);
  - trench lines end in closed ends 6 m inside the map edge, instead of running to within 2 m of it as in Python.
- The sightline guarantee is asserted per bay against the generated voxels: a standing eye clears the crest by the configured clearance, and a crouched eye is below it.

### Far field

The terrain continues past the playable edge to about 2 km in every direction:
- A 2048 × 2048 height map at 2 m cells, centred on the map.
- Its relief is the same terrain function plus broad hills.
- It has a material per cell: field, ploughed field, wood, village roofs and a distant spire.
- Workers generate it with the voxel world.
- Height and material go to GPU textures, with a max-height mip chain for fast ray marching.
- Inside the playable area the far field is empty. At the boundary the voxel terrain and the far field share the same function, so there is no seam.
- Movement stops 2 m inside the edge, as the solid skirt does in Python.

### Checks

- A golden world fingerprint for seed 7.
- 1-worker and 8-worker generation produce identical bytes.
- Per-bay sightline and peek assertions.
- Nothing loose or hanging is left.
- Water only at or below the water table.
- Spawn is on intact duckboards with headroom and an intact firing step.
- Brick map invariants hold: uniform and empty bricks compact, and the GPU encoding round-trips.
- Generation time is reported per phase.

## 3. Rendering

Rendering is compute-first WebGPU: every pass is a compute shader except the final present.

### Frame

1. **Primary visibility** (internal resolution). One ray per pixel, sub-pixel jittered (Halton 2,3) for TAA. Rays that leave the voxel volume continue into the far field. It writes a G-buffer:
   - depth;
   - hit voxel coordinates (for stable per-voxel variation and reprojection checks);
   - face normal;
   - palette index;
   - motion vector.
2. **Lighting** (half resolution in each axis, so a quarter of the rays). Each lighting pixel takes one representative of its 2×2 block, rotating every frame, and traces:
   - **Sun or moon:** one shadow ray, jittered within a cone so penumbrae soften as they accumulate.
   - **Sky visibility:** one cosine-weighted ray, up to 4 m.
   - **Point light:** one, chosen by weighted importance from the lights in range as in the probe (at most 64 lights in this sub-project), with one shadow ray.
3. **Denoise** (half resolution).
   - Temporal accumulation with reprojection. Disocclusion is detected from depth, normal and voxel identity.
   - Per-pixel history length (capped at 32) and moment-based variance.
   - Then three passes of a variance-guided, edge-stopping à-trous filter. Voxel faces are flat, which makes edge stopping easy: same normal and same plane.
4. **Upsample and shade** (internal resolution).
   - Lighting is upsampled with depth- and normal-aware weights.
   - Shading is albedo (palette plus per-voxel variation) × (sun × visibility × N·L + sky colour by normal × sky visibility + point lights) + emission.
   - Then exponential height fog with a forward-scattering sun term, and the sky for misses.
5. **TAA** (internal resolution): YCoCg neighbourhood clamp, motion-vector reprojection, and a velocity-weighted blend.
6. **Present** (canvas resolution): bicubic upscale with contrast-adaptive sharpening, ACES-fit tonemap, exposure, and blue-noise dither (it stops night skies banding).

### Tracing
- **Shared traversal.** Every ray uses one hierarchical DDA: sector (32) → brick (8) → voxel.
  - Occupancy-only rays (shadows, sky) read just the bitmask and never decode materials.
  - Primary rays decode the material at the hit.
- **Long rays.** Shadow and sky rays also skip using a 2D max-height pyramid built over brick columns: once a ray is above everything in the pyramid cell it is crossing, it jumps to that cell's exit. This is aimed at the long, low dusk-sun rays that dominated the probe's cost.
- **Far field.** A max-mip height-field march, with coarse shadowing toward the sun.

### Light and sky (this sub-project's level)
- **Time of day** is one parameter running dusk → twilight → night, with keyframes in tunables:
  - sun direction, colour and intensity;
  - moon;
  - sky zenith and horizon colours;
  - fog density and colour;
  - exposure.
- **Lighting presets.** Dusk is the default spawn lighting. Night shows the moon and a handful of static flares and lanterns, so the lighting the user saw in the probe is preserved.
- **Water** is a flat surface: dark, with a sky-tinted Fresnel term. No reflections yet; those belong to sub-project 4.

### Quality and resolution
- **Internal resolution** targets about 1.5 megapixels at "high" (roughly 1500 × 1000 on the M1 Pro's display).
- **Dynamic resolution** scales it between 50% and 100% to hold the GPU budget, using timestamp queries when available and frame intervals otherwise.
- **Presets:** "low" adds quarter-resolution lighting; "high" is the default.

### GPU data and code organisation
- **Buffers:**
  - brick table, sector mask, brick heap, palette;
  - max-height pyramid, far-field textures;
  - lights;
  - per-frame camera uniforms (current and previous).
- **Uploads** are queued and budgeted per frame. A full world upload happens once, behind the loading screen.
- **Shaders.** WGSL modules are composed from shared files (`common`, `traverse`, `palette`, `sky`) by a small build-time include step. Each pass reports its GPU time to the debug overlay (F3).

## 4. Simulation, movement, app and testing

### Simulation
- `sim/session.ts` owns:
  - the brick map and plan (trench network, landmarks);
  - the player and controller;
  - a 60 Hz `FixedClock` ported from Python;
  - the named random streams.
- It runs on the main thread in this sub-project, because walking is cheap.
- World edits leave a list of dirty bricks, which is the only thing the renderer reads from them. Moving the simulation into a worker later (if shelling at 10 cm needs it in sub-project 3) therefore changes the transport, not the design.

### Movement
- `physics/` ports `vec`, `collision` and `character` line for line:
  - the five stances: standing, crouched, prone, firing step and periscope;
  - step-up, the step-down probe and penetration recovery;
  - wading, the firing-step test as "standing on timber", and the stance transitions refused by low ceilings.
- **Voxel size.** Collision reads the voxel size from the world, so the same code runs the 0.5 m parity fixture and the 10 cm game.
- **Conventions.** Python's are kept:
  - yaw 0 looks down +z, and right is +x;
  - yaw and pitch are in degrees;
  - the horizontal field of view is 90°.
- **Camera.**
  - Head bob, landing dip and the periscope's field-of-view easing come from `[camera]`.
  - The periscope also gets a simple CSS mirror-frame overlay.

### App
- **Bootstrap:**
  - check for WebGPU;
  - start the generation workers and show phase progress on the loading screen;
  - upload, spawn, show "click to play".
- **Input:** pointer lock and keys.
  - W A S D move; Shift sprints; Space jumps.
  - C crouches; Z goes prone; Q raises the periscope on a firing step.
  - Esc opens the pause menu.
- **Frame loop:** `requestAnimationFrame` → clock advance → simulation ticks → render with the interpolated pose. Look is applied every frame for responsiveness, and the simulation reads the latest yaw and pitch at each tick.
- **Pause menu:** quality preset, mouse sensitivity, field of view, a time-of-day slider, and resume.
- **Debug overlay (F3):** pass timings, internal resolution, brick and memory counts, position, bay.
- **Capture hooks.** `window.__trenchline` exposes them to tests: teleport, set the time of day, wait for convergence, read timings, read the world fingerprint.

### Testing
- **Vitest (Node):**
  - RNG streams and state;
  - `dmath` accuracy;
  - tunables;
  - brick map edits, compaction and the GPU encode/decode round-trip;
  - the destruction primitives;
  - every generation invariant in §2 at full size;
  - generation by 1 versus 8 workers (simulated in-process);
  - the golden fingerprint;
  - the controller parity fixtures;
  - the architecture and determinism rules.
- **Playwright (installed Chrome, headless, WebGPU enabled):**
  - smoke (loads, no GPU errors, frames are not blank);
  - a screenshot set at fixed views, dusk and night, written to `artifacts/`;
  - a perf run that fails if any standard view exceeds the 14 ms GPU budget at the default quality;
  - load-time measurement.
  - The standard views are: front-line bay along the trench; firing step looking out; no man's land at night; the elevated overview; inside a dugout; the hamlet.
- **Safari report run:** `npm run safari` opens the same check page in Safari with `open -a Safari`. The page posts its timings, fingerprint and screenshots back to the dev server, as the probe did.
- **Python:** `.venv/bin/python -m pytest` in `reference/python/` stays green.

## Build order

Each milestone gets its own implementation plan, and each ends with every test green:

1. **Foundation:**
   - scaffold;
   - the Python move;
   - `core` (rng, dmath, clock, hashing, tunables);
   - the architecture and determinism tests.
2. **World data:**
   - materials and palette;
   - brick map, edits and compaction;
   - GPU encoding;
   - destruction primitives;
   - the fingerprint.
3. **Generator:**
   - terrain function;
   - trench planner;
   - region fill;
   - props;
   - events;
   - far field;
   - workers;
   - invariants and the golden fingerprint.
4. **Renderer:**
   - device and uploads;
   - primary visibility;
   - lighting, denoising, shading;
   - far field and sky;
   - TAA and present;
   - dynamic resolution;
   - debug overlay.
5. **Movement and app:**
   - controller port and parity;
   - session and loop;
   - input, camera, loading screen, menus.
6. **Proof:**
   - e2e smoke, screenshot and perf suites;
   - Safari report run;
   - tuning to the budgets.

## Risks and how they are handled

| Risk | Handling |
|---|---|
| GPU cost of long dusk shadow rays (probe: 13–19 ms full-resolution in a front-line bay) | Quarter-count lighting rays, bitmask traversal, max-height skipping, dynamic resolution. Perf tests gate every renderer task. |
| Safari WebGPU or JavaScript differences | Determinism rule (`dmath`); regular Safari report runs; generation in workers. |
| Memory on modest machines | Compressed GPU bricks. The map size is a tunable; 128 m is the fallback. |
| Generation time | Parallel fill; the plan is cheap; events are few; the loading screen shows progress. |
| Worker-count or browser nondeterminism | Fingerprint tests across worker counts and browsers. |
| Denoiser ghosting or smearing | Voxel-identity disocclusion, history clamping, a capped history length, and screenshot review while moving. |
| No WebGPU (some Firefox and older browsers) | A clear message in this sub-project; the video fallback comes in sub-project 5. |

## Not in this sub-project

- Weapons, damage and shelling during play.
- Entrenching, suppression and the combat HUD.
- Many-light reuse (ReSTIR), volumetric shafts, the physically based sky, stars, bloom, auto exposure, grain.
- Drifting flares and fires.
- Water reflections.
- Audio.
- The portfolio page and deployment.

The renderer and world are built so these arrive without rework:
- lights are already sampled stochastically;
- destruction primitives already exist;
- the palette has emission.
