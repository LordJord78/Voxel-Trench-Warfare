# TRENCHLINE

A first-person trench-warfare shooter with blocky voxel graphics, set in a
fictionalised version of the Russo-Ukrainian war. Fictional callsigns, fictional
map names. The war is the setting and the source of mechanical detail.

**Status: milestone 1 of 6 — runnable.**

## Run it

```bash
python3 -m venv .venv && .venv/bin/pip install numpy ursina pytest
.venv/bin/python -m trenchline --seed 7
```

`WASD` move · `SHIFT` sprint · `CTRL` crouch · `C` prone · `SPACE` jump ·
`F1` toggle stats · `ESC` release the mouse.

Other entry points:

```bash
.venv/bin/python -m trenchline --headless --seed 7 --ticks 600   # no window
.venv/bin/python -m trenchline --seed 7 --frames 240 --no-vsync  # smoke test
.venv/bin/python -m tools.bench --seed 7 --frames 900            # frame time
.venv/bin/python -m tools.section --seed 7 --axis x --at 100     # ASCII cross-section
.venv/bin/python -m tools.shot --seed 7 --out shot.png           # offscreen render
.venv/bin/python -m pytest                                       # tests
```

## Architecture

```
trenchline/
  core/      fixed-timestep clock, event bus, seeded RNG
  world/     voxel storage, greedy meshing, generation, raycast, water
  physics/   vectors, voxel collision, character controller
  combat/    (milestone 2)
  vehicles/  drones/  ai/            (milestones 3-6)
  render/    Ursina + Panda3D front end   <- engine lives only here
  ui/        HUD                          <- and here
  data/      tunables.toml + loader       <- every feel value lives here
```

`render/`, `ui/` and `audio/` may read the simulation. The simulation may not
import them. This is enforced by `tests/test_architecture.py`, statically over
the import graph and dynamically by running the whole simulation with `ursina`,
`panda3d` and `direct` made unimportable.

## Determinism

One `GameRandom` per run, seeded from `--seed`, passed by dependency injection.
Sub-streams are derived by **label**, not draw order, so adding a generation
step does not shift the numbers every other system receives. The simulation
advances only in whole 1/60 s ticks; rendering is decoupled and interpolates.
Same seed produces the same map and the same simulation, headless or windowed.

## Engine note

Ursina holds 60 FPS comfortably, but only if its convenience wrappers are
avoided. `ursina.Mesh` builds vertex buffers in Python loops and `ursina.Text`
does not render at all under the GL profile Panda selects on macOS. Chunk
geometry is written straight into a Panda3D `GeomVertexData` via numpy memcpy
(~0.14 ms/chunk) and the HUD is built on `TextNode`. Ursina supplies the window,
input, camera and scene graph.

## Tuning

Everything that decides how the game *feels* is in `trenchline/data/tunables.toml`.
Logic reads values by dotted key and never hard-codes a magnitude.
