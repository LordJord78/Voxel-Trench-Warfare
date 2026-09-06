"""Voxel carving primitives.

Shared by generation and by runtime destruction, so a shell crater at load time
and a shell crater at tick 40 000 are cut by the same code.
"""

from __future__ import annotations

import numpy as np

from ..core.rng import GameRandom
from . import voxel


def clamp_box(
    shape: tuple[int, int, int],
    lo: tuple[int, int, int],
    hi: tuple[int, int, int],
) -> tuple[slice, slice, slice] | None:
    """Clip an inclusive-exclusive box to the array; None if it misses."""
    slices: list[slice] = []
    for axis in range(3):
        a = max(0, int(lo[axis]))
        b = min(shape[axis], int(hi[axis]))
        if a >= b:
            return None
        slices.append(slice(a, b))
    return (slices[0], slices[1], slices[2])


def fill_box(
    v: np.ndarray,
    lo: tuple[int, int, int],
    hi: tuple[int, int, int],
    material: int,
) -> None:
    box = clamp_box(v.shape, lo, hi)
    if box is not None:
        v[box] = material


def fill_box_where_air(
    v: np.ndarray,
    lo: tuple[int, int, int],
    hi: tuple[int, int, int],
    material: int,
) -> None:
    box = clamp_box(v.shape, lo, hi)
    if box is not None:
        region = v[box]
        region[region == voxel.AIR] = material


def _irregular_radius_field(
    rng: GameRandom, extent: int, radius: float, roughness: float
) -> np.ndarray:
    """A radius perturbation field, so craters do not look like billiard balls."""
    n = max(2, extent // 3)
    coarse = rng.numpy.normal(0.0, 1.0, size=(n, n, n))
    idx = np.linspace(0, n - 1, extent)
    i0 = np.floor(idx).astype(np.int32)
    i1 = np.minimum(i0 + 1, n - 1)
    f = idx - i0
    f = f * f * (3.0 - 2.0 * f)

    def lerp_axis(a: np.ndarray, axis: int) -> np.ndarray:
        lo = np.take(a, i0, axis=axis)
        hi = np.take(a, i1, axis=axis)
        shape = [1, 1, 1]
        shape[axis] = extent
        w = f.reshape(shape)
        return lo * (1.0 - w) + hi * w

    field = coarse
    for axis in range(3):
        field = lerp_axis(field, axis)
    return (field * (roughness * radius)).astype(np.float32)


def carve_sphere(
    v: np.ndarray,
    centre: tuple[float, float, float],
    radius: float,
    rng: GameRandom,
    *,
    material: int = voxel.AIR,
    roughness: float = 0.16,
    protect: np.ndarray | None = None,
) -> tuple[tuple[int, int, int], tuple[int, int, int]] | None:
    """Carve an irregular sphere.  Returns the affected voxel box, or None.

    `protect` is an optional boolean lookup over materials that must survive
    (used so concrete resists a light charge).
    """
    r_out = radius + roughness * radius + 1.0
    lo = (
        int(np.floor(centre[0] - r_out)),
        int(np.floor(centre[1] - r_out)),
        int(np.floor(centre[2] - r_out)),
    )
    hi = (
        int(np.ceil(centre[0] + r_out)) + 1,
        int(np.ceil(centre[1] + r_out)) + 1,
        int(np.ceil(centre[2] + r_out)) + 1,
    )
    box = clamp_box(v.shape, lo, hi)
    if box is None:
        return None

    xs = np.arange(box[0].start, box[0].stop, dtype=np.float32) + 0.5 - centre[0]
    ys = np.arange(box[1].start, box[1].stop, dtype=np.float32) + 0.5 - centre[1]
    zs = np.arange(box[2].start, box[2].stop, dtype=np.float32) + 0.5 - centre[2]
    dist = np.sqrt(
        xs[:, None, None] ** 2 + ys[None, :, None] ** 2 + zs[None, None, :] ** 2
    )

    extent = max(dist.shape)
    wobble = _irregular_radius_field(rng, extent, radius, roughness)
    wobble = wobble[: dist.shape[0], : dist.shape[1], : dist.shape[2]]

    inside = dist < (radius + wobble)
    if protect is not None:
        inside &= ~protect[v[box]]
    region = v[box]
    region[inside] = material
    return (
        (box[0].start, box[1].start, box[2].start),
        (box[0].stop, box[1].stop, box[2].stop),
    )


def value_noise_2d(
    rng: GameRandom, shape: tuple[int, int], cells: int
) -> np.ndarray:
    """Smoothstep-interpolated value noise in [0, 1)."""
    grid = rng.numpy.random((cells + 1, cells + 1)).astype(np.float32)
    return _bilinear(grid, shape)


def _bilinear(grid: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    gh, gw = grid.shape
    ys = np.linspace(0.0, gh - 1, shape[0], dtype=np.float32)
    xs = np.linspace(0.0, gw - 1, shape[1], dtype=np.float32)
    y0 = np.floor(ys).astype(np.int32)
    x0 = np.floor(xs).astype(np.int32)
    y1 = np.minimum(y0 + 1, gh - 1)
    x1 = np.minimum(x0 + 1, gw - 1)
    fy = (ys - y0)[:, None]
    fx = (xs - x0)[None, :]
    fy = fy * fy * (3.0 - 2.0 * fy)
    fx = fx * fx * (3.0 - 2.0 * fx)
    top = grid[np.ix_(y0, x0)] * (1 - fx) + grid[np.ix_(y0, x1)] * fx
    bot = grid[np.ix_(y1, x0)] * (1 - fx) + grid[np.ix_(y1, x1)] * fx
    return top * (1 - fy) + bot * fy


def fbm_2d(
    rng: GameRandom,
    shape: tuple[int, int],
    octaves: int = 4,
    base_cells: int = 4,
    persistence: float = 0.5,
) -> np.ndarray:
    """Fractal value noise, normalised to [0, 1]."""
    total = np.zeros(shape, dtype=np.float32)
    amplitude = 1.0
    norm = 0.0
    for octave in range(octaves):
        cells = base_cells * (2**octave)
        total += value_noise_2d(rng, shape, cells) * amplitude
        norm += amplitude
        amplitude *= persistence
    total /= norm
    lo, hi = float(total.min()), float(total.max())
    if hi - lo < 1e-6:
        return np.zeros(shape, dtype=np.float32)
    return (total - lo) / (hi - lo)
