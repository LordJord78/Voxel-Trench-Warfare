"""The entrenching tool: undoing what the artillery did, slowly, in the open.

Collapsed spoil ramping over a shelled traverse is correct physics and good
mechanics — a position should degrade structurally over a bombardment — but a
degradation with no counter is just attrition. This is the counter, and it is
priced the way it should be: it takes real time, it cannot be done lying down,
and the whole time you are doing it you are standing up in a trench that no
longer has a traverse.

Only *loose* material can be dug: spoil, rubble, sandbags. Revetment timber,
duckboards and undisturbed strata are not shovel work, so a player cannot
quietly re-excavate the map with this.

Progress is per voxel and survives interruption. Being shot at should make you
stop; it should not make you start again.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from . import voxel
from .chunks import VoxelWorld


@dataclass(frozen=True, slots=True)
class DigPolicy:
    reach_m: float
    seconds_per_voxel: float
    exposure_scale: float
    sway_scale: float

    @staticmethod
    def from_tunables(tun) -> "DigPolicy":
        return DigPolicy(
            reach_m=tun.f("entrenching.reach_m"),
            seconds_per_voxel=tun.f("entrenching.seconds_per_voxel"),
            exposure_scale=tun.f("entrenching.exposure_scale"),
            sway_scale=tun.f("entrenching.sway_scale"),
        )


@dataclass(slots=True)
class EntrenchingTool:
    """Clears loose fill in front of the player, one voxel at a time."""

    world: VoxelWorld
    policy: DigPolicy
    progress: dict[tuple[int, int, int], float] = field(default_factory=dict)
    """Seconds of work banked against each voxel. Interruptible means this
    survives letting go of the button, taking cover, and coming back."""
    target: tuple[int, int, int] | None = None
    cleared: int = 0
    seconds_worked: float = 0.0

    def find_target(
        self, x: float, y: float, z: float, yaw: float
    ) -> tuple[int, int, int] | None:
        """The nearest loose voxel within reach, biased to where you are facing.

        Nearest rather than exactly-under-the-crosshair: a shovel is not a
        rifle, and making the player pixel-hunt a pile of dirt would be a worse
        game than making them stand still for twenty seconds.
        """
        s = voxel.VOXEL_SIZE
        reach = self.policy.reach_m
        span = int(math.ceil(reach / s))
        heading = math.radians(yaw)
        fx, fz = math.sin(heading), math.cos(heading)
        # Look from just in front of the feet, at shin-to-waist height.
        cx, cy, cz = x + fx * reach * 0.5, y, z + fz * reach * 0.5
        vx, vy, vz = int(cx // s), int(cy // s), int(cz // s)

        best: tuple[int, int, int] | None = None
        best_d = float("inf")
        for dx in range(-span, span + 1):
            for dy in range(-1, span + 1):
                for dz in range(-span, span + 1):
                    px, py, pz = vx + dx, vy + dy, vz + dz
                    if not voxel.LOOSE[self.world.get(px, py, pz)]:
                        continue
                    wx, wy, wz = (px + 0.5) * s, (py + 0.5) * s, (pz + 0.5) * s
                    d = (wx - x) ** 2 + (wy - y) ** 2 + (wz - z) ** 2
                    if d > reach * reach or d >= best_d:
                        continue
                    best_d, best = d, (px, py, pz)
        return best

    def work(self, x: float, y: float, z: float, yaw: float, dt: float) -> bool:
        """One tick of digging.  Returns True if a voxel came out this tick."""
        target = self.find_target(x, y, z, yaw)
        self.target = target
        if target is None:
            return False
        self.seconds_worked += dt
        banked = self.progress.get(target, 0.0) + dt
        if banked < self.policy.seconds_per_voxel:
            self.progress[target] = banked
            return False
        self.progress.pop(target, None)
        # Thrown over the parapet, not relocated: the trench getting deeper
        # every time someone tidies it is not a mechanic anyone wants.
        self.world.set(target[0], target[1], target[2], voxel.AIR)
        self.cleared += 1
        return True

    def idle(self) -> None:
        self.target = None

    @property
    def target_fraction(self) -> float:
        """How far through the current voxel, for a progress bar."""
        if self.target is None:
            return 0.0
        return min(
            1.0,
            self.progress.get(self.target, 0.0) / max(1e-6, self.policy.seconds_per_voxel),
        )


def fill_in(world: VoxelWorld, lo: tuple[int, int, int], hi: tuple[int, int, int]) -> int:
    """Loose voxels standing in a box.  How much shovelling is left."""
    block = world.v[lo[0] : hi[0], lo[1] : hi[1], lo[2] : hi[2]]
    return int(voxel.LOOSE[block].sum())


__all__ = ["DigPolicy", "EntrenchingTool", "fill_in"]
