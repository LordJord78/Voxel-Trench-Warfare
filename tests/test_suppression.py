"""Being shot at, with nothing hitting you.

Most rounds miss, and the ones that miss are doing the work. These assert that
a near miss costs something real — movement, aim, and the parapet — rather than
only greying the screen, because the visual half is communication and the
simulation half is the mechanic.
"""

from __future__ import annotations

import math

import pytest

from trenchline.combat.suppression import (
    SuppressionProfile,
    load_suppression,
    segment_distance,
)
from trenchline.core.rng import GameRandom
from trenchline.data import load_tunables
from trenchline.physics.character import MoveIntent, Stance
from trenchline.physics.vec import Vec3
from trenchline.session import Session, SessionConfig

TICK = 1.0 / 60.0


@pytest.fixture(scope="module")
def tun():
    return load_tunables()


@pytest.fixture
def sup(tun):
    return load_suppression(tun, GameRandom(4).derive("sup"))


# -- what counts as a near miss ----------------------------------------------


def test_a_near_miss_is_measured_against_the_flight_path() -> None:
    """A rifle round covers 3.7 m in a tick. A test that only looked at where
    it stopped would miss every round that missed — which is all the
    interesting ones."""
    a, b = Vec3(0.0, 0.0, -20.0), Vec3(0.0, 0.0, 20.0)
    head = Vec3(0.5, 0.0, 0.0)
    assert segment_distance(a, b, head) == pytest.approx(0.5)
    # Both endpoints are 20 m away; only the path comes close.
    assert (head - a).length > 19.0 and (head - b).length > 19.0


def test_a_round_that_stops_short_is_not_a_near_miss() -> None:
    a, b = Vec3(0.0, 0.0, -20.0), Vec3(0.0, 0.0, -10.0)
    assert segment_distance(a, b, Vec3(0.0, 0.0, 0.0)) == pytest.approx(10.0)


def test_a_degenerate_segment_is_a_point() -> None:
    a = Vec3(1.0, 2.0, 3.0)
    assert segment_distance(a, a, Vec3(1.0, 2.0, 6.0)) == pytest.approx(3.0)


def test_closer_is_worse_and_non_linearly_so(sup) -> None:
    """A round that parts your hair is not twice as bad as one two metres out."""
    radius = sup.profile.crack_radius_m
    levels = []
    for distance in (radius * 0.9, radius * 0.5, 0.05):
        sup.reset()
        sup.crack(distance)
        levels.append(sup.level)
    assert levels[0] < levels[1] < levels[2]
    assert levels[2] > levels[1] * 1.8, "the falloff is basically linear"


def test_a_round_outside_the_radius_does_nothing(sup) -> None:
    sup.crack(sup.profile.crack_radius_m + 0.01)
    assert sup.level == 0.0
    assert sup.state.cracks == 0


def test_a_crack_counts_for_more_than_an_impact(sup, tun) -> None:
    """Dirt kicking up beside you is frightening. A crack past your ear is
    frightening AND means they have your range."""
    assert sup.profile.crack_amount > sup.profile.impact_amount


# -- the level ---------------------------------------------------------------


def test_a_burst_pins_you_and_then_it_wears_off(sup) -> None:
    for _ in range(6):
        sup.crack(1.0)
        for _ in range(9):
            sup.tick(TICK)
    assert sup.level > 0.7, f"six close rounds only reached {sup.level:.2f}"

    elapsed = 0.0
    while sup.level > 0.01 and elapsed < 30.0:
        sup.tick(TICK)
        elapsed += TICK
    assert 1.0 < elapsed < 6.0, f"took {elapsed:.1f}s to recover"


def test_the_level_holds_briefly_so_a_burst_does_not_bleed_off_mid_burst(sup) -> None:
    sup.crack(0.5)
    peak = sup.level
    for _ in range(int(sup.profile.hold_s / TICK) - 2):
        sup.tick(TICK)
    assert sup.level == pytest.approx(peak), "it started recovering inside the hold"


def test_the_level_is_capped(sup) -> None:
    for _ in range(50):
        sup.crack(0.0)
    assert sup.level == pytest.approx(sup.profile.max_level)


# -- what it costs -----------------------------------------------------------


def test_being_pinned_takes_your_movement(sup) -> None:
    assert sup.speed_scale == pytest.approx(1.0)
    for _ in range(20):
        sup.crack(0.2)
    assert sup.speed_scale < 0.5, "pinned should mean pinned"


def test_being_pinned_takes_your_aim_apart(sup) -> None:
    assert sup.sway_scale == pytest.approx(1.0)
    for _ in range(20):
        sup.crack(0.2)
    assert sup.sway_scale > 3.0


def test_a_near_miss_drags_the_muzzle(sup) -> None:
    sup.crack(0.1)
    yaw, pitch = sup.aim_offset
    assert pitch > 0.0
    for _ in range(120):
        sup.tick(TICK)
    assert abs(sup.aim_offset[1]) < abs(pitch) * 0.1, "the flinch never recovered"


def test_enough_fire_takes_the_parapet_away_from_you(sup) -> None:
    assert not sup.forced_off_the_step
    for _ in range(20):
        sup.crack(0.2)
    assert sup.forced_off_the_step


def test_the_visual_layer_tracks_the_level_and_nothing_else(sup) -> None:
    assert (sup.desaturation, sup.vignette, sup.blur) == (0.0, 0.0, 0.0)
    for _ in range(20):
        sup.crack(0.2)
    assert sup.desaturation > 0.0 and sup.vignette > 0.0
    sup.tick(TICK)          # the shake needs a phase, which needs a tick
    assert sup.shake()[0] != 0.0 or sup.shake()[1] != 0.0


# -- through the session -----------------------------------------------------


def _in_the_open(game: Session) -> None:
    import numpy as np

    from trenchline.world import voxel

    bay = game.network.lines["front"].bays[3]
    x, _, z = bay.centre_metres
    z += 14.0
    column = game.world.v[int(x / 0.5), :, int(z / 0.5)]
    top = float(np.nonzero(voxel.SOLID[column])[0][-1] + 1) * 0.5
    game.player.position = Vec3(x, top + 0.05, z)
    game.player.yaw = 0.0
    game.intent = MoveIntent()
    game.run_ticks(30)


def test_incoming_fire_suppresses_a_man_caught_in_the_open() -> None:
    game = Session(SessionConfig(seed=7, incoming_rpm=500.0, incoming_range_m=38.0))
    _in_the_open(game)
    peak = 0.0
    for _ in range(60 * 5):
        game.tick()
        peak = max(peak, game.suppression.level)
    assert peak > 0.6, f"five seconds of fire only reached {peak:.2f}"
    assert game.suppression.state.cracks > 0


def test_your_own_rifle_does_not_suppress_you() -> None:
    game = Session(SessionConfig(seed=7))
    _in_the_open(game)
    game.intent = MoveIntent(fire=True)
    game.run_ticks(300)
    assert game.weapon.state.shots_fired > 5
    assert game.suppression.level == 0.0
    assert game.suppression.state.cracks == 0


def test_suppression_pushes_you_off_the_firing_step() -> None:
    # Settle onto the step in peace first, or the rig has already pinned the
    # player before the test has established they were ever up there.
    game = Session(SessionConfig(seed=7, incoming_range_m=22.0))
    bay = game.network.lines["front"].bays[3]
    game.player.position = Vec3(*bay.step_metres)
    game.player.yaw = 0.0
    game.intent = MoveIntent()
    game.run_ticks(30)
    assert game.player.stance is Stance.FIRING_STEP

    game.config.incoming_rpm = 600.0
    for _ in range(60 * 6):
        game.tick()
        if game.player.pinned:
            break
    assert game.player.pinned, "six seconds of close fire did not pin the player"
    game.run_ticks(5)
    assert game.player.stance is not Stance.FIRING_STEP
    assert game.suppression.state.ejected > 0


def test_a_pinned_player_cannot_raise_the_periscope_either() -> None:
    game = Session(SessionConfig(seed=7))
    bay = game.network.lines["front"].bays[3]
    game.player.position = Vec3(*bay.step_metres)
    game.intent = MoveIntent(periscope=True)
    game.run_ticks(60)
    assert game.player.stance is Stance.PERISCOPE

    game.player.pinned = True
    game.suppression.state.level = 1.0
    game.run_ticks(60)
    assert game.player.stance is Stance.CROUCHED


def test_the_harassment_rig_is_off_unless_asked_for() -> None:
    game = Session(SessionConfig(seed=7))
    game.run_ticks(600)
    assert game.projectiles.count == 0
    assert game.suppression.level == 0.0


def test_suppression_is_deterministic() -> None:
    def run() -> tuple:
        game = Session(SessionConfig(seed=7, incoming_rpm=400.0))
        _in_the_open(game)
        game.run_ticks(400)
        state = game.suppression.state
        return (round(state.level, 9), state.cracks, state.impacts)

    assert run() == run()
