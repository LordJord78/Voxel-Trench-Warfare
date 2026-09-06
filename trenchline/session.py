"""The simulation root.

Owns the world, the player and the clock.  Deliberately importable without an
engine present: `render/` reads a Session, a Session never reaches for a
renderer.  This is the boundary the architecture test enforces.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .core.events import EventBus
from .core.loop import TICK_DT, FixedClock
from .core.rng import GameRandom
from .data import Tunables, load_tunables
from .physics.character import CharacterController, CharacterState, MoveIntent, Stance
from .physics.vec import Vec3
from .world import voxel
from .world.chunks import VoxelWorld
from .world.generation import GeneratedWorld, generate
from .world.trenchmap import TrenchNetwork


@dataclass(slots=True)
class SessionConfig:
    seed: int = 1
    tunables_path: Path | None = None
    callsign: str = "BADGER-2"
    """Fictional callsign for the player's element."""


@dataclass(slots=True)
class SessionStats:
    ticks: int = 0
    chunk_rebuilds: int = 0
    sim_ms: list[float] = field(default_factory=list)


class Session:
    def __init__(self, config: SessionConfig | None = None) -> None:
        self.config = config or SessionConfig()
        self.tun: Tunables = load_tunables(self.config.tunables_path)
        self.rng = GameRandom(self.config.seed)
        self.bus = EventBus()
        self.clock = FixedClock()
        self.stats = SessionStats()

        self.generated: GeneratedWorld = generate(self.rng.derive("worldgen"), self.tun)
        self.world: VoxelWorld = self.generated.world
        self.network: TrenchNetwork = self.generated.network

        self.controller = CharacterController(self.world, self.tun)
        spawn = self.generated.spawn
        self.player = CharacterState(
            position=Vec3(*spawn),
            yaw=0.0,
            pitch=0.0,
            stance=Stance.STANDING,
            height=self.controller.stances[Stance.STANDING].height,
        )
        self.intent = MoveIntent()

    # -- simulation ------------------------------------------------------

    def tick(self, dt: float = TICK_DT) -> None:
        self.controller.tick(self.player, self.intent, dt)
        self.bus.drain()
        self.stats.ticks += 1

    def run_ticks(self, count: int, dt: float = TICK_DT) -> None:
        for _ in range(count):
            self.tick(dt)

    # -- introspection ---------------------------------------------------

    @property
    def eye_height(self) -> float:
        return self.controller.eye_height(self.player)

    @property
    def eye_position(self) -> Vec3:
        p = self.player.position
        return Vec3(p.x, p.y + self.eye_height, p.z)

    def exposure(self) -> float:
        return self.controller.profile(self.player).exposure

    def craters_ahead(
        self, x: float, z: float, facing: int, lateral_m: float
    ) -> list[tuple[int, int, int, float]]:
        """Shell holes in the corridor a bay looks down, nearest first."""
        s = voxel.VOXEL_SIZE
        out = []
        for crater in self.generated.craters:
            cx, cz = (crater[0] + 0.5) * s, (crater[2] + 0.5) * s
            if (cz - z) * facing <= 0.0 or abs(cx - x) > lateral_m:
                continue
            out.append(crater)
        out.sort(key=lambda c: abs((c[2] + 0.5) * s - z))
        return out

    def state_digest(self) -> str:
        """Short hash of everything a replay must reproduce."""
        h = hashlib.blake2b(digest_size=12)
        p, v = self.player.position, self.player.velocity
        for value in (p.x, p.y, p.z, v.x, v.y, v.z, self.player.yaw,
                      self.player.pitch, self.player.height):
            h.update(f"{value:.6f}".encode())
        h.update(bytes([int(self.player.stance), int(self.player.on_ground)]))
        h.update(np.ascontiguousarray(self.world.v[::7, ::5, ::7]).tobytes())
        return h.hexdigest()

    def describe(self) -> str:
        p = self.player.position
        bay = self.network.nearest_bay(p.x, p.z)
        where = f"{bay.line} bay {bay.index}" if bay else "open ground"
        return (
            f"{self.generated.name} | {self.config.callsign} | "
            f"pos ({p.x:6.2f},{p.y:6.2f},{p.z:6.2f}) "
            f"stance={self.player.stance.name.lower()} "
            f"ground={int(self.player.on_ground)} "
            f"step={int(self.player.on_firing_step)} "
            f"wade={self.player.wade_depth:.2f} | {where}"
        )
