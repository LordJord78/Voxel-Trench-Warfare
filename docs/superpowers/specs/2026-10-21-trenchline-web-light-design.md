# TRENCHLINE for the web — sub-project 2: light

- **Date:** 2026-10-21
- **Status:** written for building under the user's standing instruction ("approved continue build out … if you need to stop and ask me something make sure its super necessary"). Like sub-project 1's §3–4, it has not yet been read by the user, and the final report says so.
- **Builds on:** sub-project 1 (docs/superpowers/specs/2026-10-21-trenchline-web-world-design.md), whose world, renderer, movement and budgets it keeps.

## Why

Sub-project 1 draws the dusk-into-night look the user approved, at its own level of light. It has:
- a hand-keyed sky;
- one sun or moon;
- at most 64 point lights, each pixel picking one by scanning them all;
- height fog with no shafts;
- a fixed exposure per time of day.

This sub-project makes the light carry the portfolio piece:
- many lights that stay clean as they move;
- shafts of moonlight and flare light through the fog;
- a sky with a real atmosphere, the moon in its phase, and stars;
- the whole day, not only its end;
- the camera's response to it all: bloom, adaptation, grain.

## What "done" means for this sub-project

| # | Criterion | Measured by |
|---|---|---|
| 1 | GPU frame ≤ 14 ms on the M1 Pro at the high preset's 1.5 MP, dynamic resolution off, for each standard view at dusk, night, noon and dawn. | e2e perf run; Safari report run |
| 2 | 1,024 point lights, 256 of them moving, render without visible fizz at night. The noise is bounded by a test against a many-sample reference. | e2e lighting test; screenshot review |
| 3 | Sky radiance matches a CPU reference of the same atmosphere model within 3%, for sun elevations from −18° to 90°. | e2e sky test |
| 4 | A full 24-hour cycle plays without a jump in exposure, sky or light. Each frame's mean brightness changes by under 2% per minute of game time. | e2e cycle test |
| 5 | Shafts read through gaps: in front of the ruined church at dusk and over the parapet under a flare. | screenshot review |
| 6 | Load ≤ 4 s (Chrome) and ≤ 8 s (Safari) are kept, and every sub-project 1 test still passes. | e2e, `npm run safari` |

## 1. Budget first

The frame already spends 8.4 to 13.0 ms of its 14. Everything this sub-project adds costs about 2.5 ms on the worst view (the overview), so the first milestone buys at least that before anything is added, measured per pass on the overlay:

- **A beam pre-pass for primary rays.**
  - One ray per 8 × 8 tile, traced with a cone the width of the tile, finds the nearest hit any of its pixels can have.
  - Each pixel's ray then starts at that distance less one voxel, so open views stop re-walking the empty air above the field.
  - Target: −30% on the primary pass in the overview.
- **À-trous in shared memory.**
  - Each pass loads its tile, plus a halo of twice its step, once into workgroup memory.
  - Today each of its 25 taps reads three textures.
  - Target: −40% on the three filter passes.
- **Lighting rays by need.**
  - The sky ray (4 m, cosine-weighted) is traced on alternate frames per pixel, half the pixels each frame, with the history weighting it accordingly.
  - The key-light ray is skipped on faces turned from the light. Today they trace and discard.
- **Gate:** every standard view ≤ 11 ms at dusk and night before milestone 2 starts.

## 2. Sky and the day

- **Atmosphere:** Hillaire's 2020 model, all of it in compute shaders on the GPU.
  - Rayleigh, Mie and ozone, at the Earth's radii, for a site at 50° N in northern France.
  - A transmittance LUT (256 × 64) and a multiple-scattering LUT (32 × 32), rebuilt only when tunables change.
  - A sky-view LUT (192 × 108), rebuilt each frame the sun or moon has moved.
  - An aerial-perspective volume (32 × 32 × 32) over the view frustum.
- **The clock.**
  - Time of day becomes a 24-hour clock.
  - Sun and moon positions come from a low-precision ephemeris for the site, with a fixed date (an autumn of 1916, so the moon's phase is known) and a tunable time zone.
  - The sub-project 1 keys map onto it: dusk is 18:40 and night is 21:00.
  - The pause menu's slider becomes the clock, with a time-lapse speed.
- **The moon** lights the scene as sunlight scattered by a grey disc: its phase follows the sun–moon angle. Its disc in the sky shows that phase, with a procedural surface and earthshine.
- **Stars.**
  - A procedural field: about 6,000 stars to magnitude 6, by a hashed cube-map grid.
  - Their brightness follows a magnitude distribution, they fade as the sky brightens, and they twinkle near the horizon.
  - A faint band marks the Milky Way.
- **Sky light on faces.** Voxel faces have six normals. Each frame the sky-view LUT is integrated into six irradiances, one per face direction, replacing the hand-keyed zenith and horizon colours.
- **Fog** keeps the height-fog shape the user approved. Its colour and the light it scatters come from the atmosphere, and the fog density keeps its own time-of-day keys.
- **Exposure** is automatic (§4). The keys keep only an exposure bias, so night stays dark on purpose.

## 3. Many lights

- **Lights become per-frame data.** A storage buffer of up to 1,024 lights is written each frame. Each light has a position, radius, colour, intensity and a flicker phase. Lanterns flicker, flares drift and fade; sub-project 4 will drive them.
- **Light grid.** Built on the GPU each frame: a 2D grid of 8 m cells over the map, each listing the lights whose radius reaches it, at most 32 per cell, nearest first.
- **ReSTIR DI**, at the lighting resolution, replacing the scan-all pick:
  1. **Candidates.** Eight per pixel, drawn from the pixel's cell list in proportion to unshadowed contribution, then resampled to one (RIS).
  2. **Temporal reuse.** Merge with the reprojected reservoir from last frame, which is kept only on the same face and plane, with M clamped to 20 × the candidate count.
  3. **Spatial reuse.** Merge three neighbours within 12 lighting pixels, on the same face and plane, using the unbiased MIS weights.
  4. **One shadow ray** for the chosen light. The result feeds the denoiser as the point-light term does today.
- **The lantern's own voxel.** A shadow ray toward a light stops at the face of the light's emitting voxel, so a lantern no longer frames itself in shadow (sub-project 1's known blemish).

## 4. The camera's response

- **Bloom.**
  - An energy-conserving mix, with no threshold, of a six-level dual-filter pyramid (13-tap down, tent up) over the HDR image before TAA's output is presented.
  - Weight 0.04, tunable.
- **Auto exposure.**
  - A 128-bin log-luminance histogram over the internal image. The darkest 50% and brightest 2% are ignored.
  - It adapts at 3 stops a second toward brighter and 1 toward darker.
  - The keyed bias from §2 is applied on top.
- **Grain.** Blue-noise luminance grain in the present pass, stronger at night (tunable), animated per frame, and below the dither's step at day.
- **Hardening carried from sub-project 1:**
  - TAA ignores NaN and infinite colours.
  - The Karis weights are clamped positive.
  - Fog's exponent is clamped.

## 5. Shafts

- **A light-space height map.**
  - It covers the 256 m map in 0.25 m texels: 1,024 × 1,024, r16float.
  - Each texel holds the height at which a ray toward the key light is first blocked, traced through the voxel world.
  - It is rebuilt over 16 frames, 64k rays a frame, interleaved; the sun moves slowly.
  - It is rebuilt outright when the key light changes between sun and moon, or after a large edit (sub-project 3).
- **In-scattering froxels.**
  - A 160 × 90 × 64 grid over the frustum, exponential in depth to 120 m.
  - Each froxel holds the fog density (the height fog), the key light's visibility from the height map, the Henyey–Greenstein phase (g 0.6 for the sun, 0.3 for the moon), and the point lights from the light grid (four per froxel, chosen as ReSTIR's candidates are).
  - Jittered in depth per frame and blended with the reprojected froxels from last frame.
- **Integration.**
  - A front-to-back pass accumulates in-scattering and transmittance per froxel.
  - Shading reads it at each pixel's depth, replacing the analytic fog for anything nearer than 120 m. Beyond that, the analytic fog continues the same falloff.

## 6. Far field and polish

- **The far field:** shaded with normals from a bicubic fit of its heights and the near field's per-voxel albedo variation, scaled to its cells, so it stops reading as flat facets beside the hamlet.
- **Quality presets:** "high" as above. "Low" also halves the froxel grid's x and y, drops spatial reuse, and keeps the sky-view LUT to 96 × 54.

## Testing

Testing follows sub-project 1's pattern: Vitest for the pure maths, and Playwright GPU cases compared against CPU references.

- **Vitest:**
  - the ephemeris against published sun and moon positions;
  - the atmosphere integrals (a CPU reference in f64);
  - the reservoir arithmetic: RIS and the MIS weights are unbiased on a Monte Carlo test against a closed-form integral;
  - the histogram and adaptation;
  - the light grid's lists.
- **Playwright cases:**
  - sky radiance against the CPU reference;
  - ReSTIR's mean against a 4,096-sample reference at fixed lights;
  - the light grid against a CPU build;
  - froxel transmittance against an analytic fog;
  - bloom energy conservation;
  - exposure convergence.
- **Perf gate** after every task: the standard views at dusk, night, noon and dawn, each ≤ 14 ms (≤ 11 ms through milestone 1).
- **Screenshot sets** at dusk, night, noon and dawn, plus the shaft views, reviewed by eye. Moving captures as in sub-project 1.

## Build order

1. **Headroom:** the beam pre-pass, à-trous in shared memory, lighting rays by need, the hardening, the lantern fix, far-field shading.
2. **Sky and day:** the atmosphere LUTs, the ephemeris and clock, moon and stars, sky irradiance on faces, and fog colour from the atmosphere.
3. **Response:** bloom, auto exposure and grain.
4. **Many lights:** per-frame lights, the light grid, and ReSTIR DI with temporal and spatial reuse.
5. **Shafts:** the light-space height map, froxels, and integration into fog.
6. **Proof:** perf in both browsers across the day, the screenshot sets, and the load budget.

## Not in this sub-project

- Weapons, muzzle flashes and explosions as lights. Sub-project 3 adds them through §3's light buffer.
- Drifting flares, fires and their smoke (sub-project 4); this sub-project gives them their lights.
- Water reflections (sub-project 4).
- Global illumination beyond the sky and the 4 m sky ray: no multi-bounce indirect light.
- Clouds and weather.
