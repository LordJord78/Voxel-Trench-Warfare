# TRENCHLINE

A first-person trench-warfare game, built from 10 cm voxels.

You hold a fire bay on the shoulder of a dry ravine. Across fifty metres of shelled ground is another line exactly like yours. The trench is the game:
- what its walls hide, and what they don't;
- how a parapet reads from the firing step and from the duckboards;
- what a shell does to the ground you were counting on.

## Web rebuild (in progress)

The game is being rebuilt for the browser in TypeScript and WebGPU. It uses its own voxel ray tracer at Teardown-scale voxels and is lit for dusk into night.

The design is in [docs/superpowers/specs/2026-10-21-trenchline-web-world-design.md](docs/superpowers/specs/2026-10-21-trenchline-web-world-design.md), and the build plans are in [docs/superpowers/plans/](docs/superpowers/plans/).

## Python reference

The original Python/Ursina game lives in [reference/python/](reference/python/). It stays runnable, and its tests stay green, until the web version has ported everything it does. Run it from that folder with the repo's virtual environment:

```sh
cd reference/python
../../.venv/bin/python -m trenchline      # play
../../.venv/bin/python -m pytest          # 283 tests
```

## Development

```sh
npm install
npm run dev      # Vite dev server
npm test         # Vitest
```
