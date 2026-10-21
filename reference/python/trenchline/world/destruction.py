"""Blowing holes in things, and what falls in afterwards.

Two halves that have to happen together.  Carving a sphere out of a trench wall
leaves the spoil above it hanging in mid-air, which is both wrong to look at and
wrong to shoot through; and a crater that does not put its dirt anywhere has
made cover out of nothing.  So every carve is followed by a collapse, and the
dirt lands where it fell — usually in the bottom of the trench.

Soil collapse is two alternating vectorised passes:

*Vertical* — a granular voxel with nothing under it drops one voxel.  A stack
falls one layer per pass, so repeated passes drain a column from the bottom.
Dirt falling into standing water swaps with it rather than deleting it, because
a crater that fills itself in should displace its puddle, not drink it.

*Diagonal* — a **loose** voxel with air both beside it and beneath that drops
sideways-and-down, giving a heap a slope instead of one-voxel towers.  It
settles at roughly 45 degrees, near enough the angle of repose of wet spoil.
Only spoil, rubble and sandbags do this: a ploughed field is full of one-voxel
steps, and undisturbed strata that slide off every one of them erode the whole
map into a plain the first time anything settles.

Both passes are whole-array numpy with a fixed direction order and no
randomness at all, so a collapse is a pure function of the voxels going in.
Runtime destruction and generation call the same code, which is what stops a
crater cut at load behaving differently from one cut at tick 40 000.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..core.rng import GameRandom
from ..data import Tunables
from . import shapes, voxel, water as water_sim
from .chunks import VoxelWorld

# (axis, direction) for the diagonal pass, in a fixed order so a heap settles
# the same way every time.
_LATERAL: tuple[tuple[int, int], ...] = ((0, +1), (0, -1), (2, +1), (2, -1))


@dataclass(slots=True)
class Explosion:
    """What one detonation did, for the renderer and the stats line."""

    centre: tuple[float, float, float]
    radius_m: float
    removed: int = 0
    loosened: int = 0
    collapsed: int = 0
    flooded: int = 0
    box: tuple[tuple[int, int, int], tuple[int, int, int]] | None = None
    materials: dict[int, int] = field(default_factory=dict)


def unsupported(v: np.ndarray) -> np.ndarray:
    """Granular voxels resting on nothing.  True where soil is hanging."""
    out = np.zeros(v.shape, dtype=bool)
    granular = voxel.GRANULAR[v]
    out[:, 1:, :] = granular[:, 1:, :] & ~voxel.SOLID[v[:, :-1, :]]
    return out


def _fall_vertical(block: np.ndarray) -> int:
    """Drop every granular voxel that has nothing solid directly beneath it.

    "Nothing solid" rather than "air": water and wire are both non-solid, and
    both are things soil falls through. Wire is crushed and water is displaced,
    which is the difference between them.
    """
    granular = voxel.GRANULAR[block]
    below = block[:, :-1, :]
    into_water = below == voxel.WATER
    falling = granular[:, 1:, :] & ~voxel.SOLID[below]
    moved = int(falling.sum())
    if not moved:
        return 0
    upper = block[:, 1:, :]
    lower = block[:, :-1, :]
    # Dirt into water swaps, so the puddle is displaced upward instead of being
    # drunk by the soil that fell into it. Dirt onto a picket flattens it.
    swap = falling & into_water
    drop = falling & ~into_water
    lower[drop], upper[drop] = upper[drop], voxel.AIR
    if swap.any():
        sinking = upper[swap].copy()
        upper[swap] = voxel.WATER
        lower[swap] = sinking
    return moved


def _fall_diagonal(block: np.ndarray, axis: int, direction: int) -> int:
    """Slump a *resting* loose voxel one step down and sideways.

    Only material that is already sitting on something moves here. A voxel in
    free fall is the vertical pass's business: deflecting it sideways every
    time it passes an empty ledge makes a single clod of earth wander across
    the map on its way down instead of landing where it was dropped.

    The destination only has to be air. If there is nothing under it either,
    the vertical pass takes it further next round, which is what makes material
    cascade down a slope rather than stopping on the first step.
    """
    if block.shape[axis] < 2 or block.shape[1] < 2:
        return 0
    src: list[slice] = [slice(None)] * 3
    dst: list[slice] = [slice(None)] * 3
    if direction > 0:
        src[axis], dst[axis] = slice(0, -1), slice(1, None)
    else:
        src[axis], dst[axis] = slice(1, None), slice(0, -1)
    src[1], dst[1] = slice(1, None), slice(0, -1)

    under = list(src)
    under[1] = slice(0, -1)

    source = block[tuple(src)]
    destination = block[tuple(dst)]
    movable = (
        voxel.LOOSE[source]
        & (destination == voxel.AIR)
        & voxel.SOLID[block[tuple(under)]]
    )
    moved = int(movable.sum())
    if moved:
        destination[movable] = source[movable]
        source[movable] = voxel.AIR
    return moved


def collapse(block: np.ndarray, max_passes: int = 64, repose: bool = True) -> int:
    """Settle loose soil in `block` until nothing else moves.

    `block` is a view, so this mutates the world in place.  Returns how many
    voxels moved, which is the honest measure of how much was hanging.
    """
    moved_total = 0
    for _ in range(max_passes):
        moved = _fall_vertical(block)
        if repose:
            for axis, direction in _LATERAL:
                moved += _fall_diagonal(block, axis, direction)
        if moved == 0:
            break
        moved_total += moved
    return moved_total


def _region(world: VoxelWorld, lo, hi, pad: int = 2):
    """A clipped view of the world plus a margin, and its voxel bounds."""
    nx, ny, nz = world.v.shape
    x0, y0, z0 = (max(0, lo[i] - pad) for i in range(3))
    x1 = min(nx, hi[0] + pad)
    y1 = min(ny, hi[1] + pad)
    z1 = min(nz, hi[2] + pad)
    if x0 >= x1 or y0 >= y1 or z0 >= z1:
        return None, None, None
    return world.v[x0:x1, y0:y1, z0:z1], (x0, y0, z0), (x1, y1, z1)


def mobile_band(v: np.ndarray) -> tuple[int, int] | None:
    """The y range anything could possibly move within.

    Bedrock and open sky make up most of a 64-voxel-tall world and neither can
    move, so collapsing the whole array wastes most of every pass — and it
    takes about 25 passes to converge, so the waste is 25-fold. The band runs
    from the lowest gap that has granular material somewhere above it (the
    deepest anything could fall to) up to the highest granular voxel. Exact
    rather than a padded guess, because a band one voxel short would leave soil
    resting on the crop boundary.
    """
    granular = voxel.GRANULAR[v]
    if not granular.any():
        return None
    # Subsoil is granular too, so "has granular material" is true of the whole
    # depth of the map and is not the question. The question is whether there
    # is anywhere for it to go: a granular voxel can only ever move if there is
    # a gap strictly below it in its own column.
    gap = ~voxel.SOLID[v]
    gap_below = np.zeros_like(gap)
    np.maximum.accumulate(gap[:, :-1, :], axis=1, out=gap_below[:, 1:, :])
    mobile = granular & gap_below
    if not mobile.any():
        return None

    # The floor of the band is the lowest gap that has mobile soil above it,
    # which is the deepest anything can fall to.
    mobile_above = np.flip(np.maximum.accumulate(np.flip(mobile, axis=1), axis=1), axis=1)
    rows = np.nonzero((gap & mobile_above).any(axis=(0, 2)) | mobile.any(axis=(0, 2)))[0]
    if rows.size == 0:
        return None
    return int(rows[0]), int(rows[-1]) + 1


def settle_world(world: VoxelWorld, max_passes: int = 64, rounds: int = 6) -> int:
    """Collapse everything.  Used once at generation, after the craters.

    Soil and water settle against each other, so they settle together. Dirt
    falling into a pool displaces it upward; the displaced water then drains
    off anything it is left hanging over; and draining it can leave soil that
    was resting on that water with nothing underneath. Running the two once
    each in sequence leaves a handful of voxels in mid-air, so they share a
    loop and it runs until neither has anything left to do.

    The band is re-derived each round rather than trusted once, for the same
    reason: a diagonal slide moves soil out of one column into another, which
    can open a gap under material that had solid ground beneath it when the
    band was first measured.
    """
    total = 0
    for _ in range(rounds):
        band = mobile_band(world.v)
        if band is None:
            break
        y0, y1 = band
        moved = collapse(world.v[:, y0:y1, :], max_passes=max_passes)
        water_sim.flood_below_table(world.v, world.water_table)
        moved += water_sim.settle(world.v)
        total += moved
        if moved == 0 or not unsupported(world.v).any():
            break
    if total:
        world.mark_all_dirty()
    return total


def detonate(
    world: VoxelWorld,
    centre: tuple[float, float, float],
    radius_m: float,
    rng: GameRandom,
    tun: Tunables,
) -> Explosion:
    """Cut a crater in metres, loosen its rim, collapse it and let it flood."""
    s = voxel.VOXEL_SIZE
    result = Explosion(centre=centre, radius_m=radius_m)
    radius = radius_m / s
    if radius <= 0.0:
        return result

    voxel_centre = (centre[0] / s, centre[1] / s, centre[2] / s)
    hard_limit = tun.f("destruction.resists_above_hardness")
    resists = voxel.HARDNESS > hard_limit
    loosen = tun.f("destruction.loosen_radius_scale")
    core = tun.f("destruction.core_radius_scale")

    # Everything this shell can reach: the crater, the loosened rim, and enough
    # room under both for the dirt to fall into. Copied once so the chunks that
    # actually changed can be told apart from the chunks that were merely
    # nearby — the difference is the whole cost of the rebuild queue.
    reach = radius * max(loosen, 1.0) + 2.0
    fall = radius * 2.0 + 4.0
    lo = (
        int(np.floor(voxel_centre[0] - reach)),
        int(np.floor(voxel_centre[1] - fall)),
        int(np.floor(voxel_centre[2] - reach)),
    )
    hi = (
        int(np.ceil(voxel_centre[0] + reach)) + 1,
        int(np.ceil(voxel_centre[1] + reach)) + 1,
        int(np.ceil(voxel_centre[2] + reach)) + 1,
    )
    view, lo, hi = _region(world, lo, hi, pad=0)
    if view is None:
        return result
    before = view.copy()

    # Soft ground goes out to the full radius; concrete and masonry only give
    # way near the centre, where the pressure is.
    if shapes.carve_sphere(world.v, voxel_centre, radius, rng, protect=resists) is None:
        return result
    shapes.carve_sphere(world.v, voxel_centre, radius * core, rng)

    # A rind of ground around the hole is shaken loose rather than removed. It
    # is what actually falls in, and it is why a near miss on a parapet costs
    # you cover even where it did not break through.
    result.loosened = _loosen_rim(world.v, voxel_centre, radius * loosen, radius)
    result.collapsed = collapse(view)
    water_sim.flood_region(world.v, world.water_table, lo, hi)

    changed = view != before
    if not changed.any():
        return result
    result.removed = int((changed & (view == voxel.AIR)).sum())
    result.flooded = int((changed & (view == voxel.WATER)).sum())
    materials, counts = np.unique(before[changed], return_counts=True)
    result.materials = {int(m): int(c) for m, c in zip(materials, counts)}

    # Dirty the chunks that changed, not the chunks that were in the
    # neighbourhood. Padding this by the search radius queued around a hundred
    # chunks per shell, most of them identical to what was already on the GPU,
    # and no rebuild budget can outrun that.
    axes = [np.nonzero(changed.any(axis=tuple(a for a in range(3) if a != i)))[0]
            for i in range(3)]
    tight_lo = tuple(lo[i] + int(axes[i][0]) for i in range(3))
    tight_hi = tuple(lo[i] + int(axes[i][-1]) for i in range(3))
    world.mark_region_dirty(tight_lo, tight_hi)
    result.box = (tight_lo, tuple(v + 1 for v in tight_hi))
    return result


def _loosen_rim(
    v: np.ndarray, centre: tuple[float, float, float], outer: float, inner: float
) -> int:
    """Turn intact ground just outside the crater into loose spoil."""
    lo = tuple(int(np.floor(centre[i] - outer)) for i in range(3))
    hi = tuple(int(np.ceil(centre[i] + outer)) + 1 for i in range(3))
    box = shapes.clamp_box(v.shape, lo, hi)
    if box is None:
        return 0
    grids = [
        np.arange(box[i].start, box[i].stop, dtype=np.float32) + 0.5 - centre[i]
        for i in range(3)
    ]
    d2 = (
        grids[0][:, None, None] ** 2
        + grids[1][None, :, None] ** 2
        + grids[2][None, None, :] ** 2
    )
    region = v[box]
    shell = (d2 >= inner * inner) & (d2 < outer * outer) & (region != voxel.AIR)
    if not shell.any():
        return 0
    region[shell] = voxel.SPOIL_OF[region[shell]]
    return int(shell.sum())


def chip(
    world: VoxelWorld, impact, tun: Tunables
) -> bool:
    """A single round's mark.  Soft ground gives, concrete does not.

    Small on purpose: a rifle round should scar a parapet over a magazine, not
    dig through it. Whether the voxel goes depends on the energy left in the
    round against the material's hardness, so range matters.
    """
    x, y, z = impact.voxel
    material = world.get(x, y, z)
    hardness = float(voxel.HARDNESS[material])
    if hardness <= 0.0:
        return False
    threshold = tun.f("destruction.chip_energy_j") * hardness
    if impact.energy_j < threshold:
        return False
    world.set(x, y, z, int(voxel.SPOIL_OF[material]))
    return True


__all__ = [
    "Explosion", "collapse", "unsupported", "detonate", "settle_world", "chip",
]
