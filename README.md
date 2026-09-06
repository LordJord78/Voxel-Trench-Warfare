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
`LMB` fire · `R` reload · `V` periscope · `F` dig ·
`F1` toggle stats · `ESC` release the mouse.

To feel suppression, ask for incoming fire. It is a tuning rig with no shooter
behind it — no AI, no decisions, no target selection — and it goes away the day
a squad exists:

```bash
.venv/bin/python -m trenchline --seed 7 --incoming 400 --incoming-range 30
```

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
.venv/bin/python -m tools.bench --seed 7 --frames 900            # frame time, static
.venv/bin/python -m tools.stress --seed 7 --shells 6             # frame time, under shelling
.venv/bin/python -m tools.stress --sweep                         # find the rebuild ceiling
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

That claim is held up by a golden test rather than by inference. `Session`
hashes its whole state — every voxel, every transform, and how far every named
RNG stream has advanced — and `tests/golden_digests.json` records what three
fixed seed/script/tick-count cases are supposed to produce. A 0.02% change to
one movement tunable moves the digest.

When it fails, look at which of the three sub-digests moved (`world`,
`entities`, `rng`), satisfy yourself the change was intended, then:

```bash
.venv/bin/python -m tools.golden            # show current vs committed
.venv/bin/python -m tools.golden --update   # rewrite, then commit the diff
```

Regenerating is deliberate and reviewable. The test never does it for itself.

## Engine note

Ursina holds 60 FPS comfortably, but only if its convenience wrappers are
avoided. `ursina.Mesh` builds vertex buffers in Python loops and `ursina.Text`
does not render at all under the GL profile Panda selects on macOS. Chunk
geometry is written straight into a Panda3D `GeomVertexData` via numpy memcpy
(~0.14 ms/chunk) and the HUD is built on `TextNode`. Ursina supplies the window,
input, camera and scene graph.

That memcpy path is `render/buffers.py`, and it is shared. Terrain, tracers,
muzzle dust, impact debris and the drone overlay all need it, in two lifetimes:

- `build_static` — sized exactly, uploaded once, discarded on rebuild. Terrain.
- `DynamicGeometry` — allocates its worst case once, then only memcpies a
  prefix and moves the draw count. A frame with nine tracers costs nine
  tracers' worth of copy and no allocation, because reallocating a vertex
  buffer every frame is what makes particle systems stutter.

## Tuning

Every number that decides how the game *feels* is in
**`trenchline/data/tunables.toml`** — trench geometry, field relief, stances,
movement, camera, weather. Logic reads values by dotted key and never hard-codes
a magnitude, so retuning never means touching logic.

The trench section is the load-bearing one. Parapet crest height is not a
constant there: each fire bay measures the ground it has to see over, raises its
own firing step until a standing eye clears it, and builds its crest from that
step. `tools/sightlines.py` prints what that produces.

## Suppression

Most rounds miss, and the ones that miss are doing the work. A round passing
within 3.2 m of your head raises suppression, sharply non-linearly with how
close it came; dirt kicking up nearby raises it less, because a crack past your
ear also means they have your range. It holds for half a second so a burst does
not bleed off between its own rounds, then recovers over about three seconds.

What it costs, in order of how much it is felt: movement down to 0.4x, the
dispersion cone out to 4.2x, a flinch that drags the muzzle off, and above 0.55
you cannot stay on the firing step or keep the periscope up at all. The grey
wash and vignette are how that is communicated, not what it is.

Whether fire can actually reach you is terrain, not a number, which is the part
worth playing with. From a firing step behind an intact parapet, measured on
seed 7:

| range of incoming fire | peak suppression | pushed off the step |
| --- | --- | --- |
| 55 m | 0.49 | no |
| 40 m | 0.73 | yes |
| 28 m | 1.00 | yes |
| 18 m | 1.00 | yes |

At 55 m the parapet and the ground clutter eat nearly every round; caught in
the open at the same range you are pinned solid in seconds.

## Performance

A mean frame time on a static scene says almost nothing about a voxel world;
the whole cost is what happens when it stops being static. Both numbers, seed 7,
offscreen at 1440x810:

| | mean | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| static, walking the line | 1.36 ms | 1.10 | 2.91 | 6.36 |
| sustained shelling, 19+ dirty chunks/frame | 7.99 ms | 7.95 | 8.63 | 8.72 |

Under artillery the limit is the rebuild queue, and the number that matters is
not its depth. A thousand stale chunks behind the player cost nothing; one
stale chunk in the trench they are standing in is a correctness bug, because
collision and raycasts read the voxel array rather than the mesh — the player
takes cover behind a wall the simulation has already deleted, and cannot see
the breach they just made.

So chunks are rebuilt nearest-and-visible first rather than in the order they
were shelled, repeat dirties on a waiting chunk coalesce into one rebuild at
its final state, the budget is milliseconds rather than a chunk count, and
distant unviewed chunks are allowed to stay stale indefinitely — invisible and
free. Under the load above, the worst run of consecutive frames during which
the player was *shown* wrong geometry within 32 m is **12 frames (200 ms)**,
p99 10, mean 0.92. `tools/stress.py --sweep` prints the whole curve.

## Licence

MIT — see [LICENSE](LICENSE).
