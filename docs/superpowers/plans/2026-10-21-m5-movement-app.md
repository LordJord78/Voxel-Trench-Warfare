# Milestone 5: Movement and App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A visitor sees a loading screen while the world generates, clicks to play, and walks the 10 cm world from the front-line bay with every stance. The movement matches the Python controller tick for tick.

**Architecture:**
- `src/physics` ports Python's `vec`, `collision` and `character` line for line. Collision runs against a `VoxelGrid` interface, so the same controller replays a 0.5 m parity fixture and walks the 10 cm brick map.
- `src/sim/session.ts` owns the player, the controller and a 60 Hz `FixedClock`.
- `src/app` turns keys and the mouse into intents, places the camera (interpolated foot, eye height, bob, landing dip, periscope FOV), and runs the loop.
- `src/ui` holds the loading screen, the pause menu and the periscope frame, as DOM over the canvas.

**Tech Stack:** TypeScript 7 strict, Vite 8, Vitest 5, Playwright 1.64 (installed Chrome, WebGPU), Python 3.13 for the fixture exporter (`.venv`).

**Spec:** docs/superpowers/specs/2026-10-21-trenchline-web-world-design.md (§1 Movement parity, §4 Simulation, Movement and App, Build order step 5).

## Global Constraints

- `core`, `world`, `physics` and `sim` import nothing from `render`, `ui` or `app`, and touch no DOM or WebGPU globals. They use `core/dmath.ts`, never `Math.sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `exp`, `expm1`, `log`, `log1p`, `log2`, `log10`, `pow`, `cbrt`, `hypot`, `sinh`, `cosh`, `tanh` or `Math.random`. `tests/architecture.test.ts` enforces both.
- Python's conventions:
  - yaw 0 looks down +z and right is +x;
  - yaw and pitch are in degrees;
  - the horizontal field of view is 90°.
- The movement port matches Python on the parity fixtures within 1 mm per tick.
- From navigation to the "click to play" prompt: ≤ 4 s in Chrome on the M1 Pro, from a local server.
- Keys:
  - W A S D move; Shift sprints; Space jumps.
  - C crouches; Z goes prone; Q raises the periscope on a firing step.
  - Esc opens the pause menu.
  - F3 is the overlay, and M4's keys stay.
- Pause menu: quality preset, mouse sensitivity, field of view, a time-of-day slider, and resume.
- Head bob, landing dip and the periscope's FOV easing come from `[camera]`. The periscope gets a CSS mirror-frame overlay.
- Capture hooks on `window.__trenchline`: teleport, set the time of day, wait for convergence, read timings, read the world fingerprint.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `reference/python` keeps passing its own suite (`.venv/bin/python -m pytest` in `reference/python/`).

## Review Focus

- **Keys held while focus leaves the page.** Examples: alt-tab with W down, the pointer lock lost to Esc, the menu opened mid-stride. The player must stop, not walk on forever. Pinned in Task 5 (`blur()` releases every key) and Task 6 (pausing clears input).
- **A pointer lock that fails or is refused.** Headless Chrome, a lock requested too soon after Esc, or the user denying it. Play must still start, Esc must still pause, and Resume must not throw unhandled rejections. Pinned in Task 6.
- **Low ceilings and stance at 10 cm.** In dugouts and the culvert, standing up is refused, and the eye never rises into the roof while the body is refused. Pinned by the parity fixture's ceiling scenario (Task 3) and the e2e crouch test (Task 7).
- **Display rates other than 60 Hz, and long gaps.** At 30, 120 and 144 Hz the simulation runs the same 60 Hz ticks and the camera interpolates. A hidden tab coming back runs at most the clock's catch-up, never a fall through the floor. Pinned in Task 4 (session tests at several frame intervals).
- **Fast falls onto thin floors.** At 10 cm a duckboard is one voxel. A body falling one voxel per tick or faster must still land, not tunnel. Pinned in Task 3 (`a prone body falling at full speed lands on a one-voxel floor`).

---

### Task 1: Parity fixtures from the Python controller

**Files:**
- Create: `reference/python/tools/export_parity.py`, `reference/python/tests/test_parity_export.py`, `tests/fixtures/parity/{walk-slide,steps,ceiling,fall-wade}.json`
- Modify: `package.json` (script `parity:export`)

**Interfaces:**
- Produces: one fixture per scenario:
  ```
  { scenario, voxel: 0.5, dims: [32, 16, 32],
    boxes: [[x0, y0, z0, x1, y1, z1, material], ...],   // half-open voxel boxes, applied in order; ids are Python's (= TS kinds 0–17)
    controller: { radius, stepUp, gravity, jumpSpeed, groundAccel, airAccel, friction, maxFall, headBobHz,
                  stances: [{ height, eyeHeight, speed, sprintSpeed, swayScale, exposure, transitionTime, fovScale } × 5] },  // index = Stance
    dt: 1/60,
    start: { position, yaw, pitch, stance, height, onGround },
    ticks: [{ forward, strafe, jump, sprint, stance, periscope, yaw, pitch }],
    states: [{ position, velocity, stance, height, onGround, onFiringStep, wadeDepth, landingImpact, bobPhase, blockedStance }] }
  ```
  `states[i]` is the state after tick `i`, with the yaw and pitch of `ticks[i]` set before it ran.

**The scenarios.** Every world is SOD ground over y < 4, so its top is at 2.0 m, plus the boxes listed. The player starts standing on that ground unless stated.

| Scenario | Boxes beyond the ground | Start (m, yaw) | Ticks |
|---|---|---|---|
| walk-slide | BRICK wall x [20, 21), y [4, 10), z [4, 28) | (6, 2, 8), 90 | 0–89 forward. 90–179 forward at yaw 60, sliding along the wall. 180–239 sprint forward at yaw 0. 240–299 nothing (friction). 300–359 strafe −1. |
| steps | SOD kerb x [8, 12), y [4, 5), z [0, 32). TIMBER step x [16, 19), y [4, 5), z [0, 32). BRICK wall x [19, 20), y [4, 10), z [0, 32). | (2, 2, 8), 90 | 0–149 forward: up the kerb, off it, onto the step. 150–209 periscope. 210–269 nothing. 270–359 forward −1. |
| ceiling | TIMBER roof x [8, 16), y [7, 8), z [2, 14), leaving 1.5 m under it | (2, 2, 8), 90 | 0–29 crouched. 30–149 crouched forward. 150–209 standing (refused). 210–299 prone. 300–419 prone forward. 420–479 standing (refused). 480–599 crouched forward. 600–659 standing. |
| fall-wade | SOD platform x [0, 8), y [4, 6), z [0, 32). AIR pit x [16, 20), y [3, 4), z [0, 32), then WATER in the same box. | (2, 3, 8), 90 | 0 jump. 1–89 nothing. 90–389 forward: off the platform at 4 m, into the pit, out the far side. |

- [ ] **Step 1: Write the failing Python test** `reference/python/tests/test_parity_export.py`:
  - `test_scenarios_are_deterministic`: `run_scenario(name)` twice gives equal dicts, for every name in `SCENARIOS`.
  - `test_scenarios_exercise_what_they_claim`:
    - walk-slide: x never exceeds 10.0 − 0.30 + 1e-6. While pressing into the wall at yaw 60, z rises by at least 1.0 m.
    - steps: some state's stance is FIRING_STEP and a later one PERISCOPE. Some state stands at y = 2.5 on the kerb.
    - ceiling: some state has `blocked_stance`. Some state is PRONE with height 0.55. The final state is STANDING with height 1.8.
    - fall-wade: max `landing_impact` > 3.0, and max `wade_depth` > 0.3. The final state is on the ground at y = 2.0.
- [ ] **Step 2: Run it.** `cd reference/python && ../../.venv/bin/python -m pytest tests/test_parity_export.py -q`. Expected: FAIL, because there is no module `tools.export_parity`.
- [ ] **Step 3: Implement `tools/export_parity.py`.**
  - `SCENARIOS: dict[str, Scenario]` and `run_scenario(name) -> dict` (the fixture as above).
  - `main(outdir)` writes `<outdir>/<name>.json` with sorted keys and floats as Python's `repr`.
  - Build each world by `VoxelWorld(WorldDims(32, 16, 32))` and writes to `world.v`. Use `CharacterController(world, load_tunables())`.
  - The `controller` block is read back from that controller, so it is exactly what Python ran.
- [ ] **Step 4: Run it.** The pytest file passes, and the whole Python suite stays green: `../../.venv/bin/python -m pytest -q`.
- [ ] **Step 5: Export.**
  - Add `"parity:export": "cd reference/python && ../../.venv/bin/python -m tools.export_parity ../../tests/fixtures/parity"` to package.json.
  - Run it. Expected: four JSON files, each with as many states as ticks.
- [ ] **Step 6: Commit** "Export the Python controller's per-tick states on four small worlds, as the parity fixtures".

### Task 2: Vectors and voxel collision

**Files:**
- Create: `src/physics/vec.ts`, `src/physics/collision.ts`, `src/physics/grid.ts`
- Test: `tests/physics/collision.test.ts`

**Interfaces:**
- Produces:
  - `class Vec3 { readonly x; y; z; add; sub; mul(k); div(k); neg; dot; cross; length; lengthSq; horizontalLength; normalised(); withY(y); lerp(o, t) }`, plus `ZERO`, `UP`, `fromYawPitch(yaw, pitch)` and `yawBasis(yaw): [forward, right]`. These are Python's `vec.py` with dmath's `sin` and `cos`; `horizontalLength` is `sqrt(x² + z²)`.
  - `interface VoxelGrid { readonly voxel: number; kindAt(x, y, z): number }`. Outside the world, the sides and bottom read `K.SUBSOIL` and above reads `K.AIR`, as Python's `VoxelWorld.get`.
  - `brickGrid(map: BrickMap, voxel: number): VoxelGrid`, whose kind is `kindOf(map.get(...))`.
  - `boxGrid(dims: [number, number, number], voxel: number, boxes: readonly number[][]): VoxelGrid`: a dense grid of kinds with boxes applied in order, for fixtures and tests.
  - `boxHitsSolid(g, centre: Vec3, halfX, height, halfZ = halfX): boolean`.
  - `groundHeightUnder(g, centre, halfX, maxDrop): number | null`.
  - `supportIs(g, centre, halfX, kind): boolean`.
  - `submergedDepth(g, centre, height): number`.
  - All of these follow `collision.py`, with `_EPS = 1e-4` and solidity from `KIND_SOLID`.

- [ ] **Step 1: Write the failing tests** in `tests/physics/collision.test.ts`, on `boxGrid([16, 16, 16], 0.5, …)` and on a `brickGrid` of a 64³ `BrickMap` at 0.1:
  - **Touching is not overlapping.** A 0.3-radius box whose side lies exactly on a wall's face does not hit it, and 1e-3 further does.
  - **Outside the world.** It is solid to the sides and below, and air above. A box at y = dims.y·voxel + 1 hits nothing.
  - **Ground.** `groundHeightUnder` from 1.2 m above a floor whose top is at 2.0 m returns 2.0. Over a 3 m drop with `maxDrop` 1 it returns null.
  - **Support.** `supportIs` is true for TIMBER when one boot is over a one-voxel timber tread and the centre is over air (Python's docstring case).
  - **Water.** `submergedDepth` in 0.5 m of water over a floor at 1.5 m returns 0.5 at 0.5 m voxels, and 0.5 at 0.1 m voxels.
  - **Wire and cloth are not solid; duckboards are.** These are the 10 cm kinds through `brickGrid`.
- [ ] **Step 2: Run** `npx vitest run tests/physics/collision.test.ts`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** it, then `npx vitest run tests/architecture.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** "Port vectors and voxel collision, against any voxel size".

### Task 3: The character controller, matching Python

**Files:**
- Create: `src/physics/character.ts`
- Test: `tests/physics/parity.test.ts`, `tests/physics/character.test.ts`

**Interfaces:**
- Consumes: Task 2's grid and collision; Task 1's fixtures.
- Produces:
  - `const Stance = { STANDING: 0, CROUCHED: 1, PRONE: 2, FIRING_STEP: 3, PERISCOPE: 4 } as const`, and `type Stance`.
  - `interface StanceProfile`, and `interface ControllerTunables`: the fixture's `controller` block.
  - `controllerTunables(tun: Tunables): ControllerTunables`, read from `[player]`, `[stance.*]` and `camera.head_bob_hz`. The firing step's eye height is `eye_height_standing` and the periscope's is `eye_height_periscope`, as Python's `load_stances`.
  - `interface MoveIntent { forward; strafe; jump; sprint; stance; periscope }`.
  - `interface CharacterState { position: Vec3; velocity: Vec3; yaw; pitch; stance; height; onGround; onFiringStep; landingImpact; bobPhase; wadeDepth; blockedStance; speedScale; pinned }`, and `newCharacter(position: Vec3, yaw, pitch): CharacterState` (standing, height 1.8, not on the ground).
  - `class CharacterController { constructor(grid: VoxelGrid, t: ControllerTunables); tick(state, intent, dt): void; profile(state): StanceProfile; eyeHeight(state): number; fovScale(state): number }`. This is `character.py` line for line: `_resolve_stance`, `_wish_velocity`, `_accelerate`, `_apply_gravity`, `_integrate`, `_slide` and `_post_move`. The firing-step test is `supportIs(…, K.TIMBER)`.

- [ ] **Step 1: Write the failing tests.**
  - `parity.test.ts`, for each fixture file:
    - Build `boxGrid` and a controller from its `controller` block.
    - Start from `start`, and for each tick set yaw and pitch, then `tick(state, intent, dt)`.
    - Position and height must be within 1e-3 m of `states[i]`, and velocity within 1e-3 m/s. Stance, `onGround`, `onFiringStep` and `blockedStance` must be equal. `wadeDepth`, `landingImpact` and `bobPhase` must be within 1e-3.
    - The first failing tick is reported with both states.
  - `parity.test.ts`: `controllerTunables(loadTunables())` deep-equals every fixture's `controller` block. The game walks with the numbers Python was checked with.
  - `character.test.ts`, at 0.1 m:
    - A prone body falling at full speed (55 m/s) from 20 m lands on a one-voxel duckboard floor over air, instead of passing through it.
    - Standing up under a 1.5 m ceiling is refused, `blockedStance` is set, and the height stays at the crouched 1.25.
- [ ] **Step 2: Run** `npx vitest run tests/physics/`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement `character.ts`.**
  - Use dmath for `sin` and `cos`; `math.copysign(a, b)` becomes `b < 0 ? -a : a`.
  - `bob_phase %= tau` keeps JavaScript's `%`, because the phase is never negative.
  - If the tunnelling test fails, the vertical move is split into sub-steps of at most one voxel each. Ruling: parity holds at 0.5 m, because Python's steps never exceed one 0.5 m voxel there.
- [ ] **Step 4: Run** `npx vitest run tests/physics/ tests/architecture.test.ts`. Expected: PASS on all four fixtures and every tick.
- [ ] **Step 5: Commit** "Port the character controller: five stances, step-up and step-down, wading, matched to Python within a millimetre a tick".

### Task 4: Session, clock and camera

**Files:**
- Create: `src/sim/session.ts`, `src/app/camera-rig.ts`
- Modify: `src/render/camera.ts` (`CameraPose.fov`), `src/render/frame-uniforms.ts` (`writeCamera` writes `tanHalf = tan(fov/2)`)
- Test: `tests/sim/session.test.ts`, `tests/app/camera-rig.test.ts`, `tests/render/camera.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3's controller; `core/clock.ts` `FixedClock`; `core/rng.ts`; `world.spawn` (foot centre in metres).
- Produces:
  - `class Session`:
    - fields `clock`, `controller`, `player`, `intent`, `prevPosition`, `streams` (an `Rng`);
    - `static create(world: { map: BrickMap; plan: WorldPlan; spawn: Spawn }, tun: Tunables, seed: number)`;
    - `advance(realDt): number` (the ticks it ran); `tick()`;
    - `footAt(alpha = clock.alpha): Vec3` (prevPosition lerped to position);
    - `teleport(position: [number, number, number], yaw, pitch)` (zero velocity, standing, settles on the next tick).
  - `CameraPose.fov?: number`: horizontal degrees, default 90. It is used by `rayDir`, `projectToPixel` and `writeCamera`.
  - `class CameraRig`:
    - `constructor(t: RigTunables)`; `rigTunables(tun)` reads `[camera]`;
    - field `fovScale`;
    - `pose(session, frameDt, baseFov): CameraPose`. The eye is at `footAt()` + `eyeHeight` + bob + dip, with sway along the camera's right vector. The FOV is `baseFov · fovScale`, eased by `min(1, fov_lerp_per_s · frameDt)`. These are Python's `_place_camera` and `_place_viewmodel` formulas, without roll.

- [ ] **Step 1: Write the failing tests.**
  - `session.test.ts`, on a 64³ map at 0.1 m with SOD below y = 20:
    - From a spawn 0.5 m above the ground, 60 idle ticks leave the player on the ground at y = 2.0.
    - `advance(1/30)` runs 2 ticks and `advance(0.004)` runs 0 with alpha 0.24. `footAt` at alpha 0.5 is halfway between the last two ticks.
    - Frame intervals of 1/30, 1/120 and 1/144 s over the same 2 s of held W reach the same position within 1e-9 m, because only whole ticks move the player.
    - A 5 s gap runs at most `maxSubsteps` ticks and the player is still on the ground.
    - The same seed and intents give identical states.
  - `camera-rig.test.ts`:
    - A standing still player's eye is at foot + 1.62. A crouched one (height 1.25) is at foot + 1.10.
    - The bob is zero standing still. At 5 m/s it stays within ±0.035.
    - A landing impact of 8 dips the eye by 0.11.
    - Moving to the periscope, the FOV scale is 0.9323 after one 1/60 s frame and within 0.001 of 0.42 after 60 frames.
  - `camera.test.ts`:
    - With `fov: 60`, `rayDir` at the image's left and right edge centres is 30° from forward.
    - `projectToPixel` inverts `rayDir` at fov 60.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npx playwright test tests/e2e/primary.spec.ts tests/e2e/taa.spec.ts`. Expected: PASS. The 90° default leaves every shader test unchanged.
- [ ] **Step 5: Commit** "Run the player in a 60 Hz session and place the camera: interpolated, bobbing, dipping on landings, narrowing for the periscope".

### Task 5: Input

**Files:**
- Create: `src/app/input.ts`
- Test: `tests/app/input.test.ts`

**Interfaces:**
- Produces: `class Input`:
  - `keyDown(code, repeat)`, `keyUp(code)`, `blur()`;
  - `mouse(dx, dy)`;
  - `intent(): MoveIntent`;
  - `look(state: { yaw; pitch }, sensitivity, pitchLimit)`, which applies and clears the mouse it has gathered;
  - `lowerPeriscope()`.
  - Keys:
    - C toggles crouched against standing, and from prone goes to crouched.
    - Z toggles prone against standing.
    - Q toggles the periscope.
    - A held key's repeats toggle nothing.

- [ ] **Step 1: Write the failing tests:**
  - **Movement keys.** W → forward 1; S → −1; W + S → 0; D → strafe +1; A → −1; Shift → sprint; Space → jump.
  - **Stance toggles.** C, then C → crouched, then standing. Z, C → prone, then crouched. Z, Z → prone, then standing. Q → periscope; Q again → none; `lowerPeriscope()` → none.
  - **Repeats.** A repeated C keydown toggles nothing.
  - **Blur.** `blur()` with W held → forward 0.
  - **Mouse.** dx = 100 at sensitivity 0.14 turns yaw by +14, wrapped into [0, 360). dy = +100 lowers pitch by 14. Pitch is clamped to ±88.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** "Turn keys and the mouse into the controller's intents, with stance toggles and focus loss handled".

### Task 6: Loading screen, play, pause, periscope frame

**Files:**
- Create: `src/ui/loading.ts`, `src/ui/pause.ts`, `src/ui/periscope.ts`, `src/ui/settings.ts`
- Modify: `src/app/main.ts`, `index.html`
- Test: `tests/ui/settings.test.ts`, `tests/e2e/support/app.ts` (hooks)

**Interfaces:**
- Produces:
  - `loadSettings(storage: Pick<Storage, 'getItem'> | null): Settings` and `saveSettings(storage, s)`.
    - `Settings { preset: 'high' | 'low'; sensitivity; fov; timeOfDay }`.
    - Defaults: high, `player.mouse_sensitivity`, `camera.fov`, 0.
    - Values are clamped to sensitivity [0.02, 0.6], fov [60, 110] and time of day [0, 1]. Anything unreadable falls back to the defaults.
  - The DOM:
    - `#loading` holds the title, a progress bar, `#status` (the phase, or the error) and `#play` ("Click to play", with the controls listed).
    - `#pause` holds Resume and the four controls.
    - `#periscope` is a dark frame with a horizontal mirror slit, its opacity following `(1 − fovScale) / (1 − 0.42)`.
  - Modes: `loading` → `ready` (frames render behind `#loading`, and `#play` shows) → `playing` ⇄ `paused`, plus `fly` for the standard views.
  - Hooks:
    - `play()`;
    - `teleport({ position, yaw, pitch })`;
    - `player()`, returning position, velocity, stance, height, onGround, onFiringStep and wadeDepth;
    - `camera()`, returning the last pose with its fov;
    - `mode()`;
    - `waitConverged()` (waits `history_max` + 8 frames);
    - `promptMs`, when `#play` first showed.
    - `view(name)` enters `fly` at that view, as before; `walk()` returns to `playing`.

- [ ] **Step 1: Write the failing test** `tests/ui/settings.test.ts`: defaults with no storage; defaults for corrupt JSON; out-of-range values clamped; a save and load round trip.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** settings, then the DOM pieces and `main.ts`.
  - **Order.** Check WebGPU first. Start the workers, with progress on `#loading`. Upload. Create the `Session` at `world.spawn`. Render behind `#loading` and show `#play`.
  - **Play.** Clicking `#play` or the canvas enters `playing` and requests pointer lock. A refused lock is caught and play continues.
  - **Pause.** Esc, or losing the lock, pauses: input is cleared and the simulation stops, but frames keep rendering behind the menu. Resume re-requests the lock and catches a refusal.
  - **Frames.** Each frame: `look`, then `advance` (setting `session.intent` before each tick), `lowerPeriscope()` when the player is not on a firing step, the rig's pose, `render`, and the periscope frame's opacity.
  - Backquote toggles `fly`. Settings are saved on change and applied at start.
- [ ] **Step 4: Run** `npm test` and `npx playwright test tests/e2e/app.spec.ts tests/e2e/smoke.spec.ts`. Expected: PASS. The app tests now click `#play` where they need play.
- [ ] **Step 5: Commit** "Load to a click-to-play prompt, walk the world, and pause to a menu of quality, sensitivity, field of view and time of day".

### Task 7: Play, end to end

**Files:**
- Create: `tests/e2e/play.spec.ts`
- Modify: `tests/e2e/perf.spec.ts`, `tests/e2e/screenshots.spec.ts` (only if they need `fly`, which `view` already gives)

- [ ] **Step 1: Write** `play.spec.ts`:
  - `'the prompt comes within 4 s, after the phases show'`: `promptMs` ≤ 4000. The status showed at least two phases, sampled by polling `#status`.
  - `'walking along the bay keeps to the floor'`:
    - Click play, and teleport to the spawn facing along the bay.
    - Hold W for 60 frames: the player moves more than 1.5 m horizontally.
    - The player stays on the ground, and y stays within 0.6 m of the spawn's.
  - `'the firing step raises you, and Q the periscope'`:
    - Teleport onto the bay's bench, facing the enemy. Within 30 frames the stance is FIRING_STEP.
    - Press Q: within 60 frames the stance is PERISCOPE, the camera fov is under 40° and `#periscope` is visible.
    - Press Q: the stance goes back to FIRING_STEP.
  - `'crouch and prone'`:
    - C → height 1.25 within 30 frames.
    - Z → 0.55 within 60 frames.
    - Z → 1.8 within 60 frames, in the open.
  - `'Esc pauses, and the menu changes the game'`:
    - Escape → `#pause` visible, and the player does not move with W held.
    - FOV slider at 70 → camera fov 70.
    - Time slider at 1 → the renderer's sky is night.
    - Quality to low → `stats().preset` is low.
    - Resume → `#pause` hidden, and mode is `playing`.
  - No test has GPU or console errors.
- [ ] **Step 2: Run** `npx playwright test tests/e2e/play.spec.ts`. Expected: PASS. A failure here is a bug in Tasks 2–6: fix it there, with its own failing unit test.
- [ ] **Step 3: Run** `npm test && npm run typecheck && npm run e2e`. Expected: PASS.
- [ ] **Step 4: Commit** "Play the game end to end: load, walk, mount the step, raise the periscope, crouch, go prone, pause".

---

### Milestone check

- [ ] `npm test && npm run typecheck && npm run build && npm run e2e`. Expected: all green.
- [ ] `cd reference/python && ../../.venv/bin/python -m pytest -q`. Expected: green.
- [ ] `node tools/preview-gen.mjs --prod`. Expected: navigation to the prompt in ≤ 4 s. The tool now waits for `promptMs`.
- [ ] Walk the front-line bay in a screenshot run:
  - capture `artifacts/m5/walk-{0..3}.png` while holding W;
  - capture one from the firing step and one through the periscope;
  - review them by eye for grain while moving, the periscope frame, and head bob.
