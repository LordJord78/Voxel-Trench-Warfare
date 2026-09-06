"""How long it takes to dig a shelled line back into a trench.

Artillery degrades a position structurally: collapsed spoil ramps over shelled
traverses and fills walkways. The entrenching tool is the counter, and the
question this answers is what that counter actually costs in seconds — walking
included, because a bay is 8 m long and a shovel reaches 1.6 m.

    python -m tools.entrench --seeds 7 21 99
"""

from __future__ import annotations

import argparse
import math

import numpy as np

from trenchline.physics.character import MoveIntent, Stance
from trenchline.physics.vec import Vec3
from trenchline.session import Session, SessionConfig
from trenchline.world import voxel
from trenchline.world.entrenching import fill_in

TICK = 1.0 / 60.0


def _bay_box(bay) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    return (bay.x0, bay.floor_y + 1, bay.z0), (bay.x1, bay.floor_y + 5, bay.z1)


def _nearest_fill(session: Session, bay, position: Vec3):
    lo, hi = _bay_box(bay)
    block = session.world.v[lo[0] : hi[0], lo[1] : hi[1], lo[2] : hi[2]]
    xs, ys, zs = np.nonzero(voxel.LOOSE[block])
    if xs.size == 0:
        return None
    s = voxel.VOXEL_SIZE
    px = (xs + lo[0] + 0.5) * s
    py = (ys + lo[1] + 0.5) * s
    pz = (zs + lo[2] + 0.5) * s
    d = (px - position.x) ** 2 + (py - position.y) ** 2 + (pz - position.z) ** 2
    i = int(np.argmin(d))
    return float(px[i]), float(py[i]), float(pz[i])


def clear_bay(session: Session, bay, limit_s: float = 240.0) -> tuple[float, int]:
    """Walk a bay and dig it clear.  Returns (seconds, voxels)."""
    cx, cy, cz = bay.centre_metres
    session.player.position = Vec3(cx, cy + 0.05, cz)
    session.player.velocity = Vec3(0.0, 0.0, 0.0)
    session.intent = MoveIntent()
    session.run_ticks(20)

    lo, hi = _bay_box(bay)
    before = session.entrenching.cleared
    elapsed = 0.0
    stalled = 0.0
    remaining = fill_in(session.world, lo, hi)

    while elapsed < limit_s and remaining:
        target = _nearest_fill(session, bay, session.player.position)
        if target is None:
            break
        tx, _ty, tz = target
        p = session.player.position
        session.player.yaw = math.degrees(math.atan2(tx - p.x, tz - p.z)) % 360.0
        # Always work: the tool decides for itself what is within a shovel's
        # reach. Walk only when there is nothing to dig from here, otherwise a
        # pile you cannot stand exactly on top of stalls the whole bay.
        digging = session.entrenching.find_target(p.x, p.y, p.z, session.player.yaw)
        session.intent = MoveIntent(
            forward=0.0 if digging else 1.0, dig=True, stance=Stance.STANDING
        )
        session.tick()
        elapsed += TICK

        now = fill_in(session.world, lo, hi)
        stalled = 0.0 if now < remaining else stalled + TICK
        remaining = now
        if stalled > 20.0:
            break  # whatever is left cannot be got at from inside the bay
    return elapsed, session.entrenching.cleared - before


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, nargs="+", default=[7, 21, 99])
    ap.add_argument("--line", default="front")
    args = ap.parse_args()

    print(f"\n--- restoring a shelled {args.line} line with the entrenching tool ---")
    print(f"{'seed':>5} {'blocked bays':>13} {'voxels':>7} {'worst bay':>11} "
          f"{'whole line':>12}")
    for seed in args.seeds:
        session = Session(SessionConfig(seed=seed))
        bays = session.network.lines[args.line].bays
        blocked = [b for b in bays if fill_in(session.world, *_bay_box(b))]
        times, total_voxels = [], 0
        for bay in blocked:
            seconds, voxels = clear_bay(session, bay)
            times.append(seconds)
            total_voxels += voxels
        worst = max(times) if times else 0.0
        whole = sum(times)
        print(f"{seed:5d} {len(blocked):6d}/{len(bays):<6d} {total_voxels:7d} "
              f"{worst:10.0f}s {whole:11.0f}s")


if __name__ == "__main__":
    main()
