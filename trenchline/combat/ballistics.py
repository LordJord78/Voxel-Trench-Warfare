"""Projectile flight: drag, gravity, and what it hits.

Deterministic by construction.  Fixed sub-steps of the fixed tick, no wall
clock anywhere, no randomness in the integrator at all — a round's dispersion
is decided once when it leaves the muzzle, from a named RNG stream, and after
that its path is a pure function of its state.  Two runs of the same seed put
the same round through the same voxel.

Stored as a struct of arrays rather than a list of objects because the tracer
geometry is a slice of these arrays, which is what feeds `render.buffers`
without a per-projectile Python loop on the render side.

The drag term is the standard quadratic one:

    a = g - (1/2 rho Cd A / m) * |v| * v

Everything constant in that bracket is folded into `ProjectileSpec.drag_factor`
once, so the inner loop is two multiplies. Mass and drag coefficient are per
projectile, so a 5.45 mm rifle round and a 40 mm grenade fall differently
without either of them being a special case.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..data import Tunables
from ..physics.vec import Vec3
from ..world import voxel
from ..world.chunks import VoxelWorld
from ..world.raycast import raycast


@dataclass(frozen=True, slots=True)
class ProjectileSpec:
    """What flies, as opposed to what fired it."""

    name: str
    mass_kg: float
    drag_coefficient: float
    cross_section_m2: float
    muzzle_velocity: float
    tracer: bool = True

    @property
    def drag_factor(self) -> float:
        """0.5 * Cd * A / m: everything in the drag term that never changes."""
        return 0.5 * self.drag_coefficient * self.cross_section_m2 / self.mass_kg

    @staticmethod
    def from_tunables(tun: Tunables, key: str) -> "ProjectileSpec":
        section = tun.section(key)
        return ProjectileSpec(
            name=str(section.get("name", key)),
            mass_kg=float(section["projectile_mass_kg"]),
            drag_coefficient=float(section["drag_coefficient"]),
            cross_section_m2=float(section["cross_section_m2"]),
            muzzle_velocity=float(section["muzzle_velocity"]),
            tracer=bool(section.get("tracer", True)),
        )


@dataclass(frozen=True, slots=True)
class Impact:
    """Where a round stopped, and with how much left."""

    position: Vec3
    normal: tuple[int, int, int]
    voxel: tuple[int, int, int]
    material: int
    speed: float
    distance: float
    energy_j: float
    spec_name: str


class ProjectilePool:
    """Every round in the air, integrated together.

    Capacity is fixed and full is full: a pool that grows under sustained fire
    reallocates in the middle of the frame that can least afford it.
    """

    __slots__ = (
        "world", "capacity", "gravity", "air_density", "substeps",
        "max_range", "max_flight_time", "count", "dropped",
        "position", "velocity", "origin", "drag_factor", "mass",
        "distance", "age", "spec_index", "_specs",
    )

    def __init__(self, world: VoxelWorld, tun: Tunables, capacity: int | None = None) -> None:
        self.world = world
        self.capacity = capacity or tun.i("ballistics.pool_capacity")
        self.gravity = tun.f("ballistics.gravity")
        self.air_density = tun.f("ballistics.air_density")
        self.substeps = max(1, tun.i("ballistics.substeps_per_tick"))
        self.max_range = tun.f("ballistics.max_range_m")
        self.max_flight_time = tun.f("ballistics.max_flight_time_s")

        n = self.capacity
        self.position = np.zeros((n, 3), dtype=np.float64)
        self.velocity = np.zeros((n, 3), dtype=np.float64)
        self.origin = np.zeros((n, 3), dtype=np.float64)
        self.drag_factor = np.zeros(n, dtype=np.float64)
        self.mass = np.zeros(n, dtype=np.float64)
        self.distance = np.zeros(n, dtype=np.float64)
        self.age = np.zeros(n, dtype=np.float64)
        self.spec_index = np.zeros(n, dtype=np.int32)
        self.count = 0
        self.dropped = 0
        self._specs: list[ProjectileSpec] = []

    # -- firing ----------------------------------------------------------

    def fire(
        self,
        origin: Vec3,
        direction: Vec3,
        spec: ProjectileSpec,
        speed: float | None = None,
    ) -> int:
        """Put one round in the air.  Returns its slot, or -1 if the pool is full."""
        if self.count >= self.capacity:
            self.dropped += 1
            return -1
        d = direction.normalised()
        if d.length_sq < 0.5:
            return -1

        try:
            index = self._specs.index(spec)
        except ValueError:
            self._specs.append(spec)
            index = len(self._specs) - 1

        slot = self.count
        muzzle = spec.muzzle_velocity if speed is None else speed
        self.position[slot] = (origin.x, origin.y, origin.z)
        self.origin[slot] = self.position[slot]
        self.velocity[slot] = (d.x * muzzle, d.y * muzzle, d.z * muzzle)
        self.drag_factor[slot] = spec.drag_factor
        self.mass[slot] = spec.mass_kg
        self.distance[slot] = 0.0
        self.age[slot] = 0.0
        self.spec_index[slot] = index
        self.count += 1
        return slot

    # -- flight ----------------------------------------------------------

    def step(self, dt: float) -> list[Impact]:
        """Advance every live round one tick.  Returns what hit something."""
        if self.count == 0:
            return []

        impacts: list[Impact] = []
        sub_dt = dt / self.substeps
        for _ in range(self.substeps):
            if self.count == 0:
                break
            impacts.extend(self._substep(sub_dt))
        return impacts

    def _substep(self, dt: float) -> list[Impact]:
        n = self.count
        velocity = self.velocity[:n]
        position = self.position[:n]

        speed = np.linalg.norm(velocity, axis=1)
        # a = g - (1/2 rho Cd A / m) |v| v, integrated semi-implicitly: the
        # drag uses the speed at the start of the step and the position uses
        # the velocity at the end of it.
        decel = (self.drag_factor[:n] * self.air_density * speed)[:, None]
        velocity -= velocity * decel * dt
        velocity[:, 1] += self.gravity * dt

        travel = velocity * dt
        candidate = position + travel
        step_length = np.linalg.norm(travel, axis=1)
        self.distance[:n] += step_length
        self.age[:n] += dt

        impacts: list[Impact] = []
        dead: list[int] = []
        for i in range(n):
            length = float(step_length[i])
            if length > 1e-9:
                start = Vec3(*position[i])
                direction = Vec3(*(travel[i] / length))
                hit = raycast(self.world, start, direction, length)
                if hit is not None:
                    impacts.append(self._impact(i, hit, speed[i]))
                    dead.append(i)
                    continue
            position[i] = candidate[i]
            if (
                self.distance[i] >= self.max_range
                or self.age[i] >= self.max_flight_time
                or not self._in_world(position[i])
            ):
                dead.append(i)

        for slot in reversed(dead):
            self._retire(slot)
        return impacts

    def _impact(self, slot: int, hit, speed: float) -> Impact:
        return Impact(
            position=hit.point,
            normal=hit.normal,
            voxel=hit.voxel,
            material=hit.material,
            speed=float(speed),
            distance=float(self.distance[slot]),
            energy_j=0.5 * float(self.mass[slot]) * float(speed) ** 2,
            spec_name=self._specs[int(self.spec_index[slot])].name,
        )

    def _in_world(self, point: np.ndarray) -> bool:
        size = self.world.dims
        s = voxel.VOXEL_SIZE
        return (
            0.0 <= point[0] < size.x * s
            and -1.0 <= point[1] < size.y * s
            and 0.0 <= point[2] < size.z * s
        )

    def _retire(self, slot: int) -> None:
        """Swap the last live round into the retired slot; order is not state."""
        last = self.count - 1
        if slot != last:
            for array in (
                self.position, self.velocity, self.origin,
                self.drag_factor, self.mass, self.distance,
                self.age, self.spec_index,
            ):
                array[slot] = array[last]
        self.count -= 1

    # -- rendering -------------------------------------------------------

    def tracer_segments(self, length_m: float) -> tuple[np.ndarray, np.ndarray]:
        """(head, tail) points for every live round, for line geometry.

        The tail trails backwards along the velocity, so a tracer is a streak
        the length of the distance covered rather than a dot.
        """
        n = self.count
        if n == 0:
            empty = np.zeros((0, 3), dtype=np.float32)
            return empty, empty
        head = self.position[:n].astype(np.float32)
        speed = np.linalg.norm(self.velocity[:n], axis=1, keepdims=True)
        unit = np.divide(
            self.velocity[:n], speed, out=np.zeros_like(self.velocity[:n]),
            where=speed > 1e-9,
        )
        trail = np.minimum(length_m, self.distance[:n][:, None])
        return head, (self.position[:n] - unit * trail).astype(np.float32)


__all__ = ["ProjectileSpec", "Impact", "ProjectilePool"]
