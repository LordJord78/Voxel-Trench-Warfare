"""The entrenching tool: the counter to a position degrading under shellfire.

Artillery ramping spoil over a traverse is correct physics and good mechanics,
but a degradation with no counter is only attrition. The counter is priced in
time spent standing up, and these assert both the price and the limits — a
shovel must not become a way to quietly re-excavate the map.
"""

from __future__ import annotations

import pytest

from trenchline.physics.character import MoveIntent, Stance
from trenchline.physics.vec import Vec3
from trenchline.session import Session, SessionConfig
from trenchline.world import voxel
from trenchline.world.entrenching import DigPolicy, EntrenchingTool, fill_in
from trenchline.world.chunks import VoxelWorld, WorldDims

TICK = 1.0 / 60.0


@pytest.fixture
def bench(tun):
    """A floor, a heap of spoil in front of the player, and a revetment."""
    world = VoxelWorld(WorldDims(32, 32, 32))
    world.v[:, :8, :] = voxel.SUBSOIL
    world.v[10, 8, 12] = voxel.SPOIL
    world.v[10, 9, 12] = voxel.RUBBLE
    world.v[10, 8, 13] = voxel.TIMBER          # revetment
    world.v[10, 8, 14] = voxel.DUCKBOARD
    tool = EntrenchingTool(world, DigPolicy.from_tunables(tun))
    return world, tool


@pytest.fixture(scope="module")
def tun():
    from trenchline.data import load_tunables

    return load_tunables()


def _dig(tool, world, seconds: float, x=5.25, y=4.0, z=5.25, yaw=0.0) -> None:
    for _ in range(int(seconds / TICK)):
        tool.work(x, y, z, yaw, TICK)


# -- what a shovel may touch -------------------------------------------------


def test_loose_fill_can_be_dug(bench, tun) -> None:
    world, tool = bench
    _dig(tool, world, tun.f("entrenching.seconds_per_voxel") + 0.1)
    assert tool.cleared == 1


def test_revetment_duckboards_and_strata_are_not_shovel_work(bench, tun) -> None:
    """Otherwise the entrenching tool is a terrain editor."""
    world, tool = bench
    _dig(tool, world, 30.0)
    assert world.v[10, 8, 13] == voxel.TIMBER
    assert world.v[10, 8, 14] == voxel.DUCKBOARD
    assert world.v[10, 7, 12] == voxel.SUBSOIL, "it dug into undisturbed ground"


def test_nothing_in_reach_means_no_target(bench, tun) -> None:
    world, tool = bench
    assert tool.find_target(28.0, 4.0, 28.0, 0.0) is None


def test_digging_removes_the_dirt_rather_than_moving_it(bench, tun) -> None:
    """Spoil goes over the parapet. A trench that gets deeper every time
    someone tidies it is not a mechanic anyone wants."""
    world, tool = bench
    loose_before = int(voxel.LOOSE[world.v].sum())
    _dig(tool, world, tun.f("entrenching.seconds_per_voxel") * 1.1)
    assert int(voxel.LOOSE[world.v].sum()) == loose_before - 1


# -- the price ---------------------------------------------------------------


def test_a_voxel_takes_the_time_it_is_tuned_to(bench, tun) -> None:
    world, tool = bench
    per = tun.f("entrenching.seconds_per_voxel")
    _dig(tool, world, per * 0.8)
    assert tool.cleared == 0, "the dirt came out early"
    _dig(tool, world, per * 0.4)
    assert tool.cleared == 1


def test_progress_survives_being_interrupted(bench, tun) -> None:
    """Being shot at should make you stop. It should not make you start again."""
    world, tool = bench
    per = tun.f("entrenching.seconds_per_voxel")
    _dig(tool, world, per * 0.7)
    banked = dict(tool.progress)
    assert banked and max(banked.values()) > 0.0

    tool.idle()
    for _ in range(120):                       # take cover for two seconds
        pass
    assert tool.progress == banked, "progress was lost by letting go"
    _dig(tool, world, per * 0.5)
    assert tool.cleared == 1


def test_the_progress_bar_reflects_the_current_voxel(bench, tun) -> None:
    world, tool = bench
    _dig(tool, world, tun.f("entrenching.seconds_per_voxel") * 0.5)
    assert 0.2 < tool.target_fraction < 0.9


# -- through the session -----------------------------------------------------


def _blocked_bay(game: Session):
    for bay in game.network.lines["front"].bays:
        box = ((bay.x0, bay.floor_y + 1, bay.z0), (bay.x1, bay.floor_y + 5, bay.z1))
        if fill_in(game.world, *box):
            return bay, box
    pytest.skip("this seed's front line is not blocked anywhere")


def test_a_shelled_bay_can_be_dug_back_out() -> None:
    game = Session(SessionConfig(seed=21))
    bay, box = _blocked_bay(game)
    before = fill_in(game.world, *box)

    cx, cy, cz = bay.centre_metres
    game.player.position = Vec3(cx, cy + 0.05, cz)
    game.intent = MoveIntent()
    game.run_ticks(20)
    game.intent = MoveIntent(dig=True)
    game.run_ticks(60 * 40)
    assert fill_in(game.world, *box) < before, "forty seconds of work moved nothing"


def test_you_cannot_dig_lying_down() -> None:
    game = Session(SessionConfig(seed=21))
    bay, _ = _blocked_bay(game)
    cx, cy, cz = bay.centre_metres
    game.player.position = Vec3(cx, cy + 0.05, cz)
    game.intent = MoveIntent(stance=Stance.PRONE)
    game.run_ticks(90)
    game.intent = MoveIntent(dig=True, stance=Stance.PRONE)
    game.run_ticks(300)
    assert not game.digging
    assert game.entrenching.cleared == 0


def test_digging_costs_you_exposure_and_steadiness() -> None:
    game = Session(SessionConfig(seed=21))
    bay, _ = _blocked_bay(game)
    cx, cy, cz = bay.centre_metres
    game.player.position = Vec3(cx, cy + 0.05, cz)
    game.intent = MoveIntent()
    game.run_ticks(20)
    idle = game.exposure()
    game.intent = MoveIntent(dig=True)
    game.run_ticks(10)
    assert game.digging
    assert game.exposure() > idle
    assert game.tun.f("entrenching.sway_scale") > 1.0


def test_digging_is_deterministic() -> None:
    def run() -> int:
        game = Session(SessionConfig(seed=21))
        bay, _ = _blocked_bay(game)
        cx, cy, cz = bay.centre_metres
        game.player.position = Vec3(cx, cy + 0.05, cz)
        game.intent = MoveIntent(dig=True)
        game.run_ticks(600)
        return game.entrenching.cleared

    assert run() == run()
