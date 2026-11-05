# TRENCHLINE for the web — sub-project 7: the shots overhaul

Written on 2026-11-03 from the user's requests in this session. The user made the decisions below. The rest of the design is the agent's, under the standing build-out mandate (ask only when it is super necessary). The user has not read this spec.

## Why

The user's words:
- "Focus on refining the shooting mechanics within the game. All the game mechanics should be play ready."
- "I want to be able to see every bullet on the tracers. It should look very good as well."
- On what felt off: "Gun in your hands, Recoil and aim feel; the hit feedback hasn't been tested. Make sure it is punchy when you land a shot. The shots overhaul should be very satisfying."
- "Make sure to add a gushing sound to headshots and extra effects for critical hits on someone."

**Where it stands** (main at b702dd6):
- **Tracers:** one round in 3 to 5 is a tracer. The shotgun, pistols, the light front and four in five of the battle's machine-gun rounds draw nothing. The loadout can turn the player's own tracers off.
- **The gun in the hands:**
  - It sits still at its rest pose, apart from the kick, a run's 1.2 cm dip and the walk's sideways sway.
  - A reload is a timer and a HUD word, with no motion.
  - It has no sprint pose, no sway when the view turns, no bob of its own and no landing dip.
- **Recoil** is deliberately light: an AK round kicks the aim 0.34°.
- **Hit feedback:**
  - A small, plain X shows for 160 ms (red for 420 ms on a kill).
  - A hit sounds like timber being knocked, at a gain of 0.4.
  - There is no headshot or kill sound, no reaction from the body that was struck, and no blood.
  - Solo play has nothing to hit, so none of this has ever been tested in play.

**The user's decisions:**
- **Tracers:** every bullet is a tracer: the players', every pellet, the enemy line's, and the battle's machine guns.
- **Their colour is the team's:** Red's rounds are red, Blue's are blue, and the enemy line and the battle are amber. The loadout's tracer choice goes.
- **Solo gets a target range:** simple targets to test guns and see hits.
- **Headshots gush,** and **critical hits** (a headshot, or the round that kills) get extra effects.

## What "done" means

| # | Criterion | Measured by |
|---|---|---|
| 1 | **Every round is a tracer:** each of the 8 guns, each of a shotgun's 9 pellets, the front's rounds at light and heavy, every round of the battle's bursts, and other players' rounds. | unit tests (weapon, session, front, battle tracers); `tracers.spec` counts ribbons against rounds |
| 2 | **Tracers are the team's colour:** red for Red and for solo, blue for Blue, amber for the enemy line and the battle. The loadout no longer offers a colour. | unit tests; `together.spec` with two pages, one per team |
| 3 | **Tracers look very good:**<br>• a white-hot core in a coloured glow, with a burning head;<br>• a streak as long as the round's speed draws in a frame;<br>• lit in over the first metres, so an aimed sight is never covered;<br>• an ember where one strikes, and glancing rounds that ricochet;<br>• readable at noon, dusk and night. | captures in `artifacts/sp7/tracers`; head-over-background contrast measured at the three times |
| 4 | **The gun in the hands moves:**<br>• a bob of its own;<br>• sway when the view turns, and breathing at rest;<br>• a sprint pose, with no shot until the gun is up;<br>• a landing dip;<br>• reloads that tilt and work the gun: the magazine out and in, the bolt; the shotgun's shells one by one;<br>• the shotgun's pump;<br>• a dry click and a reload on an empty trigger;<br>• a flash with a white core and prongs at random, then smoke at the muzzle. | unit tests on the pose curves and the session; captures in `artifacts/sp7/hands`; `hands.spec` |
| 5 | **Recoil has weight and stays honest:**<br>• heavier kick and climb (the table in §3), and the viewmodel's punch retuned;<br>• the camera rolls and shakes with each shot without moving the round. | unit tests (the roll cannot move a round; the plateau, settle and drift); `feel.test` re-pinned |
| 6 | **A hit is punchy, and tested:**<br>• markers for a hit, a headshot and a kill, each popping in;<br>• a thwack for a hit; for a headshot, a crack and a gush; a thud and a chime for a kill; a ding off steel;<br>• the body flinches; a critical hit bursts blood and mist and spatters what is behind;<br>• "HEADSHOT" and "KILL" pop at the crosshair;<br>• being hit flashes red, jolts the aim and thumps. | unit tests (hit feedback, the audio plan, the rig's flinch); `range.spec`; `fight.spec` with two pages |
| 7 | **The range:**<br>• in solo play, dummies stand 25–150 m out in front of the spawn bay, two of them walking, beside steel plates;<br>• a dummy takes a match's damage and falls; after 4 s it is back up;<br>• a readout gives the zone, the damage and the distance;<br>• there is no range in a room or a check run, and no test's world has one unless it asks. | unit tests (range logic, placement on both maps); `range.spec` |
| 8 | **Nothing lost:**<br>• both-peaks gate: 14 ms at the 95th percentile on this Mac, Chrome;<br>• every test that passed at b702dd6 on this Mac still passes;<br>• the sounds are rendered to files for the user to hear. | the whole suite; `npm run sounds` |

## 1. Tracers

- **Every round a tracer:**
  - `[weapon.*]`: `tracer = true` and `tracer_every = 1` for every gun. Each pellet takes the shot's kind, where today only the first does.
  - `[front]`: `tracer_every = 1`, at light as at heavy.
  - `[battle.tracers]`: `tracer_every = 1`, so the director keeps every round of a burst. `max_drawn` rises from 400 to 900.
  - `MAX_RIBBONS` rises to 2048.
- **Kinds** (`net/gear.ts TRACER_KIND`): none 0, amber 1, red 2 and blue 3. Green goes.
  - The session takes the player's kind from their team: `Session.team`, red in solo.
  - Other players' rounds take their seat's team in `Together.prepare`, whatever their shot's word says. The protocol does not change.
  - `Loadout.tracer`, the loadout's tracer row and `Gear.tracer` go. The gear's two tracer bits are written 0 and ignored when read.
- **The look** (`[effects]`; the ribbon pass keeps its single dispatch):
  - **One ribbon per tracer (two while it is lit in part way along its streak, below), two terms across it:**
    - a core, `tracer_core_width_m` 0.035, mixed `tracer_core_white` 0.65 toward white;
    - a glow, `tracer_glow_width_m` 0.22, at `tracer_glow_share` 0.35 of the core's brightness.
    - The glow is drawn between `tracer_glow_min_px` 4 and `tracer_glow_max_px` 10 (internal pixels), so a round past the eye is not a bar across the screen. The core is at most 0.45 of the glow, which wins over the 2 px a ribbon is otherwise held to: 0.45 of the glow, 1.8 px at its 4 px floor, so the glow's colour always shows round it. *(As built: G1 Task 5 tuned these from the captures; the first numbers were a 28 px cap.)*
    - **Whiteness by distance:** the core's white mix is `tracer_core_white × (1 − smoothstep(tracer_white_near_m 6, tracer_white_far_m 40, distance from the eye))`, lifted by day to at least `tracer_white_by_day` 1.0 × daylight. Near the eye a tracer is white-hot; far off it is its team's colour.
    - **Its hue kept:** the tracer family's light (ribbons, heads, embers, ricochets, the battle's streams) keeps its hue through the present pass's per-channel tone curve. The effects pass maps each fragment through the exact inverse of the curve at the frame's exposure, blended back to the per-channel result by the fragment's own whiteness (`tone.wgsl`, `keepHue`). Without this, every far tracer clipped to white.
    - **Under fire too:** suppression's grey (the present pass, `[suppression] desaturate_at_full` 0.55 at its full level) spares light shown near the curve's top. A pixel whose brightest channel is presented (exposed, before the curve) under 1.0 is greyed all the way, and from 4.0 not at all (`[suppression] desaturate_knee`). The world greys, while tracers, flashes and fires keep their colour, which tells friend from foe in the firefights that suppress. *(As built, after G1's final review: greyed with the rest, a far red tracer showed white at full suppression.)*
    - **Over a bright scene:** while the sun is up a tracer's light covers what is behind it as much as it shows its colour (`tracer_cover` 0.95, rising from none to all as the sun climbs over `tracer_cover_deg` [-6, 2] degrees; less as it shows less, and none where it is white-hot, which only adds). Over the low sun's haze red shows red, blue blue and amber amber. From dusk on its light only adds, as approved: over the night's dark sky it reads brighter that way. Its heads and embers are drawn over the ribbons, so a ribbon does not cover its own head. *(As built, after G1's final fix wave: added alone at 17:35, the hour solo opens at, a red tracer's glow showed the haze's hue pulled a little toward red, orange-peach at 23 degrees, halfway to amber's 42, and a blue one lavender-white. Daylight's low end rose from -4 to 2 degrees with it (`tracer_daylight_deg`), so at 17:35 a far head is a twentieth white-hot, not 0.29, and shows red, not pastel pink.)*
    - The flash star keeps today's one-term profile, chosen by a style word in the ribbon.
  - **The head:** an emissive billboard, `tracer_head_m` 0.09 across, `tracer_head_gain` 1.6 times as bright as the core, where the round is.
  - **The streak:** `clamp(speed × tracer_streak_s, tracer_min_m, tracer_max_m)`, with streak_s 0.024 s, min 2.5 m and max 24 m, and never more than the round has flown. An AK round's is 21.1 m, longer than a frame's flight (14.7 m), so a burst reads as an unbroken stream. *(As built; the first numbers were 0.014 s and 14 m, which left dotted chains.)*
    - The battle's tracers use the same law, with their own maximum (`[battle.tracers] trail_m`, 24 m).
  - **Lit in:** the core and the glow rise from 0 at the muzzle to full at `tracer_ignite_hip_m` 1 m from the hip, `tracer_ignite_m` 4 m aimed (lerped by the shot's aimed share), and are full past it. Everyone else's rounds light in over 1 m. The ramp holds along the streak, not only at its ends: a round's first frame reaches back to the muzzle (an AK round flies 14.7 m in a 60 Hz tick), so a streak that spans the point where its round is fully lit is drawn as two ribbons, the ramp up to that point and the rest, both fading toward the tail as one streak does (`tracer_tail_alpha`). A hip shot's first frame is drawn as a round lit from the muzzle is from 1 m on, an aimed one's from 4 m on. The head is drawn from 1.5 m. From the hip, the stretch from the muzzle to the crosshair on screen lies inside the first 3 m, so it has to be lit there to be seen. Aimed, the 4 m ramp keeps the sights clear. *(As built, after G1's final review: the law first ran only at a streak's two ends, so every round's first frame ramped from the muzzle to its head, about 14.7 m, hip or aimed alike.)*
    - **Convergence at the aim's range:** the drawn tracer leaves the muzzle and joins its round's path (from the eye) where the shot was aimed. A ray cast once per trigger pull gives the distance to the first thing on the line, clamped to `tracer_converge_min_m` 8 and `tracer_converge_max_m` 150 (the sky gives 150). *(As built; it replaces a fixed 20 m.)*
  - **Brightness:** `tracer_intensity` 60 → 70, times `1 + tracer_day_boost (3.0) × daylight`.
    - Daylight is the sky's key at the clock: 0 at night, 1 at noon, rising as the sun climbs from 2 to 20 degrees (`tracer_daylight_deg`).
    - A tracer at noon reads against sunlit ground the way one at dusk reads against dusk.
  - **The colours** (linear; shown at their kept hue):
    - red: [1.0, 0.04, 0.018], shown as (255, 59, 41);
    - blue: [0.05, 0.32, 1.0], shown as (65, 152, 255);
    - amber: [1.0, 0.45, 0.0], shown as (255, 177, 0).

    *(As built: these were retuned once hue was kept. The first colours, [1.0, 0.16, 0.10], [0.20, 0.50, 1.0] and [1.0, 0.83, 0.45], showed as salmon, pale blue and cream.)*
- **Embers:** a tracer round that strikes leaves an emissive ember of its colour, 0.06 m across, fading over 0.35 s.
- **Ricochets** (cosmetic, in the effects layer; no new round, so nothing else is struck):
  - **When:** a tracer that strikes within `[effects.ricochet] max_deg` 18° of the face's plane flies again. Its chance is `chance_soil` 0.25 off soil, and `chance_hard` 0.6 off timber, metal, concrete or masonry.
  - **How:** it leaves along the reflected direction, turned by up to 12°, at 0.35–0.6 of its speed. It falls under gravity and burns 0.4–0.9 s, drawn as a tracer of its colour.
  - **Drawn from:** a hash of its impact, so a frame's draws are reproducible.
  - **Kept:** at most 64 at once.

## 2. The gun in the hands

All of it is cosmetic: none of it moves a round, apart from what §3 says the aim does.
- **Where it runs:** the session keeps it, tick by tick (`src/combat/handling.ts`, pure), so the muzzle the tracers and flash leave from is the drawn one.
- **Its numbers** are in a new `[handling]` table.

**Motion:**
- **Bob:** on the stride's phase, scaled by its share of a run.
  - The gun rises and falls by 0.008 m, swings 0.006 m at half the rate (a figure eight) and rolls 0.8°.
  - Aimed: ×0.15. At a sprint: ×1.8.
- **Look sway (inertia):** the turn of the view each tick pushes a damped spring (settle 0.18 s, damping 0.7).
  - The gun trails the turn by 0.00012 m per °/s, sideways and up, and rolls 0.004° per °/s.
  - Held to 0.025 m and 4°. Aimed: ×0.25.
- **Breathing at rest:** 0.0025 m up and down at 0.22 Hz, and 0.0015 m aside at 0.11 Hz. Aimed: ×0.35. Gone at a run.
- **Sprint:** the gun swings low and across: offset (+0.06, −0.06, −0.04) m, pitch −18°, yaw +32°, roll +18°.
  - It comes in over 0.18 s and leaves over 0.12 s.
  - Firing or aiming drops the sprint, and no shot leaves until the blend is under 0.3.
- **Landing:** a dip of 0.03 m and −4° at a hard landing's share, settling over 0.25 s.

**Reloads:** keyed curves over the reload's phase (`Weapon.reloadPhase`, 0 to 1), as the shovel's stroke is. The whole gun moves, since the models are one part.
- **Rifle, carbine, SMG and marksman:**

  | Phase | The gun |
  |---|---|
  | 0.12 | tilted: roll 28°, pitch 8°, offset (−0.02, −0.04, −0.03) |
  | 0.28 | the magazine out: a jolt 0.015 m down, with its click |
  | 0.62 | the magazine in: a jolt 0.02 m up and +3° of pitch, with its clack |
  | 0.82 | the bolt: 0.02 m back and roll 34°, with its rack |
  | 1.0 | at rest |

- **The machine gun:** the same curve, slower and 1.3× as deep, with the feed cover's clap at 0.45.
- **Pistols:** tilted 18°; the magazine out at 0.3 and in at 0.62; the slide's release at 0.86.
- **The shotgun:**
  - It loads a shell at a time: `reload_time_s` becomes `reload_base_s` 0.5 plus `reload_per_round_s` 0.5 for each shell missing, so seven take 4.0 s against today's 4.2.
  - Each shell is a push of 0.02 m and +6° with its click.
  - **The pump:** 0.12 s after each shot, 0.035 m back over 0.12 s and forward over 0.12 s, with its chk-chk.
  - A reload needs the whole tube's time before it fires again, as every gun's does today. Loading shell by shell is how it looks, not a new rule.
- **Empty:** a trigger pulled on an empty magazine clicks once, and a reload starts 0.25 s later.

**The flash and the smoke:**
- **The core:** each shot's star gets an emissive core billboard, 0.10–0.16 m across, for the flash's 0.03 s.
- **The star:** 3 to 5 prongs (`flash_prongs`), each at its own roll and length (0.15–0.30 m), drawn from the shot's hash.
  - A compensator throws two short prongs to the sides instead of the forward ones.
  - A suppressor keeps today's wisp.
- **The light:** unchanged. Intensity 3, radius 6 m, 0.03 s. Brighter than that lit the trench like noon.
- **Smoke:** a new `[particles.muzzle_smoke]`: 1 puff a shot, growing 0.05 → 0.35 m and fading from alpha 0.18 over 1.4 s.
  - It rises at 0.25 m/s and drifts on the battle's wind.
  - A suppressed gun throws 2.

## 3. Recoil and the aim

**The aim** (moves the round; `[recoil.*]`):
- kick ×1.3;
- climb per shot ×1.2;
- climb ceiling ×1.15.

| Gun | Kick (°) | Climb per shot (°) | Ceiling (°) |
|---|---|---|---|
| AK | 0.44 | 0.32 | 1.90 |
| M4 | 0.39 | 0.26 | 1.67 |
| MP5 | 0.23 | 0.16 | 1.09 |
| M249 | 0.42 | 0.20 | 2.53 |
| SVD | 2.08 | 1.08 | 2.88 |
| M870 | 3.90 | 1.80 | 3.45 |
| M17 | 1.17 | 0.66 | 2.30 |
| PM | 1.37 | 0.72 | 2.30 |

- Settle times, drift and the burst reset stay as they are.
- The Python parity scenarios do not cover recoil. If any test pins today's numbers, it is re-pinned to these.

**The camera** (`[viewkick.*]`). These move no round:
- **Roll punch:** `cam_roll_deg` per shot, its side drawn, settling over 0.12 s. Rolling about the line of sight cannot move what the crosshair covers.
  - AK, M4 and M249: 0.7°. MP5: 0.45°. SVD: 1.4°. M870: 1.8°. Pistols: 0.9°.
- **Shake:** for 60 ms after a shot, the eye shakes `cam_shake_m` 0.0015 m and `cam_shake_deg` 0.12°, drawn per tick.

**The viewmodel's punch:**
- back ×1.3 and pitch ×1.25;
- damping 0.7, so it snaps and settles past rest;
- the FOV pulse stays.

**Aiming in:** an aim-in overshoots by 0.4° of the gun's pitch and settles over 0.15 s.

## 4. Hit feedback

**Where hits come from:** `events.hits`, for every owner.
- **Who claims:** the player's own rounds (owner 0) are the claims.
- **What others' rounds show:** on any client, another player's rounds into another body (owner ≥ 2) make the blood, the flinch and the sound for whoever sees and hears them.
- **The player hit:** rounds into the player's own body make the being-hit feedback at once, before the room's word.
- **Critical hits:** a headshot, and the round that kills. A kill is the room's word in a match, and the range's own at once.
  - The death message names no round, so a match's critical kill takes the victim's last hit within 300 ms. Failing that, it bursts at their torso.

**The marker** (`src/ui/hit-marker.ts`):
- **Shape:** the 4 ticks, 1.4vh long and 0.28vh thick, with a dark outline.
- **The kinds:**
  - a hit: white, held 220 ms;
  - a headshot: gold #ffc83d, 1.25× as large, held 320 ms;
  - a kill: red #ff3b2f, 1.5× as large, with a ring, held 600 ms.
- **Motion:** each pops in from 1.6× to 1× over 90 ms and fades over 120 ms. Another hit starts the pop again.
- **In a match,** a hit's or headshot's marker comes at once, and the kill's when the room says.

**The text pop:** "HEADSHOT" in gold or "KILL" in red, 6vh under the crosshair for 0.9 s. A kill in a match adds the victim's name in their team's colour.

**Sounds** (`src/audio/voices.ts`):

| Voice | What it is | Gain |
|---|---|---|
| `hit` | a thwack: a sine falling 160 → 90 Hz over 60 ms, with a click of noise at 2.5 kHz for 12 ms | 0.75 |
| `head` | a crack of two inharmonic partials at 2.9 and 4.6 kHz, over 0.12 s | 0.9 |
| `gush` | a wet gush (below) | |
| `kill` | a thud (a sine falling 70 → 45 Hz over 0.25 s), then a low chime of 880 and 1320 Hz over 0.2 s, 60 ms later | |
| `ding` | a steel plate: partials 690, 1640, 2780 and 4100 Hz, ringing 1.2, 0.7, 0.4 and 0.25 s; heard where the plate is, late by its distance | |
| `hurt` | being hit: a low thump, and a 3 kHz ring that fades over 0.6 s at low gain | |

- **The gush:**
  - Noise through a bandpass sweeping 1.8 kHz → 500 Hz over 0.45 s.
  - Its loudness flutters at a drawn 8–20 Hz.
  - It comes in over 15 ms and dies away over 0.5 s, over a low splat of noise under 400 Hz for 80 ms.
  - The shooter hears it at the ear. Anyone else hears it at the victim, within 25 m.
- **Reload sounds:** clicks and clacks of filtered noise and short partials: `mag-out`, `mag-in`, `bolt`, `shell`, `pump` and `dry`.

**The body struck** (`soldier-rig.ts`, shooter-side or wherever it was seen):
- **Flinch:** a new `PoseInput.flinch` (its direction and age) leans the torso 12° along the round and snaps the head 25° on a headshot. It springs back over 0.25 s.
- **A kill:**
  - The body falls toward the killing round's bearing (`PoseInput.fallYaw`). Today it falls back from its feet.
  - Killed by a headshot, it drops in 0.45 s rather than 0.7.
- **Blood** (new `[particles.blood]` and `[particles.blood_mist]`, lit like dust, not emissive):
  - **An ordinary hit:** 6 droplets and a puff of mist, beside the khaki dust.
  - **A critical hit:**
    - 18 droplets thrown out the far side along the round at 3.5 m/s, spread 0.6, falling under gravity;
    - 3 puffs of mist, growing 0.15 → 0.6 m over 0.9 s;
    - on a helmet, 4 sparks.
- **Spatter** (critical hits only):
  - Up to 14 rays from the hit point along the round, within a 25° cone, reach up to 2.5 m. Each recolours the first solid voxel it meets to its kind's blood shade.
  - New palette entries: BLOOD_SOIL, BLOOD_TIMBER, BLOOD_SANDBAG, BLOOD_DUCKBOARD and BLOOD_CLOTH, each of the kind it marks. Only these kinds take it.
  - As char does, it changes only colour. A fire chars a bloodied timber.
  - In a match, each client spatters from its own hits, so worlds can differ by a few voxels' colour. Sub-project 6's M6 must count these shades as cosmetic or send them.

**The player hit:**
- **A red flash:** a red vignette that fades over 0.35 s, at the damage's share of 100, at least 0.25.
- **A flinch of the aim:** away from the round, 1.5° plus 1.5° × the damage's share. It moves the aim, as suppression's flinch does.
- **The `hurt` voice.**

## 5. The range

- **Where:** `src/combat/range.ts` (pure) and `src/app/range.ts` (into the world, the soldiers and the HUD).
- **When it stands:**
  - in solo play, from the click that starts play, so the page's still and the approved views are as they were;
  - never in a room, in a check run, or with `?range=0`;
  - in tests, only when a test asks (`hooks.range(true)`), as the front holds its fire unless asked.
- **Where things stand:** out along the spawn bay's facing, from its parapet.
  - Dummies at 25, 40, 60, 80, 110 and 150 m, each at its own spot across the bay's frontage, ±12 m.
  - Two dummies walking at 1.4 m/s, 8 m back and forth across, at 50 and 90 m.
  - Steel plates on timber posts:
    - three torso plates, 0.45 × 0.6 m, at 30, 55 and 85 m;
    - two head plates, 0.25 × 0.3 m, at 45 and 70 m.
- **Finding the ground:**
  - Each spot stands on the ground's top there.
  - A spot over water, wire, a crater's bowl or a slope over 30° moves up to 3 m sideways to the nearest one that is not, decided by a fixed search.
  - Both maps are tested.
- **Dummies:**
  - They are soldiers in hunter-orange tape (a new TAPE_RANGE), facing the bay.
  - They are given to the session as `targets`: bodies only the player's rounds (owner 0) strike. Solo's front never strikes them, and they never make a round stop short of the player.
  - **Damage:** each has 100 HP and takes a match's damage, `gunDamage(DAMAGE[zone], gun)` (net/gear.ts, net/match-rules.ts). Health comes back as a match's does.
  - At 0 HP a dummy falls (a critical kill, §4), lies 4 s, and stands up at its spot.
- **Plates:**
  - **What:** voxels of a new TARGET_STEEL (white-painted, kind HULL, so a round sparks off it), on a timber post.
  - **What a hit does:** a round of the player's on a plate rings its `ding`, shows a hit marker, and repaints the voxel it struck TARGET_STEEL_HIT, a lead-grey splash.
  - Others' rounds only spark off it.
  - **Where:** they are written into the world at the click, and taken out when the range is.
- **The readout:** under the marker for 1.5 s.
  - A hit: `TORSO 58 · 47 m`.
  - A plate: `PLATE · 55 m`.
  - A kill: `DOWN IN 3 · 47 m`, with the shots it took.

## 6. Reports and the sound check

**The report rework** (`report` voice): four layers into the voice's chain.
- **The layers:**
  - a click of broadband noise, 2 ms;
  - a body: a sine at the gun's `report_body_hz` (AK 140, M4 150, MP5 190, SVD 110, M249 135, M870 95, pistols 210), falling a third over its 60 ms;
  - the crack: noise bandpassed at 1.5–4 kHz, over 25 ms;
  - the action: a click at 3–6 kHz, 15 ms later, over 10 ms.
- **The tail:** one shared reverb bus for every report. It is a ConvolverNode on a generated impulse: decaying noise, 1.2 s, its highs falling faster. Each report sends `report_tail_send` 0.35 to it, so a report costs no more voices.
- **Suppressed reports** keep their crack and lose the body's highs.

**`npm run sounds`** (`tools/render-sounds.mjs`):
- **What:** renders every voice to WAV in headless Chrome (OfflineAudioContext), into `artifacts/sp7/sounds`, for the user to hear.
- **What it checks:**
  - each file's peak is under −1 dBFS and over −30;
  - nothing is silent;
  - the gush's energy sits mostly in 400 Hz–2 kHz.

## 7. Order

| Milestone | Delivers |
|---|---|
| G1 | tracers (§1) |
| G2 | the range (§5), so every later milestone can be seen and tested in solo |
| G3 | hit feedback (§4) |
| G4 | the gun in the hands (§2) |
| G5 | recoil and the aim (§3), and the reports and sounds (§6) |
| G6 | proof: the captures, the both-peaks gate, the whole suite, and the user's report |

**Rules:**
- Nothing is pushed or deployed without the user's word.
- The relay needs no change for this sub-project.
- Whether the deployed relay scales damage by gun (49bd3e4) is checked against it with bots, and reported.
