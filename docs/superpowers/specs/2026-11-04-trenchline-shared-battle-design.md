# TRENCHLINE: The Shared Battle (M6-lite) — Design

**Date:** 2026-11-04.
**Supersedes:** sub-project 6's §6 ("The shared battle", `2026-10-30-trenchline-multiplayer-design.md`) for this build. It does everything §6 asks except the column-hash repair, which is deferred (see the end).
**Branch:** `shots`, after sub-project 7.
**Lead:** the user handed the lead to the agent on 2026-11-03 ("going to let you take the lead from here"; "Id like the game to be complete and ready to play with friends").

## Why

A room today is a quiet field:
- the front and the artillery are switched off on deploy (`main.ts:595-597`);
- the cosmetic Director runs on each client on its own clock;
- no world edit is networked. Round chips, scoops and fire chars each happen per client, so the worlds drift apart over a match. A player can hide in a hole that nobody else sees.
- Nothing but another player can hurt anyone: `net.hurt` exists but nothing calls it.

Playing with friends needs the battle in the room, and the same world for everyone.

## What done means

| # | Criterion | Measured by |
|---|---|---|
| 1 | **The room runs the shelling:**<br>• every shell is announced 1.5 s ahead to everyone;<br>• it lands at the same room time and place on every client;<br>• its crater is the same on every client;<br>• no shell lands within 15 m of a team's spawn. | unit (room shelling deterministic, the lead time, spawns clear); Node clients (two worlds hash equal after 60 s of shelling); e2e with two pages |
| 2 | **Shells and the front kill:**<br>• a blast hurts by distance and cover;<br>• the front fires at each player from the line across from their team, and its hits hurt;<br>• deaths from them show in the kill feed with their cause. | unit; e2e |
| 3 | **One world for everyone:**<br>• chips from players' rounds are the same on every client (a shot's pellets are spread from the shot's own seed);<br>• the front's rounds don't chip in a room;<br>• scoops are sent and applied everywhere;<br>• fires and their chars follow the shells' seeds and the match clock. | unit; Node clients (world hashes); e2e (a scoop on page A shows on page B) |
| 4 | **The match's clock is the battle's:**<br>• the Director, the time of day and the shells run on room time from `startAt`;<br>• a reload or a late join replays the match's shells and scoops, and seeks the Director. | unit; e2e (reload mid-match: the craters are there) |
| 5 | **Nothing lost:**<br>• every earlier test passes;<br>• `PROTOCOL` 2;<br>• the relay redeploys with it at publish. | the whole suite |

## Design

### Room time
- `matchSeconds = max(0, (serverNow() − startAt) / 1000)`, using `ServerClock` (`net/clock.ts`).
- Everything shared keys on it:
  - shell landings;
  - the Director's `lightSeconds`;
  - `timeOfDay = config's start + lapse × matchSeconds`.

### The shelling
- **`src/net/shelling.ts`** is pure (dmath, `core/rng`):
  - `new Shelling(plan, seed, intensity)`, then `between(fromS, toS): Shell[]`;
  - `Shell = { id, landS, at: [x, y, z], radius, seed }`.
- **Tempo:**
  - light: one shell every 6–10 s;
  - heavy: one every 2.5–4 s;
  - off: none.
- **Targets:**
  - drawn over both teams' front and support lines and no man's land, from the plan's `lines`;
  - never within `spawn_clear_m` 15 m of a team's spawn.
- **The room:**
  - `room-core` ticks the shelling and broadcasts `{t:'shell', s}` when the room's clock passes `landS − 1.5`;
  - it keeps every shell in the match's log.
- **Clients:**
  - a shell whistles as it arrives;
  - `session.land(...)` runs when room time reaches `landS`;
  - a shell that arrives late lands at once, without the whistle;
  - shells land in id order. The destruction queue serialises overlapping craters, as today.
- The crater is pure from its seed, so every client cuts the same one.

### Damage
- **Blast:**
  - 200 within `lethal_m` (0.5 × radius), falling linearly to 0 at `reach_m` (2.2 × radius);
  - × `cover_share` 0.35 when a voxel ray from the blast to the chest is blocked;
  - each client tests its own body and sends `hurt{a, c:'shell'}`.
- **The front:**
  - its rounds are tested against the local body, at the zone's damage × `front_damage_scale` 0.6;
  - each hit sends `hurt{a, c:'round'}`.
- The relay applies hurt as it does today: `from −1`, no score.
- The kill feed names the cause: "shelled" or "the line".

### The front in a room
- Each client runs its own `Front` at the room's intensity. It fires from the line across from the player's team: side 1 for Red, side 0 for Blue.
- It aims at its own player, weighted by exposure: when no voxel ray reaches the player's head from the source bay, it fires at the crest in front of them (cracks overhead, no hit).
- Its rounds don't chip in a room; they raise impact dust only.
- Other players' fronts are not drawn. Each player sees the fire aimed at them.

### Edits
- **Chips:**
  - the shooter's client and every other client draw a shot's pellets from a seed of (owner, the shot's sequence number);
  - a rifle round is replayed exactly as sent;
  - rounds into a crater still being written are held, as today.
- **Scoops:**
  - `Session.dig` records the cells it clears;
  - the client sends `{t:'dig', cells}` (packed voxel indices);
  - the room relays and logs it;
  - the others clear the same cells and settle the region.
- **Fires:**
  - a strike's fire roll is drawn from its shell's seed, so every client lights the same fires;
  - the hamlet fires follow match time.

### Join and reload
- `welcome` carries the match's log, landed shells and scoops in order.
- The client applies them before play, then seeks the Director to `matchSeconds`.
- A join does not catch up on chips made before it (deferred; see below).

### Protocol
- `PROTOCOL` 2:
  - `shell`, room → all;
  - `dig`, client → room → others;
  - `log` in `welcome`.
- Builds must match, as today.

## Deferred
- **Column-hash repair** (§6's "Repair"):
  - Chips made before a join can differ.
  - The edits that change cover are shared: shells and scoops.
  - Repair comes later if playtests show drift.
- **Accepted drift** (the plan's spec note 12). Clients may differ here, and nothing in M6-lite repairs it:
  - a chip racing a crater over the same ground;
  - a round stopped by a body that one client draws and another doesn't;
  - a crater whose job asks for a wider region just as a neighbour goes out;
  - two players digging the same ground within a round trip: their clients apply the two scoops in opposite orders;
  - blood spatter (sub-project 7): per page and colour only. Every blood shade keeps the kind it marks, so the shared edits read the same world.

## Corrections from planning (2026-11-04)

The plan (`docs/superpowers/plans/2026-11-04-m6-shared-battle.md`, "Spec notes") found these details unworkable in the code and corrects them. The corrections bind:

1. **The room has no world plan:** the relay can't read the tunables or generate voxels. `Shelling` takes a pinned per-map `ShellField` (`src/net/shell-fields.ts`) instead: the lines, no man's land and both teams' starts. The whole-world tests hold the pin to the plan, and `[room_battle]` holds the room's copies of its numbers.
2. **A shell's `at` is `[x, z]`.** In a room, a crater's centre and the material it struck are taken when its job goes out, after every earlier overlapping crater is in.
3. **The front's light rounds can hit in a room.** They scatter about the head as heavy's do, at light's own rate; today light never comes within 2 m. Solo is unchanged.
4. **Message sizes:** a room's message may be up to 1 MiB. A client's keeps the 4,096 cap. The log drops its oldest scoops past 900,000 characters, never a shell.
5. **The log belongs to the world, not the match.** It lives until the map changes or the room empties, because a rematch starts on the cratered world. A joiner catches up on earlier matches' shells and scoops without the Director.
6. **The welcome is the clock's first sample,** so a late joiner reckons `matchSeconds` correctly.
7. **Others' shots fly as the shooter flew them:**
   - in a room, the shooter flies its shot exactly as sent (quantised);
   - a suppressed shot flies at the suppressor's velocity everywhere;
   - pellets spread from the shot's seed about its first pellet.
8. **A strike's fire roll** uses the material where its crater went out, not the material when the shell landed.

The plan also decides the order of scoops against craters, steps the Director along the log when catching up (rather than seeking it), and corrects the fallen line to name the cause.
