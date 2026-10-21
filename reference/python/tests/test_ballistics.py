"""Projectile flight has to be physics, and it has to be reproducible.

The physics half is checked against closed-form answers where one exists (drop
under gravity with no drag) and against the direction and ordering of effects
where one does not (drag slows a light round faster than a heavy one). The
reproducible half is checked by firing the same shot twice and demanding the
same voxel.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from trenchline.combat.ballistics import ProjectilePool, ProjectileSpec
from trenchline.combat.weapons import WeaponSpec, load_weapon
from trenchline.core.rng import GameRandom
from trenchline.data import load_tunables
from trenchline.physics.vec import Vec3, from_yaw_pitch
from trenchline.world import voxel
from trenchline.world.chunks import VoxelWorld, WorldDims

TICK = 1.0 / 60.0


@pytest.fixture(scope="module")
def tun():
    return load_tunables()


@pytest.fixture
def empty_world() -> VoxelWorld:
    """Open air with a floor, so a round has somewhere to go and to land.

    256 m along z, well past the playable map, because a rifle round covers
    60 m in a tenth of a second and a test range shorter than the effect being
    measured just retires the round at the world edge.
    """
    world = VoxelWorld(WorldDims(128, 64, 512))
    world.v[:, :4, :] = voxel.SUBSOIL
    return world


def _fly(pool: ProjectilePool, ticks: int = 240) -> list:
    impacts = []
    for _ in range(ticks):
        impacts.extend(pool.step(TICK))
        if pool.count == 0:
            break
    return impacts


# -- the spec ----------------------------------------------------------------


def test_drag_factor_folds_the_constants(tun) -> None:
    spec = ProjectileSpec.from_tunables(tun, "weapon.assault_rifle")
    expected = 0.5 * spec.drag_coefficient * spec.cross_section_m2 / spec.mass_kg
    assert spec.drag_factor == pytest.approx(expected)


def test_a_heavier_round_of_the_same_shape_carries_further(tun, empty_world) -> None:
    """Mass is in the denominator of the drag term, so sectional density is
    what decides retained velocity — not a per-weapon fudge."""
    light = ProjectileSpec("light", 0.0034, 0.3, 2.4e-5, 880.0)
    heavy = ProjectileSpec("heavy", 0.0102, 0.3, 2.4e-5, 880.0)
    speeds = []
    for spec in (light, heavy):
        pool = ProjectilePool(empty_world, tun)
        pool.fire(Vec3(4.0, 20.0, 4.0), Vec3(0, 0, 1), spec)
        for _ in range(12):
            pool.step(TICK)
            if pool.count == 0:
                break
        speeds.append(float(np.linalg.norm(pool.velocity[0])) if pool.count else 0.0)
    assert speeds[1] > speeds[0], "the heavier round should have shed less speed"


def test_drag_actually_slows_the_round(tun, empty_world) -> None:
    spec = ProjectileSpec.from_tunables(tun, "weapon.assault_rifle")
    pool = ProjectilePool(empty_world, tun)
    pool.fire(Vec3(4.0, 20.0, 4.0), Vec3(0, 0, 1), spec)
    speeds = []
    for _ in range(8):
        pool.step(TICK)
        if pool.count == 0:
            break
        speeds.append(float(np.linalg.norm(pool.velocity[0])))
    assert speeds == sorted(speeds, reverse=True), "speed must fall monotonically"
    assert speeds[0] < spec.muzzle_velocity


def test_muzzle_energy_is_in_the_right_league(tun, empty_world) -> None:
    """A 5.45 rifle round leaves the barrel with roughly 1.3 kJ. If this is out
    by an order of magnitude the mass or the velocity is wrong."""
    spec = ProjectileSpec.from_tunables(tun, "weapon.assault_rifle")
    energy = 0.5 * spec.mass_kg * spec.muzzle_velocity**2
    assert 1000.0 < energy < 1700.0, f"{energy:.0f} J at the muzzle"


# -- gravity -----------------------------------------------------------------


def test_drop_without_drag_matches_the_closed_form(tun, empty_world) -> None:
    """No drag, so the answer is exactly 1/2 g t^2 and any integrator error
    shows up directly."""
    spec = ProjectileSpec("dragless", 1.0, 0.0, 0.0, 300.0)
    pool = ProjectilePool(empty_world, tun)
    pool.fire(Vec3(4.0, 20.0, 4.0), Vec3(0, 0, 1), spec)

    ticks = 30
    for _ in range(ticks):
        pool.step(TICK)
    assert pool.count == 1
    t = ticks * TICK
    expected = 0.5 * tun.f("ballistics.gravity") * t * t
    drop = float(pool.position[0][1]) - 20.0
    assert drop == pytest.approx(expected, rel=0.02), (
        f"dropped {drop * 100:.1f} cm in {t:.2f} s, expected {expected * 100:.1f} cm"
    )


def test_a_slower_round_drops_more_over_the_same_distance(tun, empty_world) -> None:
    drops = []
    for muzzle in (300.0, 900.0):
        spec = ProjectileSpec("t", 0.01, 0.2, 2e-5, muzzle)
        pool = ProjectilePool(empty_world, tun)
        pool.fire(Vec3(4.0, 20.0, 4.0), Vec3(0, 0, 1), spec)
        while pool.count and float(pool.distance[0]) < 60.0:
            pool.step(TICK)
        drops.append(20.0 - float(pool.position[0][1]) if pool.count else 0.0)
    assert drops[0] > drops[1] > 0.0


# -- hitting things ----------------------------------------------------------


def test_a_round_stops_at_the_first_solid_voxel(tun, empty_world) -> None:
    empty_world.v[:, :, 60] = voxel.CONCRETE
    spec = ProjectileSpec.from_tunables(tun, "weapon.assault_rifle")
    pool = ProjectilePool(empty_world, tun)
    pool.fire(Vec3(4.0, 20.0, 4.0), Vec3(0, 0, 1), spec)
    impacts = _fly(pool)

    assert len(impacts) == 1
    impact = impacts[0]
    assert impact.material == voxel.CONCRETE
    assert impact.voxel[2] == 60
    assert pool.count == 0, "a round that hit something is not still flying"
    assert impact.energy_j > 0.0
    assert impact.distance == pytest.approx(28.0, abs=1.5)


def test_a_round_is_not_stopped_by_air_or_water(tun, empty_world) -> None:
    empty_world.v[:, 18:24, 30:40] = voxel.WATER
    empty_world.v[:, :, 60] = voxel.BRICK
    spec = ProjectileSpec.from_tunables(tun, "weapon.assault_rifle")
    pool = ProjectilePool(empty_world, tun)
    pool.fire(Vec3(4.0, 10.5, 4.0), Vec3(0, 0, 1), spec)
    impacts = _fly(pool)
    assert [i.material for i in impacts] == [voxel.BRICK]


def test_a_round_that_hits_nothing_is_retired_not_leaked(tun, empty_world) -> None:
    spec = ProjectileSpec("far", 0.01, 0.0, 0.0, 900.0)
    pool = ProjectilePool(empty_world, tun)
    pool.fire(Vec3(4.0, 30.0, 4.0), Vec3(0, 1, 0), spec)
    _fly(pool, ticks=600)
    assert pool.count == 0


# -- the pool ----------------------------------------------------------------


def test_the_pool_is_a_ceiling_and_says_so(tun, empty_world) -> None:
    spec = ProjectileSpec.from_tunables(tun, "weapon.assault_rifle")
    pool = ProjectilePool(empty_world, tun, capacity=4)
    slots = [pool.fire(Vec3(4, 20, 4), Vec3(0, 0, 1), spec) for _ in range(7)]
    assert slots[:4] != [-1, -1, -1, -1]
    assert slots[4:] == [-1, -1, -1]
    assert pool.dropped == 3
    assert pool.count == 4


def test_retiring_a_round_does_not_disturb_the_others(tun, empty_world) -> None:
    """Slots are compacted by swapping the last round down, so the surviving
    rounds must keep their own state rather than inheriting a neighbour's."""
    empty_world.v[:, :, 40] = voxel.CONCRETE
    fast = ProjectileSpec("fast", 0.01, 0.1, 1e-5, 900.0)
    slow = ProjectileSpec("slow", 0.01, 0.1, 1e-5, 120.0)
    pool = ProjectilePool(empty_world, tun)
    pool.fire(Vec3(4.0, 20.0, 4.0), Vec3(0, 0, 1), fast)
    pool.fire(Vec3(9.0, 20.0, 4.0), Vec3(0, 0, 1), slow)

    while pool.count == 2:
        pool.step(TICK)
    assert pool.count == 1
    survivor_x = float(pool.position[0][0])
    assert survivor_x == pytest.approx(9.0, abs=0.01), "the slow round lost its state"


def test_tracer_segments_trail_behind_the_head(tun, empty_world) -> None:
    spec = ProjectileSpec.from_tunables(tun, "weapon.assault_rifle")
    pool = ProjectilePool(empty_world, tun)
    pool.fire(Vec3(4.0, 20.0, 4.0), Vec3(0, 0, 1), spec)
    pool.step(TICK)
    head, tail = pool.tracer_segments(6.0)
    assert head.shape == tail.shape == (1, 3)
    assert head.dtype == np.float32
    assert head[0][2] > tail[0][2], "the tail must trail the head, not lead it"
    assert float(np.linalg.norm(head - tail)) <= 6.0 + 1e-3


def test_tracer_segments_of_an_empty_pool_are_empty(tun, empty_world) -> None:
    pool = ProjectilePool(empty_world, tun)
    head, tail = pool.tracer_segments(6.0)
    assert head.shape == (0, 3) and tail.shape == (0, 3)


# -- determinism -------------------------------------------------------------


def _shoot_a_burst(tun, world: VoxelWorld, seed: int) -> list[tuple]:
    pool = ProjectilePool(world, tun)
    weapon = load_weapon(tun, "assault_rifle", pool, GameRandom(seed).derive("shots"))
    impacts: list[tuple] = []
    for tick in range(300):
        weapon.tick(TICK)
        if weapon.ready and weapon.state.shots_fired < 12:
            weapon.fire(Vec3(4.0, 20.0, 4.0), 0.0, 0.0)
        impacts.extend((i.voxel, round(i.distance, 9)) for i in pool.step(TICK))
    return impacts


def test_the_same_seed_puts_the_rounds_through_the_same_voxels(tun, empty_world) -> None:
    empty_world.v[:, :, 70] = voxel.BRICK
    first = _shoot_a_burst(tun, empty_world, 5)
    second = _shoot_a_burst(tun, empty_world, 5)
    assert first and first == second


def test_a_different_seed_disperses_differently(tun, empty_world) -> None:
    empty_world.v[:, :, 70] = voxel.BRICK
    assert _shoot_a_burst(tun, empty_world, 5) != _shoot_a_burst(tun, empty_world, 6)


def test_dispersion_is_a_cone_and_not_a_square(tun, empty_world) -> None:
    """Sampling each axis independently piles rounds into the corners; the
    radius is square-rooted so the cone is evenly filled."""
    spec = WeaponSpec.from_tunables(tun, "assault_rifle")
    pool = ProjectilePool(empty_world, tun, capacity=4096)
    weapon = load_weapon(tun, "assault_rifle", pool, GameRandom(3).derive("d"))
    weapon.state.rounds = 4000

    offsets = []
    base = from_yaw_pitch(0.0, 0.0)
    for _ in range(2000):
        weapon.state.since_shot = 1e9
        slot = weapon.fire(Vec3(4.0, 20.0, 4.0), 0.0, 0.0)
        v = pool.velocity[slot]
        unit = v / np.linalg.norm(v)
        offsets.append(math.degrees(math.acos(min(1.0, float(
            unit @ np.array([base.x, base.y, base.z])
        )))))

    limit = spec.dispersion_moa / 60.0
    offsets_arr = np.array(offsets)
    assert offsets_arr.max() <= limit * 1.45, "rounds outside the cone"
    # Uniform area sampling puts the median at 1/sqrt(2) of the radius.
    assert np.median(offsets_arr) == pytest.approx(limit * 0.707, rel=0.15)
