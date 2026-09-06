"""Procedural generation of the battlefield.

Everything here is driven by an injected `GameRandom`, split into named
sub-streams, so the same seed always produces the same ground.  No engine
imports: generation runs identically headless.

Layout, looking from the friendly rear (-z) toward the enemy (+z):

    z=0    ......... friendly rear
    z=40   ===[ SUPPORT LINE ]===
             |    |                 two communication trenches
    z=84   ===[ FRONT LINE ]===     firing steps, dugouts, parapet
    z=84..186  no man's land        craters, wire, wreckage
    z=186  ===[ ENEMY FRONT ]===
    z=226  ===[ ENEMY SUPPORT ]===
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..core.rng import GameRandom
from ..data import Tunables
from . import shapes, voxel, water as water_sim
from .chunks import VoxelWorld, WorldDims
from .trenchmap import Bay, Dugout, TrenchGraph, TrenchLine, TrenchNetwork

MAP_NAME: str = "SUKHYI YAR"
"""Fictional map name.  A dry ravine between two fields; nothing more."""


@dataclass(slots=True)
class GeneratedWorld:
    world: VoxelWorld
    network: TrenchNetwork
    surface: np.ndarray
    """Pre-battle ground height per (x, z) column, in voxels."""
    spawn: tuple[float, float, float]
    name: str = MAP_NAME
    craters: tuple[tuple[int, int, int, float], ...] = ()
    landmarks: dict[str, tuple[float, float, float]] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _supported(v: np.ndarray, xs: np.ndarray, base: np.ndarray, zs: np.ndarray) -> np.ndarray:
    """Columns whose heightmap entry still sits on solid ground.

    `surface` is the *pre-excavation* heightmap.  Once a trench, dugout or
    crater has been cut, some of those columns are open air, and piling spoil
    onto them leaves slabs hanging over the walkway.  Anything that heaps
    material has to ask this first.
    """
    ny = v.shape[1]
    below = np.clip(base - 1, 0, ny - 1)
    return voxel.SOLID[v[xs, below, zs]] & (v[xs, np.clip(base, 0, ny - 1), zs] == voxel.AIR)


def _pile(
    v: np.ndarray,
    surface: np.ndarray,
    mask: np.ndarray,
    height: int,
    material: int,
) -> None:
    """Heap `height` voxels of `material` on top of every masked column."""
    if height <= 0 or not mask.any():
        return
    xs, zs = np.nonzero(mask)
    base = surface[xs, zs]
    ok = _supported(v, xs, base, zs)
    xs, zs, base = xs[ok], zs[ok], base[ok]
    ny = v.shape[1]
    for layer in range(height):
        ys = np.clip(base + layer, 0, ny - 1)
        keep = v[xs, ys, zs] == voxel.AIR
        v[xs[keep], ys[keep], zs[keep]] = material


# ---------------------------------------------------------------------------
# strata
# ---------------------------------------------------------------------------


def _lay_strata(v: np.ndarray, surface: np.ndarray) -> None:
    """Fill the world from a heightmap: sod, mud, clay, subsoil."""
    ny = v.shape[1]
    ys = np.arange(ny, dtype=np.int32)[None, :, None]
    depth = surface[:, None, :] - ys  # 1 at the top solid voxel, <=0 in air
    v[:] = np.where(
        depth <= 0,
        np.uint8(voxel.AIR),
        np.where(
            depth == 1,
            np.uint8(voxel.SOD),
            np.where(
                depth <= 3,
                np.uint8(voxel.MUD),
                np.where(depth <= 8, np.uint8(voxel.CLAY), np.uint8(voxel.SUBSOIL)),
            ),
        ),
    ).astype(np.uint8)


def _plough_stripes(v: np.ndarray, surface: np.ndarray, rng: GameRandom) -> None:
    """Alternate the top voxel between sod and turned mud: ploughed fields."""
    nx, _, nz = v.shape
    period = 7
    phase = rng.randint(0, period)
    stripe = ((np.arange(nz) + phase) // period) % 2 == 0
    xs, zs = np.nonzero(np.broadcast_to(stripe[None, :], (nx, nz)))
    ys = np.clip(surface[xs, zs] - 1, 0, v.shape[1] - 1)
    keep = v[xs, ys, zs] == voxel.SOD
    v[xs[keep], ys[keep], zs[keep]] = voxel.MUD


# ---------------------------------------------------------------------------
# trenches
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _LineSpec:
    name: str
    side: int
    long_axis: int
    """0 if the trench runs along x, 2 if along z."""
    cross_base: int
    a_start: int
    a_end: int
    floor_y: int
    facing: int
    firing_steps: bool
    dugout_every: int


def _pile_to(
    v: np.ndarray,
    surface: np.ndarray,
    target: np.ndarray,
    material: int,
) -> None:
    """Fill each column from its ground surface up to an absolute target y.

    Used for parapets: the crest is levelled per bay rather than following the
    ground, because a parapet you cannot see over from the firing step is not a
    parapet, it is a wall.
    """
    mask = target > 0
    if not mask.any():
        return
    xs, zs = np.nonzero(mask)
    base = surface[xs, zs]
    ok = _supported(v, xs, base, zs)
    if not ok.any():
        return
    xs, zs, base = xs[ok], zs[ok], base[ok]
    tops = target[xs, zs]
    ny = v.shape[1]
    span = int((tops - base).max())
    for layer in range(max(0, span)):
        ys = base + layer
        sel = (ys < tops) & (ys >= 0) & (ys < ny)
        if not sel.any():
            continue
        x2, y2, z2 = xs[sel], ys[sel], zs[sel]
        air = v[x2, y2, z2] == voxel.AIR
        v[x2[air], y2[air], z2[air]] = material


def _carve_trench_line(
    v: np.ndarray,
    surface: np.ndarray,
    rng: GameRandom,
    spec: _LineSpec,
    tun: Tunables,
    graph: TrenchGraph,
) -> tuple[TrenchLine, list[Dugout]]:
    """Cut one crenellated trench, its parapet, its dugouts.

    Each bay's floor is set from the ground directly above it, so the trench is
    a constant depth rather than a level cut through rolling ground.  Adjacent
    bays are clamped to within one voxel of each other so the duckboards step
    rather than drop.
    """
    vs = tun.f("world.voxel_size")
    width = tun.i("world.trench.width_voxels")
    depth = tun.i("world.trench.depth_voxels")
    step_h = tun.i("world.trench.firing_step_height")
    parapet_h = tun.i("world.trench.parapet_height")
    parados_h = tun.i("world.trench.parados_height")
    bay_len = max(4, int(round(tun.f("world.trench.bay_length_m") / vs)))
    offset = width + max(2, int(round(tun.f("world.trench.traverse_offset_m") / vs)) - 2)
    leg = 3

    nx, ny, nz = v.shape
    long_axis = spec.long_axis
    footprint = np.zeros((nx, nz), dtype=bool)
    parapet_target = np.zeros((nx, nz), dtype=np.int32)
    parados_target = np.zeros((nx, nz), dtype=np.int32)

    def to_box(a0: int, a1: int, b0: int, b1: int) -> tuple[int, int, int, int]:
        """(x0, x1, z0, z1) for an along/cross rectangle."""
        return (a0, a1, b0, b1) if long_axis == 0 else (b0, b1, a0, a1)

    def clear(a0: int, a1: int, b0: int, b1: int, y0: int, y1: int) -> None:
        x0, x1, z0, z1 = to_box(a0, a1, b0, b1)
        shapes.fill_box(v, (x0, y0, z0), (x1, y1, z1), voxel.AIR)
        footprint[max(0, x0) : max(0, x1), max(0, z0) : max(0, z1)] = True

    def slab(a0: int, a1: int, b0: int, b1: int, y0: int, y1: int, material: int) -> None:
        x0, x1, z0, z1 = to_box(a0, a1, b0, b1)
        shapes.fill_box(v, (x0, y0, z0), (x1, y1, z1), material)

    def local_surface(a0: int, a1: int, b0: int, b1: int) -> int:
        x0, x1, z0, z1 = to_box(a0, a1, b0, b1)
        patch = surface[max(0, x0) : x1, max(0, z0) : z1]
        return int(np.median(patch)) if patch.size else int(np.median(surface))

    bays: list[Bay] = []
    dugouts: list[Dugout] = []
    prev_node: int | None = None
    prev_floor: int | None = None

    index = 0
    a = spec.a_start
    while a < spec.a_end:
        a1 = min(a + bay_len, spec.a_end)
        b0 = spec.cross_base + (offset if index % 2 else 0)
        b1 = b0 + width

        ground_here = local_surface(a, a1, b0, b1)
        floor_y = ground_here - depth
        if prev_floor is not None:
            floor_y = max(prev_floor - 1, min(prev_floor + 1, floor_y))
        floor_y = max(3, min(floor_y, ny - depth - 4))
        top = ground_here + parapet_h + 2

        clear(a, a1, b0, b1, floor_y + 1, top)
        slab(a, a1, b0, b1, floor_y, floor_y + 1, voxel.DUCKBOARD)

        step_b = b1 - 1 if spec.facing > 0 else b0
        step_top = floor_y + 1 + step_h
        if spec.firing_steps:
            # A staircase, not a wall: one half-metre tread per voxel of rise,
            # descending away from the parapet. Player step-up is 0.55 m, so a
            # solid block of this height would simply be unclimbable.
            inward = -1 if spec.facing > 0 else 1
            for tread in range(step_h):
                b = step_b + inward * tread
                slab(a, a1, b, b + 1, floor_y + 1, step_top - tread, voxel.TIMBER)

        bx0, bx1, bz0, bz1 = to_box(a, a1, b0, b1)
        step_x0, step_x1, step_z0, step_z1 = to_box(a, a1, step_b, step_b + 1)
        # Centre of the clear walkway, with the firing step's column removed.
        if spec.firing_steps:
            # Exclude every tread column from the walkway centre.
            walk_b = (
                (b0 + b1 - step_h) * 0.5 if spec.facing > 0 else (b0 + step_h + b1) * 0.5
            )
        else:
            walk_b = (b0 + b1) * 0.5
        walk_a = (a + a1) * 0.5
        walk_x, walk_z = (walk_a, walk_b) if long_axis == 0 else (walk_b, walk_a)
        bays.append(
            Bay(
                line=spec.name,
                index=index,
                x0=bx0,
                x1=bx1,
                z0=bz0,
                z1=bz1,
                floor_y=floor_y,
                facing=spec.facing,
                step_z=step_z0 if long_axis == 0 else step_x0,
                step_top_y=step_top if spec.firing_steps else floor_y + 1,
                walk_x=walk_x,
                walk_z=walk_z,
            )
        )

        node = graph.add_node((int(walk_x), floor_y + 1, int(walk_z)))
        if prev_node is not None:
            graph.link(prev_node, node)
        prev_node = node

        # Parapet on the exposed side, parados behind, both levelled to this
        # bay's floor so the firing step keeps its exact relationship to the
        # crest regardless of what the ground is doing.
        crest = floor_y + depth + parapet_h
        back_crest = floor_y + depth + parados_h
        if spec.facing > 0:
            front_lo, front_hi = b1, b1 + 3
            back_lo, back_hi = b0 - 2, b0
        else:
            front_lo, front_hi = b0 - 3, b0
            back_lo, back_hi = b1, b1 + 2
        fx0, fx1, fz0, fz1 = to_box(a, a1 + leg, front_lo, front_hi)
        parapet_target[max(0, fx0) : fx1, max(0, fz0) : fz1] = crest
        kx0, kx1, kz0, kz1 = to_box(a, a1 + leg, back_lo, back_hi)
        parados_target[max(0, kx0) : kx1, max(0, kz0) : kz1] = back_crest

        if a1 < spec.a_end:
            nb0 = spec.cross_base + (0 if index % 2 else offset)
            lo_b, hi_b = min(b0, nb0), max(b1, nb0 + width)
            clear(a1, a1 + leg, lo_b, hi_b, floor_y + 1, top)
            slab(a1, a1 + leg, lo_b, hi_b, floor_y, floor_y + 1, voxel.DUCKBOARD)

        if spec.dugout_every and index % spec.dugout_every == 1:
            dug = _carve_dugout(v, surface, spec, floor_y, bx0, bx1, bz0, bz1, tun)
            if dug is not None:
                dugouts.append(dug)

        a = a1 + leg
        prev_floor = floor_y
        index += 1

    parapet_target[footprint] = 0
    parados_target[footprint] = 0
    parados_target[parapet_target > 0] = 0
    _pile_to(v, surface, parapet_target, voxel.SPOIL)
    _pile_to(v, surface, parados_target, voxel.SPOIL)

    # Sandbag courses along the crest, in short runs rather than everywhere.
    xs, zs = np.nonzero(parapet_target > 0)
    if xs.size:
        pick = rng.numpy.random(xs.size) < 0.28
        ys = np.clip(parapet_target[xs, zs] - 1, 0, ny - 1)
        sel = v[xs[pick], ys[pick], zs[pick]] == voxel.SPOIL
        px, py, pz = xs[pick][sel], ys[pick][sel], zs[pick][sel]
        v[px, py, pz] = voxel.SANDBAG

    line = TrenchLine(
        name=spec.name,
        side=spec.side,
        floor_y=bays[0].floor_y if bays else 0,
        facing=spec.facing,
        bays=tuple(bays),
    )
    return line, dugouts


def _carve_dugout(
    v: np.ndarray,
    surface: np.ndarray,
    spec: _LineSpec,
    floor_y: int,
    bx0: int,
    bx1: int,
    bz0: int,
    bz1: int,
    tun: Tunables,
) -> Dugout | None:
    """Sink a covered chamber off the sheltered side of a bay.

    Dug as deep as the water table allows and no deeper.  Where the ground is
    wet it becomes cut-and-cover — level with the duckboards, protected by a
    heavier burster course on top instead of by depth.  Either way the roof is
    solid, which is what stops a drone seeing in, and there is exactly one way
    out, which is what makes it a trap.
    """
    nx, ny, nz = v.shape
    water = tun.i("world.water_table")

    if spec.long_axis == 0:
        away = -spec.facing
        if away < 0:
            c_z0, c_z1 = bz0 - 7, bz0 - 2
            ent_z0, ent_z1 = bz0 - 2, bz0
            near_first = True
        else:
            c_z0, c_z1 = bz1 + 2, bz1 + 7
            ent_z0, ent_z1 = bz1, bz1 + 2
            near_first = False
        cx = (bx0 + bx1) // 2
        c_x0, c_x1 = cx - 3, cx + 3
        ent_x0, ent_x1 = cx - 1, cx + 1
    else:
        c_x0, c_x1 = bx0 - 7, bx0 - 2
        ent_x0, ent_x1 = bx0 - 2, bx0
        cz = (bz0 + bz1) // 2
        c_z0, c_z1 = cz - 3, cz + 3
        ent_z0, ent_z1 = cz - 1, cz + 1
        near_first = True

    if c_x0 < 1 or c_x1 >= nx - 1 or c_z0 < 1 or c_z1 >= nz - 1:
        return None

    dug_floor = max(floor_y - 2, water + 1)
    drop = floor_y - dug_floor
    if drop < 0 or dug_floor < 2:
        return None
    air_y0 = dug_floor + 1
    air_y1 = air_y0 + 4  # 2.0 m of headroom

    # Chamber
    shapes.fill_box(v, (c_x0, air_y0, c_z0), (c_x1, air_y1, c_z1), voxel.AIR)
    shapes.fill_box(v, (c_x0, dug_floor, c_z0), (c_x1, dug_floor + 1, c_z1), voxel.DUCKBOARD)
    shapes.fill_box(v, (c_x0, air_y1, c_z0), (c_x1, air_y1 + 1, c_z1), voxel.TIMBER)
    shapes.fill_box(v, (c_x0, air_y1 + 1, c_z0), (c_x1, air_y1 + 2, c_z1), voxel.CORRUGATE)

    # Entrance passage: clear from the duckboards down to the chamber floor.
    shapes.fill_box(v, (ent_x0, air_y0, ent_z0), (ent_x1, min(ny, floor_y + 4), ent_z1), voxel.AIR)
    shapes.fill_box(v, (ent_x0, dug_floor, ent_z0), (ent_x1, dug_floor + 1, ent_z1), voxel.DUCKBOARD)
    shapes.fill_box(v, (ent_x0, air_y1, ent_z0), (ent_x1, air_y1 + 1, ent_z1), voxel.TIMBER)

    # One timber step per half-metre of drop, walking in from the trench.
    if spec.long_axis == 0:
        passage = [ent_z0, ent_z1 - 1] if not near_first else [ent_z1 - 1, ent_z0]
        for k in range(drop):
            zk = passage[min(k, len(passage) - 1)]
            shapes.fill_box(
                v, (ent_x0, floor_y - 1 - k, zk), (ent_x1, floor_y - k, zk + 1), voxel.TIMBER
            )
    else:
        passage = [ent_x1 - 1, ent_x0]
        for k in range(drop):
            xk = passage[min(k, len(passage) - 1)]
            shapes.fill_box(
                v, (xk, floor_y - 1 - k, ent_z0), (xk + 1, floor_y - k, ent_z1), voxel.TIMBER
            )

    # Burster course: spoil heaped until there is at least 1.0 m over the roof.
    target = np.zeros((nx, nz), dtype=np.int32)
    target[c_x0:c_x1, c_z0:c_z1] = air_y1 + 4
    _pile_to(v, surface, target, voxel.SPOIL)

    return Dugout(
        line=spec.name,
        lo=(c_x0, air_y0, c_z0),
        hi=(c_x1, air_y1, c_z1),
        entrance=((ent_x0 + ent_x1) // 2, air_y0, (ent_z0 + ent_z1) // 2),
    )


# ---------------------------------------------------------------------------
# landscape features
# ---------------------------------------------------------------------------


def _drainage_ditches(
    v: np.ndarray, surface: np.ndarray, rng: GameRandom, tun: Tunables
) -> None:
    nx, ny, nz = v.shape
    water = tun.i("world.water_table")
    for _ in range(3):
        z = rng.randint(8, nz - 8)
        drift = rng.uniform(-0.03, 0.03)
        for x in range(2, nx - 2):
            zc = int(z + drift * (x - nx / 2))
            if not (2 <= zc < nz - 2):
                continue
            top = int(surface[x, zc])
            shapes.fill_box(v, (x, top - 3, zc - 1), (x + 1, top + 1, zc + 2), voxel.AIR)
            # Runoff in the bottom of the cut. Perched above the regional
            # water table, which is what a field drain is for; the settle pass
            # drains any of it left hanging over a lower neighbour.
            shapes.fill_box(v, (x, top - 3, zc - 1), (x + 1, top - 2, zc + 2), voxel.WATER)
            surface[x, max(0, zc - 1) : zc + 2] = top - 3


def _shelterbelt(
    v: np.ndarray, surface: np.ndarray, rng: GameRandom, z_centre: int
) -> None:
    """A shattered windbreak: the long thin treelines between fields."""
    nx, ny, nz = v.shape
    rows = (z_centre - 2, z_centre + 2)
    x = 2
    while x < nx - 3:
        x += rng.randint(2, 6)
        if x >= nx - 3:
            break
        z = rng.choice(rows) + rng.randint(-1, 2)
        if not (2 <= z < nz - 2):
            continue
        base = int(surface[x, z])
        # Most of the belt is shattered stumps; a few trunks still stand.
        if rng.chance(0.62):
            height = rng.randint(2, 6)
        else:
            height = rng.randint(7, 15)
        shapes.fill_box(v, (x, base, z), (x + 1, base + height, z + 1), voxel.TRUNK)
        if rng.chance(0.55):
            shapes.fill_box(
                v, (x + 1, base, z), (x + 2, base + max(1, height - 3), z + 1), voxel.TRUNK
            )
        # Fallen timber and splinter debris around the base.
        for _ in range(rng.randint(1, 4)):
            dx = rng.randint(-3, 4)
            dz = rng.randint(-2, 3)
            fx, fz = x + dx, z + dz
            if 0 <= fx < nx and 0 <= fz < nz:
                fy = int(surface[fx, fz])
                if v[fx, fy, fz] == voxel.AIR:
                    v[fx, fy, fz] = voxel.BRANCH
        if rng.chance(0.22):
            # A trunk down across the belt.
            length = rng.randint(4, 10)
            fy = base
            for step in range(length):
                fx = x + step
                fz = z + (step // 3) * rng.choice((-1, 1))
                if 0 <= fx < nx and 0 <= fz < nz:
                    lay = int(surface[fx, fz])
                    shapes.fill_box(v, (fx, lay, fz), (fx + 1, lay + 1, fz + 1), voxel.TRUNK)


def _shell_craters(
    v: np.ndarray,
    surface: np.ndarray,
    rng: GameRandom,
    z_lo: int,
    z_hi: int,
    count: int,
    radius_cap: float = 6.5,
) -> list[tuple[int, int, int, float]]:
    """Overlapping craters across no man's land, densest near the parapets."""
    nx, ny, nz = v.shape
    craters: list[tuple[int, int, int, float]] = []
    for _ in range(count):
        x = rng.randint(3, nx - 3)
        # Bias toward the two trench lines: the ground nobody crosses twice.
        t = rng.numpy.beta(0.7, 0.7)
        z = int(z_lo + t * (z_hi - z_lo))
        if not (2 <= z < nz - 2):
            continue
        radius = float(rng.numpy.gamma(2.4, 1.15)) + 1.4
        radius = min(radius, radius_cap)
        y = int(surface[x, z]) - int(radius * 0.55)
        shapes.carve_sphere(v, (x + 0.5, y + 0.5, z + 0.5), radius, rng)
        # Ejecta ring.
        ring = np.zeros((nx, nz), dtype=bool)
        r = int(radius) + 1
        x0, x1 = max(0, x - r - 1), min(nx, x + r + 2)
        z0, z1 = max(0, z - r - 1), min(nz, z + r + 2)
        gx = np.arange(x0, x1)[:, None] - x
        gz = np.arange(z0, z1)[None, :] - z
        d2 = gx**2 + gz**2
        ring[x0:x1, z0:z1] = (d2 >= r * r) & (d2 < (r + 1.6) ** 2)
        _pile(v, surface, ring, 1, voxel.SPOIL)
        craters.append((x, y, z, radius))
    return craters


def _wire_belt(v: np.ndarray, surface: np.ndarray, rng: GameRandom, z_centre: int) -> None:
    """Pickets and entanglement, planted on whatever the ground actually is.

    Wire is non-solid: at half-metre voxels a solid strand would be a wall.  It
    reads as a visual barrier and (from milestone 3) drags movement.
    """
    nx, ny, nz = v.shape
    for x in range(1, nx - 1):
        for dz in (-2, 0, 2):
            z = z_centre + dz
            if not (0 <= z < nz) or not rng.chance(0.55):
                continue
            # Find the real ground here rather than trusting the pre-cut
            # heightmap: this belt may cross craters and spoil.
            base = int(surface[x, z])
            while base > 1 and not voxel.SOLID[v[x, base - 1, z]]:
                base -= 1
            while base < ny - 1 and voxel.SOLID[v[x, base, z]]:
                base += 1
            if v[x, base, z] != voxel.AIR:
                continue
            height = rng.randint(1, 3)
            shapes.fill_box(v, (x, base, z), (x + 1, base + height, z + 1), voxel.WIRE)


def _wrecked_farm(
    v: np.ndarray, surface: np.ndarray, rng: GameRandom, cx: int, cz: int
) -> tuple[float, float, float]:
    """A brick outbuilding, roof gone, two walls down."""
    nx, ny, nz = v.shape
    w, d, h = 16, 11, 9
    x0, z0 = cx - w // 2, cz - d // 2
    base = int(np.median(surface[x0 : x0 + w, z0 : z0 + d]))
    # Concrete pad.
    shapes.fill_box(v, (x0, base - 1, z0), (x0 + w, base, z0 + d), voxel.CONCRETE)
    shapes.fill_box(v, (x0, base, z0), (x0 + w, base + h, z0 + d), voxel.AIR)
    # Walls, one voxel thick.
    for side in range(4):
        if side == 0:
            lo, hi = (x0, base, z0), (x0 + w, base + h, z0 + 1)
        elif side == 1:
            lo, hi = (x0, base, z0 + d - 1), (x0 + w, base + h, z0 + d)
        elif side == 2:
            lo, hi = (x0, base, z0), (x0 + 1, base + h, z0 + d)
        else:
            lo, hi = (x0 + w - 1, base, z0), (x0 + w, base + h, z0 + d)
        # Two of the four walls are mostly down.
        height = h if side in (0, 2) else rng.randint(2, 5)
        shapes.fill_box(v, lo, (hi[0], base + height, hi[2]), voxel.BRICK)
    # Blow holes through what is left, and drop the roof inside.
    for _ in range(6):
        hx = rng.randint(x0, x0 + w)
        hz = rng.choice((z0, z0 + d - 1, x0, x0 + w - 1))
        hz = rng.randint(z0, z0 + d)
        hy = base + rng.randint(0, h - 2)
        shapes.carve_sphere(v, (hx + 0.5, hy + 0.5, hz + 0.5), rng.uniform(1.5, 3.2), rng)
    rubble = np.zeros((nx, nz), dtype=bool)
    rubble[x0 + 1 : x0 + w - 1, z0 + 1 : z0 + d - 1] = True
    floor_map = np.full((nx, nz), base, dtype=np.int32)
    _pile(v, floor_map, rubble, 2, voxel.RUBBLE)
    s = voxel.VOXEL_SIZE
    return ((cx + 0.5) * s, base * s, (cz + 0.5) * s)


def _collapsed_culvert(
    v: np.ndarray, surface: np.ndarray, rng: GameRandom, cx: int, cz: int
) -> tuple[float, float, float]:
    """A concrete box culvert under a farm track, dropped in the middle."""
    nx, ny, nz = v.shape
    base = int(surface[cx, cz]) - 4
    length = 18
    x0 = cx - length // 2
    # Embankment for the track.
    track = np.zeros((nx, nz), dtype=bool)
    track[max(0, x0 - 6) : x0 + length + 6, cz - 3 : cz + 4] = True
    _pile(v, surface, track, 1, voxel.RUBBLE)
    # Box section.
    shapes.fill_box(v, (x0, base, cz - 2), (x0 + length, base + 5, cz + 3), voxel.CONCRETE)
    shapes.fill_box(v, (x0 + 1, base + 1, cz - 1), (x0 + length - 1, base + 4, cz + 2), voxel.AIR)
    # Middle span collapsed.
    mid = x0 + length // 2
    shapes.carve_sphere(v, (mid + 0.5, base + 4.0, cz + 0.5), 4.0, rng)
    shapes.fill_box(v, (mid - 3, base + 1, cz - 1), (mid + 3, base + 2, cz + 2), voxel.RUBBLE)
    s = voxel.VOXEL_SIZE
    return ((cx + 0.5) * s, base * s, (cz + 0.5) * s)


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------


def generate(rng: GameRandom, tun: Tunables) -> GeneratedWorld:
    dims = WorldDims(
        tun.i("world.size_x"), tun.i("world.size_y"), tun.i("world.size_z")
    )
    world = VoxelWorld(dims)
    v = world.v
    ground = tun.i("world.ground_level")
    water = tun.i("world.water_table")
    world.water_table = water

    relief = shapes.fbm_2d(
        rng.derive("field.relief"), (dims.x, dims.z), octaves=4, base_cells=3
    )
    # Flat farmland: ~1.75 m of relief across the whole map. Anything
    # rougher and the ground beyond the parapet blocks the peek.
    surface = (ground + np.round((relief - 0.5) * 3.5)).astype(np.int32)
    surface = np.clip(surface, 8, dims.y - 8)
    _lay_strata(v, surface)
    _plough_stripes(v, surface, rng.derive("field.plough"))
    _drainage_ditches(v, surface, rng.derive("field.ditches"), tun)

    layout = tun.section("world.layout")
    front_z = int(layout["front_line_z"])
    support_z = int(layout["support_line_z"])
    enemy_front_z = int(layout["enemy_front_z"])
    enemy_support_z = int(layout["enemy_support_z"])

    network = TrenchNetwork()
    dugouts: list[Dugout] = []
    specs = [
        _LineSpec("front", 0, 0, front_z, 4, dims.x - 4, ground - 5, +1, True, 3),
        _LineSpec("support", 0, 0, support_z, 4, dims.x - 4, ground - 5, +1, False, 4),
        _LineSpec("enemy_front", 1, 0, enemy_front_z, 4, dims.x - 4, ground - 5, -1, True, 3),
        _LineSpec("enemy_support", 1, 0, enemy_support_z, 4, dims.x - 4, ground - 5, -1, False, 4),
    ]
    for comm_index, comm_x in enumerate(layout["comm_trench_x"]):
        specs.append(
            _LineSpec(
                f"comm_{comm_index}",
                0,
                2,
                int(comm_x),
                support_z - 1,
                front_z + 6,
                ground - 5,
                +1,
                False,
                0,
            )
        )

    for spec in specs:
        line_rng = rng.derive(f"trench.{spec.name}")
        line, line_dugouts = _carve_trench_line(
            v, surface, line_rng, spec, tun, network.graph
        )
        network.lines[spec.name] = line
        dugouts.extend(line_dugouts)
    network.dugouts = tuple(dugouts)

    belt_rng = rng.derive("shelterbelts")
    for z_centre in layout["shelterbelt_z"]:
        _shelterbelt(v, surface, belt_rng, int(z_centre))

    landmarks: dict[str, tuple[float, float, float]] = {}
    landmarks["farm"] = _wrecked_farm(
        v, surface, rng.derive("farm"), int(dims.x * 0.26), (front_z + enemy_front_z) // 2 - 18
    )
    landmarks["culvert"] = _collapsed_culvert(
        v, surface, rng.derive("culvert"), int(dims.x * 0.70), front_z - 22
    )

    wire_rng = rng.derive("wire")
    _wire_belt(v, surface, wire_rng, front_z + 17)
    _wire_belt(v, surface, wire_rng, enemy_front_z - 17)

    craters = _shell_craters(
        v, surface, rng.derive("craters"), front_z + 4, enemy_front_z - 4, 140
    )
    # A handful of direct hits on the lines themselves: real breaches in the
    # parapet that leave a stretch of trench genuinely exposed.
    craters += _shell_craters(
        v, surface, rng.derive("craters.direct"), front_z - 2, front_z + 13, 4, radius_cap=4.2
    )
    craters += _shell_craters(
        v, surface, rng.derive("craters.direct.enemy"),
        enemy_front_z - 13, enemy_front_z + 2, 4, radius_cap=4.2,
    )

    water_sim.flood_below_table(v, water)
    water_sim.settle(v)
    world.mark_all_dirty()

    spawn_bay = network.lines["front"].bays[len(network.lines["front"].bays) // 2]
    sx, sy, sz = spawn_bay.centre_metres
    spawn = (sx, sy + 0.05, sz)

    return GeneratedWorld(
        world=world,
        network=network,
        surface=surface,
        spawn=spawn,
        craters=tuple(craters),
        landmarks=landmarks,
    )
