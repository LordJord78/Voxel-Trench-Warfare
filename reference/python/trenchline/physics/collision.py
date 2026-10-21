"""Axis-aligned collision against the voxel grid."""

from __future__ import annotations

import math

from ..world import voxel
from ..world.chunks import VoxelWorld
from .vec import Vec3

_EPS = 1e-4


def box_hits_solid(
    world: VoxelWorld,
    centre: Vec3,
    half_x: float,
    height: float,
    *,
    half_z: float | None = None,
) -> bool:
    """Does an upright box standing on `centre` overlap any solid voxel?

    `centre` is the box's foot centre.  This slices the padded store directly,
    so out-of-bounds reads hit the solid skirt and the player cannot leave the
    map.
    """
    hz = half_x if half_z is None else half_z
    s = voxel.VOXEL_SIZE
    x0 = math.floor((centre.x - half_x + _EPS) / s)
    x1 = math.floor((centre.x + half_x - _EPS) / s) + 1
    y0 = math.floor((centre.y + _EPS) / s)
    y1 = math.floor((centre.y + height - _EPS) / s) + 1
    z0 = math.floor((centre.z - hz + _EPS) / s)
    z1 = math.floor((centre.z + hz - _EPS) / s) + 1

    store = world._store  # noqa: SLF001 - deliberate hot-path access
    sx, sy, sz = store.shape
    # +1 converts world voxel coords into padded-store coords.
    ax0 = min(max(x0 + 1, 0), sx)
    ax1 = min(max(x1 + 1, 0), sx)
    ay0 = min(max(y0 + 1, 0), sy)
    ay1 = min(max(y1 + 1, 0), sy)
    az0 = min(max(z0 + 1, 0), sz)
    az1 = min(max(z1 + 1, 0), sz)
    if ax0 >= ax1 or ay0 >= ay1 or az0 >= az1:
        return True  # entirely outside the store: treat as solid
    block = store[ax0:ax1, ay0:ay1, az0:az1]
    return bool(voxel.SOLID[block].any())


def ground_height_under(
    world: VoxelWorld, centre: Vec3, half_x: float, max_drop: float
) -> float | None:
    """Top surface of the first solid voxel below `centre`, or None."""
    s = voxel.VOXEL_SIZE
    steps = int(max_drop / s) + 2
    y = math.floor((centre.y - _EPS) / s)
    for _ in range(steps):
        probe = Vec3(centre.x, y * s, centre.z)
        if box_hits_solid(world, probe, half_x, s * 0.5):
            return (y + 1) * s
        y -= 1
        if y < -1:
            return None
    return None


def support_is(
    world: VoxelWorld, centre: Vec3, half_x: float, material: int
) -> bool:
    """Is any of what the body is standing on made of `material`?

    Sampling the single voxel under the body's centre is not the same question:
    a man with one boot on a firing-step tread and one over the walkway is
    standing on the step, but the voxel under his centre is air.
    """
    s = voxel.VOXEL_SIZE
    x0 = math.floor((centre.x - half_x + _EPS) / s)
    x1 = math.floor((centre.x + half_x - _EPS) / s) + 1
    z0 = math.floor((centre.z - half_x + _EPS) / s)
    z1 = math.floor((centre.z + half_x - _EPS) / s) + 1
    y = math.floor((centre.y - s * 0.5) / s)
    for x in range(x0, x1):
        for z in range(z0, z1):
            if world.get(x, y, z) == material:
                return True
    return False


def submerged_depth(world: VoxelWorld, centre: Vec3, height: float) -> float:
    """How much of an upright body is in water, in metres."""
    s = voxel.VOXEL_SIZE
    depth = 0.0
    y = centre.y + s * 0.5
    while y < centre.y + height:
        if world.material_at(centre.x, y, centre.z) == voxel.WATER:
            depth = y - centre.y
        y += s
    return depth
