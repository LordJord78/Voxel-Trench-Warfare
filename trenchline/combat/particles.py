"""Short-lived cosmetic particles: muzzle flash, brass, dust, debris.

A struct of arrays for the same reason the projectile pool is one — the render
layer builds its geometry from slices of these arrays with no per-particle
Python loop on its side. This is the workload `render.buffers.DynamicGeometry`
was extracted for: a few dozen quads, rewritten every frame, gone in half a
second.

Deterministic, and part of the simulation rather than the renderer, so a
headless run produces the same brass as a windowed one and the whole thing is
testable without a window. It is nonetheless *cosmetic*: nothing here is read
by collision, ballistics or AI, and nothing here may ever be.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..core.rng import GameRandom
from ..data import Tunables

_FIELDS = 3


@dataclass(frozen=True, slots=True)
class ParticleSpec:
    """One kind of particle: how long it lives and what it looks like."""

    life_s: float
    gravity: float
    drag: float
    """Per-second velocity decay; brass tumbles, flash barely moves."""
    size_start_m: float
    size_end_m: float
    colour_start: tuple[float, float, float, float]
    colour_end: tuple[float, float, float, float]


class ParticlePool:
    """Every live particle, integrated together.  Full is full."""

    __slots__ = (
        "capacity", "count", "dropped",
        "position", "velocity", "age", "life", "gravity", "drag",
        "size_start", "size_end", "colour_start", "colour_end",
    )

    def __init__(self, tun: Tunables, capacity: int | None = None) -> None:
        self.capacity = capacity or tun.i("particles.pool_capacity")
        n = self.capacity
        self.position = np.zeros((n, 3), dtype=np.float32)
        self.velocity = np.zeros((n, 3), dtype=np.float32)
        self.age = np.zeros(n, dtype=np.float32)
        self.life = np.ones(n, dtype=np.float32)
        self.gravity = np.zeros(n, dtype=np.float32)
        self.drag = np.zeros(n, dtype=np.float32)
        self.size_start = np.zeros(n, dtype=np.float32)
        self.size_end = np.zeros(n, dtype=np.float32)
        self.colour_start = np.zeros((n, 4), dtype=np.float32)
        self.colour_end = np.zeros((n, 4), dtype=np.float32)
        self.count = 0
        self.dropped = 0

    # -- emission --------------------------------------------------------

    def emit(
        self,
        origin: tuple[float, float, float],
        velocity: tuple[float, float, float],
        spec: ParticleSpec,
        count: int,
        rng: GameRandom | None = None,
        spread: float = 0.0,
        speed_jitter: float = 0.0,
    ) -> int:
        """Add up to `count` particles.  Returns how many were actually added."""
        room = self.capacity - self.count
        if room <= 0:
            self.dropped += count
            return 0
        made = min(count, room)
        self.dropped += count - made
        lo, hi = self.count, self.count + made

        self.position[lo:hi] = origin
        base = np.array(velocity, dtype=np.float32)
        if rng is not None and (spread > 0.0 or speed_jitter > 0.0):
            noise = rng.numpy.normal(0.0, 1.0, size=(made, 3)).astype(np.float32)
            scale = 1.0 + rng.numpy.normal(0.0, speed_jitter, size=(made, 1)).astype(
                np.float32
            )
            self.velocity[lo:hi] = base * scale + noise * np.float32(spread)
        else:
            self.velocity[lo:hi] = base

        self.age[lo:hi] = 0.0
        self.life[lo:hi] = spec.life_s
        self.gravity[lo:hi] = spec.gravity
        self.drag[lo:hi] = spec.drag
        self.size_start[lo:hi] = spec.size_start_m
        self.size_end[lo:hi] = spec.size_end_m
        self.colour_start[lo:hi] = spec.colour_start
        self.colour_end[lo:hi] = spec.colour_end
        self.count = hi
        return made

    # -- flight ----------------------------------------------------------

    def step(self, dt: float) -> None:
        n = self.count
        if n == 0:
            return
        velocity = self.velocity[:n]
        velocity *= np.maximum(0.0, 1.0 - self.drag[:n, None] * dt)
        velocity[:, 1] += self.gravity[:n] * dt
        self.position[:n] += velocity * dt
        self.age[:n] += dt

        alive = self.age[:n] < self.life[:n]
        if alive.all():
            return
        keep = np.nonzero(alive)[0]
        # Compaction, not a free list: the render layer takes a contiguous
        # slice, and holes in it would mean either a mask or a copy every frame.
        for array in (
            self.position, self.velocity, self.age, self.life,
            self.gravity, self.drag, self.size_start, self.size_end,
            self.colour_start, self.colour_end,
        ):
            array[: keep.size] = array[keep]
        self.count = int(keep.size)

    def clear(self) -> None:
        self.count = 0

    # -- rendering -------------------------------------------------------

    def billboards(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """(centres, half-sizes, rgba 0-255) for every live particle."""
        n = self.count
        if n == 0:
            return (
                np.zeros((0, 3), np.float32),
                np.zeros(0, np.float32),
                np.zeros((0, 4), np.uint8),
            )
        t = np.clip(self.age[:n] / np.maximum(1e-6, self.life[:n]), 0.0, 1.0)
        size = self.size_start[:n] + (self.size_end[:n] - self.size_start[:n]) * t
        colour = (
            self.colour_start[:n]
            + (self.colour_end[:n] - self.colour_start[:n]) * t[:, None]
        )
        rgba = np.clip(colour * 255.0, 0.0, 255.0).astype(np.uint8)
        return self.position[:n].copy(), size * 0.5, rgba


def spec_from_tunables(tun: Tunables, key: str) -> ParticleSpec:
    section = tun.section(key)
    return ParticleSpec(
        life_s=float(section["life_s"]),
        gravity=float(section["gravity"]),
        drag=float(section["drag"]),
        size_start_m=float(section["size_start_m"]),
        size_end_m=float(section["size_end_m"]),
        colour_start=tuple(float(c) for c in section["colour_start"]),  # type: ignore[arg-type]
        colour_end=tuple(float(c) for c in section["colour_end"]),  # type: ignore[arg-type]
    )


__all__ = ["ParticleSpec", "ParticlePool", "spec_from_tunables"]
