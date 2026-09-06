"""Render a frame offscreen and save it.

Lets rendering be verified in a terminal, in CI, or over ssh.

    python -m tools.shot --seed 7 --out shot.png --frames 40
"""

from __future__ import annotations

import argparse
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", type=Path, default=Path("shot.png"))
    ap.add_argument("--frames", type=int, default=40)
    ap.add_argument("--pos", type=float, nargs=3, default=None)
    ap.add_argument("--yaw", type=float, default=None)
    ap.add_argument("--pitch", type=float, default=None)
    ap.add_argument("--tunables", type=Path, default=None)
    ap.add_argument("--bay", type=int, default=None,
                    help="stand on this front-line bay's firing step")
    ap.add_argument("--offscreen", action="store_true", default=True)
    args = ap.parse_args()

    from panda3d.core import loadPrcFileData

    if args.offscreen:
        loadPrcFileData("", "window-type offscreen")
    loadPrcFileData("", "win-size 1280 720")

    from trenchline.render.app import Frontend, _configure_panda
    from trenchline.session import Session, SessionConfig
    from trenchline.physics.vec import Vec3

    _configure_panda(vsync=False)
    session = Session(SessionConfig(seed=args.seed, tunables_path=args.tunables))
    if args.bay is not None:
        bay = session.network.lines["front"].bays[args.bay]
        session.player.position = Vec3(*bay.step_metres)
        session.player.yaw = 0.0 if bay.facing > 0 else 180.0
    if args.pos:
        session.player.position = Vec3(*args.pos)
    if args.yaw is not None:
        session.player.yaw = args.yaw
    if args.pitch is not None:
        session.player.pitch = args.pitch

    frontend = Frontend(session)
    for _ in range(args.frames):
        frontend.app.taskMgr.step()

    # The HUD refreshes on a timer; a burst of fast offscreen frames may not
    # trip it, so force one before capturing.
    frontend.hud._accum = 99.0
    frontend.hud.update(0.0, frontend.frame_stats.summary(),
                        f"chunks {frontend.chunks.stats.nodes}  "
                        f"tris {frontend.chunks.stats.triangles // 1000}k  "
                        f"queue {session.world.dirty_count}  rebuild 0.00 ms")
    frontend.app.taskMgr.step()
    frontend.app.graphicsEngine.render_frame()
    ok = frontend.app.win.save_screenshot(str(args.out))
    print(f"saved {args.out} -> {ok}")
    print(session.describe())


if __name__ == "__main__":
    main()
