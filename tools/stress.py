"""Frame time under sustained artillery, not on a static scene.

A mean of 1.80 ms on a scene where nothing changes says almost nothing: the
whole cost of a voxel world is what happens when it stops being static. This
walks shells along the line at a rate that keeps 20+ chunks dirty every frame
and reports the distribution, so the rebuild-queue ceiling is something we
found on purpose rather than during the artillery milestone.

    python -m tools.stress --seed 7 --frames 900
    python -m tools.stress --sweep            # find the budget ceiling

The number that matters is not the mean. It is p99 (the hitch you actually
feel) and whether the dirty queue is still growing at the end: a queue that
climbs is a renderer falling behind the simulation, and it will not recover on
its own.
"""

from __future__ import annotations

import argparse
import itertools
import time

import numpy as np


def _percentiles(samples: np.ndarray) -> dict[str, float]:
    return {
        "mean": float(samples.mean()),
        "p50": float(np.percentile(samples, 50)),
        "p95": float(np.percentile(samples, 95)),
        "p99": float(np.percentile(samples, 99)),
        "max": float(samples.max()),
    }


def _fire_plan(session, spacing_m: float, rng) -> list[tuple[float, float, float]]:
    """Aiming points across no-man's-land and both lines, in a shuffled sweep.

    Deliberately not uniform random. The map is 128 m square and a 4 m shell
    churns everything within about 8 m of it, so random fire spends most of a
    long run re-cratering ground it already flattened — which changes almost no
    voxels, dirties almost no chunks, and quietly stops being a stress test
    around frame 100. Walking a spaced grid keeps every shell on fresh ground,
    which is what "sustained artillery" actually means and what makes the load
    hold up for the length of the run.
    """
    from trenchline.world import voxel

    s = voxel.VOXEL_SIZE
    dims = session.world.dims
    front = session.tun.i("world.layout.front_line_z") * s
    enemy = session.tun.i("world.layout.enemy_front_z") * s
    points: list[tuple[float, float]] = []
    x = 6.0
    while x < dims.x * s - 6.0:
        z = front - 6.0
        while z < enemy + 6.0:
            points.append((x, z))
            z += spacing_m
        x += spacing_m
    order = rng.numpy.permutation(len(points))
    return [(points[i][0], 0.0, points[i][1]) for i in order]


def _ground_height(session, x: float, z: float) -> float:
    from trenchline.world import voxel

    s = voxel.VOXEL_SIZE
    column = session.world.v[int(x / s), :, int(z / s)]
    solid = np.nonzero(voxel.SOLID[column])[0]
    return (float(solid[-1]) + 0.5) * s if solid.size else session.world.dims.y * s * 0.5


def run(args) -> dict:
    from panda3d.core import loadPrcFileData

    if not args.windowed:
        loadPrcFileData("", "window-type offscreen")
    loadPrcFileData("", "win-size 1440 810")

    from trenchline.physics.character import MoveIntent, Stance
    from trenchline.render.app import Frontend, _configure_panda
    from trenchline.session import Session, SessionConfig
    from trenchline.world import destruction

    _configure_panda(vsync=False)
    session = Session(SessionConfig(seed=args.seed))
    if args.budget is not None:
        session.tun._raw["world"]["chunk_rebuilds_per_frame"] = args.budget
    frontend = Frontend(session)
    budget = frontend.chunks.budget

    frontend._read_intent = lambda: MoveIntent(  # type: ignore[method-assign]
        forward=1.0, strafe=0.2, stance=Stance.STANDING
    )
    frontend._apply_mouse = lambda: None  # type: ignore[method-assign]

    for _ in range(60):                      # settle, and drain the load queue
        frontend.app.taskMgr.step()

    rng = session.stream("stress.shells")
    # Cycled, not exhausted: a second pass over the same aiming points still
    # digs, because each shell is placed on the *current* ground surface and
    # therefore into material the last one left behind. That keeps the load
    # sustained for long enough to say anything about p99.
    plan = _fire_plan(session, args.spacing, rng)
    aim = itertools.cycle(plan)
    samples: list[float] = []
    dirty: list[int] = []
    rebuilt: list[int] = []
    dirtied: list[int] = []

    for frame in range(args.frames):
        session.player.yaw = (session.player.yaw + 0.7) % 360.0
        before = session.world.dirtied_total
        for _ in range(args.shells):
            x, _unused, z = next(aim)
            destruction.detonate(
                session.world, (x, _ground_height(session, x, z), z),
                args.radius, rng, session.tun,
            )
        dirtied.append(session.world.dirtied_total - before)

        t = time.perf_counter()
        frontend.app.taskMgr.step()
        samples.append((time.perf_counter() - t) * 1000.0)
        dirty.append(session.world.dirty_count)
        rebuilt.append(frontend.chunks.stats.rebuilds)

    a = np.array(samples)
    d = np.array(dirtied)
    # A 128 m map holds a finite amount of ground: once the fire has walked it
    # once, later shells fall on bedrock and change almost nothing. The frames
    # that matter are the ones actually carrying the load, so they are reported
    # in their own right rather than averaged away by the quiet tail.
    loaded = d >= args.loaded_at
    stats = _percentiles(a)
    if loaded.any():
        for key, value in _percentiles(a[loaded]).items():
            stats[f"loaded_{key}"] = value
    stats["loaded_frames"] = float(loaded.sum())
    stats["loaded_rate"] = float(d[loaded].mean()) if loaded.any() else 0.0
    stats.update(
        budget=budget,
        shells=args.shells,
        radius=args.radius,
        dirtied_per_frame=float(np.mean(dirtied)),
        dirtied_peak=float(np.max(dirtied)),
        queue_start=float(dirty[0]),
        queue_end=float(dirty[-1]),
        queue_max=float(max(dirty)),
        over_budget=float((a > 16.67).mean() * 100.0),
        rebuilds=rebuilt[-1] - rebuilt[0],
        demanded=float(np.sum(dirtied)),
        frames=len(a),
    )
    return stats


def _report(stats: dict, seed: int) -> None:
    print(
        f"\n--- TRENCHLINE frame time under sustained shelling "
        f"(offscreen, 1440x810, seed {seed}) ---"
    )
    print(f"{stats['shells']:.0f} shells/frame at {stats['radius']:.1f} m, "
          f"dirtying {stats['dirtied_per_frame']:.0f} chunks per frame "
          f"(peak {stats['dirtied_peak']:.0f}), "
          f"rebuild budget {stats['budget']:.0f}/frame")
    print(f"frames {stats['frames']:.0f}: {stats['demanded']:.0f} chunk rebuilds "
          f"asked for, {stats['rebuilds']:.0f} delivered "
          f"({100 * stats['rebuilds'] / max(1.0, stats['demanded']):.0f}%)")
    print(f"  mean {stats['mean']:6.2f} ms   p50 {stats['p50']:6.2f}   "
          f"p95 {stats['p95']:6.2f}   p99 {stats['p99']:6.2f}   max {stats['max']:6.2f}")
    print(f"  {1000 / stats['mean']:6.0f} fps mean, "
          f"{1000 / stats['p99']:5.0f} fps at p99")
    print(f"  frames over the 60 Hz budget: {stats['over_budget']:.1f}%")
    if stats.get("loaded_frames", 0):
        print(f"  under load ({stats['loaded_frames']:.0f} frames at "
              f"{stats['loaded_rate']:.0f}+ chunks/frame):")
        print(f"    mean {stats['loaded_mean']:6.2f} ms   p50 {stats['loaded_p50']:6.2f}   "
              f"p95 {stats['loaded_p95']:6.2f}   p99 {stats['loaded_p99']:6.2f}   "
              f"max {stats['loaded_max']:6.2f}")
    print(f"  dirty queue: start {stats['queue_start']:.0f}, "
          f"peak {stats['queue_max']:.0f}, end {stats['queue_end']:.0f}"
          + ("   <- QUEUE IS GROWING, the renderer is losing"
             if stats["queue_end"] > stats["queue_start"] + 32 else "   (stable)"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--frames", type=int, default=600)
    ap.add_argument("--shells", type=int, default=4,
                    help="detonations per frame; 4 dirties 20+ chunks")
    ap.add_argument("--radius", type=float, default=3.0)
    ap.add_argument("--spacing", type=float, default=7.0,
                    help="metres between aiming points; keeps fire on fresh ground")
    ap.add_argument("--budget", type=int, default=None,
                    help="chunk rebuilds per frame; default reads tunables.toml")
    ap.add_argument("--windowed", action="store_true")
    ap.add_argument("--loaded-at", type=int, default=10, dest="loaded_at",
                    help="chunks/frame above which a frame counts as loaded")
    ap.add_argument("--sweep", action="store_true",
                    help="sweep the rebuild budget to find the ceiling")
    args = ap.parse_args()

    if not args.sweep:
        _report(run(args), args.seed)
        return

    print(f"\n--- rebuild budget sweep (seed {args.seed}, {args.shells} shells/frame) ---")
    print("frame times below are for LOADED frames only\n")
    print(f"{'budget':>7} {'chunks/f':>8} {'mean':>8} {'p50':>8} {'p95':>8} "
          f"{'p99':>8} {'max':>8} {'>16.7ms':>8} {'queue end':>10}")
    for budget in (1, 2, 4, 8, 16, 32, 64):
        args.budget = budget
        stats = run(args)
        print(f"{budget:7d} {stats['loaded_rate']:8.0f} "
              f"{stats.get('loaded_mean', stats['mean']):6.2f}ms "
              f"{stats.get('loaded_p50', stats['p50']):6.2f}ms "
              f"{stats.get('loaded_p95', stats['p95']):6.2f}ms "
              f"{stats.get('loaded_p99', stats['p99']):6.2f}ms "
              f"{stats.get('loaded_max', stats['max']):6.2f}ms "
              f"{stats['over_budget']:7.1f}% {stats['queue_end']:10.0f}")


if __name__ == "__main__":
    main()
