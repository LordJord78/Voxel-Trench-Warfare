"""Weapons: what fires, how fast, and how straight.

A weapon is data plus a clock.  Everything that decides how it feels — rate of
fire, muzzle velocity, projectile mass and drag, dispersion, magazine, reload —
comes out of `tunables.toml`, so retuning a weapon never means editing a class.

Dispersion is the only randomness, it is drawn once per round from a named
stream, and after that the round's flight is deterministic.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from ..core.rng import GameRandom
from ..data import Tunables
from ..physics.vec import Vec3, from_yaw_pitch
from .ballistics import ProjectilePool, ProjectileSpec

MOA_TO_DEG = 1.0 / 60.0


@dataclass(frozen=True, slots=True)
class WeaponSpec:
    key: str
    name: str
    projectile: ProjectileSpec
    rounds_per_minute: float
    magazine: int
    dispersion_moa: float
    reload_time_s: float
    automatic: bool

    @property
    def shot_interval(self) -> float:
        return 60.0 / max(1e-6, self.rounds_per_minute)

    @staticmethod
    def from_tunables(tun: Tunables, key: str) -> "WeaponSpec":
        path = f"weapon.{key}"
        section = tun.section(path)
        return WeaponSpec(
            key=key,
            name=str(section.get("name", key)),
            projectile=ProjectileSpec.from_tunables(tun, path),
            rounds_per_minute=float(section["rounds_per_minute"]),
            magazine=int(section["magazine"]),
            dispersion_moa=float(section["dispersion_moa"]),
            reload_time_s=float(section["reload_time_s"]),
            automatic=bool(section.get("automatic", True)),
        )


@dataclass(slots=True)
class WeaponState:
    rounds: int = 0
    since_shot: float = 1e9
    reload_left: float = 0.0
    shots_fired: int = 0
    trigger_held: bool = False

    @property
    def reloading(self) -> bool:
        return self.reload_left > 0.0


class Weapon:
    """One weapon in one pair of hands."""

    __slots__ = ("spec", "pool", "rng", "state", "sway_scale")

    def __init__(
        self, spec: WeaponSpec, pool: ProjectilePool, rng: GameRandom
    ) -> None:
        self.spec = spec
        self.pool = pool
        self.rng = rng
        self.state = WeaponState(rounds=spec.magazine)
        self.sway_scale = 1.0

    # -- clock -----------------------------------------------------------

    def tick(self, dt: float) -> None:
        state = self.state
        state.since_shot += dt
        if state.reload_left > 0.0:
            state.reload_left = max(0.0, state.reload_left - dt)
            if state.reload_left == 0.0:
                state.rounds = self.spec.magazine

    def begin_reload(self) -> bool:
        if self.state.reloading or self.state.rounds >= self.spec.magazine:
            return False
        self.state.reload_left = self.spec.reload_time_s
        return True

    @property
    def ready(self) -> bool:
        return (
            not self.state.reloading
            and self.state.rounds > 0
            and self.state.since_shot >= self.spec.shot_interval
        )

    # -- firing ----------------------------------------------------------

    def fire(self, origin: Vec3, yaw: float, pitch: float) -> int:
        """Loose one round along (yaw, pitch).  Returns its pool slot, or -1.

        Dispersion is applied as an angular offset rather than a positional
        one, so it scales with range the way a real cone does instead of being
        a fixed wobble at the muzzle.
        """
        if not self.ready:
            return -1
        spread = self.spec.dispersion_moa * MOA_TO_DEG * self.sway_scale
        if spread > 0.0:
            # Uniform inside the cone, not uniform per axis: squaring the radius
            # keeps the density even instead of piling rounds in the middle.
            angle = self.rng.uniform(0.0, math.tau)
            radius = spread * math.sqrt(self.rng.uniform(0.0, 1.0))
            yaw = yaw + radius * math.cos(angle)
            pitch = pitch + radius * math.sin(angle)

        self.state.rounds -= 1
        self.state.since_shot = 0.0
        self.state.shots_fired += 1
        return self.pool.fire(origin, from_yaw_pitch(yaw, pitch), self.spec.projectile)


def load_weapon(
    tun: Tunables, key: str, pool: ProjectilePool, rng: GameRandom
) -> Weapon:
    return Weapon(WeaponSpec.from_tunables(tun, key), pool, rng)


__all__ = ["WeaponSpec", "WeaponState", "Weapon", "load_weapon", "MOA_TO_DEG"]
