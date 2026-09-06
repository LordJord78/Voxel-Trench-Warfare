"""Frame-time benchmark through the real game loop.

Not a synthetic render test: this builds the actual Session and Frontend, feeds
it movement, and measures whole frames including simulation ticks and the chunk
rebuild queue.

    python -m tools.bench --seed 7 --frames 900
"""

from __future__ import annotations

import argparse
import time

import numpy as np


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--frames", type=int, default=900)
    ap.add_argument("--windowed", action="store_true")
    ap.add_argument("--vsync", action="store_true")
    args = ap.parse_args()

    from panda3d.core import loadPrcFileData

    if not args.windowed:
        loadPrcFileData("", "window-type offscreen")
    loadPrcFileData("", "win-size 1440 810")

    from trenchline.physics.character import MoveIntent, Stance
    from trenchline.render.app import Frontend, _configure_panda
    from trenchline.session import Session, SessionConfig

    _configure_panda(vsync=args.vsync)
    t0 = time.perf_counter()
    session = Session(SessionConfig(seed=args.seed))
    gen_ms = (time.perf_counter() - t0) * 1000.0

    t0 = time.perf_counter()
    frontend = Frontend(session)
    load_ms = (time.perf_counter() - t0) * 1000.0
    stats = frontend.chunks.stats

    # Drive it like a player walking the line.
    frontend._read_intent = lambda: MoveIntent(  # type: ignore[method-assign]
        forward=1.0, strafe=0.3, stance=Stance.STANDING
    )
    frontend._apply_mouse = lambda: None  # type: ignore[method-assign]

    for _ in range(60):
        session.player.yaw = (session.player.yaw + 1.0) % 360.0
        frontend.app.taskMgr.step()

    samples = []
    for i in range(args.frames):
        session.player.yaw = (session.player.yaw + 0.7) % 360.0
        t = time.perf_counter()
        frontend.app.taskMgr.step()
        samples.append((time.perf_counter() - t) * 1000.0)

    a = np.array(samples)
    mode = "windowed" if args.windowed else "offscreen"
    vs = "vsync on" if args.vsync else "vsync off"
    print(f"\n--- TRENCHLINE frame time ({mode}, {vs}, 1440x810, seed {args.seed}) ---")
    print(f"worldgen        {gen_ms:7.0f} ms")
    print(f"initial meshing {load_ms:7.0f} ms  "
          f"({stats.nodes} chunks, {stats.triangles} tris, "
          f"mesh {stats.mesh_ms:.0f} / upload {stats.upload_ms:.0f})")
    print(f"frames          {len(a)}")
    print(f"  mean {a.mean():6.2f} ms   p50 {np.percentile(a,50):6.2f}   "
          f"p95 {np.percentile(a,95):6.2f}   p99 {np.percentile(a,99):6.2f}   "
          f"max {a.max():6.2f}")
    print(f"  {1000/a.mean():6.0f} fps mean, {1000/np.percentile(a,95):5.0f} fps at p95")
    over = int((a > 16.67).sum())
    print(f"  frames over the 60 Hz budget: {over}/{len(a)} ({100*over/len(a):.1f}%)")
    print(f"  sim ticks run: {session.stats.ticks}, dropped: {session.clock.dropped_ticks}")


if __name__ == "__main__":
    main()
