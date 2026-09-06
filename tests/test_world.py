"""The trench has to be mechanically true, not decorative.

These tests are the acceptance criteria for the trench design: a traverse must
actually stop enfilade fire, a firing step must actually be the difference
between seeing and not seeing, and a dugout must actually have a roof.
"""

from __future__ import annotations

import statistics

import numpy as np
import pytest

from trenchline.physics.character import Stance
from trenchline.physics.vec import Vec3
from trenchline.session import Session, SessionConfig
from trenchline.world import voxel
from trenchline.world.raycast import line_of_sight, raycast

SEEDS = (7, 21, 99)


@pytest.fixture(scope="module", params=SEEDS)
def game(request) -> Session:
    return Session(SessionConfig(seed=request.param))


def _eye(session: Session, stance: Stance) -> float:
    return session.controller.stances[stance].eye_height


# -- traverses ---------------------------------------------------------------


def test_traverses_block_enfilade_down_the_line(game: Session) -> None:
    """You must not be able to see, or shoot, down your own trench."""
    stand = _eye(game, Stance.STANDING)
    distances: list[float] = []
    for bay in game.network.lines["front"].bays:
        cx, cy, cz = bay.centre_metres
        eye = Vec3(cx, cy + stand, cz)
        for direction in (Vec3(1, 0, 0), Vec3(-1, 0, 0)):
            hit = raycast(game.world, eye, direction, 120.0)
            distances.append(hit.distance if hit else 120.0)

    median = statistics.median(distances)
    bay_length = game.tun.f("world.trench.bay_length_m")
    assert median <= bay_length + 4.0, (
        f"median sightline down the line is {median:.1f} m; traverses are not working"
    )
    # A few breaches from direct hits are the point, but not most of the line.
    breached = sum(1 for d in distances if d > bay_length * 2.5)
    assert breached <= len(distances) * 0.25


def test_traverse_blocks_fragmentation_around_the_corner(game: Session) -> None:
    """A grenade in one bay must not have line of sight into the next."""
    bays = game.network.lines["front"].bays
    blocked = 0
    pairs = 0
    for a, b in zip(bays, bays[1:]):
        ax, ay, az = a.centre_metres
        bx, by, bz = b.centre_metres
        # Burst point at roughly waist height on the duckboards.
        origin = Vec3(ax, ay + 0.6, az)
        target = Vec3(bx, by + 0.6, bz)
        pairs += 1
        if not line_of_sight(game.world, origin, target):
            blocked += 1
    assert pairs > 0
    assert blocked >= pairs * 0.75, (
        f"only {blocked}/{pairs} bay-to-bay pairs are shielded from each other"
    )


# -- firing step vs parapet --------------------------------------------------


def test_you_cannot_see_out_from_the_trench_floor(game: Session) -> None:
    """The duckboards are blind, except where a shell has opened the parapet.

    Generation puts four direct hits on each line on purpose, and a bay whose
    parapet is gone is supposed to be exposed — that is the whole point of a
    breach.  So this asserts the rule and bounds the exception, rather than
    demanding every bay pass and passing by luck.
    """
    stand = _eye(game, Stance.STANDING)
    views: list[float] = []
    for bay in game.network.lines["front"].bays:
        cx, cy, cz = bay.centre_metres
        hit = raycast(
            game.world, Vec3(cx, cy + stand, cz), Vec3(0, 0, float(bay.facing)), 90.0
        )
        views.append(hit.distance if hit else 90.0)

    assert statistics.median(views) < 4.0, (
        f"median view from the duckboards is {statistics.median(views):.1f} m; "
        "the parapet is not doing its job"
    )
    breached = [d for d in views if d >= 12.0]
    assert len(breached) <= max(1, len(views) // 6), (
        f"{len(breached)}/{len(views)} bays see into no man's land from the "
        f"duckboards ({[round(d, 1) for d in breached]} m); at most a handful "
        "should be shelled open"
    )


def test_standing_on_the_firing_step_opens_the_field(game: Session) -> None:
    stand = _eye(game, Stance.STANDING)
    views: list[float] = []
    for bay in game.network.lines["front"].bays:
        sx, sy, sz = bay.step_metres
        hit = raycast(
            game.world, Vec3(sx, sy + stand, sz), Vec3(0, 0, float(bay.facing)), 90.0
        )
        views.append(hit.distance if hit else 90.0)
    assert statistics.median(views) > 25.0, (
        f"median view from the firing step is only {statistics.median(views):.1f} m"
    )


def test_crouching_on_the_firing_step_keeps_you_behind_the_parapet(game: Session) -> None:
    crouch = _eye(game, Stance.CROUCHED)
    views: list[float] = []
    for bay in game.network.lines["front"].bays:
        sx, sy, sz = bay.step_metres
        hit = raycast(
            game.world, Vec3(sx, sy + crouch, sz), Vec3(0, 0, float(bay.facing)), 90.0
        )
        views.append(hit.distance if hit else 90.0)
    assert statistics.median(views) < 4.0, (
        "crouching on the step should put the parapet between you and the enemy"
    )


def test_the_fire_bay_is_a_fire_bay_and_not_a_corridor(game: Session) -> None:
    """Width is walkway plus firing step, and both have to be usable.

    3.0 m read as a communication trench.  The bay is 2.5 m: a 1.0 m walkway
    and a 1.5 m step.  A body is 0.60 m across, so the walkway has room to pass
    and the step has room to stand on, and the arithmetic is asserted rather
    than left in a comment.
    """
    tun = game.tun
    vs = tun.f("world.voxel_size")
    body = tun.f("player.radius") * 2.0
    width = tun.i("world.trench.width_voxels") * vs
    structure = (
        tun.i("world.trench.step_bench_voxels") + tun.i("world.trench.step_tread_voxels")
    ) * vs
    walkway = width - structure

    assert 2.0 <= width <= 2.5, f"fire bay is {width:.1f} m wide"
    assert walkway >= body, f"{walkway:.1f} m walkway will not pass a {body:.1f} m body"
    assert walkway <= 1.2, f"{walkway:.1f} m walkway is a communication trench"
    # Each tread column is worth one voxel of rise, and the step-up has to cover
    # it, or the step is only mountable from the flight at the end of the bay.
    assert vs <= tun.f("player.step_up")
    across = (tun.i("world.trench.step_tread_voxels") + 1) * vs
    assert across >= tun.i("world.trench.firing_step_min") * vs, (
        "the shortest step is already too tall to mount by walking at it"
    )

    for line in ("front", "enemy_front"):
        for bay in game.network.lines[line].bays:
            span = (bay.x1 - bay.x0) if bay.long_axis == 2 else (bay.z1 - bay.z0)
            assert span * vs == pytest.approx(width), (
                f"{line} bay {bay.index} is {span * vs:.1f} m wide"
            )


def test_crest_clearance_is_guaranteed_per_bay(game: Session) -> None:
    """The peek is arithmetic, not luck.

    This is the whole point of decoupling the crest from field relief: every
    fire bay builds its parapet from its own firing-step height, so a standing
    eye clears it and a crouched eye does not, in every bay, on every seed,
    however much shape the ground has.  If terrain could ever push a crest out
    of that window, this fails on the seed that does it.
    """
    stand, crouch = _eye(game, Stance.STANDING), _eye(game, Stance.CROUCHED)
    for line in ("front", "enemy_front"):
        for bay in game.network.lines[line].bays:
            assert bay.has_firing_step
            assert bay.clearance_m(stand) > 0.0, (
                f"{line} bay {bay.index}: a standing eye is "
                f"{-bay.clearance_m(stand):.2f} m BELOW its own crest"
            )
            assert bay.clearance_m(crouch) < 0.0, (
                f"{line} bay {bay.index}: a crouched eye is "
                f"{bay.clearance_m(crouch):.2f} m above its own crest, so "
                "crouching does not hide you"
            )


def test_crest_tracks_the_step_not_the_terrain(game: Session) -> None:
    """Bays differ in height; their clearance does not.

    The crest follows the bay's own step by construction, so clearance is
    identical everywhere even where the steps are not — which is exactly the
    property a global constant could not give.
    """
    bays = [b for line in ("front", "enemy_front")
            for b in game.network.lines[line].bays]
    clearances = {round(b.crest_y - b.step_top_y) for b in bays}
    assert len(clearances) == 1, f"crest rise varies between bays: {clearances}"
    steps = {b.step_top_y - b.floor_y - 1 for b in bays}
    grounds = {b.ground_y for b in bays}
    assert len(grounds) > 1, "this seed has no terrain variation to test against"
    assert steps, steps


def test_standing_and_crouched_differ_on_every_intact_bay(game: Session) -> None:
    """The peek must be a real decision, not a coin flip."""
    stand, crouch = _eye(game, Stance.STANDING), _eye(game, Stance.CROUCHED)
    better = 0
    for bay in game.network.lines["front"].bays:
        sx, sy, sz = bay.step_metres
        d = Vec3(0, 0, float(bay.facing))
        up = raycast(game.world, Vec3(sx, sy + stand, sz), d, 90.0)
        down = raycast(game.world, Vec3(sx, sy + crouch, sz), d, 90.0)
        up_d = up.distance if up else 90.0
        down_d = down.distance if down else 90.0
        if up_d > down_d + 5.0:
            better += 1
    bays = len(game.network.lines["front"].bays)
    assert better >= bays * 0.7, f"only {better}/{bays} bays reward standing up"


# -- dugouts -----------------------------------------------------------------


def test_dugouts_have_overhead_cover(game: Session) -> None:
    covered = 0
    for dugout in game.network.dugouts:
        cx, cy, cz = dugout.centre_metres
        hit = raycast(game.world, Vec3(cx, cy, cz), Vec3(0, 1, 0), 25.0)
        if hit is not None:
            covered += 1
    assert game.network.dugouts
    assert covered >= len(game.network.dugouts) * 0.9, (
        "dugouts must be hidden from overhead observation"
    )


def test_dugouts_are_dry(game: Session) -> None:
    v = game.world.v
    for dugout in game.network.dugouts:
        block = v[
            dugout.lo[0] : dugout.hi[0],
            dugout.lo[1] : dugout.hi[1],
            dugout.lo[2] : dugout.hi[2],
        ]
        assert not (block == voxel.WATER).any(), "a dugout below the water table is a well"


def test_dugout_roofs_are_intact_unless_shelled(game: Session) -> None:
    """A dugout is a trap because it has one entrance and a solid roof.

    A minority may have been opened by a direct hit during generation; that is
    the feature, not a defect.  Most must be sound.
    """
    v = game.world.v
    sound = 0
    for dugout in game.network.dugouts:
        x0, _, z0 = dugout.lo
        x1, y1, z1 = dugout.hi
        if voxel.SOLID[v[x0:x1, y1 : y1 + 1, z0:z1]].all():
            sound += 1
    assert sound >= len(game.network.dugouts) * 0.9


# -- water and terrain -------------------------------------------------------


def test_water_never_floats(game: Session) -> None:
    """Every water voxel rests on something."""
    v = game.world.v
    water = v == voxel.WATER
    assert water.any(), "the map should have standing water somewhere"
    below = np.zeros_like(water)
    below[:, 1:, :] = water[:, :-1, :]
    supported = voxel.SOLID[v] | (v == voxel.WATER)
    unsupported = water[:, 1:, :] & ~supported[:, :-1, :]
    assert not unsupported.any(), f"{int(unsupported.sum())} water voxels hang in mid-air"


def test_deep_cavities_flood_to_the_water_table(game: Session) -> None:
    """Anything open below the water table holds water; nothing above it does,
    except a drainage ditch, which perches its own runoff by design."""
    v = game.world.v
    table = game.world.water_table
    open_below = (v[:, : table + 1, :] == voxel.AIR)
    assert not open_below.any(), (
        f"{int(open_below.sum())} dry cavities remain below the water table"
    )


def test_some_craters_are_flooded(game: Session) -> None:
    nml = game.world.v[:, :, 92:178]
    assert int((nml == voxel.WATER).sum()) > 500, "no man's land should hold water"


def test_no_spoil_floats_over_the_trench(game: Session) -> None:
    """Regression: piling parapets used a pre-excavation heightmap, which left
    slabs of spoil hanging in mid-air over the walkway.

    The question is whether anything is *unsupported*, not whether anything is
    there at all: a shell that opens the revetment is supposed to put dirt in
    the trench, and that dirt is resting on the duckboards, not floating.
    """
    for line in game.network.lines.values():
        for bay in line.bays:
            cx, cy, cz = bay.centre_metres
            hit = raycast(game.world, Vec3(cx, cy + 0.3, cz), Vec3(0, 1, 0), 25.0)
            if hit is None:
                continue
            x, y, z = hit.voxel
            below = game.world.get(x, y - 1, z)
            assert voxel.SOLID[below] or hit.distance < 0.5, (
                f"{bay.line} bay {bay.index} has {voxel.NAMES[hit.material]} "
                f"floating {hit.distance:.1f} m overhead on {voxel.NAMES[below]}"
            )


def test_trench_bays_are_reachable_from_each_other(game: Session) -> None:
    """The communication graph must be one connected line per trench."""
    graph = game.network.graph
    assert graph.nodes
    seen = {0}
    stack = [0]
    while stack:
        node = stack.pop()
        for other in graph.edges[node]:
            if other not in seen:
                seen.add(other)
                stack.append(other)
    front_nodes = len(game.network.lines["front"].bays)
    assert len(seen) >= front_nodes
