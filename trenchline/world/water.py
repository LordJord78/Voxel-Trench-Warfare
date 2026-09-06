"""Standing water.

Water is not simulated as a fluid — it is a state the world settles into.
Anything open below the water table fills; anything left hanging drains.  Both
generation and runtime destruction go through here, so a fresh crater behaves
exactly like one that was there at load.
"""

from __future__ import annotations

import numpy as np

from . import voxel


def flood_below_table(v: np.ndarray, water_table: int) -> None:
    """Fill every open voxel at or below the water table."""
    below = v[:, : water_table + 1, :]
    below[below == voxel.AIR] = voxel.WATER


def settle(v: np.ndarray, max_passes: int = 8) -> int:
    """Drain water that has nothing underneath it.

    Cutting a ditch or a crater through the side of an existing pool leaves
    voxels of water hanging over air.  Returns how many were drained.
    """
    drained = 0
    for _ in range(max_passes):
        water = v == voxel.WATER
        if not water.any():
            break
        supported = np.empty_like(water)
        supported[:, 0, :] = True
        under = v[:, :-1, :]
        supported[:, 1:, :] = voxel.SOLID[under] | (under == voxel.WATER)
        loose = water & ~supported
        if not loose.any():
            break
        drained += int(loose.sum())
        v[loose] = voxel.AIR
    return drained


def flood_region(
    v: np.ndarray,
    water_table: int,
    lo: tuple[int, int, int],
    hi: tuple[int, int, int],
) -> None:
    """Flood-and-settle a single box, for use after a runtime explosion."""
    x0, x1 = max(0, lo[0]), min(v.shape[0], hi[0])
    z0, z1 = max(0, lo[2]), min(v.shape[2], hi[2])
    if x0 >= x1 or z0 >= z1:
        return
    column = v[x0:x1, :, z0:z1]
    flood_below_table(column, water_table)
    settle(column)
