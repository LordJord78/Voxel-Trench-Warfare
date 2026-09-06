"""Rebuild ordering, which is a correctness policy rather than a perf tweak.

Collision and raycasts read the voxel array, not the mesh, so an unrebuilt
chunk is a wall the simulation has already deleted — the player takes cover
behind nothing and cannot see the breach they just made. FIFO is the one
ordering guaranteed to get that wrong under artillery, because the first thing
shelled is reliably not the thing being stood next to.

No engine here: the policy is arithmetic and is tested as arithmetic.
"""

from __future__ import annotations

import numpy as np
import pytest

from trenchline.data import load_tunables
from trenchline.render.schedule import (
    BAND_HIDDEN_FAR,
    BAND_HIDDEN_NEAR,
    BAND_VISIBLE_FAR,
    BAND_VISIBLE_NEAR,
    SchedulePolicy,
    StalenessReport,
    rank,
)
from trenchline.world.chunks import VoxelWorld, WorldDims

EYE = np.zeros(3)
FORWARD = np.array([0.0, 0.0, 1.0])
RADIUS = 6.9


@pytest.fixture(scope="module")
def policy():
    return SchedulePolicy.from_tunables(load_tunables())


def _order(centres, policy):
    order, distance, visible = rank(
        np.asarray(centres, dtype=float), EYE, FORWARD, policy, RADIUS
    )
    return [tuple(centres[int(i)]) for i in order], distance, visible


# -- ordering ----------------------------------------------------------------


def test_bands_run_from_underfoot_to_over_the_horizon() -> None:
    assert BAND_VISIBLE_NEAR < BAND_HIDDEN_NEAR < BAND_VISIBLE_FAR < BAND_HIDDEN_FAR


def test_what_you_are_looking_at_and_standing_next_to_goes_first(policy) -> None:
    near_visible = (0.0, 0.0, 10.0)
    near_hidden = (0.0, 0.0, -10.0)
    far_visible = (0.0, 0.0, 100.0)
    far_hidden = (0.0, 0.0, -100.0)
    ordered, _, _ = _order(
        [far_hidden, far_visible, near_hidden, near_visible], policy
    )
    assert ordered == [near_visible, near_hidden, far_visible, far_hidden]


def test_near_and_hidden_beats_far_and_visible(policy) -> None:
    """You can turn round in one frame, and collision never cared where the
    camera was pointing in the first place."""
    ordered, _, _ = _order([(0.0, 0.0, 120.0), (0.0, 0.0, -8.0)], policy)
    assert ordered[0] == (0.0, 0.0, -8.0)


def test_within_a_band_the_nearest_goes_first(policy) -> None:
    ordered, _, _ = _order(
        [(0.0, 0.0, 25.0), (0.0, 0.0, 5.0), (0.0, 0.0, 15.0)], policy
    )
    assert ordered == [(0.0, 0.0, 5.0), (0.0, 0.0, 15.0), (0.0, 0.0, 25.0)]


def test_ranking_an_empty_queue_is_not_an_error(policy) -> None:
    order, distance, visible = rank(
        np.zeros((0, 3)), EYE, FORWARD, policy, RADIUS
    )
    assert order.size == distance.size == visible.size == 0


# -- visibility --------------------------------------------------------------


def test_what_is_behind_you_is_not_visible(policy) -> None:
    _, _, visible = _order([(0.0, 0.0, -20.0)], policy)
    assert not visible[0]


def test_what_is_in_front_of_you_is_visible(policy) -> None:
    _, _, visible = _order([(0.0, 0.0, 20.0)], policy)
    assert visible[0]


def test_a_chunk_just_off_the_edge_still_counts_as_visible(policy) -> None:
    """The cone is widened by the chunk's own angular radius. Being mean here
    pops geometry in at the screen edge the moment the player turns."""
    import math

    limit = math.acos(policy.cos_half_fov)
    distance = 20.0
    just_outside = limit + math.asin(RADIUS / distance) * 0.5
    centre = (
        math.sin(just_outside) * distance,
        0.0,
        math.cos(just_outside) * distance,
    )
    _, _, visible = _order([centre], policy)
    assert visible[0]


def test_something_far_enough_off_axis_is_not_visible(policy) -> None:
    _, _, visible = _order([(60.0, 0.0, 6.0)], policy)
    assert not visible[0]


# -- coalescing --------------------------------------------------------------


def test_a_chunk_shelled_three_times_rebuilds_once() -> None:
    world = VoxelWorld(WorldDims(32, 32, 32))
    for _ in range(3):
        world.mark_dirty((1, 0, 1))
    assert world.dirty_count == 1
    assert world.dirtied_total == 1
    assert world.coalesced_total == 2


def test_coalescing_keeps_the_first_timestamp() -> None:
    """Staleness is how long the player has been looking at wrong geometry.
    That clock starts at the first change, not the most recent one."""
    world = VoxelWorld(WorldDims(32, 32, 32))
    world.frame = 10
    world.mark_dirty((1, 0, 1))
    world.frame = 40
    world.mark_dirty((1, 0, 1))
    assert world.dirty_since((1, 0, 1)) == 10


def test_a_rebuilt_chunk_leaves_the_queue() -> None:
    world = VoxelWorld(WorldDims(32, 32, 32))
    world.mark_dirty((1, 0, 1))
    world.clear_dirty((1, 0, 1))
    assert world.dirty_count == 0
    assert world.dirty_since((1, 0, 1)) is None


# -- staleness accounting ----------------------------------------------------


def test_consecutive_visible_frames_are_what_is_counted() -> None:
    report = StalenessReport()
    for frame in range(1, 6):
        report.observe(
            [("a",)], np.array([frame]), np.array([12.0]), frame
        )
    assert report.worst_visible_frames == 5
    assert report.worst_visible_distance_m == pytest.approx(12.0)


def test_a_chunk_that_leaves_the_near_view_stops_accumulating() -> None:
    """A chunk shelled behind you and turned toward two seconds later was a
    visible lie for one frame, not for two seconds."""
    report = StalenessReport()
    for frame in range(1, 4):
        report.observe([("a",)], np.array([frame]), np.array([9.0]), frame)
    report.observe([], np.zeros(0, np.int64), np.zeros(0), 4)      # out of view
    report.observe([("a",)], np.array([120]), np.array([9.0]), 5)  # back again
    assert report.worst_visible_frames == 3
    assert report.worst_frames == 120, "total staleness is still reported"


def test_the_summary_separates_shown_from_outstanding() -> None:
    report = StalenessReport()
    report.observe([("a",)], np.array([90]), np.array([7.0]), 90)
    summary = report.summary()
    assert summary["worst_frames"] == 90.0
    assert summary["worst_visible_frames"] == 1.0
    assert summary["worst_ms"] == pytest.approx(90 * 1000 / 60)


def test_an_empty_report_summarises_to_zero() -> None:
    assert StalenessReport().summary()["worst_frames"] == 0.0


# -- the policy itself -------------------------------------------------------


def test_the_budget_is_time_not_a_chunk_count(policy) -> None:
    """Chunks differ by an order of magnitude in cost, so a count is a time
    budget with the units filed off."""
    assert policy.budget_ms > 0.0
    assert policy.budget_ms < 16.67, "the whole frame is not a rebuild budget"
    assert policy.min_rebuilds >= 1, "a single expensive chunk could stall forever"


def test_the_view_cone_circumscribes_the_frustum(policy) -> None:
    import math

    half = math.degrees(math.acos(policy.cos_half_fov))
    assert half > policy.fov_deg * 0.5, "the cone must contain the frustum corners"
    assert half < 90.0
