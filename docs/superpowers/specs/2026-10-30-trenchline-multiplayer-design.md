# TRENCHLINE for the web — sub-project 6: playing it together

Written from the plan the user approved on 2026-10-30. The user made the four decisions below; the rest of the design is the agent's.

## Why

The user wants to play TRENCHLINE with friends from his Discord. Today it is strictly single-player:
- there is no networking, no lobby, and no other soldier;
- there is no health or death;
- the enemy is only scheduled near-miss fire (`src/combat/front.ts`), artillery and flares.

Three more things stand in the way:
- **Getting stuck.** No trench has a way out:
  - parapets stand 3.4–5 m over the duckboards, and the parados 2.9 m;
  - a player reaches 0.55 m by a step, 0.68 m by a jump, or 2.5 m by a climb that went only from timber onto timber;
  - a step-up needed 2.35 m of headroom and dugouts have 2.0–2.2 m, so every dugout was one way;
  - any timber underfoot was the firing step: 1.2 m/s, no sprint, no jump.
- **A blocky map.** It reads as "robust and blocky" for these reasons:
  - square-wave rectangular bays on eleven straight, parallel lines;
  - vertical walls and flat-then-45° parapets;
  - box sandbags, square mounds and square tree trunks;
  - perfectly round craters.
- **No map for two teams.**

**The user's decisions:**
- **Joining:** the host clicks Host and gets a link (`…/Voxel-Trench-Warfare/?room=CODE`) to paste in Discord. It is not a Discord Activity.
- **The room:** a Cloudflare Worker with a Durable Object, on the user's Cloudflare account.
- **The match:** team deathmatch, Red against Blue.
  - Players respawn at their own end.
  - The host sets the kill target.
  - Friendly fire is on, and a team kill costs the killer's team a point.
- **The battle:** the AI battle stays (the front's fire, the artillery, flares, barrages, fires), and it is lethal to both teams.
- **Lobby size:** up to 8 players (4 against 4).

## What "done" means for this sub-project

| # | Criterion | Measured by |
|---|---|---|
| 1 | **Movement never traps anyone:**<br>• W into a bench climbs onto it.<br>• W with Space climbs anything within 3 m of the feet, about 3.7 m with the jump. That reaches every parapet from its bench and every parados from the duckboards.<br>• W alone never takes anyone over the parapet.<br>• A step-up needs room only for the rise it makes, so dugouts are walked out of standing.<br>• A jump catches a lip.<br>• A body left inside the world is moved to the nearest free space within 1.5 m.<br>• Only the bench is the firing step. | unit tests over the generated world; `escape.spec` |
| 2 | **Lobbies:**<br>• Host gives a link; the link opens the lobby.<br>• Players pick Red or Blue and see each other in the lobby; the host starts the match.<br>• Solo play makes no network request. | unit tests (room core, codec); e2e with two pages against `wrangler dev`; `deploy.spec` |
| 3 | **Soldiers:**<br>• Every other player is drawn as a voxel soldier, posed by stance, motion and firing.<br>• Each wears tape in their team's colour on the left arm and around the helmet, readable at night.<br>• What is drawn is what is hit.<br>• Seven soldiers cost ≤ 0.4 ms at the 50th percentile, and the frame holds 14 ms at the 95th. | unit tests (rig, hitboxes); e2e; perf gate |
| 4 | **Fighting:**<br>• Rounds hit players: head, torso, limbs.<br>• Deaths, respawns, kill feed and score are shown.<br>• Friendly fire is on, and a team kill is −1 to the killer's team.<br>• The first team to the kill target wins. | unit tests (rules, body hits); e2e with two pages |
| 5 | **Maps:**<br>• The current map is reshaped organically: angled, meandering bays; noisy, battered walls; rounded parapets; irregular sandbags, craters and trees.<br>• A new Corridor map has a tree corridor down its length and each team at one end.<br>• Both maps can be picked; the host picks the map in the lobby. | unit tests (goldens, symmetry, spawns); perf gates; review |
| 6 | **The shared battle:**<br>• The room runs the artillery and the front for everyone.<br>• Shells and rounds kill.<br>• Every client's world converges: column hashes are compared, and any that differ are repaired.<br>• A hidden tab or a reload catches up. | unit tests; Node clients; e2e |
| 7 | **Nothing lost:** every earlier test passes, apart from the timing gates measured on the M1 Pro, which this machine misses on main too. | the whole suite |

## 1. Movement

All in `src/physics/character.ts`. Each addition is off without its tunable, as in Python's parity fixtures, so the parity scenarios stay Python's.

- **Step-up.** `slide()` finds the ground under the raised footprint with a thin probe, and steps up where the body fits over it. It used to need room for the full step-up at full height.
- **In the air,** a lip up to `air_step_up` (0.3 m) is stepped onto.
- **The mantle replaces the climb onto the bench.**
  - **What starts it:** a body against a face, pushing into it along the way it moves, from the ground or in the air, standing or crouched.
  - **What it climbs:** the lip, or the ground past the lip where that is higher (a slumped parados rises behind its lip), between `step_up` and `climb_m` (3.0 m) over the feet.
  - **W alone climbs only a bench:** mostly bench timber three voxels in, so leaning into the parapet on the step never throws anyone over the top. With jump held, anything is climbed.
  - **Speed:** 2.6 m/s.
  - **Once begun,** it is let go of only by backing off (S) or by meeting an obstruction.
- **The firing step is the bench.** A new palette id, `BENCH`, marks a bench's top: timber as `TIMBER_DARK` is, written by `fill.ts` where a column's step timber reaches its bay's `stepTopY`.
  - Treads, stairs and revetment tops are ordinary ground.
  - The step's speed is 2.2 m/s, and a player can jump from it.
- **The unstick watchdog.** A body inside the world for 10 ticks is moved to the nearest free space. The nearest shell of voxels comes first, and within it the lowest, then the nearest to straight up, so a body a voxel into a face steps back off it and a buried one rises.
- **Keys:**
  - Space, or Shift with W, stands a crouched or prone player up. The press that stands them is not a jump.
  - Prone takes 0.45 s.
  - Suppression slows a player to 0.6 at most.

## 2. Lobbies, the room and presence

- **Determinism first,** so every client's world can follow one ordered log of edits:
  - Edits are held from the moment a shell is posted, in the latest pending job whose region contains them. They are replayed in (tick, author, seq) order.
  - Shells carry x and z only, and their detonation finds the ground from its own copy.
  - Scoops and chars become held edits.
  - Every networked edit applies at its tick + 15.
  - A fuzz test gives the same fingerprints under random worker latency.
- **Pure `src/net/`,** checked by the architecture rules like the simulation:
  - the codec;
  - the match clock;
  - the interpolation buffer;
  - the match rules;
  - the room core, written behind a socket interface.
- **The relay, `server/`:** a Worker, `trenchline-relay`, with a Durable Object `Room` using SQLite classes, as the free plan requires.
  - `POST /rooms` gives a five-letter code; `GET /room/CODE` upgrades to a WebSocket.
  - Only the Pages origin and localhost may connect.
  - A room has 8 seats with teams and ready flags, and an owner (the host), who is migrated if they leave.
  - The host's config: map, kill target, time of day and lapse, intensity, respawn time.
  - Sockets hibernate in the lobby. In a match, a 50 ms loop sends each client one frame at 20 Hz.
  - With 8 players: 160 messages a second in and 160 out. That is about 1.2 KB/s up and 8 KB/s down a client, and about 29,000 billed requests an hour. The free plan's 100,000 a day covers about 3 hours a day of a full lobby.
- **The client:**
  - `src/app/net-client.ts`, `src/app/net-players.ts`, and `src/ui/lobby.ts` with a `#lobby` section in the page. The lobby has Solo, Host and Join by code; a name; Red and Blue columns; a link to copy; the host's settings; Ready; and the host's Start.
  - The network code loads only for `?room=` or Host.
  - In a match the simulation never pauses. The pause menu keeps only the visitor's own settings and Leave.
  - `Session.advanceTo(matchTick)` follows the room's clock. A hidden tab says it is away, and catches up on its return.

## 3. Soldiers

- **`src/combat/soldier-rig.ts`** (pure): about 14 rigid parts, posed from stance, speed, bob, pitch, firing, reloading, the mantle and a death fall. It gives both the parts' transforms and the hitboxes.
- **`src/combat/soldier-model.ts`:** voxel parts at 3 cm, with mips at 6 and 12 cm. The new palette ids:
  - uniform, webbing, skin, helmet and boots;
  - a TAPE id, swapped per soldier for TAPE_RED or TAPE_BLUE, with a slight emissive lift.
- **`src/render/soldiers.ts` and `shaders/soldiers.wgsl`,** after the rifle's pass:
  - One dispatch over an 8×8 tile list, each tile carrying a bitmask of its soldiers.
  - Part boxes, then a nearest-first DDA, then the depth test against `gDepth`.
  - The rifle's shading, with haze.
  - Motion vectors, and a merge of their depth before the rifle.
  - Group 3 holds the soldiers and the haze, so `maxBindGroups` stays 4.
  - The rifle pipeline's storage-buffer limit is checked at 10, as it needs.
  - Soldiers cast no shadows and are in neither reflections nor GI.
- **The first-person rifle** gets a sleeve with the player's tape.

## 4. Fighting

- **Body hits:** `Rounds.advance` tests bodies before the world.
  - The local player's rounds are tested against the remote players, rewound by the interpolation delay (in the shooter's favour).
  - The front's rounds are tested against the local body.
  - Remote players' rounds are tested against nothing.
  - Only a round's author chips the world.
- **The rules:**
  - 100 HP. A round does 100 to the head, 55 to the torso and 30 to a limb.
  - Health regenerates at 10 a second after 6 s without damage.
  - A dead player respawns after 5 s at a free spawn of their team, with 2 s of spawn protection.
  - A kill of an enemy scores +1, a team kill −1 to the killer's team, and the battle's kills nothing.
- **The HUD:**
  - health, the scores, the kill feed, a hit marker, the damage's direction, and the respawn timer;
  - a scoreboard on Tab;
  - a teammate's name, in their colour, when aimed at within 30 m.

## 5. Maps

- A `MapDef` (plain data) moves the layout, the lines, the prop planners, the crater zones, the terrain modifiers, the team spawns, the front's lines and the far field out of the code that assumes one map.
- **The organic pass:**
  - trenches as centrelines with oriented, angled bays;
  - wall noise, a batter, and patchy revetment;
  - cosine parapets with noisy outer slopes;
  - jittered sandbags, noisy mounds and noisy craters;
  - mid-frequency terrain and meandering ditches;
  - round, tapered, leaning trees with sparse foliage;
  - ladders up the parados every second bay.
- **The Corridor map:**
  - a meandering tree corridor about 20 m wide down the map's length;
  - Red's trench system at its south mouth and Blue's at its north;
  - open, shelled flanks;
  - point symmetry about the centre.
- **The current map, reshaped:** Red holds the south lines and Blue the north.

## 6. The shared battle

- **The room runs the artillery and the front** from `planWorld(mapId, seed)`.
  - Shells are broadcast 1.5 s before they land, and every client posts each at its tick.
  - The front fires at players of the team across from its line, weighted by how exposed they are, with a multiplayer accuracy.
  - Each client tests the front's rounds and the blasts against its own body.
- **The director's clock is the match's.**
  - Fires begin from strike reports: the first report wins, and the room rolls.
- **Repair:**
  - Every 5 s, each client reports (column, edit count, hash) for its quiet columns. A column that differs is repaired from the majority's bricks.
  - A rejoin replays the room's 120 s edit log, or takes whole columns.

## 7. Order

| Milestone | Delivers |
|---|---|
| M1 | movement (§1), playable at once, solo too |
| M2 | lobbies and presence (§2) |
| M3 | soldiers (§3) |
| M4 | fighting (§4): playtest 1, on the current map |
| M5 | maps (§5) |
| M6 | the shared battle (§6): playtest 2, on the Corridor map |
| M7 | the README, the build check, and the deploy |

Each push, deploy and `wrangler` step waits for the user's go-ahead.
