# G5: Recoil with Weight, and the Reports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Give every gun's recoil weight without making it dishonest: the kick, climb and ceiling rise, and the camera rolls and shakes in ways that cannot move a round.
- Give each gun a report with a body, a crack, an action and a shared tail.
- Render every voice to a file the user can hear.

**Architecture:**
- **The aim's numbers** change only in `[recoil.*]`.
- **The camera's punch** is two new view-kick channels: a roll spring and a short shake. They join `Session.view()`, which the camera rig and the rifle already read, and touch nothing the ballistics read.
- **The report** is rebuilt in `voices.ts` as four layers, and `engine.ts` gains one shared reverb bus that every report sends to.

**Tech Stack:** TypeScript, WebAudio (OfflineAudioContext for the render tool), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-03-trenchline-shots-design.md` §3 and §6.

## Global Constraints

- **The recoil table** (degrees: kick, climb per shot, ceiling):

  | Gun | Kick | Climb per shot | Ceiling |
  |---|---|---|---|
  | AK | 0.44 | 0.32 | 1.90 |
  | M4 | 0.39 | 0.26 | 1.67 |
  | MP5 | 0.23 | 0.16 | 1.09 |
  | M249 | 0.42 | 0.20 | 2.53 |
  | SVD | 2.08 | 1.08 | 2.88 |
  | M870 | 3.90 | 1.80 | 3.45 |
  | M17 | 1.17 | 0.66 | 2.30 |
  | PM | 1.37 | 0.72 | 2.30 |

  `[recoil.defaults]` scales the same way: kick 0.39, climb 0.36 and ceiling 2.30. Settle times, drift, jitter and burst reset stay as they are.
- **Camera roll** (`cam_roll_deg`; its side drawn per shot, settling `cam_roll_settle_s` 0.12 s at damping 1):
  - AK, M4 and M249: 0.7;
  - MP5: 0.45;
  - SVD: 1.4;
  - M870: 1.8;
  - M17 and PM: 0.9.
- **Shake:** `cam_shake_m` 0.0015 and `cam_shake_deg` 0.12, for `cam_shake_s` 0.06 after a shot, drawn per tick.
- **Viewmodel punch:** `punch_back_m` × 1.3 and `punch_pitch_deg` × 1.25 for every `[viewkick.*]`, and `damping_ratio` 0.7. FOV pulses unchanged.
- **Aim-in overshoot:** 0.4° of the gun's pitch past the aim, settling over 0.15 s. It belongs to `Handling` (G4), and is added here if G4 left it out.
- **Report layers:**
  - a click: 2 ms of broadband noise;
  - a body: a sine at `report_body_hz`, falling a third over 60 ms;
  - a crack: noise bandpassed 1.5–4 kHz over 25 ms;
  - an action: a click at 3–6 kHz, 15 ms later, over 10 ms;
  - a tail: a send of `report_tail_send` 0.35 to one shared ConvolverNode. Its impulse is generated: 1.2 s of decaying noise, its highs falling faster.

  `report_body_hz` per gun (in `[viewkick.*]`): AK 140, M4 150, MP5 190, SVD 110, M249 135, M870 95, and the pistols 210. Suppressed reports keep the crack, lose the body's highs, and send half as much to the tail.
- **Sound files:** `npm run sounds` renders every `VoiceKind` to `artifacts/sp7/sounds/<kind>.wav` (48 kHz mono). Every peak lies between −30 and −1 dBFS, and none is silent.
- **Commits:** branch `shots`, never pushed. End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Quiet e2e only.

## Review Focus

- **The roll cannot move a round,** and neither can the shake's rotation: rounds leave along the player's yaw and pitch plus the recoil's aim, never `view.roll`. Task 1 fires the same intents with roll and shake on and off: every round lands in the same voxel.
- **Pinned by suppression and firing:** suppression's shake and the new shake add, and the sum must stay bounded (roll ≤ 3°) under the heavy front plus a full-auto magazine. Task 1 tests it.
- **The reverb bus under 64 voices:** one convolver, not one per voice. `audio().voices` and the engine's cap behave as before. Task 2 tests that a magazine on full auto adds no convolver nodes after the first.
- **`feel.test`'s plateau and settle numbers** move with the new table. Re-pin them from the new values with the same reasoning in their comments (the plateau in about 8 rounds; the kick gone in about 0.22 s). Don't loosen tolerances to pass.
- **A suppressed SVD and an unsuppressed one** must still differ in loudness and tone. Task 2 renders both, and the suppressed peak is at least 6 dB under.

---

### Task 1: The new recoil table, and the camera's roll and shake

**Files:**
- Modify: `data/tunables.toml`: the `[recoil.*]` values; `[viewkick.*]` `cam_roll_deg`, `cam_roll_settle_s`, `cam_shake_m`, `cam_shake_deg` and `cam_shake_s`; the punch and damping changes.
- Modify: `src/combat/viewkick.ts`:
  - `ViewKickProfile` gains `camRollDeg`, `camRollSettleS`, `camShakeM`, `camShakeDeg` and `camShakeS`;
  - `ViewKick` gains `camRoll` (a spring) and `shake: { offset: [number, number, number]; pitch: number; yaw: number }` (drawn per tick while `sinceShot < camShakeS`, from its own `Rng` stream passed into `shot()`/`tick()`).
- Modify: `src/sim/session.ts`: `ViewOffsets` gains `shake: [number, number, number]` (metres). `view()` adds `camRoll` to `roll`, and the shake's pitch and yaw to the view's (camera only). `viewAt` interpolates them.
- Modify: `src/app/camera-rig.ts`: adds `view.shake` to the eye's position.
- Test: `tests/combat/viewkick.test.ts` and `tests/combat/recoil.test.ts` (re-pin); `tests/sim/feel.test.ts` (re-pin); `tests/sim/honest-roll.test.ts` (new).

**Interfaces:**
- Produces: `ViewOffsets.shake`, `ViewKick.camRoll` and `ViewKick.shake`.

- [ ] **Step 1: Write the failing tests:**
  - `honest-roll`: the same 30-round burst with `cam_roll_deg` and `cam_shake_*` at their values, and at 0. `events.impacts` cells are identical;
  - roll ≤ 3° under heavy fire plus full auto;
  - the shake is gone 0.06 s after the last shot.

  Re-pin `recoil.test` and `feel.test`'s numbers from the new table, keeping each comment's reasoning.
- [ ] **Step 2: Run them to make sure they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** (attribution line).

---

### Task 2: The reports, the reverb bus, and `npm run sounds`

**Files:**
- Modify: `src/audio/engine.ts`: one shared `ConvolverNode` (its impulse generated at start, seeded), returned from `engine.tail` into the mix; voices may send to it.
- Modify: `src/audio/voices.ts`:
  - the `report` voice is rebuilt as the layers above. Its plan carries `bodyHz` and `suppressed` (from the shot's gun and mark via `audio/plan.ts`);
  - `afar` reports (the front's, others') keep their lowpass and delay, and send less to the tail as they are farther (the lowpass's share).
- Modify: `src/audio/plan.ts`: `report_body_hz` per gun, read from `[viewkick.<gun>]`, or the defaults' for the front.
- Create: `tools/render-sounds.mjs` and an `npm run sounds` script in `package.json`.
  - It serves a page (via the Vite dev server, as `tools/stills.mjs` does) that renders each `VoiceKind` through `voices.ts`'s own functions into an OfflineAudioContext.
  - It writes WAVs to `artifacts/sp7/sounds/`.
  - It prints a table of each file's peak dBFS, RMS, and energy share in 400 Hz–2 kHz.
  - It exits non-zero if a peak is outside −30 to −1 dBFS.
  - It covers `report-ak`, `report-svd`, `report-svd-suppressed`, `report-m870` and `report-pistol` beside the other kinds.
- Test: `tests/audio/plan.test.ts` (reports carry `bodyHz`); `tests/e2e/audio.spec.ts` (add: `'a magazine on full auto shares one reverb'`, by a hook counting the engine's convolvers).

- [ ] **Step 1: Write the failing tests** listed above.
- [ ] **Step 2: Run them to make sure they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run:** `npx vitest run && npx playwright test tests/e2e/audio.spec.ts && npm run sounds`. Expected: PASS, with every peak in range, and the suppressed SVD ≥ 6 dB under the bare one.
- [ ] **Step 5: Commit** (attribution line).
