# Light, Milestone 2: Sky and Day Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Replace the hand-keyed dusk-to-night sky with a physically based atmosphere, a sun and moon placed by a 24-hour clock at a real site and date, the moon in its phase, and stars.
- Keep the approved dusk look at 18:40 and the night look at 21:00.

**Architecture:**
- **The clock** is TypeScript. A low-precision ephemeris turns the hour into sun and moon directions at 50° N. A map-bearing tunable orients the world.
- **The atmosphere** is three compute LUTs (Hillaire 2020), checked against an f64 CPU integrator of the same model.
- **Shading** reads the sky-view LUT for misses, the fog colour and six face irradiances. The sun disc, the moon disc in its phase and the stars are drawn in the shade pass.
- **Exposure** stays keyed per hour until milestone 3 makes it automatic.

**Tech Stack:** TypeScript, WGSL compute, Vitest, Playwright GPU cases.

**Spec:** docs/superpowers/specs/2026-10-21-trenchline-web-light-design.md (§2 Sky and the day; done-table rows 3, 4).

## Global Constraints

- **Site:** 50.0° N, 2.7° E (the Somme), on 21 October 1916. Time zone UTC+1 (tunable).
- **The clock:**
  - It maps 18:40 to the sub-project 1 dusk key and 21:00 to the night key.
  - The default at load stays dusk (18:40).
- **Map bearing.**
  - `world.map_bearing_deg` is the compass bearing of +z.
  - It is chosen so the sun at 18:40 stands within 3° of sub-project 1's dusk azimuth (18° from +z toward +x). That preserves the approved composition.
- **Sky accuracy:** GPU sky radiance within 3% of the CPU reference for sun elevations −18° to 90°. That is the spec's done-table row 3.
- **Perf:** the perf gate stays ≤ 14 ms for every standard view, at its own time and at noon.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Sun below the horizon, and twilight.** At −18° to 0° the LUTs must stay finite and dark, with no NaN where the transmittance is near zero. The key light hands over from sun to moon without a jump. Pinned in Tasks 2 and 3 (the LUT sweep includes −18°; the clock test checks the hand-over).
- **The moon's phase at new moon and at full moon.** No division by zero in the phase. The disc drawn is dark at new moon and full at full moon. Pinned in Task 1 (phase-angle tests) and Task 4 (the disc).
- **Camera altitude.** The sky-view LUT is built for the camera's height. Values must stay valid from 0 m to the 2 km a fly camera reaches, as M4's fog hardening required. Pinned in Task 2 (the sky test at 2 km).
- **The approved look.** Dusk at 18:40 and night at 21:00 must read as sub-project 1's did: warm low haze, then a moonlit violet night. Pinned in Task 5 (screenshot review against `artifacts/m4/` by eye, ledgered).

---

### Task 1: The clock and the ephemeris

**Files:**
- Create: `src/core/ephemeris.ts` (pure, dmath only, so it is deterministic), `tests/core/ephemeris.test.ts`
- Modify: `data/tunables.toml` (`[sky]`: `latitude_deg`, `longitude_deg`, `date` = "1916-10-21", `utc_offset_h`, and `world.map_bearing_deg`)

**Interfaces:**
- `sunPosition(jd: number, latDeg: number, lonDeg: number): { azimuthDeg: number; elevationDeg: number }`, with the azimuth as a compass bearing.
- `moonPosition(jd, latDeg, lonDeg): { azimuthDeg; elevationDeg; phaseAngleDeg; illuminated: number }`.
- `julianDay(date: string, hours: number, utcOffset: number): number`.
- `toWorld(azimuthDeg, elevationDeg, mapBearingDeg): [x, y, z]`: a unit vector, with +z at the map bearing and +x 90° clockwise of it.

- [ ] **Step 1: Write the failing tests.**
  - **Reference values.** Take them from a published ephemeris: NOAA's solar calculator for the sun, and a published lunar ephemeris for the moon. Fetch them at implementation time (WebSearch) and record the source in the test.
  - **Sun.** For the site on 1916-10-21 at 12:00, 18:40 and 21:00 local, the elevation and azimuth match within 0.2°.
  - **Moon.** For the same times, within 1°. The phase angle and the illuminated fraction match the published values within 2° and 0.03.
  - **Properties.**
    - At an equinox noon at 50° N, the sun's elevation is 40° ± 0.5°.
    - New and full moon give an illuminated fraction ≤ 0.02 and ≥ 0.98, with no NaN.
  - **Map bearing.** `toWorld` of the sun at 18:40 is within 3° of the sub-project 1 dusk direction.
- [ ] **Step 2: Run** `npx vitest run tests/core/ephemeris.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The sun follows Meeus ch. 25's low-precision method. The moon follows Meeus ch. 47, truncated to the largest terms.
  - The local horizon comes from the sidereal time (ch. 12).
  - Choose `map_bearing_deg` so the sun at 18:40 stands at sub-project 1's dusk azimuth relative to +z, and ledger the value.
- [ ] **Step 4: Run.** Expected: PASS. `tests/architecture.test.ts` stays green: ephemeris uses dmath.
- [ ] **Step 5: Commit** "Place the sun and moon by the clock, over the Somme in October 1916".

### Task 2: The atmosphere's LUTs

**Files:**
- Create: `src/render/shaders/atmosphere.wgsl`, `src/render/atmosphere.ts` (the LUT textures and passes), `tests/support/atmosphere-ref.ts` (an f64 CPU integrator), `tests/e2e/cases/sky.ts`, `tests/e2e/sky.spec.ts`
- Modify: `data/tunables.toml` (`[atmosphere]`: Rayleigh, Mie and ozone coefficients and scale heights; ground albedo 0.3; radiance scale)

**Interfaces:**
- `class Atmosphere`:
  - `static create(device, tunables)`;
  - `update(encoder, sunDir, cameraHeightM)`: rebuilds transmittance and multiple scattering when the tunables change, and the sky view every call;
  - `views()`: the three LUT views, for a scene binding.
- The CPU reference computes `skyRadiance(sunDir, viewDir, heightM)` with the same model, in f64, with 10× the steps.

- [ ] **Step 1: Write the failing test** `sky.spec.ts`, "the sky matches the reference model":
  - Sweep sun elevations of −18, −6, 0, 4.5, 15, 45 and 90°.
  - At each, 64 view directions at the camera heights 2 m and 2,000 m.
  - The GPU sky-view LUT, sampled as shading samples it, is within 3% (relative) of `skyRadiance`, or within 1e-6 absolute where it is darker than that.
  - No NaN anywhere.
- [ ] **Step 2: Run.** Expected: FAIL (no module).
- [ ] **Step 3: Implement.**
  - The transmittance LUT is 256 × 64, with the Bruneton parametrisation.
  - Multiple scattering is 32 × 32: 64 directions, with an isotropic second order.
  - The sky view is 192 × 108, with Hillaire's non-linear elevation mapping, a 30-step march, and the sun's transmittance from the LUT.
  - Bind them in the scene layout, at bindings 11–13.
- [ ] **Step 4: Run.** Expected: PASS. Ledger the worst relative error per elevation.
- [ ] **Step 5: Commit** "Build the sky from Rayleigh, Mie and ozone: transmittance, multiple scattering and the view from the camera".

### Task 3: Light from the sky, and the key light by the clock

**Files:**
- Modify:
  - `src/render/sky-state.ts`: `skyState(tun, hours)` takes the clock. The key light comes from the ephemeris and the atmosphere's transmittance; the moon's colour is the sun's, scaled by albedo 0.12 and the illuminated fraction.
  - `sky.wgsl`: `skyColour` samples the sky-view LUT; `skyIrradiance(n)` reads six face irradiances.
  - `shade.wgsl`: the fog colour comes from the sky view in the view direction near the horizon.
  - `src/render/renderer.ts`: a small pass integrates the sky view into six irradiances each frame.
- Test: `tests/render/sky-state.test.ts` (extend), `tests/e2e/sky.spec.ts`, `tests/e2e/lighting.spec.ts` ("open ground is lit and sees the sky" re-pinned to the new irradiance)

- [ ] **Step 1: Write the failing tests:**
  - **Six irradiances.** They match the CPU reference's cosine-weighted integral of the sky radiance per face direction within 3%.
  - **The hand-over.**
    - The key light's direction and luminance change continuously across sunset: the luminance steps < 5% per minute of the clock from 18:00 to 22:00.
    - The key is whichever of sun and moon is brighter, crossfaded over the 2° of sun elevation around the crossing.
  - **sky-state at 18:40** gives a key direction within 3° of sub-project 1's dusk, and at 21:00 the moon.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the sky, lighting, shade and denoise specs, and perf. Expected: PASS.
- [ ] **Step 5: Commit** "Light the world from the sky the atmosphere makes, with the key light following the clock".

### Task 4: The discs and the stars

**Files:**
- Modify: `shade.wgsl` (the sun disc with limb darkening, the moon disc in its phase with a procedural surface and earthshine, and the stars), `sky.wgsl`
- Test: `tests/e2e/sky.spec.ts`

- [ ] **Step 1: Write the failing tests:**
  - **Moon disc.** At the phase angle of 1916-10-21 21:00, the lit fraction of the drawn disc's pixels is within 0.05 of `illuminated`. At new moon it is dark, and at full moon it is full.
  - **Stars.**
    - At night, the count of star pixels (brighter than the sky by 4×) in a 60° patch above 30° elevation is between 150 and 600.
    - At noon there are none.
    - Their positions are stable frame to frame: a fixed star field, with no TAA jitter crawl beyond a pixel.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Stars come from a hashed cube-map grid at 128² per face. Each cell holds at most one star, by a hash threshold, with a magnitude from a power law.
  - Each star is drawn as a 1-pixel Gaussian at the internal resolution, faded by the sky's luminance, and twinkling below 15° elevation.
  - A faint Milky Way band follows a fixed great circle.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** "Draw the sun, the moon in its phase, and the stars".

### Task 5: The day in the app, and the look kept

**Files:**
- Modify:
  - `src/app/main.ts` and `src/ui/pause.ts`: the time slider runs 0–24 h, plus a time-lapse speed (off, 1 min/s, 10 min/s).
  - `src/app/keys.ts`: T cycles dusk 18:40, night 21:00, dawn 06:50, noon 12:00.
  - `src/app/views.ts`: views carry an hour.
  - `data/tunables.toml`: the exposure keys move to the clock, with noon added.
  - The screenshots spec: dusk, night, noon and dawn.
- Test: `tests/app/keys.test.ts`, `tests/e2e/play.spec.ts` (the slider), `tests/e2e/screenshots.spec.ts`

- [ ] **Step 1: Write the failing tests.**
  - The keys and slider tests drive the new clock.
  - A cycle test runs 24 hours at time-lapse with frame stats: the mean frame brightness changes by under 2% per game minute (done-table row 4).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** everything. Review the four screenshot sets by eye against `artifacts/m4` for the approved dusk and night, and ledger what changed and why.
- [ ] **Step 5: Commit** "Run the whole day on the clock, and keep dusk and night as they were approved".

---

### Milestone check

- [ ] `npm test && npm run typecheck && npm run build && npm run e2e`. Expected: all green; perf ≤ 14 ms at each view's time and at noon.
- [ ] The production load stays ≤ 4 s (`node tools/preview-gen.mjs --prod`). The LUTs build at load in under 5 ms of GPU time.
