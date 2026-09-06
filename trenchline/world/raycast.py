"""Voxel ray marching (Amanatides & Woo DDA).

Used for line of sight, for the observation layer, and from milestone 2 for
ballistics.  Exact and branch-free enough to be deterministic.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..physics.vec import Vec3
from . import voxel
from .chunks import VoxelWorld


@dataclass(frozen=True, slots=True)
class RayHit:
    voxel: tuple[int, int, int]
    material: int
    distance: float
    normal: tuple[int, int, int]
    point: Vec3

    @property
    def position(self) -> Vec3:
        return self.point


def _step_setup(origin: float, direction: float, size: float) -> tuple[int, int, float, float]:
    cell = math.floor(origin / size)
    if direction > 1e-12:
        step = 1
        t_max = ((cell + 1) * size - origin) / direction
        t_delta = size / direction
    elif direction < -1e-12:
        step = -1
        t_max = (cell * size - origin) / direction
        t_delta = -size / direction
    else:
        step = 0
        t_max = math.inf
        t_delta = math.inf
    return cell, step, t_max, t_delta


def raycast(
    world: VoxelWorld,
    origin: Vec3,
    direction: Vec3,
    max_distance: float,
    *,
    blocker=None,
) -> RayHit | None:
    """March until `blocker` says stop.  Default blocker is anything solid."""
    if blocker is None:
        blocker = voxel.SOLID
    d = direction.normalised()
    if d.length_sq < 0.5:
        return None
    size = voxel.VOXEL_SIZE

    x, sx, tmx, tdx = _step_setup(origin.x, d.x, size)
    y, sy, tmy, tdy = _step_setup(origin.y, d.y, size)
    z, sz, tmz, tdz = _step_setup(origin.z, d.z, size)

    t = 0.0
    normal = (0, 0, 0)
    # A generous but finite cap: the map diagonal in voxels.
    limit = int(max_distance / size) + 3
    for _ in range(limit):
        material = world.get(x, y, z)
        if blocker[material]:
            return RayHit(
                voxel=(x, y, z),
                material=material,
                distance=t,
                normal=normal,
                point=origin + d * t,
            )
        if tmx < tmy:
            if tmx < tmz:
                t, x, normal = tmx, x + sx, (-sx, 0, 0)
                tmx += tdx
            else:
                t, z, normal = tmz, z + sz, (0, 0, -sz)
                tmz += tdz
        else:
            if tmy < tmz:
                t, y, normal = tmy, y + sy, (0, -sy, 0)
                tmy += tdy
            else:
                t, z, normal = tmz, z + sz, (0, 0, -sz)
                tmz += tdz
        if t > max_distance:
            return None
    return None


def line_of_sight(
    world: VoxelWorld, from_point: Vec3, to_point: Vec3, *, blocker=None
) -> bool:
    """True if nothing solid stands between two points."""
    delta = to_point - from_point
    distance = delta.length
    if distance < 1e-6:
        return True
    hit = raycast(world, from_point, delta, distance - 1e-3, blocker=blocker)
    return hit is None
