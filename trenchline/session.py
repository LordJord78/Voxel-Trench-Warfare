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

from .combat.ballistics import Impact, ProjectilePool
from .combat.particles import ParticlePool
from .combat.recoil import Recoil, load_recoil
from .combat.viewkick import ViewKick, WeaponReport, load_viewkick
from .combat.weapons import Weapon, load_weapon
from .core.events import Event, EventBus
from .core.loop import TICK_DT, FixedClock
from .core.rng import GameRandom
from .data import Tunables, load_tunables
from .physics.character import CharacterController, CharacterState, MoveIntent, Stance
from .physics.vec import Vec3, from_yaw_pitch
from .world import destruction, voxel
from .world.chunks import VoxelWorld
from .world.generation import GeneratedWorld, generate
from .world.trenchmap import TrenchNetwork


def _view_basis(
    yaw: float, pitch: float
) -> tuple[tuple[float, float, float], ...]:
    """(forward, right, up) for an aim direction, as plain tuples."""
    forward = from_yaw_pitch(yaw, pitch)
    flat = from_yaw_pitch(yaw, 0.0)
    right = Vec3(flat.z, 0.0, -flat.x)
    up = right.cross(forward).normalised()
    return (forward.as_tuple(), right.as_tuple(), up.as_tuple())


@dataclass(slots=True)
class SessionConfig:
    seed: int = 1
    tunables_path: Path | None = None
    callsign: str = "BADGER-2"
    """Fictional callsign for the player's element."""
    weapon: str = "assault_rifle"


@dataclass(frozen=True, slots=True)
class WeaponFired(Event):
    tick: int
    weapon: str


@dataclass(frozen=True, slots=True)
class WeaponHeard(Event):
    """The transient one shot makes.  No audio backend is wired yet; from
    milestone 3 the observation layer reads this to know a shot was audible."""

    tick: int
    report: WeaponReport


@dataclass(frozen=True, slots=True)
class RoundImpact(Event):
    """A round stopped somewhere.  Destruction and audio both listen for this."""

    tick: int
    impact: Impact


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

        self.streams: dict[str, GameRandom] = {"root": self.rng}
        """Every sub-stream that outlives generation, by label.

        Registered rather than derived ad hoc so the determinism digest can hash
        where each one has got to.  `worldgen` is deliberately absent: it is
        consumed before the first tick and its result is in the voxels."""

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

        self.projectiles = ProjectilePool(self.world, self.tun)
        self.weapon: Weapon = load_weapon(
            self.tun, self.config.weapon, self.projectiles,
            self.stream("combat.dispersion"),
        )
        self.recoil: Recoil = load_recoil(
            self.tun, self.config.weapon, self.stream("combat.recoil")
        )
        # Cosmetic layer. Deliberately downstream of everything: it reads the
        # aim kick, and nothing reads it back.
        self.particles = ParticlePool(self.tun)
        self.viewkick: ViewKick = load_viewkick(
            self.tun, self.config.weapon, self.stream("combat.viewkick"),
            self.particles,
        )
        self.impacts: list[Impact] = []
        """Last tick's impacts, for the renderer to read and for destruction."""

    def stream(self, label: str) -> GameRandom:
        """A named simulation RNG stream, created once and remembered.

        Systems ask for their own stream by name instead of sharing one, so the
        order in which they draw cannot couple them, and so the determinism
        digest can see every one of them.
        """
        existing = self.streams.get(label)
        if existing is None:
            existing = self.rng.derive(label)
            self.streams[label] = existing
        return existing

    # -- simulation ------------------------------------------------------

    def tick(self, dt: float = TICK_DT) -> None:
        self.controller.tick(self.player, self.intent, dt)
        self._tick_combat(dt)
        self.bus.drain()
        self.stats.ticks += 1

    def _tick_combat(self, dt: float) -> None:
        # Stance is the same tradeoff here as everywhere else: prone shoulders
        # more of the impulse and holds a tighter cone than standing does.
        sway = self.controller.profile(self.player).sway_scale
        self.weapon.sway_scale = sway
        self.recoil.scale = sway

        self.weapon.tick(dt)
        self.recoil.tick(dt)
        self.viewkick.tick(dt)
        self.particles.step(dt)
        if self.intent.reload:
            self.weapon.begin_reload()
        if self.intent.fire and self.weapon.ready:
            yaw, pitch = self.recoil.aim(self.player.yaw, self.player.pitch)
            eye = self.eye_position
            if self.weapon.fire(eye, yaw, pitch) >= 0:
                before = self.recoil.state.kick_pitch
                self.recoil.shot()
                # The cosmetic layer is fired from the same event on the same
                # frame, and takes the aim kick as an input, so the two cannot
                # drift into looking like two separate guns.
                forward, right, up = _view_basis(yaw, pitch)
                report = self.viewkick.shot(
                    eye.as_tuple(), forward, right, up,
                    aim_kick_deg=self.recoil.state.kick_pitch - before,
                )
                self.bus.post(WeaponFired(tick=self.stats.ticks, weapon=self.weapon.spec.key))
                self.bus.post(WeaponHeard(tick=self.stats.ticks, report=report))

        self.impacts = self.projectiles.step(dt)
        for impact in self.impacts:
            destruction.chip(self.world, impact, self.tun)
            self.bus.post(RoundImpact(tick=self.stats.ticks, impact=impact))

    def run_ticks(self, count: int, dt: float = TICK_DT) -> None:
        for _ in range(count):
            self.tick(dt)

    def scripted_intent(self, script: str, tick: int) -> MoveIntent:
        """Deterministic synthetic input, so a headless run exercises things.

        Lives here rather than in the CLI because the determinism test has to
        drive the simulation exactly the way `--headless` drives it; two copies
        of this would mean the golden digests measured something the game never
        actually runs.
        """
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
            self.player.yaw = 90.0 if phase < 2 else 270.0
            return intent
        rng = self.stream("input.script")
        intent.forward = rng.uniform(-1.0, 1.0)
        intent.strafe = rng.uniform(-1.0, 1.0)
        intent.jump = rng.chance(0.02)
        intent.sprint = rng.chance(0.2)
        intent.stance = rng.choice((Stance.STANDING, Stance.CROUCHED, Stance.PRONE))
        self.player.yaw = (self.player.yaw + rng.jitter(6.0)) % 360.0
        return intent

    def run_scripted(self, script: str, ticks: int, dt: float = TICK_DT) -> None:
        for tick in range(ticks):
            self.intent = self.scripted_intent(script, tick)
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

    # -- determinism -----------------------------------------------------

    def world_digest(self) -> str:
        """Hash of the generated world: every voxel, plus what was placed where.

        Whole array, not a stride sample.  A stride of 7 misses six voxels out of
        seven, which is exactly where a one-voxel generation drift would hide.
        """
        h = hashlib.blake2b(digest_size=16)
        h.update(np.ascontiguousarray(self.world.v).tobytes())
        h.update(f"{self.generated.spawn}".encode())
        h.update(repr(self.generated.craters).encode())
        h.update(repr(sorted(self.generated.landmarks.items())).encode())
        for name in sorted(self.network.lines):
            line = self.network.lines[name]
            for bay in line.bays:
                h.update(
                    f"{bay.index},{bay.floor_y},{bay.step_top_y},{bay.crest_y},"
                    f"{bay.step_lo},{bay.step_span},{bay.ground_y}".encode()
                )
        for dugout in self.network.dugouts:
            h.update(f"{dugout.lo}{dugout.hi}{dugout.entrance}".encode())
        h.update(repr(self.network.graph.nodes).encode())
        return h.hexdigest()

    def entity_digest(self) -> str:
        """Hash of every transform the simulation is carrying."""
        h = hashlib.blake2b(digest_size=16)
        for name, values in self._entity_rows():
            h.update(name.encode())
            for value in values:
                h.update(f"{value:.9f}".encode())
        return h.hexdigest()

    def _entity_rows(self) -> list[tuple[str, tuple[float, ...]]]:
        """(name, numbers) for everything with a transform.

        A list rather than the player's fields inline, so projectiles and
        vehicles join the digest by appearing here and nowhere else.
        """
        p, v = self.player.position, self.player.velocity
        recoil = self.recoil.state
        rows: list[tuple[str, tuple[float, ...]]] = [
            (
                "player",
                (
                    p.x, p.y, p.z, v.x, v.y, v.z,
                    self.player.yaw, self.player.pitch, self.player.height,
                    float(self.player.stance),
                    float(self.player.on_ground),
                    float(self.player.on_firing_step),
                    self.player.wade_depth,
                    self.player.bob_phase,
                    self.player.landing_impact,
                ),
            ),
            (
                "recoil",
                (
                    recoil.kick_pitch, recoil.kick_yaw,
                    recoil.kick_pitch_vel, recoil.kick_yaw_vel,
                    recoil.climb_pitch, recoil.climb_yaw,
                    float(recoil.shots), recoil.since_shot,
                ),
            ),
            (
                "weapon",
                (
                    float(self.weapon.state.rounds),
                    self.weapon.state.since_shot,
                    self.weapon.state.reload_left,
                    float(self.weapon.state.shots_fired),
                ),
            ),
        ]
        # ViewKick and the particle pool are deliberately absent. They are
        # cosmetic by contract — nothing in the simulation reads them — so
        # folding them in would mean every tweak to how the rifle *looks*
        # invalidated the determinism goldens, which is exactly the friction
        # the split was supposed to remove. test_viewkick asserts the contract.
        pool = self.projectiles
        for slot in range(pool.count):
            rows.append(
                (
                    f"round{slot}",
                    (
                        *pool.position[slot], *pool.velocity[slot],
                        float(pool.distance[slot]), float(pool.age[slot]),
                    ),
                )
            )
        return rows

    def rng_digest(self) -> str:
        """Hash of how far every live RNG stream has advanced."""
        h = hashlib.blake2b(digest_size=16)
        for label in sorted(self.streams):
            h.update(label.encode())
            h.update(self.streams[label].state_json().encode())
        return h.hexdigest()

    def state_digest(self) -> str:
        """One digest over the whole simulation state.

        Voxels, transforms and RNG position, so a replay that reproduces this
        reproduces the run.  The three parts are also available separately,
        because "the world changed" and "the physics changed" want different
        answers when this starts failing.
        """
        h = hashlib.blake2b(digest_size=16)
        h.update(self.world_digest().encode())
        h.update(self.entity_digest().encode())
        h.update(self.rng_digest().encode())
        h.update(f"{self.stats.ticks}".encode())
        return h.hexdigest()

    def digests(self) -> dict[str, str]:
        return {
            "world": self.world_digest(),
            "entities": self.entity_digest(),
            "rng": self.rng_digest(),
            "state": self.state_digest(),
        }

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
