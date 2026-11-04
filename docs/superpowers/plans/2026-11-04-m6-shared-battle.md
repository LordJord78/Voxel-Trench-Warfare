# M6-lite: The Shared Battle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the battle in the room, and give everyone one world. The room runs one shelling for everyone, announced 1.5 s ahead, and every shell lands at the same room time and place on every client. Shells and the enemy line's fire hurt and kill. Pellets are seeded, scoops are shared, and fires follow the shells' seeds. A reload or late join catches up from the room's log.

**Architecture:**
- **The room** (`src/net`, pure; the relay runs it):
  - schedules shells with a `Shelling` over each map's pinned `ShellField`;
  - tells everyone each shell 1.5 s before it lands;
  - relays scoops, stamped with its clock;
  - keeps both in a log that every welcome carries.
- **Each client** runs a `RoomBattle` (`src/sim/room-battle.ts`, pure) on its session. The `RoomBattle`:
  - lands the room's shells at room time, in id order (each crater is cut where the ground is when it goes out);
  - applies the others' scoops in an order that keeps one world;
  - holds the player's own shovel off an announced shell's ground;
  - turns its craters into the Director's strikes;
  - catches a joiner up from the log.

  The session turns the blasts and the front's rounds on the local body into harms, which the client sends as `hurt`.
- **The app:**
  - keys the Director, the lights' clock and the time of day on `matchSeconds`;
  - points the session's own `Front` at its player from the line across from the player's team;
  - wires the room's messages through `Together`.

**Tech Stack:** TypeScript, raw WebGPU, Vitest (Node), Playwright (two pages against `wrangler dev`), Cloudflare Durable Object relay.

**Spec:** `docs/superpowers/specs/2026-11-04-trenchline-shared-battle-design.md` (the M6-lite design, 2026-11-04, with its "Corrections from planning"). It supersedes §6 of `docs/superpowers/specs/2026-10-30-trenchline-multiplayer-design.md`, which gives the context.

## Spec notes

These are corrections where the code proves a detail of the spec unworkable. The plan implements each correction. The spec's values are kept everywhere else.

1. **The room has no world plan, and the relay cannot build one.**
   - *Evidence:*
     - `planWorld(params, seed)` needs `genParams(tun)`. `world/generation/params.ts` does `new Tunables(raw)`.
     - `core/tunables.ts` imports `data/tunables.toml` through Vite's TOML plugin (`vite.config.ts`, `vitest.config.ts`). The relay's wrangler bundle has no such plugin.
     - Every module the relay imports is tunables-free for this reason: `net/gear.ts` says "Pure and small, because the room imports it", and `net/match-rules.ts` keeps its numbers as constants.
     - The teams' starts come from `pickSpawns(map, plan, line, 4)`, which reads generated voxels.
   - *Correction:*
     - `Shelling` takes a `ShellField`, not the plan. The field holds the front and support lines, no man's land and both teams' starts: about 32 numbers.
     - Each map's field is pinned in `src/net/shell-fields.ts`.
     - The whole-world tests assert that the pin equals `shellField(plan, starts)`, as the world fingerprints are pinned.
     - The schedule's numbers live in `[room_battle]`. They are copied into `SHELLING`, as match-rules' numbers are, and a test holds the two together.
2. **A shell's `at` is `[x, z]`.**
   - *Evidence:*
     - The room has no ground to give a `y`.
     - Today `Session.land` takes the ground's top when the shell lands. The crater is cut later, when its region is free (`sim/destruction.ts`).
     - On a client whose earlier crater is still being written, a shell landing over it would be centred on the old ground.
   - *Correction:*
     - `Shell = { id, landS, at: [x, z], radius, seed }`.
     - In a room, a crater's centre and what it struck are taken when its job goes out (`Destruction.shell(..., onGround)`). By then every earlier crater that overlaps it is in.
3. **Light's rounds never hit.**
   - *Evidence:*
     - `Front.aimAt` puts every light round on a ring `light_miss_m` 2 m or more from the head.
     - Light is the room's default (`defaultConfig().intensity`).
     - So criterion 2's "its hits hurt" would hold only on heavy.
   - *Correction:*
     - In a room, light's rounds are scattered about the head as heavy's are (`spread_m` 1.6, `spread_vertical` 0.6), at light's own rate.
     - Solo is unchanged.
     - The controller may veto this; one test in Task 4 pins it.
4. **The welcome's log is bigger than the codec allows.**
   - *Evidence:*
     - `parse` refuses any text over 4,096 characters (`net/protocol.ts`).
     - A scoop is up to 24 packed cells, about 280 characters, and a digger makes one every 0.26 s. A long match's log runs to hundreds of kilobytes.
   - *Correction:*
     - A room's message may be up to `ROOM_TEXT_MAX` = 1 MiB, Cloudflare's WebSocket message limit.
     - A client's message keeps the 4,096 cap.
     - The room keeps its log under `LOG_CHARS_MAX` = 900,000 characters by dropping its oldest scoops, never a shell.
5. **The log is the world's, not the match's.**
   - *Evidence:*
     - A rematch on the same map starts on the cratered world: nothing in `together.ts` or `main.ts` `ended` resets it.
     - With a per-match log, anyone who reloads or joins in a rematch would lack the earlier matches' craters. That breaks criterion 4, "the craters are there".
   - *Correction:*
     - The room keeps its log until its map changes or its last player leaves, and numbers its shells across matches.
     - Log entries carry the room's clock (ms). A joiner lands the earlier matches' shells and scoops quietly, without the Director.
     - So those matches' fires' chars are not caught up. A char is colour only, the same accepted drift as chips.
6. **The clock is not synced when the welcome arrives.**
   - *Evidence:*
     - `NetClient` takes its first clock sample from the first `pong`, which comes after the welcome.
     - Until then `ServerClock.serverAt` adds no offset, so `serverNow()` is the page's clock.
     - A late joiner would therefore reckon `matchSeconds` 0 and catch up on nothing.
   - *Correction:* the welcome is the hello's reply and carries `now`, so it becomes the clock's first sample.
7. **Others' rounds don't fly as the shooter's did,** and pellets are not the only reason.
   - *Evidence:*
     - The wire rounds a shot's origin to the millimetre and its direction to 1e-4 (`encodeShot`), so the shooter flew a slightly different ray.
     - A suppressor slows its rounds to 0.97 (`[attachment.suppressor] velocity`). `Session.remoteGun` fires the bare gun's round.
   - *Correction:*
     - In a room the shooter flies its shot as sent: its rounds use the words' origin and direction.
     - A suppressed shot flies at the suppressor's velocity on every client.
     - Pellets spread about the shot's first pellet by the gun's own `dispersion_moa`, drawn from the shot's seed. The stance's cone stays with the shooter alone.
8. **A strike's fire roll depends on when its shell landed.**
   - *Evidence:* `strikesFrom` (`main.ts`) decides fire by the material under the ground when the shell landed. That material differs between clients while another crater is still being written there.
   - *Correction:* in a room, the strike uses the material where its crater went out (note 2), and the fire stands on the fuel its crater left.

The spec is silent on the following; they are decided here.

9. **The order of scoops against craters.**
   - (a) A player's own scoop waits while an announced shell's region would take it, from the shell's announcement until its crater is in.
   - (b) The room stamps each scoop with its clock.
   - (c) A client given a scoop stamped `s` first lands every heard shell due by `s`. It applies the scoop once no crater region it touches is pending, after any earlier held scoop that overlaps it.
   - Together these give every client the same order unless latency or clock skew exceeds about 1.2 s.
10. **"Seeks the Director".** `Director.at(seconds, ...)` steps with one fixed input and no strikes, so it would light none of the match's fires and char nothing. The catch-up therefore steps the Director along the log, feeding each shell's strike at its time and making the chars as they fall due.
11. **The kill feed already names the cause:** `together.ts` `death()` writes "shelled", "shot from the line" and "burned". The fallen line, though, says "Killed by the shelling" for every battle death (`match-hud.ts` `fallen`). It should name the line.
12. **Accepted drift, unchanged by this plan:**
    - a chip racing a crater over the same ground;
    - a round stopped by a body that one client draws and another doesn't;
    - a crater whose job asks for a wider region just as a neighbour goes out.

## Global Constraints

- **Pure code:** `src/core`, `world`, `sim`, `combat`, `battle` and `net` follow `tests/architecture.test.ts`. They use `core/dmath` and `core/rng`. They use no DOM, no `Date`, no `Math.random`, no `crypto` randomness, no `**`, and no timers.
- **Numbers:** numbers live in `data/tunables.toml`, in a new `[room_battle]` table. The relay cannot read it, so `src/net/shelling.ts` `SHELLING` holds the room's copies, and a test holds the two equal.
- **The spec's values:**
  - lead 1.5 s;
  - light gaps of 6–10 s and heavy gaps of 2.5–4 s; off, no shells;
  - `spawn_clear_m` 15;
  - a blast does 200 within 0.5 × radius, falling linearly to 0 at 2.2 × radius, times `cover_share` 0.35 behind cover;
  - `front_damage_scale` 0.6;
  - the front fires from side 1 at Red and from side 0 at Blue;
  - the feed's causes are "shelled" and "shot from the line";
  - `matchSeconds = max(0, (serverNow() − startAt) / 1000)`;
  - `timeOfDay = start + lapse × matchSeconds` (lapse in game minutes a second, so ÷ 60 for hours).
- **Protocol:** `PROTOCOL` is 2, and builds must match as today. `npm --prefix server run typecheck` passes, because the relay bundles `src/net` and what it imports.
- **Sub-project 7 lands first.** It changes `session.ts` (round targets, bleeding, handling), `together.ts` (`death()` calls a `HitFeedback`) and `main.ts`. Work against the interfaces named here (`Session.land`, `combat`, `fireRemote`, `dig`; `Together.prepare`, `after`, `death`, `started`, `ended`; `CombatEvents`), not line numbers. Every `CombatEvents` literal in the tests (`grep -rln "remoteShots: \[\]" tests`) gains each new field.
- **e2e:**
  - Run e2e only when no other e2e or timing run is going.
  - The two-page specs need the relay (`npm --prefix server run dev`, wrangler on 8787). `playwright.config.ts` starts it, as for `fight.spec.ts` and `together.spec.ts`. A relay left running from before Task 2 speaks protocol 1, so restart it.
- **Commits:**
  - Commit on branch `shots`, one commit per task, and never push.
  - Each message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - No `wrangler deploy`: the relay redeploys at publish (M7).

## Review Focus

The five conditions most likely to bite players, most likely first. Each is pinned by a test in the task that owns it.

- **Clock skew.** Two clients' clocks disagree by up to 0.2 s, and their craters come back from the worker at different times. They must still cut the same craters in the same order. Task 3: "two clients whose clocks disagree by 0.2 s…".
- **A late join mid-shell.** A player joins in the 1.5 s between a shell's announcement and its landing. They must hear it whistle for the time it has left, and it must land at its time, once. Task 2 (it is in the welcome's log) and Task 7: "a shell in the air at the join…".
- **A shell landing during a reload.** A reload regenerates the world for about 10 s, and shells land meanwhile. On return each must be in the world exactly once, with its crater as everyone else's. Task 7: "a shell that landed while the page was away…".
- **A dig colliding with a crater region.** A scoop is made, or arrives, while a crater over the same ground is announced, queued or still being written. It must wait, then go in on the right side of the crater on every client. Task 6: "a dig stamped after a shell landed…" and "a scoop waits while a heard shell's ground…".
- **Spawn kills.** A player at their team's start must never be hurt by a shell or seen by the front. Task 2: "never lands within 15 m of either side's start". Task 3: "no shell the room sends reaches anyone at a start". Task 4: "the front sees no one standing at a Red or Blue start".

---

### Task 1: Room time: the Director, the lights' clock, the time of day and fires on the match's clock

**Files:**
- Modify: `src/net/clock.ts`: `matchSeconds`, `matchHours`, `battleStep` and `SILENT_STEP_S`.
- Modify: `src/app/net-client.ts`:
  - keep the hello's send time;
  - take the welcome as the clock's first sample;
  - add `matchSeconds()`.
- Modify: `src/battle/director.ts`: add `Strike.seed?`. A seeded strike draws its roll, size and burn from its own seed.
- Modify: `src/sim/session.ts`: `CombatEvents.blasts[]` gains `seed?: number`, the seed `land` was given.
- Modify: `src/app/main.ts`:
  - strikes carry their blast's seed;
  - in a match, the lights' clock, the time of day and the Director run on `net.matchSeconds()`;
  - add the hook `together.matchSeconds()`.
- Test:
  - `tests/net/clock.test.ts` (add);
  - `tests/app/net-client.test.ts` (new);
  - `tests/battle/director.test.ts` (add).

**Interfaces:**
- Produces:
  - `matchSeconds(serverNowMs: number, startAtMs: number): number`;
  - `matchHours(config: Pick<RoomConfig, 'timeOfDay' | 'lapse'>, seconds: number): number`;
  - `battleStep(givenS: number, nowS: number): { stepS: number; silent: boolean }`, with `SILENT_STEP_S = 1`;
  - `NetClient.matchSeconds(): number`, which is 0 with no match;
  - `Strike.seed?: number`.

- [ ] **Step 1: Write the failing tests**
```ts
// tests/net/clock.test.ts
it("reckons the match's seconds from the room's clock, never before its start", () => {
  expect(matchSeconds(10_500, 4_000)).toBe(6.5);
  expect(matchSeconds(3_000, 4_000)).toBe(0);
});
it("keeps the match's hours: the config's start, run on by its lapse", () => {
  expect(matchHours({ timeOfDay: 19.5, lapse: 0 }, 600)).toBe(19.5);
  expect(matchHours({ timeOfDay: 23.5, lapse: 2 }, 900)).toBeCloseTo(5.5, 9); // 30 game hours on, round the clock
});
it("runs the battle on to the room's time, never back, and a jump past a second silently", () => {
  expect(battleStep(10, 10.25)).toEqual({ stepS: 0.25, silent: false });
  expect(battleStep(10, 9.9)).toEqual({ stepS: 0, silent: false });
  expect(battleStep(10, 14)).toEqual({ stepS: 4, silent: true });
});
// tests/app/net-client.test.ts: a stub WebSocket (vi.stubGlobal; static OPEN = 1) the test opens and speaks through, fake timers, a page clock it sets
it("takes the welcome as the clock's first sample: the room's time at once, not the page's", ...)
  // opened at page time 1000 (the hello goes); welcome { now: 5_000_000 } at 1040 → clock.synced, serverNow() within 1 of 5_000_020
it("gives the match's seconds from its start, and 0 with no match", ...)
  // welcome { phase: 'playing', match: { startAt: 4_990_000, ... } } at 1040 → matchSeconds() within 0.002 of 10.02; a lobby welcome → 0
// tests/battle/director.test.ts
it('a seeded strike lights the same fire whatever the battle drew before it', ...)
  // A: 40 s with unseeded timber strikes, its player at x 20; B: 40 s with none, its player at x 230.
  // Then a P.TIMBER strike for each seed 1..20, one a second, fed to both. Expect: the same seeds light on both,
  // each fire's size is the same on both, and at least 3 of the 20 light.
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/net/clock.test.ts tests/app/net-client.test.ts tests/battle/director.test.ts`
Expected: FAIL. The exports are missing, the clock is not synced on the welcome, and the fires differ.

- [ ] **Step 3: Implement**
  - `net/clock.ts`: the three functions. `matchHours` returns `(timeOfDay + (lapse × seconds) / 60) mod 24`.
  - `NetClient`:
    - record `helloAt = this.now()` when the hello is sent;
    - on `welcome`, call `this.clock.sample(this.helloAt, m.now, this.now())` before anything else;
    - `matchSeconds()` returns `matchSeconds(this.serverNow(), this.match.startAt)`.
  - `Director.tendFires`: a strike with `seed` draws `roll`, `size` and `burnS`, in that order, from `Rng.root(seed).derive('battle.fire')`, leaving the fire stream untouched. A strike without one behaves as today.
  - `Session.land` puts its `seed` on its blast.
  - `main.ts`:
    - `strikesFrom` passes each blast's `seed` into its strike.
    - In a match (`together.inMatch`), each frame, with `s = together.net.matchSeconds()`:
      - `timeOfDay = matchHours(config, s)`, and the lapse's creep is skipped. The darkness follows it, so the hamlet's fires light at the match's nightfall on every client;
      - `lightSeconds = s`;
      - `light()` runs the Director by `battleStep(battleGiven, s)`, not by `dt`, and adds `stepS` to `battleGiven`;
      - there is no pre-roll on a jump into the dark;
      - a silent step adds its chars to the queue, then clears `battleEvents`, so its launches, distant shells, bursts and crackles go unheard.
    - `deploy` sets `battle = new Director(world.plan, tun, SEED, ground)` and `battleGiven = 0`.
    - The hook `together.matchSeconds()` returns `together.net?.matchSeconds() ?? 0`.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/net tests/app tests/battle && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**
```bash
git add src/net/clock.ts src/app/net-client.ts src/battle/director.ts src/sim/session.ts src/app/main.ts tests/net/clock.test.ts tests/app/net-client.test.ts tests/battle/director.test.ts
git commit -m "Room time: the battle, the lights and the time of day on the match's clock; a strike's fire from its shell's seed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The room's shelling and its log, and PROTOCOL 2

**Files:**
- Create: `src/net/shelling.ts`, `src/net/shell-fields.ts` and `src/world/generation/shell-field.ts`.
- Modify: `data/tunables.toml` with `[room_battle]`:
  - `light_gap_s = [6.0, 10.0]`, `heavy_gap_s = [2.5, 4.0]`, `lead_s = 1.5`, `radius_m = [2.2, 3.4]`;
  - `spawn_clear_m = 15.0`, `nml_share = 0.5`, `line_spread_m = 4.0`, `nml_inset_m = 8.0`, `tries = 8`;
  - a comment that `SHELLING` copies these for the relay.
- Modify: `src/net/protocol.ts` and `src/net/room-core.ts`.
- Test:
  - `tests/net/shelling.test.ts` (new);
  - `tests/net/protocol.test.ts` and `tests/net/room-core.test.ts` (add);
  - `tests/world/generation/world.test.ts` and `tests/world/generation/corridor.test.ts` (add one pin each).

**Interfaces:**
- Produces:
```ts
// src/net/shelling.ts
export const SHELLING: { lightGapS: [6, 10]; heavyGapS: [2.5, 4]; leadS: 1.5; radiusM: [2.2, 3.4]; spawnClearM: 15; nmlShare: 0.5; lineSpreadM: 4; nmlInsetM: 8; tries: 8 };
export interface ShellField { size: [number, number]; lines: { z: number; x0: number; x1: number }[]; nml: [number, number]; spawns: [number, number][] }
export interface Shell { id: number; landS: number; at: [number, number]; radius: number; seed: number }
export class Shelling { constructor(field: ShellField, seed: number, intensity: Intensity, firstId = 1); between(fromS: number, toS: number): Shell[] }
export function shellingSeed(startAt: number, mapSeed: number): number; // hash32(mapSeed, ⌊startAt / 4294967296⌋, startAt >>> 0)
// src/net/shell-fields.ts
export const SHELL_FIELDS: Record<string, ShellField>; // ravine, corridor: pinned
// src/world/generation/shell-field.ts
export function shellField(plan: WorldPlan, starts: { red: readonly Spawn[]; blue: readonly Spawn[] }): ShellField;
// src/net/protocol.ts
export const PROTOCOL = 2, CLIENT_TEXT_MAX = 4096, ROOM_TEXT_MAX = 1 << 20, DIG_CELLS_MAX = 64;
export type WireShell = number[]; // [id, landAt (room ms), x mm, z mm, radius mm, seed]
export type WireDig = number[];   // [seat, at (room ms), ...cells]
export interface RoomShell { id: number; landAt: number; at: [number, number]; radius: number; seed: number }
export interface Dig { seat: number; at: number; cells: number[] }
export interface MatchLog { shells: WireShell[]; digs: WireDig[] }
export function encodeShell(s: Shell, startAt: number): WireShell;
export function decodeShell(w: unknown): RoomShell | null;
export function decodeDig(w: unknown): Dig | null;
// ClientMsg += { t: 'dig'; c: number[] }   (1–64 integer cells in [0, 2^31): (z·Y + y)·X + x)
// RoomMsg  += { t: 'shell'; s: WireShell } | { t: 'dig'; d: WireDig }; welcome += log: MatchLog
// src/net/room-core.ts
export const LOG_CHARS_MAX = 900_000;
```
- **The `Shelling` algorithm.** The tests don't fix the draws, but the room must make the same shells however its time is asked for, so the draw order is fixed here:
  - One stream: `Rng.root(seed).derive('shelling')`.
  - For each slot:
    1. Add the gap, drawn uniform in the intensity's range, to a millisecond accumulator.
    2. Try up to `tries` places:
       - if `float() < nmlShare`, draw x uniform across the map and z uniform across `nml`;
       - otherwise take line `randint(0, lines.length)`, draw x uniform across its extent, and draw z as its z ± `lineSpreadM`.
    3. Take the first place not within `spawnClearM` of any spawn. If none is found, the slot sends nothing and uses no id.
    4. Draw the radius uniform in `radiusM`, then the seed with `nextU32()`.
  - `landS` is kept to the millisecond, and `at` and `radius` to the millimetre, so the wire carries them exactly.
  - Shells are made lazily and kept, so `between` is a filter: `fromS < landS ≤ toS`.
  - Intensity off yields none.
- **`shellField`:**
  - `lines`: those with `longAxis` 0 whose name matches `/(^|_)(front|support)$/`; z = `crossBase × voxel`, and x0, x1 = `aStart`, `aEnd` × voxel.
  - `nml`: the z of `front` and `enemy_front`, each moved `nmlInsetM` inward.
  - `spawns`: Red's starts, then Blue's, as (x, z).
  - `size`: `dims × voxel`.
  - All values in metres, rounded to the centimetre.
- **The room:**
  - Its log (shells, digs, a character count and `nextId`) lives from the first match on a map until a config message changes `map` or the last player leaves.
  - At `start`: a `Shelling` over `SHELL_FIELDS[config.map] ?? SHELL_FIELDS.ravine`, seeded by `shellingSeed(startAt, match.seed)` and numbered from `log.nextId`. None when the intensity is off.
  - On `tick` while playing and not yet won: every shell with `landS ≤ (now − startAt) / 1000 + leadS` not yet told is encoded, logged and broadcast as `{ t: 'shell', s }`.
  - A seated player's `dig` while playing, at or after `startAt`: `[seat, now, ...c]` is logged and sent to the others as `{ t: 'dig', d }`.
  - Past `LOG_CHARS_MAX`, counting each entry's JSON length + 1, the oldest digs leave the log, never a shell.
  - Every welcome carries `log`.

- [ ] **Step 1: Write the failing tests**
```ts
// tests/world/generation/world.test.ts, and corridor.test.ts with SHELL_FIELDS.corridor
it("is the room's shell field (net/shell-fields.ts): its lines, no man's land, and both sides' starts", () => {
  const field = shellField(plan, { red: pickSpawns(world.map, plan, 'front', 4), blue: pickSpawns(world.map, plan, 'enemy_front', 4) });
  expect(SHELL_FIELDS.ravine, JSON.stringify(field)).toEqual(field);
});
// tests/net/shelling.test.ts
it('lands one shell every 6–10 s on light and every 2.5–4 s on heavy, the first a gap in, and none when off', ...)
  // over 1800 s of SHELL_FIELDS.ravine: the first landS and each gap after it in [6, 10] (light), [2.5, 4] (heavy); off → between(0, 1800) is []
it('is the same shells however its time is asked for, and from the same seed; another seed gives others', ...)
  // between(0, 600) toEqual [...between(0, 7.3), ...between(7.3, 100), ...between(100, 600)]; a second Shelling of the same seed the same; seed + 1 differs
it("never lands within 15 m of either side's start, on either map", ...)
  // heavy, 3600 s, both maps: every shell ≥ SHELLING.spawnClearM (xz) from every spawn
it("lands on both sides' front and support lines and in no man's land, about half there", ...)
  // every shell on the map, and within nml or within 4 m of a line's z inside its x extent; every line ≥ 5% of them; nml 40–60%
it("draws radii in 2.2–3.4 m, and its numbers are the wire's", ...)
  // decodeShell(encodeShell(s, 1e12)) equals { id, landAt: 1e12 + landS × 1000, at, radius, seed } exactly
it("holds [room_battle]'s numbers", ...)   // SHELLING equals the table's nine values
// tests/net/protocol.test.ts
it('carries shells and digs as integers, and believes no malformed one', ...)
  // parseClient dig: 1–64 integer cells in [0, 2^31) kept; 0 or 65 cells, a float, a negative → null.
  // decodeShell: a seed up to 2^32 − 1 kept; wrong length or a float → null. decodeDig: a seat outside 0–7 → null.
it("takes a room's message up to a mebibyte, a player's still not past 4,096 characters", ...)
  // a welcome with a 100,000-character log parses; parseClient('x'.repeat(5000)) is still null
// tests/net/room-core.test.ts (the Fake conns parse everything the room sends)
it('tells everyone each shell once, 1.5 s before it lands', ...)
  // heavy, ticks every 50 ms to 63 s after start: a and b get the same shells, ids 1, 2, 3…, each told at (landAt − now) in [1450, 1550] ms;
  // told through landS 64.5, so 16 to 25 of them
it('refuses a hello of protocol 1', ...)   // { v: 1 } → refused 'version'
it("relays a dig to the others, stamped with the room's clock, and logs it", ...)
  // a's { t: 'dig', c: [1, 2, 3] } at 12_000 → b gets { t: 'dig', d: [0, 12_000, 1, 2, 3] }, a nothing; a later welcome's log.digs has it
it("welcomes a late joiner with the log so far, a shell still in the air among it", ...)   // Review Focus: a shell during a reload, a late join mid-shell
  // join c 0.5 s after a shell was told: c's welcome log.shells equals a's shells so far, the last with landAt > now
it('keeps its log through a rematch on the same map, numbering on; a new map clears it', ...)
  // end, start again: the first new shell's id follows the last; config { map: 'corridor' } in the lobby → the next welcome's log is empty
it('keeps its log under LOG_CHARS_MAX, dropping its oldest digs, never a shell', ...)
it('shells nothing when off, nor once the match is won', ...)
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/net/shelling.test.ts tests/net/protocol.test.ts tests/net/room-core.test.ts`
Expected: FAIL, because the modules and messages don't exist.

- [ ] **Step 3: Write `shellField`, pin the two fields, and run the whole-world tests**

Start with `SHELL_FIELDS = { ravine: {} as ShellField, corridor: {} as ShellField }`.

Run: `npx vitest run tests/world/generation/world.test.ts tests/world/generation/corridor.test.ts`
Expected: FAIL. Each failure prints its computed field. Paste each field into `SHELL_FIELDS`, then run again.
Expected: PASS.

- [ ] **Step 4: Implement `Shelling`, the protocol and the room, then run**

Run: `npx vitest run tests/net tests/architecture.test.ts && npx tsc --noEmit && npm --prefix server run typecheck`
Expected: PASS, no type errors in either project.

- [ ] **Step 5: Commit**
```bash
git add data/tunables.toml src/net src/world/generation/shell-field.ts tests/net tests/world/generation/world.test.ts tests/world/generation/corridor.test.ts
git commit -m "The room runs the shelling: each shell told 1.5 s ahead from its map's field, its scoops relayed, both kept in its log; protocol 2" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Clients land the room's shells, and blasts hurt

**Files:**
- Create: `src/combat/harm.ts` and `src/sim/room-battle.ts`.
- Modify: `data/tunables.toml` with `[room_battle]` additions: `blast_hp = 200.0`, `lethal_radii = 0.5`, `reach_radii = 2.2`, `cover_share = 0.35`, `front_damage_scale = 0.6`. `lethal_radii` and `reach_radii` are the spec's `lethal_m` and `reach_m`, as multiples of the radius.
- Modify: `src/sim/destruction.ts`, `src/sim/session.ts` and `src/battle/fires.ts` (`roomStrike`).
- Modify: `src/app/net-client.ts`: the room's `shell` goes into an edits queue.
- Modify: `src/app/together.ts` and `src/app/main.ts`.
- Test:
  - `tests/combat/harm.test.ts` and `tests/sim/room-battle.test.ts` (new);
  - `tests/sim/destruction.test.ts` and `tests/sim/shells.test.ts` (add);
  - every `CombatEvents` literal in the tests gains `harms: []`.

**Interfaces:**
- Consumes:
  - from Task 1: `NetClient.matchSeconds`, `Strike.seed`;
  - from Task 2: `RoomShell`, `decodeShell`, `SHELLING`.
- Produces:
```ts
// src/combat/harm.ts
export interface HarmTunables { blastHp: number; lethalRadii: number; reachRadii: number; coverShare: number; frontDamageScale: number }
export function harmTunables(tun: Tunables): HarmTunables;
export function blastHarm(distanceM: number, radiusM: number, covered: boolean, t: HarmTunables): number;
export function frontHarm(zone: Zone, t: HarmTunables): number; // net/match-rules DAMAGE[zone] × frontDamageScale
// src/sim/destruction.ts
shell(centre: readonly [number, number, number], radius: number, seed: number, onGround = false): number; // onGround: its centre's y the ground's top there when it goes out
overlapsPending(box: Box): boolean; // queued, out or landing
Crater.material?: number;            // an onGround crater's: the voxel under its centre when it went out
// src/sim/session.ts
room: boolean;                       // false; Together sets it each frame
export interface Harm { tick: number; amount: number; cause: 'shell' | 'round' }
CombatEvents.harms: Harm[];
land(x: number, z: number, radiusM: number, seed: number, quiet = false): number | null;
whistle(x: number, z: number, landsInS: number): void; // an `incoming` event at the ground's top
// src/battle/fires.ts
export function roomStrike(map: BrickMap, crater: Crater, seed: number, voxel: number, t: FireTunables): Strike | null;
// src/sim/room-battle.ts
export class RoomBattle {
  constructor(session: Session, fireT: FireTunables);
  hear(shell: RoomShell, nowMs: number): void;
  tick(nowMs: number): void;
  strikes(events: CombatEvents): Strike[];
  outgoing(events: CombatEvents, inPlay: boolean): ClientMsg[];
  finish(): void;
  get waiting(): readonly RoomShell[]; // heard, not landed
  get landed(): readonly RoomShell[];
}
// src/app/net-client.ts
export type RoomEdit = { t: 'shell'; shell: RoomShell } | { t: 'dig'; dig: Dig };
takeEdits(): RoomEdit[];             // in the order they came
// src/app/together.ts
TogetherHooks.battle(): RoomBattle;  // a new room battle on this page's session
Together.battle: RoomBattle | null;
```
- **Behaviour of `RoomBattle`:**
  - `hear` takes each id once. If `landAt > nowMs`, it calls `session.whistle(x, z, (landAt − nowMs) / 1000)`. A late shell gets no whistle and lands on the next `tick`.
  - `tick(nowMs)` lands every heard shell with `landAt ≤ nowMs`, in id order, through `session.land(x, z, radius, seed)`, and remembers each crater id's seed.
  - `strikes(events)` returns the non-null `roomStrike`s of this frame's `events.craters` that are its shells'.
  - `outgoing` turns each harm ≥ 1 into `{ t: 'hurt', a: min(200, amount), c: cause }`. It sends nothing unless `inPlay`.
  - `finish` lands every heard shell still in the air, at once and quietly.
- **`Session.land` in a room:**
  - its crater is `onGround`;
  - while alive and not quiet, it pushes a harm of `blastHarm(|at − chest|, radiusM, covered)` when that is above 0, where:
    - the chest is the own body's `torso` frame;
    - `covered` means a voxel ray from one voxel above the struck ground to the chest meets solid more than a voxel short of it.
  - `quiet` queues the crater alone: no blast event, particles, debris, shake, suppression or harm.
- **`roomStrike`:** it returns null unless `fireChance(crater.material)` is above 0 and `fuelNear(map, centre, radius + t.charM, voxel)` finds fuel, with the centre and radius in metres. Otherwise it returns `{ at: fuel, material, crater: crater.id, seed }`.
- **`Together`:**
  - `prepare`: set `session.room = this.inMatch`. In a match, `this.battle ??= hooks.battle()`. Once `net.clock.synced`, pass each queued shell to `hear`, then call `battle.tick(net.serverNow())`.
  - `after`: send `outgoing(events, this.inPlay && this.begun && !this.fallen && session.alive)` with `net.hurt(a, c)`.
  - `started`: drop the battle.
  - `ended`: call `battle.finish()`, then drop it.
- **`main.ts`:**
  - `hooks.battle = () => new RoomBattle(session, fireT)`.
  - In a match:
    - the Director's strikes are `together.battle?.strikes(events) ?? []`;
    - chars wait while `destruction.overlapsPending`;
    - the session runs with idle intent once the match has begun, before Go too, so the world goes on for a player still on the deploy screen.

- [ ] **Step 1: Write the failing tests**
```ts
// tests/combat/harm.test.ts
it('a blast does 200 within half its radius, nothing from 2.2 radii, linearly between', () => {
  expect(blastHarm(1.5, 3, false, t)).toBe(200);
  expect(blastHarm(4.05, 3, false, t)).toBeCloseTo(100, 9);
  expect(blastHarm(6.6, 3, false, t)).toBe(0);
  expect(blastHarm(20, 3, false, t)).toBe(0);
});
it('cover leaves 0.35 of it', () => expect(blastHarm(1, 3, true, t)).toBeCloseTo(70, 9));
it("no shell the room sends reaches anyone at a start: the largest's reach is inside spawn_clear_m", () => {   // Review Focus: spawn kills
  expect(SHELLING.radiusM[1] * t.reachRadii).toBeLessThan(SHELLING.spawnClearM);
  expect(blastHarm(SHELLING.spawnClearM, SHELLING.radiusM[1], false, t)).toBe(0);
});
it("the front's round does its zone's damage × 0.6", () =>
  expect((['head', 'torso', 'limb'] as const).map((z) => frontHarm(z, t))).toEqual([60, 33, 18]));
// tests/sim/destruction.test.ts
it('a shell on the ground is cut where the ground is when it goes out, and says what it struck there', ...)
  // trenchArena, heldRunner: a shell at CREST, then an onGround one at [140, 0, 150] r 25 overlapping it; once the first is in, the second's
  // posted centre y is groundTop(map, 140, 150) as the first left it; its crater has `material` = the voxel under that; the world equals
  // detonate(CREST) then detonate at that centre in place (sameWorld)
// tests/sim/shells.test.ts
it("in a room a shell by the player is a harm of its blast's by distance and cover; none solo, quiet, or dead", ...)
  // room: land 2 m off (r 3) → one harm, cause 'shell', amount blastHarm(d, 3, false); the same with a clay wall between → covered;
  // room = false, quiet = true, or alive = false → none
// tests/sim/room-battle.test.ts: sessions on trenchArena() (plan null), the player 10 m clear of the parapet
it("whistles a shell from when it is heard, for the time it has left, and lands it when the room's clock reaches it", ...)
  // hear(landAt 10_000) at 8_600 → one incoming, landsInS 1.4; tick(9_999) → no blast; tick(10_000) → one blast at its (x, z)
it('lands a shell heard late at once, without a whistle, and a shell heard twice once', ...)
it('lands shells in id order, however they were heard', ...)   // hear 3 then 2, both due → craters land 2 then 3
it('two clients whose clocks disagree by 0.2 s, and whose craters come back at different times, cut the same craters', ...)   // Review Focus: clock skew
  // six overlapping shells on the parapet 2.5 s apart; A: clock true, frames 60 a second, in-process runner; B: clock − 200 ms, frames 45 a second,
  // a runner that hands each crater back 200 ticks late (later than the gap); each heard 1.5 s before by its own clock plus 30 / 120 ms;
  // all landed and settled → sameWorld(A.map, B.map), and not sameWorld(A.map, trenchArena())
it("a crater on timber is a strike from its shell's seed once it is in, standing on what it left", ...)
it('sends each harm as a hurt, at most 200, and nothing while not in play', ...)
it('the match over, every shell heard lands at once, quietly', ...)
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/combat/harm.test.ts tests/sim/room-battle.test.ts tests/sim/destruction.test.ts tests/sim/shells.test.ts`
Expected: FAIL, because the modules and methods are missing.

- [ ] **Step 3: Implement the Files list, add `harms: []` to the tests' event literals, then run**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, the whole suite.

- [ ] **Step 4: Commit**
```bash
git add data/tunables.toml src/combat/harm.ts src/sim src/battle/fires.ts src/app tests
git commit -m "Every client lands the room's shells at room time, in order, where the ground is; a blast hurts the body it lands by" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The front in a room

**Files:**
- Modify: `src/combat/front.ts` and `src/sim/session.ts`.
- Modify: `data/tunables.toml`: `[room_battle] crest_clear_m = 0.3`.
- Modify: `src/app/main.ts`, `deploy` and `ended`.
- Test:
  - `tests/combat/front.test.ts` and `tests/sim/generated-world.test.ts` (add);
  - `tests/sim/room-front.test.ts` (new).

**Interfaces:**
- Consumes: from Task 3, `Session.room`, `Harm`, `frontHarm` and `harmTunables`.
- Produces:
```ts
export function planSource(plan: WorldPlan, reachM: number, side: 0 | 1 = 1): FrontSource;  // that side's fire trench
export type FrontSight = (from: readonly [number, number, number], to: readonly [number, number, number]) => [number, number, number] | null;
FrontTunables.crestClearM: number;   // [room_battle] crest_clear_m
Front.room: boolean;                 // false
Front.source: FrontSource;           // no longer readonly
Front.tick(dt: number, target: readonly [number, number, number], rounds: Rounds, spec: ProjectileSpec, sight?: FrontSight): number;
Session.frontFrom(side: 0 | 1): void; // the front's source from the plan's line of that side (no plan: unchanged)
```
- **The `Front` in a room:**
  - Light's rounds are aimed as heavy's are (spec note 3).
  - A round whose `sight(origin, head)` returns a point is aimed `crestClearM` above that point, scattered sideways only (±`spreadM`): it cracks over and doesn't hit.
- **The `Session`:**
  - `front.room = this.room` each tick.
  - In a room, `sight` is a voxel raycast from → to. It returns the metres where the ray meets solid a voxel or more short of `to`, or null.
  - In a room the front's impacts are not marked. Their dust and suppression stay.
  - The front's hits on `LOCAL_BODY` become a harm of `frontHarm(zone)`, with cause `'round'`.
- **`main.ts`:**
  - `deploy`: call `session.frontFrom(team === 'red' ? 1 : 0)` and set `session.front.intensity = match.config.intensity`. The artillery stays off.
  - `ended`: call `session.frontFrom(1)`, and put both intensities back to the settings'.

- [ ] **Step 1: Write the failing tests**
```ts
// tests/combat/front.test.ts
it("fires from side 0's front line for side 0, and side 1's for side 1", ...)
  // planWorld(genParams(tun), 7), a target mid-field: every origin within 8 m (z) of that side's front line, over its crest
it('at a player it cannot see, fires 0.3 m over where its sight was stopped', ...)
  // a sight returning [10, 2, 30]: every round's aim point y is 2.3, its x within ±spread_m of 10
it('in a room light aims to hit, scattered as heavy is; solo it never passes nearer than light_miss_m', ...)
  // 400 light rounds at a head: room → some aim points within 0.3 m of it; solo → none within 2 m
// tests/sim/room-front.test.ts: a lineSource front over a flat arena
it("in a room the front's rounds raise dust and crack, but chip nothing", ...)
  // heavy 5 s, room: impacts > 0, cracks > 0, sameWorld with an untouched copy; solo: the world changed
it("in a room the front's round into the player is a harm of its zone's damage × 0.6, cause round", ...)
  // the player standing in the open, heavy 20 s: harms > 0, every one cause 'round', each amount in {60, 33, 18}
it('a player whose head is behind a wall is cracked over, never hit', ...)
// tests/sim/generated-world.test.ts
it('in a room the front sees no one standing at a Red or Blue start', ...)   // Review Focus: spawn kills
  // for each of pickSpawns(map, plan, 'front' | 'enemy_front', 4), the standing eye; from 3 points over the crest of every bay of the line
  // across within reach_m: the session's sight is stopped
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/combat/front.test.ts tests/sim/room-front.test.ts tests/sim/generated-world.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement, then run**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**
```bash
git add data/tunables.toml src/combat/front.ts src/sim/session.ts src/app/main.ts tests/combat/front.test.ts tests/sim/room-front.test.ts tests/sim/generated-world.test.ts
git commit -m "The front in a room: fire from the line across from the player's team, at them when it can see them, over their crest when not; its hits hurt, its rounds chip nothing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Seeded pellets; shots flown as sent

**Files:**
- Modify: `src/combat/weapon.ts`, `src/net/protocol.ts`, `src/sim/session.ts`, `src/app/net-client.ts` and `src/app/together.ts`.
- Test:
  - `tests/combat/weapon.test.ts` and `tests/net/protocol.test.ts` (add);
  - `tests/sim/shared-shots.test.ts` (new).

**Interfaces:**
- Consumes: from Task 3, `Session.room`.
- Produces:
```ts
export function pelletDirs(dir: readonly number[], count: number, coneDeg: number, seed: number): [number, number, number][]; // uniform over the cone's disc about `dir`, from Rng.root(seed)
export function pelletSeed(seat: number, tick: number): number;  // hash32(seat, tick)
export function sent(shot: ShotState): { wire: number[]; shot: ShotState }; // protocol.ts: the words, and what they say
Session.seat: number;                // −1 solo; the room's seat in a match
ShotEvent.wire?: number[];
fireRemote(owner, origin, dir, tracer, muzzle, mark?, kind?, tick = 0): void;
NetClient.state(s: PlayerState, shots: readonly number[][]): void;  // shots as their words
```
- **The shooter:**
  - The first round goes along the shot's direction, as today.
  - In a room the shot is `sent(...)`. Its rounds leave from the words' origin along the words' direction, and the event carries those values and the `wire`.
  - The other pellets are `pelletDirs(dir, pellets − 1, weapon.spec.dispersionMoa / 60, pelletSeed(seat, tick))`, solo too.
  - The shot's `tick` is the spec's "sequence number". A gun fires at most once a tick, so (seat, tick) names one shot, and the wire already carries it.
- **The receiver:**
  - It draws the same pellets from `pelletSeed(owner − 2, tick)`.
  - A suppressed mark's rounds fly at the gun's muzzle velocity × `[attachment.suppressor] velocity`.
  - `remoteRng` goes.
- **`Together`:**
  - sets `session.seat = net.you`;
  - keeps its shots out as words (`s.wire ?? encodeShot(...)`);
  - passes `shot.tick` to `fireRemote`.

- [ ] **Step 1: Write the failing tests**
```ts
// tests/combat/weapon.test.ts
it("a shot's pellets come from its seed: the same seed the same, another others, each within the gun's cone of the first", ...)
// tests/net/protocol.test.ts
it('a shot flown as sent is what its words say', ...)   // sent(s).shot toEqual decodeShot(sent(s).wire) for 50 random shots
// tests/sim/shared-shots.test.ts: two identical clay arenas, A (room, seat 2) and B (room)
it("another's shotgun shot chips the same voxels on the shooter's world and a receiver's", ...)
  // A fires the m870 at the wall: its ShotEvent's words → decodeShot → B.fireRemote(4, …, mark, kind, tick); 60 ticks each →
  // sameWorld(A.map, B.map), and both differ from a third untouched arena
it("a suppressed rifle shot flies on the receiver's world as on the shooter's", ...)
  // the m4 with a suppressor: the round's positions after 1, 5 and 20 ticks are equal on A and B
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/combat/weapon.test.ts tests/net/protocol.test.ts tests/sim/shared-shots.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement, then run**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. The existing pellet tests still pass: nine rounds, every one of them a tracer.

- [ ] **Step 4: Commit**
```bash
git add src/combat/weapon.ts src/net/protocol.ts src/sim/session.ts src/app/net-client.ts src/app/together.ts tests/combat/weapon.test.ts tests/net/protocol.test.ts tests/sim/shared-shots.test.ts
git commit -m "One shot, one set of chips: a shot's pellets from its own seed, and in a room every round flown as its words say" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Scoops for everyone

**Files:**
- Modify: `src/combat/entrenching.ts`, `src/sim/session.ts`, `src/sim/room-battle.ts`, `src/app/net-client.ts` and `src/app/together.ts`.
- Test: `tests/combat/entrenching.test.ts`, `tests/sim/digging.test.ts` and `tests/sim/room-battle.test.ts` (add).

**Interfaces:**
- Consumes:
  - from Task 2: `Dig`, `decodeDig`, the `dig` messages;
  - from Task 3: `RoomBattle`, `Destruction.overlapsPending`.
- Produces:
```ts
Scoop.cells: number[];   // the packed cells it cleared
export function packCell(dims: Dims, x: number, y: number, z: number): number; // (z·dims.y + y)·dims.x + x, findScoop's order
export function scoopBox(dims: Dims, cells: readonly number[]): Box;            // the box work() asks be free: SETTLE_PAD about them, SPREAD wider in x and z
export function applyScoop(map: BrickMap, cells: readonly number[], waterTable?: number): void; // AIR, then settleRegion exactly as work() does
Session.reserved: (box: Box) => boolean;          // () => false
Session.applyDig(cells: readonly number[]): boolean; // false (held) while a pending region overlaps its scoopBox; else applied, and the body lifted out
RoomBattle.dug(dig: Dig): void;
RoomBattle.reserves(box: Box): boolean;
NetClient.dig(cells: readonly number[]): void;
```
- **The rules (spec note 9):**
  - `Entrenching.work` calls `applyScoop` and returns `cells`.
  - In a room, `Session.dig` asks that `!destruction.overlapsPending(box) && !reserved(box)` hold; solo is unchanged.
  - `RoomBattle` sets `session.reserved = (b) => this.reserves(b)`. A box is reserved when any heard shell not yet landed has a `detonationRegion(dims, [x/v, 0, z/v], radius/v, loosen)` that overlaps it in x and z.
  - `dug` first lands every heard shell with `landAt ≤ dig.at`, in id order, then queues the dig.
  - `tick`, after its landings, applies held digs in the order they came. A dig is held while `applyDig` refuses it, or while an earlier held dig overlaps its box.
  - `outgoing` adds `{ t: 'dig', c: scoop.cells }` for each of the frame's scoops when in play.
  - `Together` passes each queued dig to `battle.dug`.

- [ ] **Step 1: Write the failing tests**
```ts
// tests/combat/entrenching.test.ts
it('a scoop records the cells it cleared, and those applied to a copy of the world make the same world', ...)
// tests/sim/digging.test.ts
it("in a room a scoop waits while a heard shell's ground would take it, and goes once its crater is in", ...)   // Review Focus: a dig and a crater
  // yard(), digging; hear a shell landing 2 m ahead in 1.5 s: no scoop until its crater has settled, then scoops again
// tests/sim/room-battle.test.ts
it("a dig stamped after a shell landed waits for its crater, then goes in: the digger's world and a receiver's agree", ...)   // Review Focus
  // A lands S, settles, digs in its rim → cells; B (clock 200 ms behind, its runner slow) hears S, then the dig stamped S.landAt + 300:
  // B lands S at once, holds the dig while S is pending, then applies it → sameWorld(A.map, B.map)
it('a dig stamped before a shell lands goes in first, on a client whose clock has not reached it too', ...)
it('held digs go in in the order they came', ...)
it('sends each scoop it dug, and nothing while not in play', ...)
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/combat/entrenching.test.ts tests/sim/digging.test.ts tests/sim/room-battle.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement, then run**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. The existing digging tests are unchanged.

- [ ] **Step 4: Commit**
```bash
git add src/combat/entrenching.ts src/sim src/app/net-client.ts src/app/together.ts tests/combat/entrenching.test.ts tests/sim/digging.test.ts tests/sim/room-battle.test.ts
git commit -m "Scoops for everyone: each one's cells sent, relayed and logged, and dug on every client in one order with the craters" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Join and reload: the log caught up, and the feed's cause

**Files:**
- Modify: `src/sim/room-battle.ts`, `src/app/net-client.ts`, `src/app/together.ts`, `src/ui/match-hud.ts` and `src/app/main.ts`.
- Test:
  - `tests/sim/room-battle.test.ts` and `tests/app/together.test.ts` (add);
  - `tests/ui/match-hud.test.ts` (new).

**Interfaces:**
- Consumes:
  - from Tasks 3 and 6: `RoomBattle`, `Session.land(…, quiet)`, `Session.applyDig`, `roomStrike`;
  - from Task 1: `matchHours`.
- Produces:
```ts
export interface BattleCatchUp { runTo(s: number, strikes: readonly Strike[]): void } // the Director run on to match second s, its chars made in the world before it returns
RoomBattle.catchUp(log: MatchLog, startAt: number | null, nowMs: number, battle: BattleCatchUp | null, yieldNow: () => Promise<void>): Promise<void>;
NetClient.log: MatchLog;   // the welcome's
TogetherHooks.catchUp(battle: RoomBattle, log: MatchLog, match: MatchInfo | null, nowMs: number): Promise<void>;
Together.caughtUp: boolean;
export function howKilled(killer: number, zone: Zone | null, teamkill: boolean, cause: Cause): string;  // together.ts, today's strings
export function fallenLine(by: { name: string } | null | undefined, cause: Cause): string;            // match-hud.ts
MatchHud.fallen(by, backIn, cause: Cause = 'shell'): void;
```
- **The catch-up.** The signature doesn't fix the order, so here it is:
```
entries = the log's shells (time landAt) and digs (time at) with time ≤ nowMs, by time, a shell before a dig of the same ms
for each entry:
  earlier match (startAt null, or time < startAt): shell → land quiet, settle; dig → applyDig
  this match: s = (time − startAt) / 1000; battle.runTo(s, [])
              shell → land quiet, settle, then battle.runTo(s, [roomStrike of its crater] if any); dig → applyDig
battle?.runTo((nowMs − startAt) / 1000, [])
for each logged shell with landAt > nowMs: hear(shell, nowMs)
settle: destruction.tick() until nothing is pending, awaiting yieldNow() between ticks
```
- **`main.ts`'s `catchUp`:**
  - It uses a new Director at 0. `BattleCatchUp.runTo` steps it at most 1 s at a time, with each second's inputs: the intensity, the darkness at `matchHours(config, t)`, and the player's feet.
  - The strikes are fed on the first step.
  - Each step's chars are added to the `CharQueue` and made at once (nothing is pending after a settle).
  - `yieldNow` is a `setTimeout(0)` promise.
  - Afterwards it calls `renderer.largeEdit()` and sets `battleGiven` to the match's seconds.
  - While catching up, the session doesn't run, `RoomBattle.tick` isn't called, and edits queue in `NetClient`.
- **`Together`:**
  - On a welcome, after `started` if the match is on, it catches up once through `hooks.catchUp`.
  - Until it is done, the deploy line says "Catching up on the battle…" and Go stays hidden. Then the queued edits go to the battle.
  - `death()` uses `howKilled`, and `fallen` keeps the cause.
  - `fallenLine` gives:
    - "Killed by NAME" when there is a killer;
    - when the battle killed (null): "Killed by the shelling" for a shell, "Shot from the line" for a round, "Burned" for a fire;
    - "Killed" when the killer is unknown (undefined).

- [ ] **Step 1: Write the failing tests**
```ts
// tests/sim/room-battle.test.ts: a live client (RoomBattle, a Director over plan null, a CharQueue, fed strikes(events) each frame)
// against a joiner on a fresh copy of the same arena, a timber wall along the parapet
it("a joiner caught up from the log has the world of a client that was there: craters, scoops and fires' chars", ...)
  // 8 shells on the timber in its first 12 s (seeds chosen so at least two fires light), a scoop at 12 s, 40 s of the match: the joiner's catchUp at 40 s →
  // sameWorld with the live client's; the live client's world has CHAR_TIMBER in it
it('a shell in the air at the join whistles for the time it has left, and lands at its time', ...)   // Review Focus: a late join mid-shell
  // the log's last shell lands 0.9 s after nowMs: after catchUp, one incoming with landsInS 0.9, no blast; tick(landAt) → its blast, once
it('a shell that landed while the page was away lands in the catch-up, once', ...)   // Review Focus: a shell during a reload
  // the same shell in the log and then told live: one crater
it("an earlier match's shells and scoops are caught up quietly, before this match's", ...)
  // entries before startAt: no runTo for them, no harms; this match's after them
// tests/app/together.test.ts
it("names the battle's kills in the feed: shelled, shot from the line, burned", () => {
  expect(howKilled(-1, null, false, 'shell')).toBe('shelled');
  expect(howKilled(-1, null, false, 'round')).toBe('shot from the line');
  expect(howKilled(-1, null, false, 'fire')).toBe('burned');
  expect(howKilled(2, 'head', false, 'round')).toBe('headshot');
  expect(howKilled(2, 'torso', true, 'round')).toBe('team-killed');
});
// tests/ui/match-hud.test.ts
it('says how a player fell: by a name, by the shelling, shot from the line, burned', () => {
  expect(fallenLine({ name: 'Sam' }, 'round')).toBe('Killed by Sam');
  expect(fallenLine(null, 'shell')).toBe('Killed by the shelling');
  expect(fallenLine(null, 'round')).toBe('Shot from the line');
  expect(fallenLine(null, 'fire')).toBe('Burned');
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/sim/room-battle.test.ts tests/app/together.test.ts tests/ui/match-hud.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement, then run**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**
```bash
git add src/sim/room-battle.ts src/app src/ui/match-hud.ts tests/sim/room-battle.test.ts tests/app/together.test.ts tests/ui/match-hud.test.ts
git commit -m "A reload or a late join catches up from the room's log: its craters, scoops and fires' chars, the Director run along it; the fallen line names the line" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The proof: Node clients and two pages

**Files:**
- Modify: `tests/support/worlds.ts`: `cloneMap(map: BrickMap): BrickMap`, copying `table`, `denseView` and `loadBrick` brick by brick.
- Modify: `src/app/main.ts`, adding hooks:
  - `together.shells()` → `{ heard: number; landed: { id: number; at: [number, number]; radius: number }[]; next: { at: [number, number]; landsInS: number } | null }`;
  - `together.caughtUp()`;
  - `together.digs()` → `{ sent: number; heard: number }`;
  - `together.pending()`: craters queued or out, plus held digs (`peakGame` already has a `pending`);
  - "idle" in the e2e means `together.pending() === 0` and no heard shell is due.
- Create: `tests/net/shared-world.test.ts` and `tests/e2e/battle.spec.ts`.

**Interfaces:**
- Consumes: everything above, through the same calls `Together` and `main.ts` make.

**The Node clients:**
- They use the real `RoomCore`, with JSON over fake conns, and the generated Corridor (`MAP_SEEDS.corridor`, generated once in `beforeAll`, 180 s).
- Each client has:
  - a `Session` on its own `cloneMap`;
  - a `RoomBattle`;
  - a Director over the plan, with darkness 0, and a `CharQueue`, fed `strikes(events)` each frame;
  - its own clock offset and line delay.
- A carries out the scripted actions. Before the match, every map gets the same spoil heap, 1.6 × 0.8 × 1.4 m, 8 m along Red's first start's bay.
  - **Digging:** A stands at the heap and digs for 8 s from 20 s. Its `outgoing` digs go to the room.
  - **Shooting:** A fires three m870 shots into the heap's side, at 35, 36 and 37 s. Its shots go out in its states. B and C fire them from the room's frames, as `Together.prepare` does.

- [ ] **Step 1: Write the tests**
```ts
// tests/net/shared-world.test.ts
it("two clients' worlds hash the same after 60 s of heavy shelling, a player's digging and shooting, their clocks 80 ms apart and their frames 60 and 45 a second", ...)
  // A: offset 0, lines 30 ms each way, frames 1/60 s, in-process runner; B: offset +80 ms, 120 ms each way, frames 1/45 s, a runner 90 ticks late.
  // The room ticks every 50 ms to 63 s after start, then stops; the clients run on 2 s (the last shells land), then their Directors 25 s
  // (every fire at its full burn), then settle.
  // await fingerprint(A.map) === await fingerprint(B.map); A's landed shells 16–25, the same ids as B's; A dug ≥ 20 scoops, B applied them all.
it('a third who joins at 45 s and catches up from the log hashes the same at the end', ...)
  // C joins at 45 s: welcome → catchUp (time held while it runs) → then live, as A and B; fingerprint(C.map) equals A's
// tests/e2e/battle.spec.ts: two pages against the relay, as fight.spec.ts opens them; the Corridor, intensity heavy; each page turns its own front off
// (h.setIntensity('off'): the front is each client's own, the room's shells go on). sameWorlds(a, b): freeze a once it is idle; wait for b to be
// idle with a's landed count; freeze it; compare fingerprints; thaw both; up to 10 tries.
test("the room's shells land the same on both pages, on the battle's clock", ...)
  // ≥ 4 shells landed; sameWorlds; on each page |battle().seconds − together.matchSeconds()| < 0.25; timeOfDay() equal within 0.01 h
test('a scoop on one page is dug on the other', ...)
  // A at the last crater's rim facing its centre, F held 3 s: digs().sent > 0, B's digs().heard equals it, sameWorlds
test('a reload mid-match finds the craters and scoops there', ...)
  // B reloads; caughtUp() true before Go shows; B goes in: landed ids equal A's, sameWorlds
test('a shell kills: the feed says shelled', ...)
  // B (alive, past its protection) stood on next.at when landsInS > 1: B dies; A's #hud .feed contains 'shelled'; B's .fallen says 'Killed by the shelling'
```

- [ ] **Step 2: Run the Node clients**

Run: `npx vitest run tests/net/shared-world.test.ts`
Expected: PASS, with the worlds' hashes equal. These tests prove Tasks 1–7 together. A failure is a bug in one of them: find it (superpowers:systematic-debugging) and fix it in its own commit before going on.

- [ ] **Step 3: Run the whole suite and both typechecks**

Run: `npx vitest run && npx tsc --noEmit && npm --prefix server run typecheck`
Expected: PASS, every earlier test included.

- [ ] **Step 4: Run the two-page specs**

Run this only when no other e2e or timing run is going, and after restarting a relay left from before Task 2:
`npx playwright test tests/e2e/battle.spec.ts tests/e2e/together.spec.ts tests/e2e/fight.spec.ts`
Expected: PASS. If `together.spec.ts` flakes under the default light battle, set its match to `intensity: 'off'` as `fight.spec.ts` does, and say so in the commit.

- [ ] **Step 5: Commit**
```bash
git add tests/support/worlds.ts tests/net/shared-world.test.ts tests/e2e/battle.spec.ts src/app/main.ts
git commit -m "M6-lite's proof: Node clients hash one world after a minute of shelling, digging and shooting, and two pages share the battle, a scoop and a reload" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
