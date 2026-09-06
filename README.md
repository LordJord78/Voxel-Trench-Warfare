# TRENCHLINE

A first-person trench-warfare shooter with blocky voxel graphics, set in a
fictionalised version of the Russo-Ukrainian war. Fictional callsigns, fictional
map names. The war is the setting and the source of mechanical detail.

**Status: milestone 2 of 6.**

## Run it

```bash
python3 -m venv .venv && .venv/bin/pip install numpy ursina pytest
.venv/bin/python -m trenchline --seed 7
```

`WASD` move · `SHIFT` sprint · `CTRL` crouch · `C` prone · `SPACE` jump ·
`F1` toggle stats · `ESC` release the mouse.

### Headless

No window, no GPU, deterministic. This is the mode tests and CI use.

```bash
.venv/bin/python -m trenchline --headless --seed 7 --ticks 600
```

| flag | meaning |
| --- | --- |
| `--headless` | run the simulation with no window at all |
| `--seed N` | master seed; the same seed is the same map and the same run |
| `--ticks N` | how many 1/60 s ticks to run |
| `--script idle\|walk\|patrol\|random` | synthetic input, so a headless run exercises movement |
| `--report-every N` | print a state line every N ticks; `0` to print only the digest |
| `--tunables PATH` | load a different `tunables.toml` |

It prints a `digest ...` line: a hash of the full end state. Two runs of the
same command must print the same digest.

### Everything else

```bash
.venv/bin/python -m trenchline --seed 7 --frames 240 --no-vsync  # windowed smoke test
.venv/bin/python -m tools.bench --seed 7 --frames 900            # frame time
.venv/bin/python -m tools.sightlines --seeds 7 21 99             # parapet peek numbers
.venv/bin/python -m tools.section --seed 7 --axis x --at 100     # ASCII cross-section
.venv/bin/python -m tools.shot --seed 7 --bay 2 --out shot.png   # offscreen render
```

## Tests

```bash
.venv/bin/python -m pytest          # everything
.venv/bin/python -m pytest -q -x    # stop at the first failure
```

The suite is the design's acceptance criteria, not smoke tests. `test_world.py`
asserts that a traverse stops enfilade fire, that a standing eye clears its own
parapet and a crouched one does not, and that dugouts have roofs.
`test_architecture.py` asserts the simulation cannot reach the renderer, both
statically over the import graph and dynamically with the engine made
unimportable. `test_determinism.py` asserts a fixed seed reproduces a fixed
world-state hash.

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

Every number that decides how the game *feels* is in
**`trenchline/data/tunables.toml`** — trench geometry, field relief, stances,
movement, camera, weather. Logic reads values by dotted key and never hard-codes
a magnitude, so retuning never means touching logic.

The trench section is the load-bearing one. Parapet crest height is not a
constant there: each fire bay measures the ground it has to see over, raises its
own firing step until a standing eye clears it, and builds its crest from that
step. `tools/sightlines.py` prints what that produces.

## Licence

MIT — see [LICENSE](LICENSE).
