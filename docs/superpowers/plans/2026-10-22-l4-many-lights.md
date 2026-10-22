# Light, Milestone 4: Many Lights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Light the night with as many as 1,024 point lights, 256 of them moving, without visible fizz.
- Replace the pick that weighs every light at every pixel with a GPU light grid and ReSTIR DI.
- Keep every standard view within the GPU budget, and the approved look.

**Architecture:**
- **Lights are per-frame data.** The CPU writes up to 1,024 lights a frame (32 bytes each, as now). Lanterns flicker and flares drift and fade, animated on the CPU from each light's phase. Sub-project 4 will drive them for real.
- **Light cells.** A compute pass builds a 2D grid of 8 m cells over the map each frame. Each cell lists the lights whose radius reaches it, at most 32, nearest first.
- **ReSTIR DI**, at the lighting resolution, in passes that bind their own small groups, not the scene's:
  1. **Candidates:** eight per lighting pixel, drawn uniformly from its cell's list, resampled to one by unshadowed contribution (RIS).
  2. **Temporal:** merged with last frame's reservoir where the history test (`sameSpot`) holds, M clamped to 20 × 8.
  3. **Spatial:** merged with three neighbours within 12 lighting pixels on the same face and plane, with unbiased (Z-counted) weights.
  4. **Shading:** the lighting pass traces one shadow ray to the chosen light, as it does to the picked light today.

**Tech Stack:** TypeScript, WGSL compute, Vitest, Playwright GPU cases.

**Spec:** docs/superpowers/specs/2026-10-21-trenchline-web-light-design.md (§3 Many lights; done-table rows 1, 2, 6).

## Global Constraints

- **Lights:** up to 1,024; `MAX_LIGHTS` 1,024; position, radius, colour and intensity as today (the light buffer's 32 bytes).
- **Cells:** 8 m square, over the map's x and z; at most 32 lights each, nearest the cell's middle first.
- **ReSTIR:** 8 candidates; M ≤ 160 from history; 3 spatial neighbours within 12 lighting pixels; one shadow ray per lighting pixel.
- **Row 2:** 1,024 lights, 256 moving, at night: the mean within 5% of a 4,096-sample reference, and the frame-to-frame noise of the lit image (measured before grain) bounded.
- **Perf:** every standard view ≤ 14 ms at dusk, night, noon and dawn (1.5 MP, dynamic resolution off). The light cells and ReSTIR together ≤ 0.5 ms on the overview.
- **The approved look:** dusk and night region means within milestone 3's, and every approved view's exposure uncorrected.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A light that moves or flickers.** Its reservoir sample must be weighed again each frame with the light's current data, never stale. Pinned in Task 3 (a moving light's mean).
- **A cell with no lights, or more than 32.** No pixel picks from an empty list; the 32 kept are the nearest. Pinned in Task 2.
- **Disocclusion and edges.** Temporal and spatial reuse cross no face or plane boundary, or the light bleeds round corners. Pinned in Task 4 (a corner scene).
- **A light at a pixel's own surface, or behind it.** A zero target never divides, and Z counts only where the sample could have been drawn. Pinned in Task 3 (the reservoir arithmetic).
- **The budget.** The overview has some 0.4 ms in hand at dawn. Pinned in Task 0 and every task's perf run.

---

### Task 0: Headroom, and the load's spread

**Files:**
- Modify: `src/render/shaders/lighting.wgsl` (the key's ray only where its light can show), `tests/e2e/lighting.spec.ts`
- Ledger the load runs.

- [ ] **Step 1: Measure** the production load five times (`node tools/preview-gen.mjs --prod`) and the overview's passes at the four keys (61-frame medians). Ledger the spread.
- [ ] **Step 2: Write the failing test** `the key's ray is skipped where its light cannot show`: a scene lit by a key under 1% of the sky's light on the faces traces no key rays (the lighting pass's ray count), and its image differs from a traced one by under one 8-bit step.
- [ ] **Step 3: Implement** the skip, against the faces' sky irradiance. **Run** it, A/B the overview at dawn against the base (alternating runs, as milestone 1 did). Expected: at least 0.3 ms saved at dawn.
- [ ] **Step 4: Commit** "Trace the key light's ray only where its light can show".

### Task 1: Lights per frame

**Files:**
- Create: `src/render/shaders/light.wgsl` (the Light struct and `unshadowed`, moved from scene.wgsl and lighting.wgsl), `src/render/light-motion.ts` (each light's state at a time: lanterns' flicker, flares' drift and fade)
- Modify: `src/render/lights.ts` (`MAX_LIGHTS` 1,024; a light's phase), `src/render/renderer.ts` (the light buffer at 1,024), `src/app/main.ts` (lights written every frame)
- Test: `tests/render/light-motion.test.ts`, `tests/render/lights.test.ts`

**Interfaces:**
- Produces: `lightsAt(lights: SceneLight[], seconds: number): SceneLight[]`; `light.wgsl`'s `Light` and `unshadowed(l, p, n)` for Tasks 2–4.

- [ ] **Step 1: Write the failing tests:**
  - lanterns flicker within ±10% of their intensity, smoothly (under 2% between frames at 60 Hz);
  - flares sink no faster than 0.5 m/s and fade over their burn;
  - the same seconds give the same lights;
  - 1,024 lights fit the buffer, and 1,025 throw.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run** them and the lighting spec. Expected: PASS.
- [ ] **Step 5: Commit** "Make the lights frame data: lanterns flicker, flares drift and fade".

### Task 2: Light cells

**Files:**
- Create: `src/render/light-cells.ts`, `src/render/shaders/light-cells.wgsl`, `tests/support/light-cells-ref.ts`
- Test: `tests/render/light-cells-ref.test.ts`, `tests/e2e/cases/lights.ts`, `tests/e2e/lights.spec.ts`

**Interfaces:**
- Produces: `LightCells.encode(encoder, lightCount)`; a cells buffer of `count` and 32 light indices per cell (`light-cells.wgsl` gives `cellOf(p)` and `cellLight(cell, k)`).

- [ ] **Step 1: Write the failing tests:**
  - CPU reference: each cell holds every light whose sphere reaches its square, up to 32, nearest first;
  - GPU: 1,024 random lights over the map give exactly the reference's lists. An empty cell has a count of 0; a crowded one keeps the 32 nearest.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement** (one thread per cell). **Step 4: Run.** Expected: PASS; the build ≤ 0.05 ms.
- [ ] **Step 5: Commit** "Grid the lights over the map, the nearest 32 in each cell".

### Task 3: ReSTIR: candidates, history, and the shadow ray

**Files:**
- Create: `src/render/restir.ts`, `src/render/shaders/restir.wgsl` (entries `candidates` and `spatial`), `tests/support/restir-ref.ts`
- Modify: `src/render/shaders/lighting.wgsl` (the reservoir's light and weight in place of `pickLight`), `src/render/renderer.ts` (reservoir buffers, three ping-ponged)
- Test: `tests/render/restir-ref.test.ts`, `tests/e2e/lights.spec.ts`

**Interfaces:**
- Consumes: Task 1's `light.wgsl`, Task 2's cells.
- Produces: per lighting pixel a reservoir (light index, W, M, its target).

- [ ] **Step 1: Write the failing tests:**
  - Vitest, on the reference: RIS from uniform candidates is unbiased (a Monte Carlo mean within 1% of the closed-form sum over lights, 10⁵ trials); merging two reservoirs keeps it so; a zero target is never divided by; M is clamped.
  - GPU: at fixed lights, the mean over 256 frames of the point-light term within 5% of a 4,096-sample reference; a light moved between frames is weighed at its new place (no stale contribution).
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement** candidates and temporal reuse in one pass, the shadow ray in the lighting pass. **Step 4: Run** them and the lighting spec. Expected: PASS.
- [ ] **Step 5: Commit** "Pick lights by resampling, and carry the pick from frame to frame".

### Task 4: Spatial reuse

**Files:**
- Modify: `src/render/shaders/restir.wgsl` (`spatial`), `src/render/restir.ts`
- Test: `tests/render/restir-ref.test.ts`, `tests/e2e/lights.spec.ts`

- [ ] **Step 1: Write the failing tests:**
  - reference: the Z-counted merge of neighbours is unbiased where some neighbours could not have drawn the sample;
  - GPU: the corner scene (two walls lit from either side): no light crosses the edge; the mean still within 5% of the reference, the noise lower than Task 3's.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** "Share picks between neighbours on the same plane".

### Task 5: A thousand lights at night

**Files:**
- Modify: `tests/e2e/lights.spec.ts` (row 2), `tests/e2e/screenshots.spec.ts` (a night view under many lights), `tests/e2e/perf.spec.ts`

- [ ] **Step 1: Write the test** for row 2: 1,024 lights, 256 moving, over the test world at night. The lit image (before grain) frame to frame within a bound set by the reference's own sampling noise, and its mean within 5%.
- [ ] **Step 2: Run** everything: `npm test && npm run typecheck && npm run build && npm run e2e`. Expected: all green; perf ≤ 14 ms at the four keys; the approved look's region means as milestone 3's.
- [ ] **Step 3: Run** `node tools/preview-gen.mjs --prod`. Expected: ≤ 4 s.
- [ ] **Step 4: Commit and ledger.**
