# Battle, Milestone 2: Distant Artillery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Barrages fall beyond the map, and shells land in the far field. The shells beyond the map flicker on the horizon and rumble seconds later. The far-field shells flash, smoke and thump.

**Architecture:**
- **Simulation (`src/battle/`, pure and deterministic, as in B1):**
  - barrages beyond the map and shells into the far field, each a pure plan drawn from its own stream;
  - a smoke column that is a pure function of its shell, the time and the wind;
  - the director schedules both by the front's intensity, with no wait for the dark.
- **Render side:** each landed shell is a flash record (where it fell, and its power now).
  - The sky and the haze glow toward the newest 16, and the far field is lit by them.
  - A far shell also draws an emissive disc, and its column as lit discs (the froxels end at 120 m).
  - At rest none of it is drawn.
- **Sound:** a rumble for a shell beyond the map and a thump for a far shell, each late by its distance at 343 m/s.

**Tech Stack:** TypeScript, WGSL, WebGPU, WebAudio, Vitest, Playwright (Chrome).

**Spec:** docs/superpowers/specs/2026-10-23-trenchline-web-battle-design.md:
- §1 (the director);
- §3 (distant artillery);
- §7 (the rumble and the thump);
- done-table row 2;
- build order item 2.

## Global Constraints

- **Architecture rules** (tests/architecture.test.ts) hold for the new `src/battle/` files:
  - no imports from `render`, `ui`, `app` or `audio`;
  - only the exactly rounded `Math` functions; `sin`, `cos`, `exp`, `atan2` and `radians` come from `core/dmath`.
- **The spec's values:**
  - Barrages fall 1–8 km off, along the front to either side and beyond the enemy's line.
  - A barrage is 6–40 shells over 10–60 s.
  - The tempo: at `light` a barrage every few minutes; at `heavy` one or two always in progress; none `off`.
  - The sky shader takes the 16 most recent flashes.
  - A rumble or thump arrives distance ÷ 343 m/s late.
  - Far shells land 200–800 m off. Each has a flash (a billboard and a brief unshadowed light) and a smoke column that rises and leans with the wind for a minute. They cut no craters.
- **Every magnitude comes from the tunables,** in new `[battle.barrages]`, `[battle.far_shells]` and `[battle.flashes]` tables and new `[audio]` keys.
- **Determinism.** The same seed, inputs and clock steps give the same shells. Seeking to t gives what stepping to t gives.
- **The approved look holds.** At rest there are no flashes, columns or rumbles. Sub-project 3's shells near the player are unchanged.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work stays on `web/world`, and nothing is pushed.

## Rulings made in planning

1. **Where barrages fall.** Bearings and distances are measured from the map's middle, (128, 128) m. +z is toward the enemy, and a bearing is 0° along +z and 90° along +x, as the wind and the camera use.
   - A barrage's bearing is uniform within ±110° of +z. That covers both flanks along the front (±90°) and beyond the enemy's line.
   - Its distance is uniform in 1–8 km.
   - Its shells land uniformly in a box 400 m across and 150 m deep about that point.
   - Their times are uniform over its length, sorted.
   - All of this is drawn from the barrages' stream when the barrage starts.
2. **The tempo.** Barrages start by Poisson, at a mean gap of 150 s at `light` and 20 s at `heavy`. With a mean length of 35 s, that keeps about 1.75 in progress at `heavy`.
   - A barrage in progress stops when the intensity goes `off`; its unfired shells are dropped.
   - Far shells come by Poisson at mean gaps of 30 s (`light`) and 5 s (`heavy`). There are none `off`.
   - Neither waits for the dark: dusk shows the distant fire.
3. **Far shells** land 200–800 m from the map's middle, within ±110° of +z. That is outside the map, whose corners are 181 m out. Their height is the far field's: the director takes a `ground(x, z)` in metres, which main passes from `world.farField`.
4. **A flash is a record:** where the shell fell (metres) and its power now.
   - The power is the shell's own (0.6–1.4) × exp(−age / 0.15 s) while its age is under 1 s.
   - The CPU folds the age into the power. The sky shader takes position and power, not the spec's "bearing, strength and age": the same information, and less work per pixel.
   - The newest 16 are sent.
5. **The glow.** Each flash lights a patch of haze over it, 300 m wide and 150 m high, as seen from the eye.
   - Shape: Gaussian in azimuth with half-width atan(150 / d), and in elevation about the flash's own elevation from the eye with half-height max(atan(150 / d), 1.5°). So a near shell lights a broad swath and a far one a flicker on the skyline.
   - Its radiance: `sky × power × exp(−d / reach)`.
   - It is added to the sky (`skyWithBodies`) and to the haze's glow (`hazeGlow`, × `haze`). Together they show the glow over the haze toward it and silhouette the far field against it.
   - The far field is also lit directly: `far × power × min(1, (near / dist)²) × max(n·l, 0)` from each flash.
6. **A far shell's flash** is an emissive disc growing from 6 to 12 m over 0.2 s, fading.
   - Its "brief unshadowed light" is its flash record. That lights the far field near it and the haze toward it.
   - It is not a transient light in the map: the map's lights end at the map, 70 m or more from the nearest far shell.
7. **A smoke column** is 8 puffs, let out every 0.5 s from the shell.
   - Each rises at 6 m/s, slowing over 8 s to about 48 m, and is carried by the wind from its release.
   - Each grows from 3 to 12 m and fades over 60 s.
   - They are drawn as lit discs: the froxels' haze ends at 120 m, and far shells are 200 m out at the nearest.
8. **The voices.**
   - The rumble: gain × 1000 m / d; lowpass falling geometrically from 300 Hz at 1 km to 80 Hz at 8 km; length growing from 1.5 s to 5 s.
   - The thump: gain × 200 m / d; lowpass 1200 Hz → 500 Hz and length 0.8 s → 1.5 s over 200–800 m.
   - The engine's 64-voice cap comes with B3's chatter. B2 adds about ten voices at once at `heavy`.

## Review Focus

- **Dusk.** At dusk the distant fire falls (barrages, far shells, their flashes and smoke) while no flare is fired. Pinned in Task 3.
- **Turning the front off.** A barrage in progress stops when the pause menu sets `off`. No new far shell falls, and rumbles already on their way still arrive. Pinned in Task 3.
- **A crowded heavy night.** Two barrages and the far shells together send the sky only the newest 16 flashes, and the frame holds the budget. Pinned in Tasks 3 and 7.
- **Rest unchanged.** With the lights held at rest (every approved view, the check run) there is no flash, column or rumble. Pinned in Tasks 4 and 5.
- **The eye high above.** From the overview, 100 m and more up, a distant flash glows at its own elevation on the far horizon, not floating level with the eye. Pinned in Task 4.

---

### Task 1: Barrages and their flashes

**Files:**
- Create: `src/battle/barrages.ts`
- Modify: `data/tunables.toml`, with two new tables:
  - `[battle.barrages]`: `every_light_s = 150`, `every_heavy_s = 20`, `arc_deg = 110`, `distance_m = [1000, 8000]`, `shells = [6, 40]`, `duration_s = [10, 60]`, `width_m = 400`, `depth_m = 150`, `power = [0.6, 1.4]`;
  - `[battle.flashes]`: `window_s = 1.0`, `decay_s = 0.15`.
- Test: `tests/battle/barrages.test.ts`

**Interfaces:**
- Produces:
  - `interface BarrageTunables`, `barrageTunables(tun: Tunables): BarrageTunables`;
  - `interface FlashTunables { windowS: number; decayS: number }`, `flashTunables(tun: Tunables): FlashTunables`;
  - `interface PlannedShell { t: number; x: number; z: number; power: number }`, in seconds and metres;
  - `planBarrage(t0: number, centre: readonly [number, number], rng: Rng, bt: BarrageTunables): PlannedShell[]`, sorted by `t`;
  - `flashPower(shell: { t: number; power: number }, now: number, ft: FlashTunables): number`;
  - `const HORIZON_FLASHES = 16`.

- [ ] **Step 1: Write the failing tests:**
  - `'a barrage is 6–40 shells over 10–60 s, 1–8 km out within 110° of toward the enemy'`: over 200 seeds:
    - the count is in [6, 40];
    - every time is in [t0, t0 + 60] and sorted, with last − first ≤ 60;
    - every shell is within 1000 − 75 and 8000 + 75 m (plus 200 m across) of the centre, at a bearing within 110° plus the box's own angle.
  - `'barrages fall on both flanks and beyond the enemy'`: of 500 barrages' first shells, those at bearing < −60°, > +60° and within ±30° are each ≥ 15%.
  - `'a flash is brightest as its shell lands, 1/e after decay_s, and gone after the window'`: `flashPower` is 0 at t − 0.01 s, the shell's power at t, power/e at t + 0.15 s (6 digits), and 0 at t + 1.01 s.
  - `'the same stream plans the same barrage'`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement,** as ruling 1 sets out. Every random number comes from `rng`, in a fixed order:
  1. the bearing;
  2. the distance;
  3. the count (`randint(6, 41)`);
  4. the duration;
  5. then per shell: its time, its offset across, its offset along, its power.
- [ ] **Step 4: Run them to see them pass,** with `npm test` and `tsc`.
- [ ] **Step 5: Commit** ("Plan the barrages beyond the map").

### Task 2: Far shells and their smoke columns

**Files:**
- Create: `src/battle/far-shells.ts`
- Modify: `data/tunables.toml`, `[battle.far_shells]`: `every_light_s = 30`, `every_heavy_s = 5`, `distance_m = [200, 800]`, `arc_deg = 110`, `power = [0.6, 1.4]`, `flash_s = 0.2`, `flash_size_m = [6, 12]`, `flash_glow = 3`, `smoke_s = 60`, `puffs = 8`, `puff_every_s = 0.5`, `rise_mps = 6`, `rise_s = 8`, `puff_radius_m = [3, 12]`, `smoke_alpha = 0.6`, `smoke_colour = [0.2, 0.18, 0.16]`.
- Test: `tests/battle/far-shells.test.ts`

**Interfaces:**
- Consumes: `PlannedShell` (Task 1); `Wind.drift(t0, t1)` (B1).
- Produces:
  - `interface FarShellTunables`, `farShellTunables(tun: Tunables): FarShellTunables`;
  - `planFarShell(t: number, centre: readonly [number, number], rng: Rng, ft: FarShellTunables): PlannedShell`;
  - `interface ColumnPuff { centre: [number, number, number]; radiusM: number; alpha: number }`;
  - `columnPuffs(shell: { t: number; position: readonly number[] }, now: number, wind: Wind, ft: FarShellTunables): ColumnPuff[]`.

- [ ] **Step 1: Write the failing tests:**
  - `'a far shell falls 200–800 m from the map's middle, within 110° of toward the enemy'`, over 500 seeds.
  - `'its column rises, leans downwind, grows and thins over a minute'`: at t + 20 s:
    - there are 8 puffs;
    - the first puff let out is the highest;
    - each puff's offset across the ground from the shell is `wind.drift(release, now)` (6 digits);
    - each is below `rise_mps × rise_s` above the shell;
    - radii grow and alpha falls with age;
    - at t + 60 s there is none.
  - `'a puff is out only once let out'`: at t + 0.2 s there is one; before t, none.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement,** as ruling 7 sets out. Puff k is let out at `t + k × puff_every_s`, and its age is `now` minus that.
  - Height: `rise_mps × rise_s × (1 − exp(−age / rise_s))`.
  - Radius: `mix(r0, r1, min(1, age / smoke_s))`.
  - Alpha: `smoke_alpha × (1 − (now − t) / smoke_s)`.
- [ ] **Step 4: Run them to see them pass.**
- [ ] **Step 5: Commit** ("Plan the far shells and their smoke").

### Task 3: The director fires them

**Files:**
- Modify:
  - `src/battle/director.ts`;
  - `src/world/generation/farfield.ts`: `farHeightM`.
- Test:
  - `tests/battle/director.test.ts`;
  - `tests/world/generation/farfield.test.ts` (new).

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  - `interface DistantShell { id: number; position: [number, number, number]; t: number; power: number; far: boolean }`;
  - `BattleEvents { launches: Launch[]; distant: DistantShell[] }`: each shell as it lands;
  - `new Director(plan, tun, seed, ground?: (xM: number, zM: number) => number)`. The default ground is the plan's ground level, in metres;
  - `Director.flashes(): DistantShell[]`: the newest `HORIZON_FLASHES` landed within `window_s`, newest first;
  - `Director.smoke(): ColumnPuff[]`: every far shell's column still standing;
  - `Director.at(seconds, plan, tun, seed, inputs, ground?)`;
  - `farHeightM(ff: FarField, xM: number, zM: number, voxel: number): number`: the height (m) of the cell under the point, clamped to the grid's edge; −Infinity inside the map.

- [ ] **Step 1: Write the failing tests:**
  - `'at light a barrage every two or three minutes, at heavy one or two in progress, none off'`:
    - 60 min at `light` starts 12–40 barrages;
    - 30 min at `heavy` keeps a mean of 1.0–2.6 in progress, sampled each second;
    - 10 min `off` lands no distant shell.
  - `'far shells: about two a minute at light, twelve at heavy, none off'`, each within ±30%.
  - `'the distant fire does not wait for the dark'`: at darkness 0 and `heavy`, barrages and far shells fall and no flare is fired.
  - `'turned off, a barrage in progress stops'`: run `heavy` until a barrage has landed a shell, then `off`; no distant shell lands after.
  - `'the sky is sent the newest sixteen, none older than the window'`: through 10 min at `heavy`, `flashes()` is at most 16 long, newest first, each younger than `window_s`.
  - `'a far shell stands on the far field'`: with `ground = (x, z) => x / 100`, each far shell's y is `ground(x, z)`.
  - `'seeking is stepping, for the distant fire too'`: `Director.at(150, …)` against 30 Hz stepping gives equal `flashes()` and `smoke()`.
  - `farHeightM`: `'reads the cell under a point in metres, and the edge beyond the grid'`, on a small hand-made `FarField`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
  - Two new streams, `root.derive('battle.barrages')` and `root.derive('battle.far')`, so B1's flares are unchanged.
  - Each 60 Hz step:
    1. maybe start a barrage (chance `dt / every`);
    2. land its due shells;
    3. drop barrages in progress when `off`;
    4. maybe land a far shell.
  - Landed shells keep ids from one counter, their y from `ground`. They are kept for `max(window_s, smoke_s)`.
- [ ] **Step 4: Run them to see them pass.** B1's director tests pass unchanged.
- [ ] **Step 5: Commit** ("Fire barrages beyond the map and shells into the far field").

### Task 4: The sky, the haze and the far field lit toward the flashes

**Files:**
- Modify:
  - `src/render/frame-uniforms.ts`:
    - new `FRAME` fields: `horizonColour vec3f`, `horizonSky`, `horizonHaze`, `horizonFar`, `horizonNear`, `horizonReach`, `horizonMinEl` (f32 each), `horizonSpread vec2f`, `horizonCount u32`, and `horizon: { element: 'vec4f', count: MAX_HORIZON }` (an f32 array's stride is not allowed in uniform space);
    - `MAX_HORIZON = 16`;
    - `interface HorizonTerms`, `horizonTerms(tun)`, `writeHorizon(w, terms, flashes)`.
  - `src/render/shaders/sky.wgsl`:
    - `fn horizonGlow(rd: vec3f) -> vec3f`, added in `skyWithBodies` and, × `horizonHaze`, in `hazeGlow`;
    - `fn horizonLight(p: vec3f, n: vec3f) -> vec3f`.
  - `src/render/shaders/shade.wgsl`: the far field (face 6) adds `horizonLight`.
  - `src/render/renderer.ts`: `setHorizon(flashes)`, written each frame.
  - `src/app/main.ts`: running or held, the shown battle's `flashes()` with `flashPower`; at rest none. A hook `horizon()` returns what was set.
  - `data/tunables.toml`, `[battle.flashes]`: `colour = [1.0, 0.72, 0.45]`, `sky`, `haze = 1.0`, `far`, `near_m = 60`, `spread_m = [300, 150]`, `min_deg = 1.5`, `reach_m = 6000`. Set `sky` and `far` by eye in Task 7, from first guesses: a full flash at 2 km about four times the night sky at the horizon.
  - Tests:
    - `tests/e2e/shaders/sky-test.wgsl` and `tests/e2e/cases/sky.ts`: the case writes the camera and the horizon records;
    - `tests/e2e/support/app.ts`: hook types.
- Test:
  - `tests/e2e/sky.spec.ts` (GPU harness);
  - `tests/e2e/horizon.spec.ts` (new, the app).

**Interfaces:**
- Consumes: `DistantShell`, `Director.flashes()`, `flashPower` (Tasks 1 and 3).
- Produces: `interface HorizonFlash { position: readonly [number, number, number]; power: number }` (metres), and `Renderer.setHorizon(flashes: readonly HorizonFlash[]): void`.

- [ ] **Step 1: Write the failing tests:**
  - **The GPU harness, at night**, with the eye 2 m up at the origin and one flash of power 1 at 2 km on bearing 40°:
    - `'a flash glows in the sky and the haze toward it, low on the horizon, and not opposite'`:
      - `skyWithBodies` and `fogColour` at 0.5° up toward it are > 1.5× without it;
      - at 30° up toward it, within 2%;
      - opposite, within 0.1%.
    - `'a nearer flash glows wider'`: 10° aside, a flash at 1 km raises the sky more than 10%, and one at 8 km less than 1%.
    - `'from high above, the glow sits on the far horizon'`: from 150 m up, the glow is brighter at −4° than at +4°.
    - `'the far field is lit by a flash toward it, falling with distance, never facing away'`: `horizonLight` at 30 m from a flash, facing it, is more than 50× its value at 600 m. Facing away it is 0.
  - **The app** (`horizon.spec.ts`): `'at rest no flash is set; running at heavy, the battle's newest are, each at least 200 m off'`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement,** as ruling 5 sets out. In `horizonGlow`, the azimuth term uses az² ≈ 2(1 − cos az) between `normalize(rd.xz)` and the flash's bearing from the eye. Where rd is vertical it is 0.
- [ ] **Step 4: Run them to see them pass.** Then run `sky.spec`, `shafts.spec`, `screenshots.spec`'s standard views and `day.spec` unchanged. At rest the frame holds no flash.
- [ ] **Step 5: Commit** ("Light the sky, the haze and the far field toward distant shells").

### Task 5: The far shells drawn: their flash and smoke

**Files:**
- Modify:
  - `src/app/effects-frame.ts`: `build(session, events, rifle, eye, battle: ShownBattle)`, replacing B1's `battleFlares`;
  - `src/app/main.ts`: passes the shown battle; at rest, `NO_BATTLE`.
- Test:
  - `tests/app/effects-frame.test.ts`;
  - `tests/e2e/horizon.spec.ts`.

**Interfaces:**
- Consumes: `Director.flashes()`, `Director.smoke()`, `FarShellTunables` (Tasks 2 and 3).
- Produces: `interface ShownBattle { seconds: number; flares: FlareState[]; flashes: DistantShell[]; smoke: ColumnPuff[] }`, and `const NO_BATTLE: ShownBattle`.

- [ ] **Step 1: Write the failing tests:**
  - `'a far shell's flash is an emissive disc growing from 6 to 12 m over 0.2 s, gone after; a shell beyond the map draws none'`;
  - `'its column's puffs are lit discs, premultiplied by their alpha'`: kind 0, and the colour is `smoke_colour × alpha`;
  - **e2e:** `'running at heavy, a far shell's flash and smoke are drawn; at rest, none'`. The billboards drawn rise by the smoke's puffs, and at rest they are as before.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement,** after the flares' discs, within `MAX_BILLBOARDS`. The flash's colour is `colour × flash_glow × (1 − age / flash_s)`.
- [ ] **Step 4: Run them to see them pass,** with B1's flare tests.
- [ ] **Step 5: Commit** ("Draw the far shells' flash and smoke").

### Task 6: The rumble and the thump

**Files:**
- Modify:
  - `src/audio/plan.ts`: `VoiceKind` gains `'rumble' | 'thump'`, and `planVoices` voices `battle.distant`;
  - `src/audio/voices.ts`:
    - the rumble: lowpassed noise with a 0.1 s attack that rolls away over its length, and a 40 Hz sine;
    - the thump: a 90→40 Hz sine drop with a short noise burst;
  - `data/tunables.toml`, `[audio]`: `rumble_gain = 0.5`, `rumble_ref_m = 1000`, `rumble_lowpass_hz = [80, 300]`, `rumble_length_s = [1.5, 5]`, `thump_gain = 0.6`, `thump_ref_m = 200`, `thump_lowpass_hz = [500, 1200]`, `thump_length_s = [0.8, 1.5]`.
- Test:
  - `tests/audio/plan.test.ts`;
  - `tests/e2e/audio.spec.ts`.

**Interfaces:**
- Consumes: `BattleEvents.distant` (Task 3).

- [ ] **Step 1: Write the failing tests:**
  - `'a barrage's shell rumbles distance ÷ 343 m/s later, quieter, duller and longer the farther'`, at 1 and 8 km:
    - delays 1000/343 and 8000/343 s;
    - gain ratio 1/8;
    - lowpass 300 and 80 Hz;
    - lengths 1.5 and 5 s.
  - `'a far shell thumps after its distance'`, at 200 and 800 m.
  - **e2e:** `'distant artillery is heard'`: after 40 s at `heavy`, `kinds.rumble` and `kinds.thump` are above 0. The silent browser's `kinds` stays `{}`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement,** as ruling 8 sets out.
- [ ] **Step 4: Run them to see them pass.**
- [ ] **Step 5: Commit** ("Hear the distant guns").

### Task 7: Proof

**Files:**
- Modify:
  - `tests/e2e/perf.spec.ts`: a new `'a heavy dusk's barrages'` at the overview and no man's land at dusk, `heavy`, `runLights(120)`, GPU p95 ≤ 14 ms. B1's heavy night now carries barrages too; log the flashes seen.
  - `tests/e2e/screenshots.spec.ts`, written to `artifacts/b2`:
    - `'a barrage on the horizon at dusk'`, and the same at night: the battle held at a horizon flash 0.02 s old, the camera turned to it, with a hold 0.5 s before it beside it;
    - `'a far shell's flash and its smoke at dusk'`: held at its flash, and 20 s on.
  - `data/tunables.toml`: `[battle.flashes]` `sky` and `far`, set by eye from the captures.
- Test: the whole suite.

- [ ] **Step 1: Write the perf test and the captures.**
- [ ] **Step 2: Run them and look at every capture.** Set `sky` and `far` until a barrage reads on the horizon at dusk and at night without washing out the sky. Ledger the look calls left for the user.
- [ ] **Step 3: Run everything:** `npm test && npx tsc --noEmit -p . && npx playwright test`. Expected: all green.
- [ ] **Step 4: Commit** ("Prove the distant artillery: its perf and captures").
