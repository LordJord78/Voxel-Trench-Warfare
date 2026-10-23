# TRENCHLINE for the web — sub-project 3: combat and destruction

- **Date:** 2026-10-22
- **Status:** written for building under the user's standing instruction ("approved continue build out … if you need to stop and ask me something make sure its super necessary"). Like sub-project 2's spec, the user has not yet read it, and the final report says so.
- **Builds on:**
  - sub-project 1 (docs/superpowers/specs/2026-10-21-trenchline-web-world-design.md): the world, the destruction primitives, movement and the budgets;
  - sub-project 2 (docs/superpowers/specs/2026-10-21-trenchline-web-light-design.md): many lights, the froxels' haze, the key's height map and the camera's response.
- **Setting:** a fictionalised Russo-Ukrainian war, as the reference README says. Fictional callsigns and fictional map names. The weapons and artillery are modern.

## Why

The world can be walked and lit, but nothing in it can be fought over yet.

The reference game is at its milestone 2 of 6, and `reference/python` holds what it has:
- one rifle (a 5.45 assault rifle) with a deterministic ballistic model;
- recoil that moves the bullet, and view kick that only moves the picture;
- suppression from near misses;
- digging;
- a destruction library (carve, loosen, collapse, flood) that nothing in the game calls.

It has no shelling at runtime, no effects beyond a flash and brass, no sound, no enemies and no health.

This sub-project does two things:
- **Ports** the reference's combat to 10 cm, keeping its numbers and its tests as the specification.
- **Adds** what makes it a portfolio piece:
  - shells that cut the world at runtime and pour its soil into the trench;
  - muzzle flashes that light the trench through the many-lights renderer;
  - smoke and dust in the haze;
  - a rifle drawn in the world's own light;
  - a HUD and sound.

## What "done" means for this sub-project

| # | Criterion | Measured by |
|---|---|---|
| 1 | The rifle fires at 650 rounds a minute, 30 to a magazine, with a 2.4 s reload. Each round flies with the reference's drag and drop: at 100 m it has flown 0.125 s, slowed to 773 m/s and dropped 7.6 cm, each within 2%. It stops at the first solid voxel and marks soil and timber at 10 cm. Every reference ballistics test passes, ported. | unit tests |
| 2 | Recoil and view kick behave as the reference's tests pin them. Near misses suppress: they pin the player, push them off the firing step, and slow their aim and feet. The reference's suppression tests pass, with its dead sway multiplier wired. | unit tests; e2e |
| 3 | A 3 m shell on a parapet cuts a crater at 10 cm. Its rim slumps into the trench and settles, and water floods below the table. The crater is deterministic (same seed, same voxels). It is in the world within 0.5 s, and no frame's main-thread work exceeds 20 ms while shells land. | unit tests; e2e |
| 4 | **Effects:** a shot's flash lights the trench (a light in the light buffer). Tracers fly. Impacts throw dust coloured by what they hit. A shell throws a flash, smoke and dust into the haze, debris and a shake. The rifle is drawn in the world's light: the key's shadows, the sky and the point lights, its own flash among them. | e2e; screenshot review |
| 5 | **Digging and the HUD:** digging clears loose soil at the reference's rate. The HUD shows the magazine, reloading, stance and dig progress. Suppression greys and vignettes the view. Every shot, crack, impact, whistle and blast has a sound. | unit tests; e2e; review |
| 6 | **Perf:** the GPU frame stays ≤ 14 ms at 1.5 MP in Chrome for every standard view at dusk and night under combat at its peak (below), and the main thread ≤ 8 ms a frame (99th percentile). Peak combat is: a magazine on full auto, shells landing 20–50 m off at one a second, and incoming fire at the heavy rate. Safari is measured under the same peak and reported; its overview already misses 14 ms without combat (sub-project 2). The load budgets hold, and every test of sub-projects 1 and 2 still passes. | e2e perf run (Chrome); Safari report run |

## 1. The rifle and its rounds

### Porting the reference

The reference's `weapons.py` and `ballistics.py` are ported as they are. Their tunables come over unchanged:
- `[weapon.assault_rifle]`: 880 m/s, 3.43 g, Cd 0.295, 2.38e-5 m², 650 rpm, 30 rounds, 3.2 MOA, a 2.4 s reload, automatic;
- `[ballistics]`: g −9.81, ρ 1.225, 4 substeps, a pool of 256, 400 m, 4 s.

**Data-driven weapons.** A weapon is its tunables tables (`[weapon.<key>]`, `[recoil.<key>]`, `[viewkick.<key>]`). Adding one adds tables, not code.

**Origin and aim.** A round leaves from the eye, not the muzzle, as in the reference, so the reticle tells the truth. Its aim is the view's yaw and pitch, plus recoil and flinch, plus the dispersion drawn at the muzzle.
- The dispersion is a uniform disc of 3.2 MOA, scaled by the stance's sway and by suppression (§2).
- It is drawn from the named stream `combat.dispersion`.
- Tracers and the flash are drawn from the muzzle (§4).

**The integrator.** Explicit quadratic drag, gravity, and semi-implicit Euler at 240 Hz (4 substeps of the 60 Hz tick), all in float64.
- The pool is struct-of-arrays, with live rounds a prefix and retirement by swap-with-last.
- A full pool refuses the shot and says so; the round is not consumed (see below).

**Hits.** A new CPU raycast through the brick map (`world/raycast.ts`) finds hits. It is an Amanatides–Woo walk in voxels that skips empty sectors and bricks as the GPU does.
- The first solid voxel along each substep's segment stops the round.
- Water, wire and air let it through.
- A hit records position, normal, voxel, material, speed, distance and energy.

**Marks.** A hit marks its voxel (`destruction.chip`): at ≥ 260 J × the material's hardness, the voxel becomes its spoil (soil to spoil, timber to rubble, branch to air).
- At 10 cm a mark is a tenth of the reference's in size, so a magazine leaves a parapet pocked, not dug through.
- A round leaving the world's box is retired. The reference's solid skirt has no equivalent: the far field is not hit.

### Rulings on the reference's quirks

**Fire rate.** The reference resets the shot timer on each shot, so 650 rpm fires at 600. The port carries the remainder: shots fall on ticks 5 and 6 apart in turn, averaging 650.
- Cost if wrong: 8% more rounds a second than the reference fired.

**Semi-automatic.** The reference's `automatic` flag is never read. The port honours it: a weapon with `automatic = false` fires once per press.
- The rifle stays automatic.

**A full pool.** In the reference, a full pool consumed the round with no recoil. The port refuses the shot instead, leaving the magazine as it was.

**Own impacts.** The reference let your own rounds' impacts within 4.5 m suppress you. The port filters impacts by owner, as it already does cracks.
- Cost if wrong: digging in and firing at a close wall no longer unnerves you.

## 2. Recoil, view kick and suppression

**Recoil** (aim: it moves the round).
- The reference's closed-form damped spring, its kick and climb, and its drift.
- Every magnitude comes from `[recoil.defaults]` overlaid by `[recoil.<weapon>]`, and none is written in code (the reference's test of that is ported).
- Draws come from `combat.recoil`.

**View kick** (cosmetic: it never moves a round).
- Viewmodel punch, an FOV pulse, and the flash and brass, from `[viewkick.*]` with draws from `combat.viewkick`.
- The reference's test that removing it changes no impact is ported.

**Suppression.**
- **Cracks:** a round passing within 3.2 m of the head, measured against each substep's segment, adds 0.34 × nearness². A crack also flinches the aim up by 1.35° × nearness, sideways by a draw from `combat.suppression`.
- **Impacts** within 4.5 m add 0.16 × (1 − d/4.5)².
- **Decay:** the level holds 0.55 s, then falls 0.42 a second.
- **Effects:**
  - movement is scaled to 1 − 0.6 × the level;
  - at ≥ 0.55 the player is pinned: off the firing step and the periscope;
  - the dispersion cone is scaled by 1 + 3.2 × the level. This is the reference's documented effect, which its code computed and discarded; the port wires it.
- **Shells:** a shell's blast suppresses by distance as a crack does, over its own radius (`[suppression] blast_radius_m`, 25 m).

**The camera.** A suppressed camera shakes (0.85° at full, 7.5 Hz), flinches with the aim, and pulses its FOV with each shot. Suppression greys and vignettes the picture in the present pass (§5).

## 3. Shelling and destruction at runtime

### Cost and where it runs

The primitives exist: `world/destruction.ts`'s `detonate` is generation's crater-cutter. They were measured on the generated world, at 10 cm, at front-line parapets:

| Shell radius | Carve | Collapse | Flood | Bricks dirtied |
|---|---|---|---|---|
| 1.5–3.4 m (15–34 voxels) | 7–38 ms | 88–426 ms | 8–32 ms | 134–667 |

The work regions are about 100–150 voxels across. So a shell cannot be cut on the main thread.

### Ruling: a destruction worker

**The work is done on regions, not the world.**
- The main thread copies the region a detonation will work over out of the brick map, brick by brick. That is the blast's box, widened by the collapse's slump margin and extended down to the solid floor and up through what rests on it.
- It transfers the copy to the destruction worker.
- The worker runs `detonate` on it, with the same code generation uses, and sends back the changed bricks.
- The main thread writes them back, spread over frames under a budget of 4 ms a frame.
- If the collapse still reaches the region's edge with open air beyond (rare), the worker asks for a wider region.

**Edits while a region is out.** A round's mark or a dig inside a region that is out is held, then made again after its bricks come back. A second shell whose region overlaps one that is out waits for it. Requests are served in order.

**Determinism.**
- Tests run the same worker code in-process, in step with the ticks, so the same seed and the same inputs give the same voxels.
- In play the result lands at whatever tick the worker finishes, typically 0.2–0.5 s later, behind the blast's smoke and dust (§4).

**Cost if wrong:**
- a crater appears a few hundred milliseconds after its flash;
- a full copy of the world in the worker, shared or kept in step by messages, would avoid the copy-out but doubles hundreds of MB of bricks. With SharedArrayBuffer it also needs cross-origin isolation, which static hosting may not give.

### Shells

A shell has:
- a radius, 2.2–3.4 m, drawn from `combat.shells`;
- an impact point: the top of the ground where its trajectory meets it;
- a time of flight;
- a whistle, heard about 1.5 s before impact (§5).

`detonate` runs as in generation: hard materials survive outside the core, the core takes everything, a rind 1.45 radii out is shaken loose, the collapse settles it at its angle of repose, and below the water table it floods.

### Incoming fire (the front)

The reference had a tuning rig for incoming fire and no shooter behind it. This sub-project keeps that idea. A scheduler, the front, fires on the player's sector from the enemy line in the plan. It has no squads, no AI and no damage.

**Rifle and machine-gun fire.** Bursts from the enemy line's bays, aimed at the player's position with spread (`[front]` tunables). Their cracks and impacts suppress.

**Shells.**
- Most land in no man's land and along both lines.
- Some land in the player's sector, no nearer than 15 m unless the intensity is heavy.

**Intensity** is set in the pause menu:
- **Off.**
- **Light** (the default, so a visitor hears the front without being pinned).
- **Heavy** (the perf gate's peak).

Sub-project 4 builds the battle around the player (distant artillery, tracers across the sky, fires) on these same systems.

### On the GPU

Changed bricks reach the GPU through the existing upload queue, nearest first. After an edit of more than 64 bricks, the key light's height map is traced outright in one frame, not a sixteenth at a time, so a crater's shadow is right at once (the light spec's §3 deferred this to here). The flares' maps follow the world as they do now. The far field is not edited.

## 4. Effects, and the rifle in the world's light

### The effects pass

A raster pass draws effects into the image after sharpening and before bloom, at the internal resolution.
- It is depth-tested against the G-buffer's depth, so walls hide what is behind them.
- Bloom and the exposure then treat effects as they treat the world.

It draws:
- **tracers:** camera-facing ribbons from a round's head back along its path, up to 7 m, bright and additive, for rounds with `tracer = true` (every fifth, `[weapon] tracer_every`, and every incoming machine-gun round);
- **the muzzle flash:** a short star of quads at the muzzle point, for 2–3 frames;
- **particles:** brass, sparks, impact dust coloured by the hit material's palette, a shell's thrown soil, and debris cubes. They are simulated on the CPU (the reference's `particles.py`, struct-of-arrays, a pool of 4,096) and drawn as quads lit by the sky's irradiance and the key.

### Light from effects

- Each shot adds a point light at the muzzle for 2 frames: warm, about 0.5 m across, falling over 6 m.
- A shell adds a blast light that flares and dies over 0.3 s.
- Both go through the light buffer, so ReSTIR picks them like the lanterns and flares, with their shadows.

### Smoke and dust in the haze

A blast leaves a few spheres of extra density that the froxels' inject pass adds to the haze. They rise and spread, and fade over about 15 s. Every light lights them as it lights the haze, so a flare's light and the moon's shafts cross the smoke.

### The rifle in the world's light

The rifle is a voxel model at 1.5 cm in its own space, made procedurally:
- the receiver and its dust cover;
- a curved 30-round magazine;
- the barrel and muzzle device;
- the handguard and the stock;
- iron sights.

A pass after the primary pass traces it, for the pixels in its screen box. Where it is nearer than the world, it writes the G-buffer:
- the depth;
- a face and a palette from the model;
- a marker in place of a world cell;
- motion from its own movement.

The lighting passes then light it as they light the world. The trench's shadow falls on it, the sky lights it, the lanterns light it, and its own flash lights it.

**Ruling:** the rifle is drawn into the G-buffer, not rasterised over the image with lighting of its own. Its light then always agrees with the world's.
- Cost if wrong: every pass that reads a world cell from the G-buffer must take the marker, and the plan's tests pin each one.

## 5. Digging, the HUD and sound

### Digging

- Digging clears loose soil (spoil, rubble, sandbags) in front of the feet at the reference's rate: 0.125 m³ per 1.35 s, which is 93 voxels a second at 10 cm.
- It works in scoops. Each scoop takes the nearest loose voxels in reach (1.6 m) and runs a collapse over the scoop's neighbourhood, so nothing is left hanging (the reference left it).
- While digging, aim sways 1.6 times as much, and exposure is scaled by 1.25 (shown only).

### The HUD

DOM over the canvas, in the loading screen's and pause menu's type and colours.
- **Rifle:** the magazine count, or "reloading".
- **Status:** the stance, dig progress when digging, and a small crosshair (the reference's four ticks).
- **Suppression:** greys and vignettes the picture in the present pass (desaturation 0.55, vignette 0.5 at full), not with a DOM overlay.

### Sound

Sound uses WebAudio. Every sound is synthesised: no asset files, nothing added to the load.

| Sound | How it is made |
|---|---|
| The rifle's report | A noise crack, a low thump and a tail. Distance filters it and delays it at 343 m/s. |
| A round's crack past the head | A sharp click, by nearness. |
| Impacts | By material: soil thuds, timber knocks, metal pings. |
| A shell's whistle | Falls in pitch over its last 1.5 s. |
| A blast | A sub-bass thump and a rumble, delayed by distance, then soil raining down. |
| Digging | A scrape per scoop. |

- Sounds are placed with HRTF panners.
- The audio context starts with the click that starts play.

## Testing

**Unit (Vitest).** The reference's tests, ported as specification:
- `test_ballistics`: drag, drop, the flight table, first-solid stops, air and water passed, retirement, the pool's ceiling, tracers, determinism, and the dispersion cone;
- `test_recoil`: no magnitude in code, the kick's peak, settle and no bounce, the climb's plateau and bleed, drift, the exact spring;
- `test_viewkick`: cosmetic only, overshoot, settling together with recoil, particles;
- `test_suppression`: segment distance, nearness, the hold, the cap, pinning, flinch;
- `test_destruction`'s shell and chip cases at 10 cm;
- `test_entrenching`: rate, reach, materials, interruption, prone.

New:
- the raycast against the GPU traversal's CPU reference;
- the region copy-out and write-back, brick for brick;
- the worker's result equal to an in-process `detonate`;
- held edits made again;
- the fire rate's remainder;
- semi-automatic fire;
- the own-impact filter;
- the wired sway multiplier.

**GPU (Playwright, Chrome).**
- The rifle's G-buffer pass against a CPU trace of the model.
- The effects pass hidden by a wall.
- A shot's light in the light buffer.
- The haze denser inside a blast's sphere.
- The key map traced outright after a large edit.
- The perf gate under peak combat.
- The main thread's frame times while shells land.

**Review.** Captures of a magazine fired along a bay at dusk and at night, a shell on the parapet (before, during and after), suppression under heavy fire, and digging out a slumped bay.

## Build order

Each milestone has its own plan, as sub-project 2's did:

1. **The rifle and its rounds:**
   - the CPU raycast;
   - weapons and ballistics, with marks;
   - firing from the session (left mouse) and reloading (R, moving dynamic resolution's developer key to Y);
   - the reference's tests.
2. **Recoil, view kick and suppression,** with the front's rifle fire and the camera's response.
3. **Effects, the rifle and the sound of a shot:**
   - the effects pass, particles and tracers;
   - shot lights;
   - the rifle in the G-buffer;
   - the audio engine with reports, cracks and impacts.
4. **Shelling:**
   - the destruction worker and region copies;
   - shells and the front's artillery;
   - blast light, smoke in the haze, debris and shake;
   - the whistle and blast sounds;
   - the key map traced outright after a large edit.
5. **Digging and the HUD:** digging at 10 cm with collapse; the HUD; suppression's look; digging's sound.
6. **Proof:** the perf gate under peak combat in Chrome and Safari, the review captures, and every earlier test.

## Not in this sub-project

- Enemies, squads, AI, health, damage, death and respawn. The front shoots without anyone behind it, and being shot at is felt through suppression. That is the reference's design to date.
- Grenades and other weapons. The data allows them; none is built.
- Aiming down the sights.
- Drones and vehicles (the reference's packages for them are empty).
- Penetration and ricochet.
- The battle around the player: distant artillery, tracers across the sky, fires and water (sub-project 4).
