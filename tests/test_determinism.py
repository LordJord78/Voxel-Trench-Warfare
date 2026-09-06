"""Same seed, same world, same simulation."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np

from trenchline.core.rng import GameRandom
from trenchline.session import Session, SessionConfig

ROOT = Path(__file__).resolve().parent.parent


def _run(seed: int, ticks: int) -> str:
    session = Session(SessionConfig(seed=seed))
    session.run_ticks(ticks)
    return session.state_digest()


def test_same_seed_same_world() -> None:
    a, b = Session(SessionConfig(seed=31)), Session(SessionConfig(seed=31))
    assert np.array_equal(a.world.v, b.world.v)
    assert a.generated.spawn == b.generated.spawn
    assert a.generated.craters == b.generated.craters


def test_different_seed_different_world() -> None:
    a, b = Session(SessionConfig(seed=31)), Session(SessionConfig(seed=32))
    assert not np.array_equal(a.world.v, b.world.v)


def test_same_seed_same_simulation() -> None:
    assert _run(11, 300) == _run(11, 300)


def test_different_seed_diverges() -> None:
    assert _run(11, 300) != _run(12, 300)


def test_substreams_are_order_independent() -> None:
    """Deriving a stream must not depend on what other streams have drawn."""
    root = GameRandom(7)
    a = root.derive("ballistics")
    first = [a.uniform() for _ in range(8)]

    root2 = GameRandom(7)
    noisy = root2.derive("worldgen")
    for _ in range(5000):
        noisy.uniform()
    root2.derive("craters").uniform()
    b = root2.derive("ballistics")
    assert [b.uniform() for _ in range(8)] == first


def test_substream_labels_are_distinct() -> None:
    root = GameRandom(7)
    assert root.derive("a").uniform() != root.derive("b").uniform()


def test_headless_cli_is_reproducible() -> None:
    cmd = [sys.executable, "-m", "trenchline", "--headless", "--seed", "4",
           "--ticks", "240", "--report-every", "0"]
    first = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    second = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    assert first.returncode == 0, first.stderr
    digest_lines = [
        [ln for ln in r.stdout.splitlines() if ln.startswith("digest")]
        for r in (first, second)
    ]
    assert digest_lines[0] and digest_lines[0] == digest_lines[1]
