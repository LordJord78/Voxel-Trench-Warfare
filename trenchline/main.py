"""Entry point.

    python -m trenchline                       windowed
    python -m trenchline --seed 7
    python -m trenchline --headless --seed 7 --ticks 600
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from .core.loop import TICK_DT, TICK_HZ
from .core.rng import GameRandom
from .physics.character import MoveIntent, Stance
from .session import Session, SessionConfig


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="trenchline", description="Trench warfare, voxels.")
    ap.add_argument("--seed", type=int, default=1, help="master simulation seed")
    ap.add_argument("--headless", action="store_true", help="run without a window")
    ap.add_argument("--ticks", type=int, default=600, help="headless tick count")
    ap.add_argument(
        "--script",
        choices=("idle", "walk", "patrol", "random"),
        default="patrol",
        help="headless input script",
    )
    ap.add_argument("--tunables", type=Path, default=None)
    ap.add_argument("--report-every", type=int, default=120)
    ap.add_argument("--fullscreen", action="store_true")
    ap.add_argument(
        "--frames",
        type=int,
        default=0,
        help="windowed: run this many frames then exit (smoke test)",
    )
    ap.add_argument("--no-vsync", action="store_true", help="uncap the frame rate")
    return ap


def _scripted_intent(script: str, tick: int, rng: GameRandom, session: Session) -> MoveIntent:
    """Deterministic synthetic input, so headless runs actually exercise things."""
    intent = MoveIntent()
    if script == "idle":
        return intent
    if script == "walk":
        intent.forward = 1.0
        return intent
    if script == "patrol":
        # Walk the bay, turn about, sprint back, drop prone for a spell.
        phase = (tick // 90) % 4
        intent.forward = 1.0 if phase in (0, 2) else -0.6
        intent.sprint = phase == 2
        intent.stance = Stance.PRONE if phase == 3 else Stance.STANDING
        session.player.yaw = 90.0 if phase < 2 else 270.0
        return intent
    intent.forward = rng.uniform(-1.0, 1.0)
    intent.strafe = rng.uniform(-1.0, 1.0)
    intent.jump = rng.chance(0.02)
    intent.sprint = rng.chance(0.2)
    intent.stance = rng.choice((Stance.STANDING, Stance.CROUCHED, Stance.PRONE))
    session.player.yaw = (session.player.yaw + rng.jitter(6.0)) % 360.0
    return intent


def run_headless(args: argparse.Namespace) -> int:
    session = Session(SessionConfig(seed=args.seed, tunables_path=args.tunables))
    rng = session.rng.derive("headless.input")
    print(session.describe())

    start = time.perf_counter()
    for tick in range(args.ticks):
        session.intent = _scripted_intent(args.script, tick, rng, session)
        session.tick()
        if args.report_every and (tick + 1) % args.report_every == 0:
            print(f"t={tick + 1:5d}  {session.describe()}")
    elapsed = time.perf_counter() - start

    per_tick = elapsed / max(1, args.ticks) * 1000.0
    print(
        f"\n{args.ticks} ticks in {elapsed * 1000:.1f} ms "
        f"({per_tick:.4f} ms/tick, {TICK_HZ} Hz budget {TICK_DT * 1000:.2f} ms, "
        f"realtime factor {TICK_DT / max(per_tick / 1000, 1e-9):.0f}x)"
    )
    print(f"digest {session.state_digest()}")
    return 0


def run_windowed(args: argparse.Namespace) -> int:
    try:
        from .render.app import run
    except ImportError as exc:  # pragma: no cover - depends on local install
        print(f"render layer unavailable ({exc}); try --headless", file=sys.stderr)
        return 2
    return run(
        SessionConfig(seed=args.seed, tunables_path=args.tunables),
        fullscreen=args.fullscreen,
        vsync=not args.no_vsync,
        frames=args.frames,
    )


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return run_headless(args) if args.headless else run_windowed(args)


if __name__ == "__main__":
    raise SystemExit(main())
