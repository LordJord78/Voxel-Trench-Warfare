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

import math
from dataclasses import dataclass, field

import numpy as np

from ..core.rng import GameRandom
from ..data import Tunables
from . import destruction, shapes, voxel, water as water_sim
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


def _swale(nz: int, front_z: int, enemy_front_z: int, tun: Tunables) -> np.ndarray:
    """The ground between the lines, sagging into a shallow dry watercourse.

    Amplitude alone does not make no-man's-land read.  A man on a firing step
    has his eye 1.1 m over the field, so ground past about 20 m is edge-on to
    him and a flat plate is exactly what he sees, whatever the relief is doing
    vertically — raise the same view 3 m and the craters are obvious.  What
    makes ground read is ground that *faces* you, and the cheapest honest way
    to get that across 100 m of open field is to put both trench lines on the
    shoulders of a shallow depression, which is what the map is named for.

    A concave surface is fully visible from its own rim, so this costs no
    fairness: each side overlooks the same dip, and the far shoulder rising
    toward the enemy line is what the 60 m mark lands on.

    Returns a per-z offset in voxels, zero outside the depression.
    """
    dip = tun.f("world.field.swale_depth_m") / tun.f("world.voxel_size")
    if dip <= 0.0:
        return np.zeros(nz, dtype=np.int32)
    margin = tun.f("world.field.swale_margin_voxels")
    centre = 0.5 * (front_z + enemy_front_z)
    half = max(1.0, 0.5 * (enemy_front_z - front_z) + margin)
    t = np.clip(np.abs(np.arange(nz, dtype=np.float32) - centre) / half, 0.0, 1.0)
    hump = 0.5 * (1.0 + np.cos(np.pi * t))
    return -np.round(dip * hump).astype(np.int32)


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


@dataclass(slots=True)
class _BayPlan:
    """Every height for one bay, settled before a single voxel is written.

    Planning the whole line first is what lets the crest be a *guarantee*:
    each bay works out how high it has to stand to see its own ground, the
    line is then smoothed so the crest does not saw up and down between
    neighbours, and only then is anything carved.
    """

    a0: int
    a1: int
    b0: int
    b1: int
    ground_y: int
    floor_y: int
    step_top_y: int
    crest_y: int
    step_lo: int
    step_span: int
    walk_b: float


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


def _revet(v: np.ndarray, surface: np.ndarray, target: np.ndarray) -> int:
    """Face the trench's earth walls with timber, up to an absolute y.

    Loose spoil piled at the lip of a two-and-a-half metre trench does not stay
    there: it finds its angle of repose, and the angle of repose runs through
    the walkway. Every army that ever dug one revetted the inner face for
    exactly this reason, so the fix is the historical one rather than a
    special case in the collapse code.

    It also gives the breach its meaning. Where a shell takes the revetment
    out, the parapet behind it *does* come down into the trench, because
    nothing is holding it any more.
    """
    mask = target > 0
    if not mask.any():
        return 0
    xs, zs = np.nonzero(mask)
    tops = target[xs, zs]
    base = surface[xs, zs]
    ny = v.shape[1]
    faced = 0
    span = int((tops - base).max())
    for layer in range(max(0, span)):
        ys = base + layer
        sel = (ys < tops) & (ys >= 0) & (ys < ny)
        if not sel.any():
            continue
        x2, y2, z2 = xs[sel], ys[sel], zs[sel]
        loose = voxel.LOOSE[v[x2, y2, z2]]
        v[x2[loose], y2[loose], z2[loose]] = voxel.TIMBER
        faced += int(loose.sum())
    return faced


def _corridor_height(
    surface: np.ndarray,
    long_axis: int,
    facing: int,
    a0: int,
    a1: int,
    front_edge: int,
    reach: int,
    near: int,
    percentile: float,
) -> int:
    """How high the ground gets in the strip this bay has to see over.

    Two numbers, because they fail differently.  A rise anywhere in the corridor
    costs you distance; a rise in the first few metres walls you in completely.
    We take a high percentile of the whole strip and the maximum of the near
    band, and answer with whichever is worse.

    This reads the *field* heightmap, which is the terrain the parapet has to
    beat.  Craters come later and mostly dig down; their ejecta is one voxel,
    which the sight margin covers.
    """
    if facing > 0:
        wide = (front_edge, front_edge + reach)
        close = (front_edge, front_edge + near)
    else:
        wide = (front_edge - reach, front_edge)
        close = (front_edge - near, front_edge)

    def patch(span: tuple[int, int]) -> np.ndarray:
        lo, hi = max(0, span[0]), max(0, span[1])
        if long_axis == 0:
            return surface[max(0, a0) : a1, lo:hi]
        return surface[lo:hi, max(0, a0) : a1]

    far_patch = patch(wide)
    if far_patch.size == 0:
        return int(np.median(surface))
    near_patch = patch(close)
    far_h = float(np.percentile(far_patch, percentile))
    near_h = float(near_patch.max()) if near_patch.size else far_h
    return int(math.ceil(max(far_h, near_h)))


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

    The parapet crest is *not* a constant the terrain has to stay under.  Each
    fire bay measures the ground it is supposed to see over, raises its firing
    step until a standing eye clears that ground, and then builds its crest at
    `step_top + floor(standing eye)` — high enough that a crouched man on the
    same step is behind it.  Clearance is therefore guaranteed locally, and the
    field is free to have as much relief as it likes.
    """
    vs = tun.f("world.voxel_size")
    width = tun.i("world.trench.width_voxels")
    depth = tun.i("world.trench.depth_voxels")
    bench = tun.i("world.trench.step_bench_voxels")
    treads = tun.i("world.trench.step_tread_voxels")
    parapet_min = tun.i("world.trench.parapet_min_height")
    parados_h = tun.i("world.trench.parados_height")
    thickness = tun.i("world.trench.parapet_thickness")
    step_min = tun.i("world.trench.firing_step_min")
    step_max = tun.i("world.trench.firing_step_max")
    smooth = tun.i("world.trench.crest_smoothing_voxels")
    reach = max(1, int(round(tun.f("world.trench.sight_range_m") / vs)))
    near = max(1, int(round(tun.f("world.trench.sight_near_m") / vs)))
    percentile = tun.f("world.trench.sight_percentile")
    margin = tun.f("world.trench.sight_margin_m") / vs
    bay_len = max(4, int(round(tun.f("world.trench.bay_length_m") / vs)))
    offset = width + max(2, int(round(tun.f("world.trench.traverse_offset_m") / vs)) - 2)
    leg = 3

    # The peek mechanic, stated as arithmetic rather than as a comment.  The
    # crest sits `crest_rise` voxels over the bench; a standing eye is above it
    # and a crouched eye is below it, and both halves are checked here so a
    # careless edit to an eye height fails loudly at generation instead of
    # quietly turning the parapet into a wall.
    eye_stand = tun.f("player.eye_height_standing") / vs
    eye_crouch = tun.f("player.eye_height_crouched") / vs
    crest_rise = int(math.floor(eye_stand))
    if not eye_crouch < crest_rise < eye_stand:
        raise ValueError(
            f"no whole-voxel crest gives a peek: standing eye {eye_stand:.2f} vx, "
            f"crouched {eye_crouch:.2f} vx. The crest must land strictly between "
            "them, so the two eye heights have to straddle an integer."
        )
    # How much rise the across-bay treads can carry on their own.  Each column
    # buys one voxel, and the player's step-up has to cover it; past that the
    # flight turns and runs along the bay instead, which costs bay length
    # rather than walkway width.
    if vs > tun.f("player.step_up") + 1e-9:
        raise ValueError(
            f"a {vs:.2f} m tread needs a step-up of at least that; "
            f"player.step_up is {tun.f('player.step_up'):.2f} m"
        )
    across_rise = treads + 1
    step_max = max(step_min, min(step_max, bay_len - 4))
    structure = (bench + treads) if spec.firing_steps else 0
    walk_width = width - structure
    if walk_width * vs < tun.f("player.radius") * 2.0:
        raise ValueError(
            f"{spec.name}: {width * vs:.1f} m of trench less a "
            f"{structure * vs:.1f} m firing step leaves a "
            f"{walk_width * vs:.1f} m walkway; a body is "
            f"{tun.f('player.radius') * 2:.1f} m across"
        )
    # A man on the bench may overhang the tread below it — that column is air at
    # his feet — but not the parapet, which is solid to the crest.  So the
    # standable surface is the bench plus one tread, and that is what has to
    # hold a body.
    standable = (bench + min(1, treads)) * vs
    if spec.firing_steps and standable < tun.f("player.radius") * 2.0:
        raise ValueError(
            f"{spec.name}: a {bench * vs:.1f} m bench over a {treads} tread step "
            f"gives {standable:.1f} m to stand on; a body is "
            f"{tun.f('player.radius') * 2:.1f} m across"
        )

    nx, ny, nz = v.shape
    long_axis = spec.long_axis
    footprint = np.zeros((nx, nz), dtype=bool)
    parapet_target = np.zeros((nx, nz), dtype=np.int32)
    parados_target = np.zeros((nx, nz), dtype=np.int32)
    revet_target = np.zeros((nx, nz), dtype=np.int32)

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

    # -- plan ------------------------------------------------------------

    plans: list[_BayPlan] = []
    prev_floor: int | None = None
    index = 0
    a = spec.a_start
    while a < spec.a_end:
        a1 = min(a + bay_len, spec.a_end)
        b0 = spec.cross_base + (offset if index % 2 else 0)
        b1 = b0 + width

        ground_y = local_surface(a, a1, b0, b1)
        floor_y = ground_y - depth
        if prev_floor is not None:
            floor_y = max(prev_floor - 1, min(prev_floor + 1, floor_y))
        floor_y = max(3, min(floor_y, ny - depth - 6))
        duck_y = floor_y + 1

        if spec.facing > 0:
            step_lo, front_edge = b1 - bench, b1
        else:
            step_lo, front_edge = b0, b0
        walk_b = (
            (b0 + b1 - structure) * 0.5
            if spec.facing > 0
            else (b0 + structure + b1) * 0.5
        )

        if spec.firing_steps:
            ahead = _corridor_height(
                surface, long_axis, spec.facing, a, a1, front_edge,
                reach, near, percentile,
            )
            needed = int(math.ceil(ahead + margin - eye_stand))
            step_top = max(duck_y + step_min, ground_y + parapet_min - crest_rise, needed)
            step_top = min(step_top, duck_y + step_max)
            crest_y = step_top + crest_rise
        else:
            step_top = duck_y
            crest_y = ground_y + parapet_min
            walk_b = (b0 + b1) * 0.5

        plans.append(
            _BayPlan(
                a0=a, a1=a1, b0=b0, b1=b1,
                ground_y=ground_y, floor_y=floor_y,
                step_top_y=step_top, crest_y=crest_y,
                step_lo=step_lo, step_span=bench if spec.firing_steps else 0,
                walk_b=walk_b,
            )
        )
        a = a1 + leg
        prev_floor = floor_y
        index += 1

    # Smooth the crest line.  Raising a bay is free — it only buys a taller
    # parapet — so smoothing only ever lifts, and no bay loses the clearance it
    # asked for.
    if spec.firing_steps and smooth > 0:
        for i in range(1, len(plans)):
            plans[i].step_top_y = max(plans[i].step_top_y, plans[i - 1].step_top_y - smooth)
        for i in range(len(plans) - 2, -1, -1):
            plans[i].step_top_y = max(plans[i].step_top_y, plans[i + 1].step_top_y - smooth)
        for plan in plans:
            plan.step_top_y = min(plan.step_top_y, plan.floor_y + 1 + step_max)
            plan.crest_y = plan.step_top_y + crest_rise

    # -- carve -----------------------------------------------------------

    bays: list[Bay] = []
    dugouts: list[Dugout] = []
    prev_node: int | None = None

    for index, plan in enumerate(plans):
        a, a1, b0, b1 = plan.a0, plan.a1, plan.b0, plan.b1
        floor_y, duck_y = plan.floor_y, plan.floor_y + 1
        top = plan.crest_y + 3

        clear(a, a1, b0, b1, duck_y, top)
        slab(a, a1, b0, b1, floor_y, duck_y, voxel.DUCKBOARD)

        step_h = plan.step_top_y - duck_y
        if spec.firing_steps and step_h > 0:
            lo, hi = plan.step_lo, plan.step_lo + plan.step_span
            # Across the bay: the bench, and below it a short flight of treads
            # falling away from the parapet.  This is what makes the step
            # mountable from anywhere along the walkway, so it is built first
            # and its width is fixed.
            slab(a, a1, lo, hi, duck_y, plan.step_top_y, voxel.TIMBER)
            for tread in range(treads):
                col = lo - 1 - tread if spec.facing > 0 else hi + tread
                rise = min(treads - tread, step_h)
                slab(a, a1, col, col + 1, duck_y, duck_y + rise, voxel.TIMBER)
            # Along the bay: whatever rise the across-bay treads could not
            # carry.  Putting the extra height here is what lets the step vary
            # per bay without the bay having to get wider to hold it.
            climb = step_h - across_rise
            if climb > 0:
                for tread in range(climb):
                    slab(
                        a + tread, a + tread + 1, lo, hi,
                        duck_y, plan.step_top_y - (climb - tread) + 1, voxel.TIMBER,
                    )

        bx0, bx1, bz0, bz1 = to_box(a, a1, b0, b1)
        walk_a = (a + a1) * 0.5
        walk_x, walk_z = (
            (walk_a, plan.walk_b) if long_axis == 0 else (plan.walk_b, walk_a)
        )
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
                step_lo=plan.step_lo,
                step_span=plan.step_span,
                step_top_y=plan.step_top_y,
                crest_y=plan.crest_y,
                walk_x=walk_x,
                walk_z=walk_z,
                long_axis=long_axis,
                ground_y=plan.ground_y,
            )
        )

        node = graph.add_node((int(walk_x), duck_y, int(walk_z)))
        if prev_node is not None:
            graph.link(prev_node, node)
        prev_node = node

        # Parapet on the exposed side, parados behind.  The parapet's inner
        # courses carry the crest; the outer ones fall away one voxel per
        # course, so a tall bay reads as a bank of spoil rather than a wall and
        # its own back slope never blocks the view it was raised to give.
        for course in range(thickness):
            col = b1 + course if spec.facing > 0 else b0 - 1 - course
            target = plan.crest_y - max(0, course - 1)
            if target <= plan.ground_y:
                continue
            px0, px1, pz0, pz1 = to_box(a, a1 + leg, col, col + 1)
            parapet_target[max(0, px0) : px1, max(0, pz0) : pz1] = target
        # Both earth faces of the trench get revetted, to their own heights:
        # the parapet side to the crest, the parados side to its lower top.
        # Leaving either one bare lets that bank find its angle of repose
        # through the walkway — the parados is only a single course of spoil,
        # but a single course sliding in runs the whole length of the bay and
        # lands exactly where a man's feet go.
        parapet_face = b1 if spec.facing > 0 else b0 - 1
        parados_face = b0 - 1 if spec.facing > 0 else b1
        for face, height in (
            (parapet_face, plan.crest_y),
            (parados_face, plan.ground_y + parados_h),
        ):
            fx0, fx1, fz0, fz1 = to_box(a, a1 + leg, face, face + 1)
            revet_target[max(0, fx0) : fx1, max(0, fz0) : fz1] = height

        for course in range(2):
            col = b0 - 1 - course if spec.facing > 0 else b1 + course
            kx0, kx1, kz0, kz1 = to_box(a, a1 + leg, col, col + 1)
            parados_target[max(0, kx0) : kx1, max(0, kz0) : kz1] = (
                plan.ground_y + parados_h
            )

        if a1 < spec.a_end and index + 1 < len(plans):
            nb0 = plans[index + 1].b0
            lo_b, hi_b = min(b0, nb0), max(b1, nb0 + width)
            clear(a1, a1 + leg, lo_b, hi_b, duck_y, top)
            slab(a1, a1 + leg, lo_b, hi_b, floor_y, duck_y, voxel.DUCKBOARD)

        if spec.dugout_every and index % spec.dugout_every == 1:
            dug = _carve_dugout(v, surface, spec, floor_y, bx0, bx1, bz0, bz1, tun)
            if dug is not None:
                dugouts.append(dug)

    parapet_target[footprint] = 0
    parados_target[footprint] = 0
    parados_target[parapet_target > 0] = 0
    _pile_to(v, surface, parapet_target, voxel.SPOIL)
    _pile_to(v, surface, parados_target, voxel.SPOIL)
    revet_target[footprint] = 0
    _revet(v, surface, revet_target)

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


def _pick_spawn(v: np.ndarray, line: TrenchLine) -> tuple[float, float, float]:
    """Stand the player on duckboards that a shell has not already taken.

    Craters are cut after the trench is dug, four of them per line are aimed at
    it deliberately, and the collapse then drops whatever they undercut. The
    geometric middle bay is therefore sometimes a hole in the walkway with its
    firing step shot away — which is a fine bay to fight over and a poor one to
    start in, since you can neither stand where you spawned nor climb up to see
    out. Search outward from the middle for a bay that still works, and fall
    back to the middle if the whole line has been ploughed.
    """
    bays = line.bays
    if not bays:
        return (0.0, 0.0, 0.0)
    nx, ny, nz = v.shape
    middle = len(bays) // 2
    order = sorted(range(len(bays)), key=lambda i: (abs(i - middle), i))
    for index in order:
        bay = bays[index]
        x, z = int(bay.walk_x), int(bay.walk_z)
        if not (0 <= x < nx and 0 <= z < nz):
            continue
        floor = bay.floor_y
        if v[x, floor, z] != voxel.DUCKBOARD:
            continue
        if (v[x, floor + 1 : min(ny, floor + 5), z] != voxel.AIR).any():
            continue
        if bay.has_firing_step and _step_intact(v, bay) < 0.5:
            continue
        s = voxel.VOXEL_SIZE
        return (bay.walk_x * s, (floor + 1) * s + 0.05, bay.walk_z * s)
    sx, sy, sz = bays[middle].centre_metres
    return (sx, sy + 0.05, sz)


def _step_intact(v: np.ndarray, bay: Bay) -> float:
    """Fraction of this bay's firing-step bench still standing."""
    lo, hi = bay.step_lo, bay.step_lo + max(1, bay.step_span)
    if bay.long_axis == 0:
        bench = v[bay.x0 : bay.x1, bay.floor_y + 1 : bay.step_top_y, lo:hi]
    else:
        bench = v[lo:hi, bay.floor_y + 1 : bay.step_top_y, bay.z0 : bay.z1]
    if bench.size == 0:
        return 0.0
    return float((bench == voxel.TIMBER).mean())


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

    vs = tun.f("world.voxel_size")
    layout = tun.section("world.layout")
    front_z = int(layout["front_line_z"])
    support_z = int(layout["support_line_z"])
    enemy_front_z = int(layout["enemy_front_z"])
    enemy_support_z = int(layout["enemy_support_z"])

    relief = shapes.fbm_2d(
        rng.derive("field.relief"),
        (dims.x, dims.z),
        octaves=tun.i("world.field.relief_octaves"),
        base_cells=tun.i("world.field.relief_base_cells"),
        persistence=tun.f("world.field.relief_persistence"),
    )
    # Amplitude no longer has to stay under a global parapet crest: each fire
    # bay guarantees its own clearance, so the field is free to have shape.
    amplitude = tun.f("world.field.relief_amplitude_m") / vs
    surface = (ground + np.round((relief - 0.5) * 2.0 * amplitude)).astype(np.int32)
    surface += _swale(dims.z, front_z, enemy_front_z, tun)[None, :]
    surface = np.clip(surface, water + 2, dims.y - 8)
    _lay_strata(v, surface)
    _plough_stripes(v, surface, rng.derive("field.plough"))
    _drainage_ditches(v, surface, rng.derive("field.ditches"), tun)

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

    # Craters undercut trench walls and parapets, leaving spoil hanging over the
    # walkway. Settle it before anyone sees it: the same collapse the runtime
    # uses, so a crater cut at load behaves like one cut at tick 40 000, and
    # the dirt ends up where it would have ended up — in the bottom of the
    # trench underneath.
    water_sim.flood_below_table(v, water)
    water_sim.settle(v)
    destruction.settle_world(world)
    world.mark_all_dirty()

    spawn = _pick_spawn(v, network.lines["front"])

    return GeneratedWorld(
        world=world,
        network=network,
        surface=surface,
        spawn=spawn,
        craters=tuple(craters),
        landmarks=landmarks,
    )
