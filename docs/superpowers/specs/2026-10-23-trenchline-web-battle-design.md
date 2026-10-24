# TRENCHLINE for the web — sub-project 4: the battle around you

Written under the user's standing instruction (build out without stopping; ask only if super necessary). The design decisions are the agent's, and the user has not reviewed this spec, as for sub-projects 2 and 3.

## Why

Sub-projects 1–3 built a front-line trench that a visitor can walk, light and fight in. Around them, though, the night is still: six flares hang where they were placed, the horizon glows a steady violet, and no one fires but the stretch of front facing the player.

This sub-project makes the war visible beyond arm's reach:
- flares fired from both lines that climb, burst and drift on the wind;
- barrages beyond the map, flickering on the horizon and rumbling seconds later;
- machine-gun tracers arcing across the sky;
- fires that shells start, burning for minutes and smoking into the haze;
- water in the craters that reflects all of it.

It is built on what exists:
- the light buffer and its ray-traced shadows (sub-project 2), and the flares' shadow maps;
- the froxel haze and its smoke puffs;
- the effects pass's ribbons and billboards (sub-project 3);
- the artillery and the front (sub-project 3);
- the shared voxel traversal.

## What "done" means for this sub-project

| # | Criterion | Measured by |
|---|---|---|
| 1 | **Flares:** at night both lines fire flares. Each climbs from a post on its line, bursts 25–40 m up (low enough for its 65 m of light to reach the field, as the approved flares at 22–32 m did), drifts downwind on its parachute along no man's land, sinks 0.3 m/s, burns 40 s and gutters out over 5 s. At the light intensity about six burn at once, as the approved night's six static flares did, and light no man's land about as they did. Never more than 16 are alight. Each lights the field, and the eight nearest the player cast their shadows into the haze. The same seed and inputs fire the same flares. | unit tests; e2e; review |
| 2 | **Distant artillery:** barrages fall beyond the map along the front. Each shell flashes on the horizon in its own direction, lighting the sky and the haze there, and is heard distance ÷ 343 m/s later. Shells landing in the far field (200–800 m off) show a flash and a column of smoke. The tempo follows the front's intensity. | unit tests; e2e; review |
| 3 | **Tracers across the sky:** at night, machine guns on both lines fire streams of tracers over no man's land and the field. Some ricochet upward, all fall under gravity, and the distant chatter is heard. At the light intensity at least 20 tracers are in flight on average. | unit tests; e2e; review |
| 4 | **Fires:** a shell that strikes timber, cloth or a hull starts a fire with a set chance, and the hamlet's ruins burn at night. A fire flickers and casts shadows, throws flames and embers, and smokes into the haze, leaning downwind and visible at dusk and at night. It burns for 2–6 minutes and chars what it burned. | unit tests; e2e; review |
| 5 | **Water:** water's surface reflects the voxel world as it is lit, the sky, and the flares and fires as glints. Rounds, shells and debris falling in water ripple it, and the wind roughens it. The reflection costs ≤ 1 ms at no man's land at night. | e2e; review |
| 6 | **Perf:** with the battle at its peak, and the combat peak of sub-project 3 on top, every standard view at dusk and at night holds the GPU frame ≤ 14 ms at the 95th percentile at 1.5 MP in Chrome, and the main thread ≤ 8 ms at the 99th. The battle at its peak is: the heavy intensity, the maximum flares and fires, and a barrage and tracer streams in progress. Safari is measured under the same and reported. The load budgets hold, and every earlier test passes. | e2e perf run; Safari report run |

## 1. The battle's director and the wind

- **The director** (`src/battle/director.ts`) is a deterministic simulation with its own seeded streams (`battle.*`), ticked at 60 Hz on the lights' clock (sub-project 2), not the session's.
  - That clock runs whenever the world is drawn, in fly mode and the check as in play, and stops only for the pause menu. So the standard views and the check see the battle too; the session, which runs only in play, could not show it to them.
  - The same clock steps give the same events. Tests hold the battle at a moment as they hold the lights (`holdLights`), by running the director from its start to that moment.
  - The app feeds it what the session does that it must answer: each shell's strike and its material (for fires), and where rounds and shells meet water (for ripples).
- **Each tick it schedules:**
  - flare launches;
  - barrages beyond the map, and shells into the far field;
  - tracer bursts;
  - and it carries the fires.
- **Its tempo follows the front's intensity,** the pause menu's choice: `off`, `light` or `heavy`, as sub-project 3's front and artillery do.
  - `off` keeps a quiet night: a flare a minute, and nothing else.
  - Flares and tracers answer the clock. They are fired only while it is dark enough (the sky state's `flares` key above 0.1) and the sun is down, so dusk shows the distant artillery and the smoke but no flares, and the morning none.
  - A jump of the clock into the night (a view, the time key, the pause menu; not the time-lapse's creep) finds a night already under way: the director runs a flare's climb and burn (45 s) first, unheard.
- **The director is in `src/battle/`.** Like `core`, `world`, `physics`, `sim` and `combat`, it imports nothing from `render`, `ui`, `app` or `audio`, uses no DOM, WebGPU, WebAudio or timing globals, and only the exactly rounded `Math` functions. The architecture test gains it.
- **Events** are drained each frame with the session's combat events: flares lit and burning, distant flashes, far shells, tracer segments, fires.
  - The renderer turns them into lights, effects, sky terms and haze.
  - The audio engine turns them into voices.
- **The wind** (`src/battle/wind.ts`) blows over the whole map. It veers slowly, a few degrees a minute, about a prevailing direction along the front, so the flares drift along no man's land (from the enemy's side at up to 5 m/s, it carried them over the lines behind, and no man's land had a sixth of the approved light). Its speed is 1–3 m/s with gusts, and it is the same for everything it carries:
  - flares drift with it;
  - smoke plumes lean with it;
  - water roughens with it.

## 2. Flares

- **They replace sub-project 2's six static flares.** The night's look was approved with six burning, so at the light intensity the director keeps about six alight on average.
- **Launches** come from posts along both front lines: the friendly line, and the enemy's 60–120 m beyond no man's land. Each post fires a flare every so often, by a Poisson schedule with its own rate, and a quarter of launches come from the player's own bay sector.
- **A flare's flight:**
  - It leaves its pistol at about 40 m/s at 70–85° and climbs under gravity and drag, a spark trailing it.
  - At its apogee (25–40 m) it bursts: its light catches over 0.5 s.
  - It drifts with the wind under its parachute, sinking 0.3 m/s. It burns 40 s, guttering over the last 5.
- **Its light** goes into the light buffer as now: radius 65 m, intensity 260, and its warm colour.
- **The eight flares nearest the player** hold the flare shadow maps (flare-shadows.ts), so their light in the haze is cut into shafts. A flare is a moving light, so its map is retraced as it drifts, as now.
- **The horizon's front glow** follows the flares burning (their count, and their distance to the horizon) rather than the clock alone.
- **Sound:** the pistol's pop at the post, the hiss as it climbs, and nothing while it burns.

## 3. Distant artillery

- **Barrages beyond the map** fall 1–8 km off along the front, to either side and beyond the enemy's line. A barrage is a run of 6–40 shells over 10–60 s from a bearing. The tempo follows the intensity: at `light` a barrage every few minutes, at `heavy` one or two always in progress.
- **Each shell beyond the map** is a horizon flash:
  - a brief glow of the sky and the haze in its direction, low on the horizon, its strength by its distance;
  - it lights the far field's silhouettes toward it;
  - the sky shader takes the 16 most recent flashes: bearing, strength and age.
  - Its rumble comes distance ÷ 343 m/s later: a low thud, longer and duller the farther.
- **Shells into the far field** (200–800 m off, within the far-field terrain) show:
  - a flash: a billboard and a brief unshadowed light;
  - a smoke column that rises and leans with the wind for a minute;
  - their thump after their distance.
  - They cut no craters: the far field is a height field, and craters there are not shovel work.
- **Sub-project 3's shells near the player** are unchanged. The director's distant fire only adds to them.

## 4. Tracers across the sky

- **Machine guns** stand at posts along both lines, beyond the stretch of front that fires at the player (sub-project 3's front). Each fires bursts of 5–20 rounds, every fifth a tracer, sweeping across a bearing over no man's land and the field.
- **The tracers fly** under gravity and drag along simplified ballistics: the reference's projectile, without strikes.
  - A round that falls below the ground ends.
  - One in six ricochets: it climbs again from where it struck, slower, at a random bearing.
  - They are aimed over the field away from the player's own bay, so none passes near the player. They are seen and heard, not felt: sub-project 3's front is what fires at the player.
- **The tracers are drawn** as the effects pass's ribbons, as sub-project 3's are: a bright head and a fading trail. Up to 400 are in flight; beyond that the farthest are not drawn.
- **Sound:** the distant chatter of each burst, after its distance.

## 5. Fires and their smoke

- **Shells start fires:**
  - A shell (sub-project 3's, or the director's near shells) that strikes timber, cloth, duckboards or a wreck's hull starts a fire at the struck surface: by chance: a third for timber, cloth and duckboards, a fifth for a hull.
  - At night the hamlet's ruins burn: 2–4 fires placed in its buildings by the plan.
  - At most 12 fires burn at once; past that, the oldest goes out.
- **A fire** grows over 20 s, burns 2–6 minutes and dies down over a minute:
  - **light:** a light in the light buffer, flickering (the lanterns' flicker, stronger and faster) and shadowed by the many-lights pass, radius 12–25 m by its size, warm orange;
  - **flames:** emissive particles rising and fading;
  - **embers:** small lit sparks carried up and downwind;
  - **smoke:** a plume in the haze;
  - **char:** what it burned is charred (its voxels take the burnt palette shades) and stays so;
  - **sound:** a crackle, heard within 30 m.
- **A plume** is a chain of six of the haze's analytic puffs (sub-project 3's closed-form spheres). They rise from the fire, grow and thin with height, and lean with the wind.
  - The haze takes the 64 puffs nearest the camera each frame, blasts and plumes together. The per-frame limit grows from 16.
- **A fire does not spread.**

## 6. Water

- **Reflections.** Water's top traces a reflected ray through the voxel world with the shared traversal, up to 160 m, then the sky beyond. The hit is shaded cheaply, not by the denoised lighting, which it does not have:
  - its albedo;
  - the key light through the key shadow map;
  - the sky's ambient;
  - the nearest few lights of its light cell, unshadowed;
  - its emission.
  - Flares and fires, the brightest lights, add their glints: where the reflected ray passes close to such a light, its disc.
  - A Fresnel term weighs the reflection against the water's own dark colour, as now with the sky.
- **Ripples.**
  - A round, a shell or debris falling in water starts a ring: it spreads at 1 m/s and fades over 2 s.
  - The surface's normal takes the 32 newest rings, and the wind's roughness on top.
- **Quality presets.** The low preset reflects the sky and glints only. The high preset traces the world.

## 7. Sound

New voices, made as sub-project 3's are from noise and oscillators with no samples:
- the flare pistol's pop and the flare's hiss;
- the distant rumble and the far thump;
- the distant machine guns' chatter;
- a fire's crackle, by distance;
- a splash where a round or a shell meets water.

Each is placed where it happens and arrives late by its distance at 343 m/s. The engine's voice count is capped (64 sounding at once, the farthest dropped first), so a heavy night cannot swamp the main thread.

## 8. Perf and quality

- **The battle adds:**
  - lights: up to about 14 flares and 12 fires, each fire shadowed (the many-lights pass takes them);
  - effects: up to 400 tracers and the fires' particles;
  - 64 puffs in the haze;
  - the sky's 16 flashes;
  - reflection rays on the water's pixels.
- **The budget is sub-project 3's:** 14 ms GPU at the 95th percentile at 1.5 MP, and 8 ms main thread at the 99th. It holds under the battle's peak and the combat peak together, at every standard view, at dusk and at night.
- **The low preset** halves the flares' shadow maps (4), traces no world reflections, and keeps the 32 nearest puffs.

## Testing

**Unit (Vitest):**
- the wind's veer and gusts, deterministic;
- a flare's flight: its apogee, burst, drift with the wind, sink, burn and gutter;
- the flare schedule's mean count by intensity;
- the director's determinism (same seed and inputs, same events);
- barrages' bearings, distances, tempo, and the flashes' and rumbles' delays;
- tracers' flight, ricochets and ends;
- fires: their chance by material, growth, burn and death; the cap; the char;
- the plume's puffs;
- the ripple rings' spread and fade;
- the audio plan's new voices and the voice cap;
- the architecture rule for `src/battle/`.

**GPU (Playwright, Chrome):**
- a flare's light and its shadow map following it as it drifts;
- the horizon flash brightening the sky in its direction and not opposite;
- the tracers drawn and hidden by a wall;
- a fire's light, its particles, and its plume in the haze;
- the water's reflection of a lit wall, of a flare's glint, and ripples spreading;
- the perf gate under the battle's peak with the combat peak.

**Review captures:**
- no man's land at night under the flares;
- a barrage on the horizon at dusk;
- tracers over the field at night;
- a fire burning in the bay and its smoke at dusk;
- a crater's water reflecting a flare;
- the hamlet burning at night.

## Build order

Each milestone has its own plan:

1. **Flares fired and drifting:** the director and the wind; the flares' flight, light, shadows, glow and sound, replacing the static six.
2. **Distant artillery:** barrages beyond the map, the horizon flashes and rumbles, shells into the far field with their flash and smoke.
3. **Tracers across the sky:** the machine guns' streams, ricochets and chatter.
4. **Fires and their smoke:** shells starting fires; the hamlet burning; light, flames, embers, plumes, char and crackle; the haze's 64 puffs.
5. **Water:** traced reflections, glints, ripples and splashes.
6. **Proof:** the perf gate under the battle's peak with the combat peak, in Chrome and Safari; the review captures; every earlier test.

## Not in this sub-project

- Enemies, squads, AI, health, damage and death: the battle is seen and heard, not fought.
- Rain and weather beyond the wind.
- Fires that spread.
- Craters in the far field.
- Day-time flares.
- Vehicles and aircraft.
