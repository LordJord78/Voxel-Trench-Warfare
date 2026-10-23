# Combat, Milestone 5: Digging and the HUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A player can dig a shelled bay back out, a scoop at a time, with a scrape for each, and sees their magazine, their stance, how exposed they are, their digging and a crosshair; suppression greys the picture and closes it in.

**Architecture:**
- **Sim side** (`src/combat`, deterministic): the reference's entrenching tool, at 10 cm and in scoops. Each scoop clears the nearest loose voxels in reach and runs a collapse over its neighbourhood.
- **Session:** digging is an intent (F, held), refused prone, through the periscope or off the ground. It widens the aim's sway, raises the exposure the HUD shows, and waits while a crater's region is out.
- **Render side:** the present pass greys and vignettes the picture by suppression.
- **UI:** a DOM HUD over the canvas in the page's type and colours.
- **Sound:** a scrape per scoop.

**Tech Stack:** TypeScript, WGSL, WebGPU, DOM and CSS, WebAudio, Vitest, Playwright (Chrome).

**Spec:** docs/superpowers/specs/2026-10-22-trenchline-web-combat-design.md:
- build order item 5;
- done-table row 5;
- §5 ("Digging", "The HUD", "Sound"'s digging);
- the Testing section's `test_entrenching` and its review captures ("digging out a slumped bay", "suppression under heavy fire").

**Reference:**
- reference/python/trenchline/world/entrenching.py: the tool; `find_target`'s search about a point half the reach ahead; progress that survives letting go;
- reference/python/tests/test_entrenching.py: its tests, ported here at 10 cm;
- reference/python/trenchline/session.py: `_tick_dig` (on the ground and not prone), `exposure()` (the stance's × `exposure_scale` while digging), and the sway × `sway_scale` while digging;
- reference/python/trenchline/ui/hud.py: stance, an exposure bar, the weapon and its rounds or RELOADING, a digging bar or NOTHING TO CLEAR, and the four-tick reticle.

## Global Constraints

- **Architecture rules** (tests/architecture.test.ts): `core`, `world`, `physics`, `sim` and `combat` import nothing from `render`, `ui`, `app` or `audio`; use no DOM, WebGPU, WebAudio or timing globals; and use only the exactly rounded `Math` functions, everything else from `core/dmath`.
- **Every magnitude comes from the tunables.** The spec's numbers:
  - the reference's rate: 0.125 m³ per 1.35 s, which is 93 voxels a second at 10 cm;
  - reach 1.6 m;
  - while digging, aim sways 1.6 times as much, and exposure is scaled by 1.25 (shown only);
  - suppression's look: desaturation 0.55 and vignette 0.5 at full.
- **Loose soil only:** spoil, rubble, sandbags (`isLoose`). Timber, duckboards and undisturbed ground are not shovel work.
- **The HUD** is DOM over the canvas, in the loading screen's and pause menu's type (`--serif`) and colours (`--haze`, `--duckboard`). Suppression's look is drawn in the present pass, not with a DOM overlay.
- **Determinism.** Digging is simulated in the session's tick. The same seed and the same inputs clear the same voxels.
- **The approved look holds.** With no suppression, the present pass's output is unchanged. The standard views and their GPU times are as before.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work stays on `web/world`; nothing is pushed.

## Rulings made in planning

1. **Scoops.** A scoop is `scoop_voxels` (24) voxels, cleared each time `scoop_voxels × voxel³ / m3_per_s` of digging is banked: 0.26 s at 10 cm, so 93 voxels a second.
   - Its voxels are the nearest loose ones to the feet, within `reach_m`. They are searched about a point half the reach ahead, at shin to waist height, as the reference's `find_target` does.
   - The scoop's voxels go: air, thrown over the parapet, as the reference's are.
   - Then `collapseRegion` runs over the scoop's box, grown 2 voxels each way, so whatever rested on it comes down.
   - Banked time survives letting go, as the reference's does, and is capped at one scoop's.
   - **Cost if wrong:** a retune of `scoop_voxels`.
2. **Where digging is refused:** prone (the reference), off the ground (falling or climbing), and with the periscope up (both hands on it). Firing while digging stays allowed, at 1.6× the sway, as the reference's does.
3. **A dig in a region that is out** (a crater's job, milestone 4) waits: the scoop stays banked until the region is in again. The spec holds a dig "made again after its bricks come back", and a scoop chosen from bricks about to be replaced would be cut from the wrong ground.
4. **The dig key is F, held**, as the reference's. It is a movement-style key, read while held. Blurring the page lets go of it, as it does every held key.
5. **Exposure** is the stance's `exposure` (`[player.stances.*]`), × `exposure_scale` while digging. Nothing hits the player yet, so it is shown only, as the spec says.
6. **The HUD** updates ten times a second, as the reference's does. It is hidden with the loading screen, while paused and in fly mode. Its crosshair is hidden through the periscope. The copy is in sentence case:
   - the stance;
   - "Exposure" with a bar;
   - the rifle's rounds as "30 / 30", or "Reloading";
   - "Digging" with a bar, or "Nothing to clear".

## Review Focus

- **The ground slumping onto the player.** A scoop's collapse can slide spoil toward the feet that dug it. The player is never left inside solid. Pinned in Task 2.
- **Nothing to dig.** Holding F with no loose ground in reach banks nothing, clears nothing and says so. Pinned in Tasks 1 and 4.
- **A crater out while digging.** A dig inside a region that is out waits, then goes on, and the world matches the crater cut first, then the scoop. Pinned in Task 2.
- **Leaving the page with F held.** The blur lets go: digging stops. Pinned in Task 2.
- **The HUD where it should not be:** over the loading screen, the pause menu, fly mode, or (the crosshair) through the periscope. Pinned in Task 4.

---

### Task 1: The entrenching tool at 10 cm

**Files:**
- Create: `src/combat/entrenching.ts`
- Modify: `data/tunables.toml` `[entrenching]`:
  - `m3_per_s = 0.0926` (the reference's 0.125 m³ per 1.35 s), replacing `seconds_per_voxel`;
  - `scoop_voxels = 24`.
- Test: `tests/combat/entrenching.test.ts`

**Interfaces:**
- Produces, in `src/combat/entrenching.ts`:
  - `interface EntrenchingTunables { reachM: number; m3PerS: number; scoopVoxels: number; exposureScale: number; swayScale: number }`, and `entrenchingTunables(tun: Tunables)`;
  - `interface Scoop { voxels: number; at: [number, number, number] }` (`at`: the scoop's middle, metres);
  - `class Entrenching`:
    - `constructor(map: BrickMap, t: EntrenchingTunables, voxel: number)`;
    - `banked: number`, `cleared: number`, `inReach: boolean`;
    - `get scoopS(): number`, `get fraction(): number` (banked over a scoop's time, 0 to 1);
    - `findScoop(feet: readonly number[], yaw: number): [number, number, number][]` (voxels, nearest first, ties by index);
    - `work(feet: readonly number[], yaw: number, dt: number, free?: (box: Box) => boolean): Scoop | null`: banks `dt` if anything is in reach, and scoops once a scoop's time is banked and `free(box)` allows.

- [ ] **Step 1: Write the failing tests** in `tests/combat/entrenching.test.ts`, the reference's ported to 10 cm.
  - Fixture `bench()`: a 64 × 64 × 64 map:
    - subsoil to y 16;
    - a heap of spoil and rubble 2 m ahead of the feet: 6 × 4 × 6 voxels of `P.SPOIL` with `P.RUBBLE` on top;
    - a timber revetment and a duckboard beside it.
  - Tests:
    - `'loose fill can be dug: a scoop's worth after a scoop's time'`;
    - `'revetment timber, duckboards and undisturbed ground are not shovel work'` (30 s of digging);
    - `'nothing in reach means no scoop, and nothing banked'` (`inReach` false);
    - `'digging removes the dirt rather than moving it'` (the loose count falls by exactly the voxels cleared);
    - `'it clears the reference's 0.125 m³ per 1.35 s: 93 voxels a second'`: over 10 s within one scoop of 926; after 0.8 of a scoop's time nothing, after 1.2 one scoop;
    - `'progress survives being interrupted'`;
    - `'the progress bar reflects the next scoop'` (0.2 < fraction < 0.9 at half a scoop's time);
    - `'nothing is left hanging over a scoop'`: dig under an overhang of spoil; afterwards no granular voxel within 3 voxels of the scoop has air beneath it;
    - `'digging is deterministic'`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/combat/entrenching.test.ts`
Expected: FAIL: `src/combat/entrenching` does not exist.

- [ ] **Step 3: Implement** `entrenching.ts` and the tunables, as ruling 1 sets out.

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run tests/combat/entrenching.test.ts && npm test && npx tsc --noEmit -p .`

- [ ] **Step 5: Commit** ("Dig loose ground in scoops: the entrenching tool at 10 cm").

### Task 2: Digging in the session

**Files:**
- Modify:
  - `src/physics/character.ts`: `MoveIntent.dig`, and every intent literal in the tests;
  - `src/sim/session.ts`:
    - `readonly entrenching: Entrenching`, `digging: boolean`;
    - `exposure(): number`;
    - the dig in the tick: refused prone, through the periscope or off the ground;
    - the sway × `sway_scale` while digging;
    - `CombatEvents.scoops: (Scoop & { tick: number })[]`;
  - `src/sim/destruction.ts`: `overlapsOut(box: Box): boolean`;
  - `src/app/input.ts`: F held is `dig`;
  - `index.html`: the controls legend gains "F, held: Dig out loose earth".
- Test: `tests/sim/digging.test.ts`, `tests/app/input.test.ts`

**Interfaces:**
- Consumes: Task 1's `Entrenching`, `Scoop`; milestone 4's `Destruction`.
- Produces: `Session.digging`, `Session.exposure()`, `Session.entrenching`, `CombatEvents.scoops`; `MoveIntent.dig`.

- [ ] **Step 1: Write the failing tests.**
  - In `tests/sim/digging.test.ts`, on milestone 4's trench arena (tests/support/worlds.ts):
    - `'a shelled bay can be dug back out'`:
      - a 3 m shell on the parapet's crest;
      - the player on the trench floor, under the slump;
      - 40 s of F held;
      - the loose voxels in the trench's box fall by more than 2,000.
    - `'you cannot dig lying down, through the periscope, or in the air'`.
    - `'digging costs exposure and steadiness'`: exposure × 1.25, and the shot cone's sway × 1.6.
    - `'a dig inside a region that is out waits for it, then goes on'`: a held runner; the world equals the crater, then the scoops.
    - `'the ground slumping in never leaves the player inside solid'`: every tick of the 40 s dig, `boxHitsSolid` is false.
    - `'a scoop is an event'`.
    - `'digging is deterministic'`.
  - In `tests/app/input.test.ts`: `'F held digs, and a blur lets go of it'`.

- [ ] **Step 2: Run them to see them fail.** Expected: FAIL (`dig` is not part of the intent; `entrenching` missing).

- [ ] **Step 3: Implement** as listed.
  - If the slump test fails, it is a controller finding: rule on it in the ledger before changing the controller.

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run tests/sim tests/app tests/physics && npm test && npx tsc --noEmit -p .`

- [ ] **Step 5: Commit** ("Dig in the session: F, held").

### Task 3: Suppression greys and closes in the picture

**Files:**
- Modify:
  - `src/render/shaders/present.wgsl`: `Present` gains `desaturate` (in place of `pad`) and `vignette` (the buffer grows to 16 floats). Before exposure, the colour is mixed toward its luminance by `desaturate`. After tonemapping it is darkened by `1 − vignette × smoothstep(0.35, 1.0, r)`, where `r` is the pixel's distance from the middle over the corner's.
  - `src/render/renderer.ts`: `setSuppressionLook(desaturate: number, vignette: number)`;
  - `src/app/main.ts`: each frame, from `session.suppression.desaturation` and `.vignette`, while playing or paused;
  - `src/app/main.ts` `canvasStats`: gains `saturation` (the mean of (max − min) / max per pixel) and `edge` and `middle` (the mean luminance of the outer tenth and of the middle half).
- Test: `tests/e2e/present.spec.ts`

- [ ] **Step 1: Write the failing test** `'suppression greys the picture and closes it in, and none leaves it as it was'`:
  - the bay at dusk, frozen;
  - snapshots at suppression 0, then 1 (set through `h.session.suppression.level` before each step);
  - at full: saturation × at most 0.6, and edge/middle × at most 0.8;
  - back at 0: within 1% of the first.
  - Also at the low preset and at half scale.

- [ ] **Step 2: Run it to see it fail.** Expected: FAIL (saturation unchanged).

- [ ] **Step 3: Implement** as listed.

- [ ] **Step 4: Run it to see it pass**, with `present.spec.ts`, `screenshots.spec.ts`'s standard views and `perf.spec.ts`.

- [ ] **Step 5: Commit** ("Grey and close in the picture under fire").

### Task 4: The HUD

**Files:**
- Create: `src/ui/hud.ts`
- Modify:
  - `index.html`: `#hud`'s markup and styles;
  - `src/app/main.ts`: the HUD's updates (ten a second) and visibility;
  - the hooks: `hud(): { visible: boolean; crosshair: boolean; text: string }`.
- Test: `tests/e2e/hud.spec.ts`, `tests/ui/hud.test.ts`

**Interfaces:**
- Produces, in `src/ui/hud.ts` (as overlay.ts splits `overlayText` from its element):
  - `interface HudState { stance: Stance; exposure: number; rounds: number; magazine: number; reloading: boolean; digging: boolean; digFraction: number; digInReach: boolean; crosshair: boolean }`;
  - `interface HudLines { stance: string; exposure: { label: string; filled: number; of: number }; rifle: string; dig: { label: string; filled: number; of: number } | null }`;
  - `hudLines(s: HudState): HudLines`, pure;
  - `class Hud { constructor(doc: Document); set visible(on: boolean); update(s: HudState): void }`, which draws `hudLines`.
- The copy:

  | State | Text |
  |---|---|
  | Stances | "Standing", "Crouched", "Prone", "On the firing step", "Periscope up" |
  | Exposure | "Exposure" and a bar of 14, filled to `round(exposure × 10)` |
  | Rifle | "30 / 30" or "Reloading" |
  | Digging | "Digging" and a bar of 8, or "Nothing to clear" |

- [ ] **Step 1: Write the failing tests.**
  - Unit, in `tests/ui/hud.test.ts` (Node, as `tests/ui/overlay.test.ts` tests `overlayText`):
    - `'the HUD says what the state is'`: `hudLines` for each row of the table.
  - e2e, in `tests/e2e/hud.spec.ts`:
    - `'in play the HUD shows the rounds, the stance and a crosshair; R shows reloading; C, crouched'`;
    - `'holding F by spoil shows digging and its bar; by none, nothing to clear'`;
    - `'the HUD is hidden on the loading screen, paused and flying, and the crosshair through the periscope'`.

- [ ] **Step 2: Run them to see them fail.** Expected: FAIL.

- [ ] **Step 3: Implement** as listed.
  - The styles: the page's `--serif`, `--haze` and `--duckboard`, a text shadow for the clay behind.
  - The crosshair: four ticks round a gap (the reference's 0.014 gap, 0.020 long, 0.0022 thick, in the reference's half-height units), drawn as CSS boxes.

- [ ] **Step 4: Run them to see them pass**, with `app.spec.ts` and `play.spec.ts`.

- [ ] **Step 5: Commit** ("Show the rifle, the stance, the digging and a crosshair").

### Task 5: A scrape per scoop

**Files:**
- Modify:
  - `src/audio/plan.ts`: `VoiceKind` gains `'scrape'`; `events.scoops` make one each, at the scoop, at `scrape_gain`;
  - `src/audio/voices.ts`: the scrape: band-passed noise (1.2 kHz, Q 2) rising for 0.04 s and falling over 0.18 s, with a short low thud of the earth landing;
  - `data/tunables.toml` `[audio]`: `scrape_gain = 0.5`.
- Test: `tests/audio/plan.test.ts`, `tests/e2e/audio.spec.ts`

- [ ] **Step 1: Write the failing tests.**
  - Unit: `'a scoop is a scrape where it was dug'`.
  - e2e: `'digging is heard'`: the voices rise while F is held by spoil.

- [ ] **Step 2: Run them to see them fail.** Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run them to see them pass.**

- [ ] **Step 5: Commit** ("Hear each scoop").

### Task 6: Proof

**Files:**
- Modify: `tests/e2e/screenshots.spec.ts`:
  - `'digging out a slumped bay'`: a shell's slump in a bay, before, after 20 s of digging, and after 40 s;
  - `'suppression under heavy fire'`: the step view at dusk and night, heavy rifle fire on;
  - both written to `artifacts/c5`.
- Test: the whole suite.

- [ ] **Step 1: Write the captures.**

- [ ] **Step 2: Run them and look at every capture.** Fix what reads wrong in this task, and ledger each look call left for the user.

- [ ] **Step 3: Run everything**

Run: `npm test && npx tsc --noEmit -p . && npx playwright test`
Expected: all green.

- [ ] **Step 4: Commit** ("Prove the digging and the HUD: captures").
