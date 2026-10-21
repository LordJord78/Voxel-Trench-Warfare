"""Seeded randomness.

There is exactly one root RNG per run, created from the `--seed` and passed by
dependency injection.  Nothing in the simulation is allowed to reach for a
global `random` module.

Sub-streams are derived by *label*, not by draw order, so adding a generation
step or a new weapon does not shift the numbers every other system receives.
Two runs with the same seed produce the same map and the same ballistics.
"""

from __future__ import annotations

import hashlib
import json
from typing import Sequence, TypeVar

import numpy as np

T = TypeVar("T")


def _label_key(label: str) -> int:
    """Stable 63-bit hash of a label.  Python's hash() is salted; this is not."""
    digest = hashlib.blake2b(label.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big") & ((1 << 63) - 1)


class GameRandom:
    """A named, reproducible random stream."""

    __slots__ = ("_seq", "_gen", "label")

    def __init__(self, seed: int | np.random.SeedSequence, label: str = "root") -> None:
        self._seq = (
            seed if isinstance(seed, np.random.SeedSequence)
            else np.random.SeedSequence(entropy=int(seed))
        )
        self._gen = np.random.default_rng(self._seq)
        self.label = label

    def derive(self, label: str) -> "GameRandom":
        """A child stream that is independent of how much this one has drawn."""
        child = np.random.SeedSequence(
            entropy=self._seq.entropy,
            spawn_key=(*self._seq.spawn_key, _label_key(label)),
        )
        return GameRandom(child, label=f"{self.label}.{label}")

    # -- draws -----------------------------------------------------------

    @property
    def numpy(self) -> np.random.Generator:
        """Direct access for vectorised generation work."""
        return self._gen

    def uniform(self, lo: float = 0.0, hi: float = 1.0) -> float:
        return float(self._gen.uniform(lo, hi))

    def normal(self, mean: float = 0.0, sigma: float = 1.0) -> float:
        return float(self._gen.normal(mean, sigma))

    def randint(self, lo: int, hi: int) -> int:
        """Inclusive of lo, exclusive of hi."""
        return int(self._gen.integers(lo, hi))

    def chance(self, probability: float) -> bool:
        return bool(self._gen.random() < probability)

    def choice(self, options: Sequence[T]) -> T:
        return options[int(self._gen.integers(0, len(options)))]

    def shuffled(self, options: Sequence[T]) -> list[T]:
        out = list(options)
        order = self._gen.permutation(len(out))
        return [out[i] for i in order]

    def jitter(self, magnitude: float) -> float:
        """Symmetric noise in [-magnitude, +magnitude]."""
        return float(self._gen.uniform(-magnitude, magnitude))

    # -- introspection ---------------------------------------------------

    def state_json(self) -> str:
        """Exact position in the stream, as a stable string.

        This is what makes "did the RNG drift?" a testable question rather than
        an inference from downstream numbers.  A system that draws one extra
        value moves this even when the world it produced happens to look the
        same, which is the failure that is otherwise invisible until a replay
        diverges hours later.
        """
        return json.dumps(self._gen.bit_generator.state, sort_keys=True, default=str)

    def __repr__(self) -> str:
        return f"GameRandom({self.label!r}, entropy={self._seq.entropy})"
