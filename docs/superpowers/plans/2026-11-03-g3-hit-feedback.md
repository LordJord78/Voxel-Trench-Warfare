# G3: Hit Feedback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make landing a shot punchy and satisfying, and test it. That means:
- markers that pop for a hit, a headshot and a kill;
- a thwack, a crack with a wet gush on headshots, and a kill's thud and chime;
- bodies that flinch and fall the way they were shot;
- blood, mist and spatter on critical hits;
- HEADSHOT and KILL pops;
- and being hit felt at once.

**Architecture:**
- **Blood** comes from the session, which keeps its particles deterministic. It bleeds every body hit as it happens (more on a headshot), and `Session.bleed` lets the app burst a kill. Spatter is a pure world function (`src/world/spatter.ts`) that recolours voxels to new blood shades.
- **Everything else** is the app's: `src/app/hit-feedback.ts` turns a frame's events, the room's kill messages and the range's events into:
  - marker and pop calls (`src/ui/hit-marker.ts`);
  - feedback voices for the audio plan;
  - the flinch and fall of bodies (`soldier-rig.ts` pose inputs, kept per body by `Gaits`);
  - the being-hit flash and aim jolt.

**Tech Stack:** TypeScript, WebAudio (synthesized voices), DOM HUD, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-03-trenchline-shots-design.md` §4 (and §5 for the range's events).

## Global Constraints

- **Critical hit:** a headshot, or the round that kills (the room's `death` message in a match; the range's `kill` event in solo).
- **Marker:**
  - hit: white, held 220 ms;
  - head: gold `#ffc83d`, 1.25× as large, held 320 ms;
  - kill: red `#ff3b2f`, 1.5× as large, with a ring, held 600 ms;
  - every marker pops from 1.6× to 1× over 90 ms and fades over 120 ms; a new hit restarts it;
  - precedence: kill > head > hit.
- **Pop:** "HEADSHOT" (gold) on any headshot, and "KILL" (red) on a kill that is not one. A match kill adds the victim's name in their team's colour. It sits 6vh under the crosshair for 0.9 s.
- **Voices and gains:**
  - `hit` 0.75: a 160 → 90 Hz sine over 60 ms, and a 12 ms click of noise at 2.5 kHz;
  - `head` 0.9: partials at 2.9 and 4.6 kHz over 0.12 s;
  - `gush`: a bandpass sweeping 1.8 kHz → 500 Hz over 0.45 s, its loudness fluttering at a drawn 8–20 Hz, in over 15 ms and out over 0.5 s, over a splat of noise under 400 Hz for 80 ms;
  - `kill`: a 70 → 45 Hz sine over 0.25 s, then 60 ms later a chime of 880 and 1320 Hz over 0.2 s;
  - `ding`: partials at 690, 1640, 2780 and 4100 Hz, ringing 1.2, 0.7, 0.4 and 0.25 s;
  - `hurt`: a low thump, and a 3 kHz ring fading over 0.6 s.

  The shooter hears hit, head, gush and kill at the ear. Others hear them where the body is: `hit` within 30 m, `gush` within 25 m. A `ding` is heard at its plate, late by its distance.
- **Blood:**
  - an ordinary hit: 6 droplets and 1 mist puff;
  - a critical hit: 18 droplets thrown out of the far side at 3.5 m/s with spread 0.6, and 3 mist puffs growing 0.15 → 0.6 m over 0.9 s;
  - a helmet struck: 4 sparks;
  - droplets dark red, lit as dust is.
- **Spatter** (critical hits only): up to 14 rays within a 25° cone along the round, reaching up to 2.5 m. Each recolours the first solid voxel it meets, if its kind takes blood.
- **Blood shades:** appended palette entries BLOOD_SOIL, BLOOD_TIMBER, BLOOD_SANDBAG, BLOOD_DUCKBOARD and BLOOD_CLOTH, each of the kind it marks and nothing but darker red-brown. Mud and clay kinds map to BLOOD_SOIL.
- **Flinch:** the torso leans 12° along the round, and the head snaps 25° on a headshot. It springs back over 0.25 s.
- **A kill's fall:** the body falls toward the killing round's bearing, in 0.45 s if killed by a headshot and 0.7 s otherwise.
- **Being hit:**
  - a red vignette at max(0.25, damage/100), fading over 0.35 s;
  - an aim flinch of 1.5° + 1.5° × damage/100, away from the round. It moves the aim, as suppression's flinch does;
  - the `hurt` voice.
- **Pure code:** `src/sim`, `src/world` and `src/combat` follow `tests/architecture.test.ts`. Numbers live in `data/tunables.toml`: a new `[hits]` table, `[particles.blood]` and `[particles.blood_mist]`.
- **Commits:** branch `shots`, never pushed. End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Quiet e2e:** no other e2e run may be going. The sound-counting e2e tests skip where `audioRenders()` says sound does not render, as the audio specs do.

## Review Focus

- **Nine shotgun pellets into one body on one tick:** one marker pop, one `hit` voice (not nine) and blood per pellet capped at 2 bursts. Task 3 pins it.
- **A kill that the room confirms 150 ms after the last hit:** the kill marker must replace a hit marker still showing. The kill's burst must stand at the victim's last seen hit, not at their feet. Task 3 tests the timing.
- **A headshot on a dummy that is already down:** no feedback at all; a dead body is not hit. Task 3 checks it with the range.
- **Spatter near a crater's pending region:** the recolour must skip voxels inside a region out (`destruction.overlapsOut`), or the crater's write-back undoes half of it and leaves torn edges. Task 2 tests it.
- **Being hit by one's own round** (ricocheting rounds do not exist; a body test excludes the owner): never feedback. Task 3 asserts no hurt from owner 0 hits on LOCAL_BODY.

---

### Task 1: Blood in the session, and the rig's flinch and fall

**Files:**
- Modify: `data/tunables.toml`:
  - `[particles.blood]`: life 0.8, gravity −9.81, drag 1.2, size 0.03 → 0.02, colour start `[0.32, 0.02, 0.02, 1.0]` → end alpha 0, not emissive, count 6, speed 3.5, spread 0.6, jitter 0.3;
  - `[particles.blood_mist]`: life 0.9, gravity −0.4, drag 3.0, size 0.15 → 0.6, colour `[0.42, 0.04, 0.04, 0.45]` → alpha 0, count 1, speed 0.8, spread 0.8;
  - `[hits]`: `critical_droplets = 18`, `critical_mist = 3`, `helmet_sparks = 4`, `flinch_deg = 12`, `head_snap_deg = 25`, `flinch_s = 0.25`, `fall_s = 0.7`, `head_fall_s = 0.45`.
- Modify: `src/sim/session.ts`:
  - `bleed(at: readonly number[], dir: readonly number[], critical: boolean, helmet = false): void` emits the droplets, mist and sparks above;
  - `combat()` bleeds each `rounds.bodyHits` (critical when zone is head; helmet when the hit's part is the head above 1.62 m of the body's height, or simply every head hit);
  - the khaki dust stays.
- Modify: `src/combat/soldier-rig.ts`: `PoseInput` gains:
  - `flinch?: { dir: V3; age: number; head: boolean }`;
  - `fallYaw?: number`;
  - `fallS?: number`.

  The flinch adds its lean to the torso and head frames by a critically damped spring of `flinch_s`. The death fall turns toward `fallYaw` (degrees, world), taking `fallS` (default `FALL_S`).
- Modify: `src/app/together.ts`:
  - `Figure` gains `flinch?`, `fallYaw?` and `fallS?`, passed into `pose`;
  - `Gaits` keeps nothing new (the caller sets them).
- Test: `tests/combat/soldier-rig.test.ts` (add); `tests/sim/bleed.test.ts` (new).

**Interfaces:**
- Produces:
  - `Session.bleed(at, dir, critical, helmet?)`;
  - `PoseInput.flinch`, `PoseInput.fallYaw`, `PoseInput.fallS`;
  - `Figure.flinch`, `Figure.fallYaw`, `Figure.fallS`.

- [ ] **Step 1: Write the failing tests**
```ts
// tests/sim/bleed.test.ts
it('a body hit throws 6 blood droplets and a puff of mist beside the dust', ...)       // count particles by colour, before and after a target hit
it('a headshot throws 18 droplets out the far side, 3 mists, and 4 sparks off the helmet', ...) // droplets' mean velocity · round dir > 0
it('bleeding is deterministic: two sessions, same hits, same particles', ...)
// tests/combat/soldier-rig.test.ts
it('a flinch leans the torso 12° along the round at once and is back within 0.25 s', ...)
it('a headshot flinch snaps the head 25°', ...)
it('a killed body falls toward fallYaw, and in fallS', ...)  // the torso's up axis ends pointing along fallYaw's bearing, horizontal
it('hit boxes follow the pose: a flinching torso is struck where it is drawn', ...)
```
- [ ] **Step 2: Run them to make sure they fail:** `npx vitest run tests/sim/bleed.test.ts tests/combat/soldier-rig.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The spring is the rig's own closed form: `lean(age) = deg · (1 + ω·age)·e^(−ω·age)`, with ω from `flinch_s` as `combat/spring.ts`'s `SETTLE_CONSTANT` gives it. Use dmath.
- [ ] **Step 4: Run** `npx tsc --noEmit && npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** (attribution line).

---

### Task 2: Spatter

**Files:**
- Modify: `src/world/materials.ts`: append BLOOD_SOIL (kind SOIL, srgb 70, 22, 18), BLOOD_TIMBER (TIMBER, 72, 20, 16), BLOOD_SANDBAG (the sandbag kind, 84, 26, 20), BLOOD_DUCKBOARD (DUCKBOARD, 70, 22, 16) and BLOOD_CLOTH (CLOTH, 80, 16, 16), each with its kind's roughness. Then `BLOOD_OF(kind)`: the shade for a kind, or null.
- Create: `src/world/spatter.ts`: `spatter(map: BrickMap, from: readonly number[], dir: readonly number[], seed: number, t: SpatterTunables, skip?: (box: Box) => boolean): number`. It returns how many voxels it recoloured. Positions and directions are in voxels; the caller converts.
- Modify: `data/tunables.toml` `[hits]`: `spatter_rays = 14`, `spatter_cone_deg = 25`, `spatter_reach_m = 2.5`.
- Modify: `src/sim/session.ts`:
  - `spatterAt(at, dir, seed)` converts to voxels and calls `spatter` with `skip = (b) => destruction.overlapsOut(b)`;
  - `combat()` spatters each head hit, seeded from a hash of the hit's tick and position;
  - `land()` and the renderer need nothing new: the map's dirty bricks upload as for any edit.
- Test: `tests/world/spatter.test.ts` (new).

**Interfaces:**
- Produces:
  - `spatter(...)` and `BLOOD_OF(kind: number): number | null`;
  - `Session.spatterAt(at: readonly number[], dir: readonly number[], seed: number): number`.

- [ ] **Step 1: Write the failing tests**
```ts
it('a wall of soil 1.5 m behind a hit takes up to 14 blood voxels, all BLOOD_SOIL, all within the 25° cone', ...)
it('nothing past 2.5 m is marked', ...)
it("water, wire and metal take no blood; timber takes BLOOD_TIMBER, and stays timber's kind", ...)
it('voxels inside a region out are skipped', ...)
it('the same seed marks the same voxels', ...)
```
- [ ] **Step 2: Run them to make sure they fail:** `npx vitest run tests/world/spatter.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Rays use `world/raycast.ts` `raycast`. Directions are drawn uniformly over the cone from `core/rng.ts` `Rng.root(seed)`.
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit`. Expected: PASS. A char of a bloodied timber turns it to CHAR_TIMBER (`world/char.ts` maps by kind). Add a case to `tests/world/char.test.ts` if one exists.
- [ ] **Step 5: Commit** (attribution line).

---

### Task 3: The feedback: markers, pops, voices, being hit

**Files:**
- Create: `src/ui/hit-marker.ts`:
  - `class HitMarker { constructor(doc: Document); show(kind: 'hit' | 'head' | 'kill', now: number): void; pop(text: 'HEADSHOT' | 'KILL', name: { name: string; team: Team } | null, now: number): void; tick(now: number): void; clear(): void; state(): { marker: 'hit' | 'head' | 'kill' | null; pop: string | null } }`;
  - the pop animation is the Web Animations API (`el.animate`) on scale and opacity, restarted on each show.
- Modify: `index.html`:
  - the `#hud .marker` gains the three kinds' styles (sizes, colours and a ring for kill, thickness 0.28vh, dark outline);
  - a `.hit-pop` element 6vh under the centre;
  - a `#hurt-flash` full-screen radial-gradient overlay, `pointer-events: none`.
- Create: `src/app/hit-feedback.ts`:
  - `class HitFeedback`;
  - `frame(session, events, now, others: SoldierDraw[] = []): FeedbackVoice[]`:
    - **the player's hits** (owner 0, body ≥ 0): the marker and pop, plus `hit`, or `head` and `gush`, at the ear. Hits on one tick are deduplicated to one marker and one voice per kind;
    - **others' hits seen** (owner ≥ 2, body ≥ 0, or owner 0): each body's flinch is kept by id (direction, time, head), along with its last hit (position, dir, time) for a kill's burst. A spatial `hit` within 30 m, and a `gush` within 25 m on a headshot;
    - **hits on the player** (body −1, owner ≠ 0): the flash, `session.jolt(...)` and `hurt`, at the zone's damage × the gun's scale (net/gear.ts) for the estimate;
  - `kill(victimId, killerIsYou, victim, now, session)`: the kill marker, the pop, `kill` at the ear when it is yours, a critical `session.bleed` and `session.spatterAt` at the victim's last hit within 300 ms (else their torso), and the body's fall bearing and time from that hit;
  - `plate(event, at)`: a hit marker and a spatial `ding`;
  - `figureOverlay(id): { flinch?, fallYaw?, fallS? }` for `Figure`s;
  - `state()` for the hooks.
- Modify: `src/sim/session.ts`: `jolt(yawDeg: number, pitchDeg: number): void` adds to suppression's flinch springs (`Suppression.jolt`, new, adding to `flinchYaw`/`flinchPitch` with their settle).
- Modify: `src/audio/plan.ts` and `src/audio/voices.ts`:
  - new `VoiceKind`s `hit`, `head`, `gush`, `kill`, `ding` and `hurt`, as the Global Constraints give them;
  - `planVoices` drops the old `impact-timber` knock for the player's hits;
  - a new `planFeedback(t, voices: FeedbackVoice[], listener): VoicePlan[]` places each: at the ear, or spatial with `afar`.
- Modify: `src/app/main.ts`:
  - a `HitFeedback`;
  - `audio.play([...planVoices(...), ...planFeedback(...)])`;
  - `together`'s `death` and the range's `kill` and `plate` events route to it;
  - the `MatchHud` marker is removed (its CSS stays for the new marker);
  - figures (others, puppets and dummies) take `figureOverlay`;
  - hooks `hitFeedback()` → `{ marker, pop, voices: Record<string, number>, flashes: number }`.
- Modify: `src/app/together.ts`: `death()` calls `hits.kill(...)` (the `HitFeedback`, passed in by main) in place of `hud.marker('kill')`, and `after()` no longer marks hits itself.
- Test:
  - `tests/app/hit-feedback.test.ts` (new);
  - `tests/audio/plan.test.ts` (add);
  - `tests/e2e/hits.spec.ts` (new, on the range);
  - `tests/e2e/fight.spec.ts` (the two-page match: add the kill marker, the pop and the gush).

**Interfaces:**
- Consumes: Task 1 (`bleed`, the pose inputs), Task 2 (`spatterAt`), and G2's `RangeEvent`/`RangeView` (`after()` returns its events).
- Produces:
  - `FeedbackVoice = { kind: 'hit' | 'head' | 'gush' | 'kill' | 'ding' | 'hurt'; at: [number, number, number] | null; gain: number }` (null: at the ear);
  - `planFeedback`;
  - `HitFeedback`, `HitMarker` and `Session.jolt`.

- [ ] **Step 1: Write the failing unit tests**
```ts
// tests/app/hit-feedback.test.ts (a fake HitMarker records calls; a real Session as the sim tests build one)
it('a body hit of the player\'s: a hit marker and one hit voice at the ear', ...)
it('a headshot: the head marker, the HEADSHOT pop, and head + gush at the ear', ...)
it('nine pellets on one tick: one marker, one hit voice', ...)
it('a kill 150 ms after the last hit: the kill marker replaces the hit marker, the kill voice plays, and the burst is at that hit', ...)
it("another's headshot seen 10 m off: a spatial gush at the body, no marker", ...)
it('being hit by another player: the flash, a jolt of the aim away from the round, the hurt voice', ...)
it('the player\'s own round never hurts the player', ...)
it('a plate: a hit marker and a ding at the plate', ...)
// tests/audio/plan.test.ts
it('planFeedback puts ear voices at the listener with no delay, and a ding 85 m off 0.25 s late and quieter', ...)
```
- [ ] **Step 2: Run them to make sure they fail:** `npx vitest run tests/app/hit-feedback.test.ts tests/audio/plan.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the Files list. Keep the voices' synthesis in `voices.ts` as its other voices are: noise buffers, oscillators, biquads and gain envelopes. Reuse its helpers.
- [ ] **Step 4: Write `tests/e2e/hits.spec.ts`** (range on, solo, the hooks as in G2's `range.spec.ts`):
```ts
test('a torso hit on a dummy: the white marker, a hit voice, blood particles', ...)
test('a headshot: the gold marker → the red kill marker, HEADSHOT, gush and kill heard, spatter behind it', ...)
  // spatter: count BLOOD_* voxels in a 6 m box behind the dummy before and after (h.world.map.get)
test('a round into a downed dummy gives nothing', ...)
test('a plate rings: a ding is heard', ...)
```
  Add to `tests/e2e/fight.spec.ts`: the shooter's page shows the kill marker and the KILL pop with the victim's name when the room's death comes. The victim's page shows the hurt flash.
- [ ] **Step 5: Run:** `npx vitest run && npx playwright test tests/e2e/hits.spec.ts tests/e2e/fight.spec.ts tests/e2e/range.spec.ts tests/e2e/audio.spec.ts`. Expected: PASS.
- [ ] **Step 6: Commit** (attribution line).

---

### Task 4: G3's proof

- [ ] **Step 1:** `tools/hit-captures.mjs` (`npm run hit-captures`), on the range at dusk, frozen and stepped. It writes `artifacts/sp7/hits/`:
  - `torso-{0,2,6}.png`: frames 0, 2 and 6 after a torso hit on the 25 m dummy;
  - `head-{0,2,6,20}.png`: a headshot;
  - `spatter.png`: the wall behind it after.

  Read them all. Note in the ledger what reads as punchy and what does not.
- [ ] **Step 2:** Render the new voices to WAV with an OfflineAudioContext page (`tools/render-sounds.mjs`, `npm run sounds`; the spec's §6 tool, begun here). Write `artifacts/sp7/sounds/{hit,head,gush,kill,ding,hurt}.wav`. Check each file's peak is between −30 and −1 dBFS, and that the gush's energy is mostly in 400 Hz–2 kHz (an FFT in the page).
- [ ] **Step 3:** Commit the tools and `package.json`.
