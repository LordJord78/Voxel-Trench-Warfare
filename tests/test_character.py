"""Character controller behaviour."""

from __future__ import annotations

import pytest

from trenchline.physics.character import MoveIntent, Stance
from trenchline.physics.collision import box_hits_solid
from trenchline.physics.vec import Vec3
from trenchline.session import Session, SessionConfig


@pytest.fixture(scope="module")
def game() -> Session:
    return Session(SessionConfig(seed=7))


def _fresh(seed: int = 7) -> Session:
    return Session(SessionConfig(seed=seed))


@pytest.mark.parametrize("seed", [7, 21, 99])
def test_spawn_is_not_inside_geometry(seed: int) -> None:
    game = _fresh(seed)
    assert not box_hits_solid(
        game.world, game.player.position, game.controller.radius, game.player.height
    )


def test_player_settles_on_the_duckboards() -> None:
    game = _fresh()
    start_y = game.player.position.y
    game.run_ticks(60)
    assert game.player.on_ground
    assert abs(game.player.position.y - start_y) < 1.0
    assert abs(game.player.velocity.y) < 0.01


def test_player_cannot_walk_through_the_trench_wall() -> None:
    game = _fresh()
    game.run_ticks(30)
    game.player.yaw = 0.0  # straight at the enemy-side wall
    game.intent = MoveIntent(forward=1.0)
    before = game.player.position
    game.run_ticks(180)
    after = game.player.position
    assert abs(after.z - before.z) < 2.0, "walked through the parapet"
    assert not box_hits_solid(game.world, after, game.controller.radius, game.player.height)


def test_walking_down_the_bay_is_stopped_by_the_traverse() -> None:
    game = _fresh()
    game.run_ticks(30)
    game.player.yaw = 90.0
    game.intent = MoveIntent(forward=1.0)
    game.run_ticks(300)
    travelled = abs(game.player.position.x - game.generated.spawn[0])
    bay_length = game.tun.f("world.trench.bay_length_m")
    assert travelled < bay_length + 4.0, (
        f"travelled {travelled:.1f} m down the line; the traverse should stop you"
    )


def test_player_can_step_onto_the_firing_step() -> None:
    game = _fresh()
    game.run_ticks(30)
    bay = game.network.nearest_bay(game.player.position.x, game.player.position.z, "front")
    assert bay is not None and bay.has_firing_step
    game.player.yaw = 0.0 if bay.facing > 0 else 180.0
    game.intent = MoveIntent(forward=1.0)
    game.run_ticks(120)
    assert game.player.on_firing_step, "could not mount the firing step"
    assert game.player.stance is Stance.FIRING_STEP
    assert game.exposure() > 1.0, "the firing step must cost exposure"


def test_crouching_lowers_height_speed_and_exposure() -> None:
    game = _fresh()
    game.run_ticks(30)
    standing = game.controller.stances[Stance.STANDING]
    game.intent = MoveIntent(stance=Stance.CROUCHED)
    game.run_ticks(60)
    crouched = game.controller.stances[Stance.CROUCHED]
    assert game.player.stance is Stance.CROUCHED
    assert game.player.height == pytest.approx(crouched.height, abs=1e-3)
    assert crouched.height < standing.height
    assert crouched.speed < standing.speed
    assert crouched.exposure < standing.exposure


def test_prone_is_slowest_and_smallest() -> None:
    game = _fresh()
    stances = game.controller.stances
    order = [Stance.PRONE, Stance.CROUCHED, Stance.STANDING]
    assert [stances[s].height for s in order] == sorted(stances[s].height for s in order)
    assert [stances[s].exposure for s in order] == sorted(stances[s].exposure for s in order)
    assert [stances[s].speed for s in order] == sorted(stances[s].speed for s in order)


def test_stance_change_is_refused_under_a_low_ceiling() -> None:
    """Standing up inside a dugout must not push you through the roof."""
    game = _fresh()
    dugout = game.network.dugouts[0]
    cx, cy, cz = dugout.centre_metres
    game.player.position = Vec3(cx, dugout.lo[1] * 0.5, cz)
    game.player.height = game.controller.stances[Stance.PRONE].height
    game.player.stance = Stance.PRONE
    game.run_ticks(20)
    assert not box_hits_solid(
        game.world, game.player.position, game.controller.radius, game.player.height
    )


def test_player_stays_inside_the_map() -> None:
    game = _fresh()
    game.player.position = Vec3(1.0, 20.0, 1.0)
    game.player.yaw = 180.0
    game.intent = MoveIntent(forward=1.0, sprint=True)
    game.run_ticks(300)
    dims = game.world.dims.metres
    p = game.player.position
    assert 0.0 <= p.x <= dims[0] and 0.0 <= p.z <= dims[2]


def test_wading_in_a_flooded_crater_slows_you_down() -> None:
    game = _fresh()
    profile = game.controller.stances[Stance.STANDING]
    game.player.wade_depth = 0.8
    intent = MoveIntent(forward=1.0)
    wish = game.controller._wish_velocity(game.player, intent, profile)
    assert wish.length < profile.speed * 0.9


def test_simulation_cost_leaves_room_for_the_rest_of_the_game() -> None:
    import time

    game = _fresh()
    game.intent = MoveIntent(forward=1.0, strafe=0.4)
    game.run_ticks(60)
    t0 = time.perf_counter()
    game.run_ticks(600)
    per_tick = (time.perf_counter() - t0) / 600 * 1000.0
    assert per_tick < 1.0, f"{per_tick:.3f} ms/tick for one character is too much"
