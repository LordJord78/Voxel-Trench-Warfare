from __future__ import annotations

import pytest

from trenchline.core.rng import GameRandom
from trenchline.data import load_tunables
from trenchline.session import Session, SessionConfig
from trenchline.world.generation import generate

SEED = 20260906


@pytest.fixture(scope="session")
def tun():
    return load_tunables()


@pytest.fixture(scope="session")
def generated(tun):
    return generate(GameRandom(SEED).derive("worldgen"), tun)


@pytest.fixture(scope="session")
def session() -> Session:
    return Session(SessionConfig(seed=SEED))
