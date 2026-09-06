"""Blowing holes in things, and what falls in afterwards.

The load-bearing property is that a carve and a collapse are one operation. A
crater that leaves spoil hanging over the walkway is wrong to look at and wrong
to shoot through, and one that does not put its dirt anywhere has made cover
out of nothing. Both halves are asserted here, on the real map as well as on
constructed cases.
"""

from __future__ import annotations

import numpy as np
import pytest

from trenchline.core.rng import GameRandom
from trenchline.data import load_tunables
from trenchline.session import Session, SessionConfig
from trenchline.world import destruction, voxel
from trenchline.world.chunks import VoxelWorld, WorldDims

SEEDS = (7, 21, 99)


@pytest.fixture(scope="module")
def tun():
    return load_tunables()


def _world(nx: int = 32, ny: int = 32, nz: int = 32) -> VoxelWorld:
    return VoxelWorld(WorldDims(nx, ny, nz))


# -- collapse ----------------------------------------------------------------


def test_soil_with_nothing_under_it_falls() -> None:
    world = _world()
    world.v[:, :4, :] = voxel.SUBSOIL
    world.v[10, 12, 10] = voxel.SPOIL          # hanging eight voxels up
    assert destruction.unsupported(world.v).any()

    destruction.collapse(world.v)
    assert not destruction.unsupported(world.v).any()
    assert world.v[10, 4, 10] == voxel.SPOIL, "it should have landed on the floor"
    assert world.v[10, 12, 10] == voxel.AIR


def test_a_falling_stack_keeps_its_order() -> None:
    """Undercut strata drop as a column; they must not turn over on the way.

    Clay and sod rather than spoil, because loose material is supposed to
    spread when it lands and the next test is the one that checks that.
    """
    world = _world()
    world.v[:, :4, :] = voxel.SUBSOIL
    world.v[10, 10, 10] = voxel.CLAY
    world.v[10, 11, 10] = voxel.SOD
    destruction.collapse(world.v)
    assert world.v[10, 4, 10] == voxel.CLAY
    assert world.v[10, 5, 10] == voxel.SOD, "the stack inverted on the way down"


def test_a_landed_heap_of_loose_material_spreads_out() -> None:
    """Two voxels of spoil dropped on a flat floor end up side by side, not
    stacked: that is the angle of repose doing its job."""
    world = _world()
    world.v[:, :4, :] = voxel.SUBSOIL
    world.v[10, 10, 10] = voxel.SPOIL
    world.v[10, 11, 10] = voxel.SANDBAG
    destruction.collapse(world.v)

    landed = np.argwhere((world.v == voxel.SPOIL) | (world.v == voxel.SANDBAG))
    assert len(landed) == 2, "material was created or lost"
    assert {int(y) for _, y, _ in landed} == {4}, "the heap did not spread"


def test_revetment_and_masonry_hold_themselves_up() -> None:
    """A dugout roof that slumps the moment a shell lands nearby is not a
    dugout. Timber, corrugate, concrete and brick are not granular."""
    world = _world()
    world.v[:, :4, :] = voxel.SUBSOIL
    for y, material in enumerate(
        (voxel.TIMBER, voxel.CONCRETE, voxel.BRICK, voxel.CORRUGATE), start=10
    ):
        world.v[10, y, 10] = material
    before = world.v.copy()
    destruction.collapse(world.v)
    assert np.array_equal(world.v, before), "structure fell"


def test_undisturbed_strata_do_not_erode() -> None:
    """Regression: the repose pass ran on all granular material, so every
    one-voxel step in a ploughed field slumped and the map settled into a
    plain. Only loose spoil, rubble and sandbags find an angle of repose.
    """
    world = _world()
    heights = 4 + (np.arange(32) % 3)          # a field full of one-voxel steps
    for x in range(32):
        world.v[x, : heights[x], :] = voxel.CLAY
        world.v[x, heights[x] - 1, :] = voxel.SOD
    before = world.v.copy()
    destruction.collapse(world.v)
    assert np.array_equal(world.v, before), (
        f"{int((world.v != before).sum())} voxels of intact ground slid"
    )


def test_loose_spoil_finds_a_slope() -> None:
    """A heap of fresh spoil should spread, not stand as a tower."""
    world = _world()
    world.v[:, :4, :] = voxel.SUBSOIL
    world.v[16, 4:14, 16] = voxel.SPOIL        # a ten-voxel column of spoil
    destruction.collapse(world.v)

    column = int((world.v[16, :, 16] == voxel.SPOIL).sum())
    assert column < 10, "the tower did not spread at all"
    footprint = (world.v == voxel.SPOIL).any(axis=1)
    assert int(footprint.sum()) > 1, "the spoil is still one column wide"
    assert not destruction.unsupported(world.v).any()


def test_dirt_displaces_water_rather_than_drinking_it() -> None:
    world = _world()
    world.v[:, :4, :] = voxel.SUBSOIL
    world.v[10, 4:8, 10] = voxel.WATER
    world.v[10, 12, 10] = voxel.SPOIL
    water_before = int((world.v == voxel.WATER).sum())

    destruction.collapse(world.v)
    assert int((world.v == voxel.WATER).sum()) == water_before, (
        "a crater filling itself in should displace its puddle, not absorb it"
    )
    assert world.v[10, 4, 10] == voxel.SPOIL, "the dirt should have sunk to the bottom"


def test_collapse_is_idempotent() -> None:
    world = _world()
    world.v[:, :4, :] = voxel.SUBSOIL
    rng = np.random.default_rng(2)
    scatter = rng.random((32, 32, 32)) < 0.03
    world.v[scatter & (world.v == voxel.AIR)] = voxel.SPOIL

    destruction.collapse(world.v)
    settled = world.v.copy()
    assert destruction.collapse(world.v) == 0, "a settled world kept moving"
    assert np.array_equal(world.v, settled)


def test_collapse_is_deterministic() -> None:
    def run() -> np.ndarray:
        world = _world()
        world.v[:, :4, :] = voxel.SUBSOIL
        rng = np.random.default_rng(9)
        world.v[(rng.random((32, 32, 32)) < 0.05) & (world.v == voxel.AIR)] = voxel.SPOIL
        destruction.collapse(world.v)
        return world.v.copy()

    assert np.array_equal(run(), run())


def test_collapse_conserves_material() -> None:
    world = _world()
    world.v[:, :4, :] = voxel.SUBSOIL
    world.v[8:24, 10:14, 8:24] = voxel.SPOIL
    before = int((world.v == voxel.SPOIL).sum())
    destruction.collapse(world.v)
    assert int((world.v == voxel.SPOIL).sum()) == before, "spoil was created or lost"


# -- the map -----------------------------------------------------------------


@pytest.mark.parametrize("seed", SEEDS)
def test_generation_leaves_nothing_hanging(seed: int) -> None:
    """Crater spheres undercut the trench walls, leaving about a thousand
    voxels of spoil in mid-air over the walkway. Generation now settles them.
    """
    game = Session(SessionConfig(seed=seed))
    hanging = destruction.unsupported(game.world.v)
    assert int(hanging.sum()) == 0, (
        f"{int(hanging.sum())} voxels of soil are hanging over open air"
    )


@pytest.mark.parametrize("seed", SEEDS)
def test_the_trench_is_still_a_trench_after_it_settles(seed: int) -> None:
    """The dirt partially fills the trench; it must not bury it."""
    game = Session(SessionConfig(seed=seed))
    clear = 0
    bays = game.network.lines["front"].bays
    for bay in bays:
        x, y, z = bay.centre_voxel
        column = game.world.v[x, y : y + 4, z]
        if not voxel.SOLID[column].any():
            clear += 1
    assert clear >= len(bays) * 0.8, (
        f"only {clear}/{len(bays)} bays still have standing room on the walkway"
    )


# -- detonation --------------------------------------------------------------


def test_a_shell_makes_a_hole_and_dirties_the_chunks(tun) -> None:
    world = _world(64, 64, 64)
    world.v[:, :32, :] = voxel.CLAY
    world.water_table = 0
    solid_before = int(voxel.SOLID[world.v].sum())

    result = destruction.detonate(
        world, (16.0, 15.5, 16.0), 3.0, GameRandom(1).derive("boom"), tun
    )
    assert int(voxel.SOLID[world.v].sum()) < solid_before
    assert result.removed > 0
    assert result.box is not None
    assert world.dirty_count > 0, "the renderer was never told to rebuild"


def test_a_shell_leaves_nothing_hanging(tun) -> None:
    """The carve undercuts whatever was above it; the collapse is not optional."""
    world = _world(64, 64, 64)
    world.v[:, :40, :] = voxel.CLAY
    world.v[:, 36:40, :] = voxel.SPOIL
    world.water_table = 0
    destruction.detonate(
        world, (16.0, 17.0, 16.0), 4.0, GameRandom(2).derive("boom"), tun
    )
    assert not destruction.unsupported(world.v).any()


def test_concrete_resists_what_soil_does_not(tun) -> None:
    def carve(material: int) -> int:
        world = _world(64, 64, 64)
        world.v[:, :32, :] = material
        world.water_table = 0
        before = int(voxel.SOLID[world.v].sum())
        destruction.detonate(
            world, (16.0, 15.5, 16.0), 3.0, GameRandom(3).derive("boom"), tun
        )
        return before - int(voxel.SOLID[world.v].sum())

    assert carve(voxel.CONCRETE) < carve(voxel.CLAY) * 0.6, (
        "concrete gave way about as easily as mud"
    )


def test_a_shell_on_the_parapet_puts_dirt_in_the_trench(tun) -> None:
    """Per spec: the collapsed dirt partially fills the trench below."""
    game = Session(SessionConfig(seed=7))
    bay = game.network.lines["front"].bays[4]
    x, y, z = bay.centre_voxel
    s = voxel.VOXEL_SIZE

    walk_z = int(bay.walk_z)

    def walkway_fill() -> int:
        """Solid voxels standing in the walkway airspace above the duckboards.

        The walkway only, not the whole trench: the firing step is solid timber
        by design and would count as fill.
        """
        return int(voxel.SOLID[
            game.world.v[x - 4 : x + 5, y : y + 3, walk_z : walk_z + 1]
        ].sum())

    assert walkway_fill() == 0, "this bay was already blocked before the shell"

    # A shell into the parapet, level with the crest and just in front of the
    # bay. It takes out the revetment, and the bank behind it has nothing left
    # holding it up.
    front = bay.z1 if bay.facing > 0 else bay.z0 - 1
    destruction.detonate(
        game.world,
        ((x + 0.5) * s, (bay.crest_y - 1) * s, (front + 0.5) * s),
        3.2,
        game.stream("test.boom"),
        game.tun,
    )
    assert walkway_fill() > 0, (
        "the parapet came down but no dirt reached the trench"
    )
    assert not destruction.unsupported(game.world.v).any()


def test_detonation_is_deterministic(tun) -> None:
    def run() -> np.ndarray:
        world = _world(64, 64, 64)
        world.v[:, :32, :] = voxel.CLAY
        world.water_table = 0
        destruction.detonate(
            world, (16.0, 15.5, 16.0), 3.5, GameRandom(8).derive("boom"), tun
        )
        return world.v.copy()

    assert np.array_equal(run(), run())


# -- single rounds -----------------------------------------------------------


def test_a_rifle_round_marks_soil_but_not_concrete(tun) -> None:
    from trenchline.combat.ballistics import Impact
    from trenchline.physics.vec import Vec3

    world = _world()
    world.v[:, :8, :] = voxel.CLAY
    world.v[4, :8, 4] = voxel.CONCRETE

    def hit(x: int, z: int) -> bool:
        return destruction.chip(
            world,
            Impact(Vec3(0, 0, 0), (0, 1, 0), (x, 7, z), int(world.v[x, 7, z]),
                   700.0, 40.0, 900.0, "rifle"),
            tun,
        )

    assert hit(10, 10), "a rifle round should mark wet clay"
    assert world.v[10, 7, 10] == voxel.SPOIL_OF[voxel.CLAY]
    assert not hit(4, 4), "a rifle round should not chew through concrete"
    assert world.v[4, 7, 4] == voxel.CONCRETE


def test_a_spent_round_marks_nothing(tun) -> None:
    from trenchline.combat.ballistics import Impact
    from trenchline.physics.vec import Vec3

    world = _world()
    world.v[:, :8, :] = voxel.CLAY
    spent = Impact(Vec3(0, 0, 0), (0, 1, 0), (10, 7, 10), voxel.CLAY,
                   40.0, 380.0, 3.0, "rifle")
    assert not destruction.chip(world, spent, tun)
