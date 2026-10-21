"""Measure the parapet peek, seed by seed.

The trench design lives or dies on three numbers per bay: what you see from the
duckboards (nothing), what you see crouched on the firing step (nothing), and
what you see standing on it (the field).  This prints all three, plus how far
out the shell holes actually read, which is the metric field relief is tuned
against.

    python -m tools.sightlines --seeds 7 21 99
    python -m tools.sightlines --seeds 7 --json

Note on the crater figure: no-man's-land on this layout is only 51 m deep, so
the farthest crater that can possibly read is at 51 m.  Anything past that is
the enemy parapet.
"""

from __future__ import annotations

import argparse
import json
import statistics

import numpy as np

from trenchline.physics.character import Stance
from trenchline.physics.vec import Vec3
from trenchline.session import Session, SessionConfig
from trenchline.world import voxel
from trenchline.world.raycast import line_of_sight, raycast

LATERAL_M = 14.0
"""How far off the bay's own axis a crater still counts as part of its view."""


def _horizontal(session: Session, eye: Vec3, facing: int, reach: float) -> float:
    hit = raycast(session.world, eye, Vec3(0, 0, float(facing)), reach)
    return hit.distance if hit else reach


def _ground_top(session: Session, x: float, z: float) -> float | None:
    """Height in metres of the top solid voxel of the column at (x, z)."""
    s = voxel.VOXEL_SIZE
    vx, vz = int(x // s), int(z // s)
    if not (0 <= vx < session.world.dims.x and 0 <= vz < session.world.dims.z):
        return None
    column = session.world.v[vx, :, vz]
    solid = np.nonzero(voxel.SOLID[column])[0]
    return float(solid[-1] + 1) * s if solid.size else None


def _craters_ahead(session: Session, x: float, z: float, facing: int
                   ) -> list[tuple[int, int, int, float]]:
    """Shell holes in the corridor a bay looks down, nearest first."""
    s = voxel.VOXEL_SIZE
    out = [
        c for c in session.generated.craters
        if ((c[2] + 0.5) * s - z) * facing > 0.0
        and abs((c[0] + 0.5) * s - x) <= LATERAL_M
    ]
    out.sort(key=lambda c: abs((c[2] + 0.5) * s - z))
    return out


def _craters_read(session: Session, eye: Vec3, x: float, z: float, facing: int
                  ) -> tuple[float, float]:
    """Farthest shell hole this bay can pick out, and what share of them read.

    A crater reads if any of it presents itself: the bowl, the far inner wall,
    or the far lip.  Requiring the bowl floor would be too strict — at 40 m a
    man on a firing step sees a crater as a notch in the ground, not as a hole
    he is looking into — and requiring only the lip would be too generous,
    because a lip against the sky is what a flat plate looks like too.
    """
    s = voxel.VOXEL_SIZE
    farthest = 0.0
    seen = 0
    total = 0
    for cx, _, cz, radius in _craters_ahead(session, x, z, facing):
        px = (cx + 0.5) * s
        offsets = (0.0, radius * 0.7 * facing * s, (radius + 1.0) * facing * s)
        points = []
        for off in offsets:
            pz = (cz + 0.5) * s + off
            top = _ground_top(session, px, pz)
            if top is not None:
                points.append(Vec3(px, top + 0.1, pz))
        if not points:
            continue
        total += 1
        if any(line_of_sight(session.world, eye, point) for point in points):
            seen += 1
            farthest = max(farthest, abs((cz + 0.5) * s - z))
    return farthest, (100.0 * seen / total if total else 0.0)


def measure(seed: int, line: str = "front", reach: float = 120.0) -> dict[str, float]:
    session = Session(SessionConfig(seed=seed))
    stand = session.controller.stances[Stance.STANDING].eye_height
    crouch = session.controller.stances[Stance.CROUCHED].eye_height
    periscope = session.controller.stances[Stance.PERISCOPE].eye_height

    floor_views: list[float] = []
    stand_views: list[float] = []
    crouch_views: list[float] = []
    crater_reach: list[float] = []
    crater_share: list[float] = []
    periscope_reach: list[float] = []
    periscope_share: list[float] = []
    periscope_views: list[float] = []
    clearances: list[float] = []
    step_heights: list[float] = []
    bays = session.network.lines[line].bays

    for bay in bays:
        cx, cy, cz = bay.centre_metres
        sx, sy, sz = bay.step_metres
        facing = bay.facing
        floor_views.append(_horizontal(session, Vec3(cx, cy + stand, cz), facing, reach))
        stand_views.append(_horizontal(session, Vec3(sx, sy + stand, sz), facing, reach))
        crouch_views.append(_horizontal(session, Vec3(sx, sy + crouch, sz), facing, reach))
        crest_rise = (bay.crest_y - bay.step_top_y) * voxel.VOXEL_SIZE if hasattr(
            bay, "crest_y") else float("nan")
        clearances.append(stand - crest_rise)
        peri_far, peri_share = _craters_read(
            session, Vec3(sx, sy + periscope, sz), sx, sz, facing
        )
        periscope_reach.append(peri_far)
        periscope_share.append(peri_share)
        periscope_views.append(
            _horizontal(session, Vec3(sx, sy + periscope, sz), facing, reach)
        )
        step_heights.append((bay.step_top_y - bay.floor_y - 1) * voxel.VOXEL_SIZE)

        far, share = _craters_read(session, Vec3(sx, sy + stand, sz), sx, sz, facing)
        crater_reach.append(far)
        crater_share.append(share)

    surface = session.generated.surface.astype(float) * voxel.VOXEL_SIZE
    return {
        "seed": float(seed),
        "bays": float(len(bays)),
        "floor_median": statistics.median(floor_views),
        "stand_median": statistics.median(stand_views),
        "crouch_median": statistics.median(crouch_views),
        "crater_reach_median": statistics.median(crater_reach),
        "crater_reach_p10": float(np.percentile(crater_reach, 10)),
        "craters_read_pct": statistics.median(crater_share),
        "periscope_median": statistics.median(periscope_views),
        "periscope_reach_median": statistics.median(periscope_reach),
        "periscope_reach_p10": float(np.percentile(periscope_reach, 10)),
        "periscope_read_pct": statistics.median(periscope_share),
        "clearance_min_m": min(clearances),
        "clearance_max_m": max(clearances),
        "step_height_median_m": statistics.median(step_heights),
        "step_height_max_m": max(step_heights),
        "relief_p2p_m": float(surface.max() - surface.min()),
        "relief_sd_m": float(surface.std()),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, nargs="+", default=[7, 21, 99])
    ap.add_argument("--line", default="front")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    rows = [measure(seed, args.line) for seed in args.seeds]
    if args.json:
        print(json.dumps(rows, indent=2))
        return

    print(f"\n--- parapet peek, {args.line} line ---")
    print(f"{'seed':>4} {'bays':>4} {'floor':>7} {'crouch':>7} {'stand':>7} "
          f"{'craters':>8} {'p10':>6} {'read':>6} {'clear':>7} {'relief':>7}")
    for r in rows:
        print(f"{r['seed']:4.0f} {r['bays']:4.0f} {r['floor_median']:6.1f}m "
              f"{r['crouch_median']:6.1f}m {r['stand_median']:6.1f}m "
              f"{r['crater_reach_median']:7.0f}m {r['crater_reach_p10']:5.0f}m "
              f"{r['craters_read_pct']:5.0f}% {r['clearance_min_m']:+6.2f}m "
              f"{r['relief_p2p_m']:6.2f}m")

    print(f"\n--- periscope (eye 2.20 m) against standing on the step (1.62 m) ---")
    print(f"{'seed':>4} {'view':>16} {'crater reach':>16} {'p10':>14} {'craters read':>16}")
    for r in rows:
        print(f"{r['seed']:4.0f} "
              f"{r['stand_median']:6.1f} ->{r['periscope_median']:6.1f}m "
              f"{r['crater_reach_median']:6.0f} ->{r['periscope_reach_median']:6.0f}m "
              f"{r['crater_reach_p10']:5.0f} ->{r['periscope_reach_p10']:5.0f}m "
              f"{r['craters_read_pct']:6.0f} ->{r['periscope_read_pct']:6.0f}%")


if __name__ == "__main__":
    main()
