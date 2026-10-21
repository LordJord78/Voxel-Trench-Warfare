"""Same seed, same world, same simulation."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from tools import golden
from trenchline.core.rng import GameRandom
from trenchline.session import Session, SessionConfig
from trenchline.world import voxel

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = golden.load()
GOLDEN_CASES = list(golden.CASES)


def _run(seed: int, ticks: int) -> str:
    session = Session(SessionConfig(seed=seed))
    session.run_ticks(ticks)
    return session.state_digest()


# -- golden digests ----------------------------------------------------------


@pytest.mark.parametrize("case", GOLDEN_CASES, ids=golden.case_key)
def test_state_matches_the_committed_golden(case: dict) -> None:
    """The same seed still produces the same run, byte for byte.

    98 passing tests do not prove determinism; they prove the things they
    assert.  This hashes the whole simulation state — every voxel, every
    transform, and how far every RNG stream has advanced — and compares it to a
    value committed to the repository.

    If this fails, something changed the run. That is often legitimate: new
    physics, a new RNG stream, a change to generation. The point is that it is
    never *silent*. Look at which part moved (the three sub-digests below say
    which), satisfy yourself the change was intended, then regenerate with
    `python -m tools.golden --update` and commit the diff.
    """
    committed = GOLDEN.get(golden.case_key(case))
    assert committed, (
        f"no golden digest for {golden.case_key(case)}; "
        "run `python -m tools.golden --update`"
    )
    assert golden.run_case(case)["state"] == committed["state"], (
        "simulation state has drifted from the committed golden"
    )


@pytest.mark.parametrize("case", GOLDEN_CASES, ids=golden.case_key)
@pytest.mark.parametrize("part", ["world", "entities", "rng"])
def test_each_part_of_the_state_matches_the_golden(case: dict, part: str) -> None:
    """Which half of the state moved: the world, the bodies, or the dice."""
    committed = GOLDEN.get(golden.case_key(case), {})
    assert golden.run_case(case)[part] == committed.get(part), (
        f"{part} digest has drifted from the committed golden"
    )


def test_the_digest_notices_a_single_changed_voxel() -> None:
    """A golden test is only worth having if it can actually fail."""
    session = Session(SessionConfig(seed=5))
    before = session.state_digest()
    x, y, z = session.generated.spawn
    session.world.set(int(x / 0.5), int(y / 0.5) + 6, int(z / 0.5), voxel.SANDBAG)
    assert session.state_digest() != before


def test_the_digest_notices_an_extra_rng_draw() -> None:
    """The stream position is part of the state, not an implementation detail.

    A system that quietly draws one extra number produces an identical world
    today and a divergent one the moment anything downstream of it draws again.
    """
    session = Session(SessionConfig(seed=5))
    session.stream("ballistics")
    before = session.state_digest()
    session.stream("ballistics").uniform()
    assert session.state_digest() != before


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
