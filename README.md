# TRENCHLINE

A front-line trench at dusk, ten centimetres to the voxel, ray traced live in your browser.

You hold a fire bay on the shoulder of a dry ravine. Across fifty metres of shelled ground is another line exactly like yours. Dusk falls into night:
- flares climb from both lines and drift on the wind;
- machine-gun tracers arc over no man's land;
- barrages flicker on the horizon and rumble seconds later;
- shells set the ruins burning, and the craters' water holds it all.

Every wall, sandbag and duckboard is made of 10 cm voxels. A shell cuts into the ground you were counting on, and you dig yourself back out.

## Play

Open it in a desktop browser with WebGPU: Chrome or Edge 113 or later, or Safari 26. Where WebGPU is missing, the page shows a video of the game instead. Click to play; the mouse looks around.

## Controls

| Keys | |
|---|---|
| <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> | Move |
| <kbd>Shift</kbd> | Sprint |
| <kbd>Space</kbd> | Jump |
| <kbd>C</kbd> / <kbd>Z</kbd> | Crouch / go prone |
| <kbd>W</kbd> into the bench | Climb onto the firing step |
| <kbd>Q</kbd> | Periscope, on a firing step |
| Left mouse | Fire |
| <kbd>R</kbd> | Reload |
| <kbd>F</kbd>, held | Dig out loose earth |
| <kbd>Esc</kbd> | Pause: quality, mouse sensitivity, field of view, the time of day and how fast it passes, incoming fire |
| <kbd>F3</kbd> | Frame timings |

## How it is made

TypeScript and raw WebGPU, with no engine:
- **The world:** a 256 × 256 m map, 32 m deep, of 10 cm voxels, generated in the browser by workers. It holds trenches, dugouts, a hamlet and a wood, and distant terrain beyond to the horizon.
- **Rendering:** a voxel ray tracer over a brick map. Its main features:
  - many shadow-casting lights, with reuse between pixels and frames;
  - a froxel haze with light shafts and smoke;
  - a physically based sky with the moon and stars, and a full day-to-night cycle;
  - denoising, temporal anti-aliasing, bloom, automatic exposure and film grain.
- **Destruction at 10 cm:** shells carve craters, soil slumps, and the player digs it out.
- **Combat:** weapons with ballistics and recoil, suppression, and the effects of fire.
- **The battle around the player:** a deterministic director fires flares, barrages, tracers and fires, and the water reflects them.
- **Quality:** two quality presets and dynamic resolution hold a 14 ms GPU budget at 1.5 megapixels.

## How it is tested

- **Unit tests (Vitest):** generation, physics, ballistics, destruction, the battle, sound planning and the renderer's arithmetic.
- **GPU tests (Playwright in Chrome):**
  - shaders against references;
  - the game played through its test hooks;
  - captures for review.
- **Performance gates:** every standard view, at dusk and at night, holds its GPU time within 14 ms at the 95th percentile. That includes the battle at its peak, with the player firing on full auto under shellfire.
- **Safari:** the same check runs in Safari (`npm run safari`) and reports.

## Run it

```sh
npm install
npm run dev          # the dev server
npm test             # unit tests
npx playwright test  # GPU tests, in Chrome with WebGPU
npm run build        # the static site, in dist/
```

The build works from any path. [The Pages workflow](.github/workflows/pages.yml) tests it, builds it and publishes it to GitHub Pages on a push to `main`.

## Design

The design is in five specs, from [the world](docs/superpowers/specs/2026-10-21-trenchline-web-world-design.md) to [the showcase](docs/superpowers/specs/2026-10-25-trenchline-web-showcase-design.md). The build plans are in [docs/superpowers/plans/](docs/superpowers/plans/).

## Python reference

The original Python/Ursina game lives in [reference/python/](reference/python/). It stays runnable, and its tests stay green, until the web version has ported everything it does. Run it from that folder with the repo's virtual environment:

```sh
cd reference/python
../../.venv/bin/python -m trenchline      # play
../../.venv/bin/python -m pytest          # 283 tests
```
