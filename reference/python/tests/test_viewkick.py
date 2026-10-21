"""The cosmetic recoil layer, and the contract that keeps it cosmetic.

Splitting recoil in two only works if the split is real: the aim layer decides
where rounds go and stays light, the cosmetic layer decides how heavy the rifle
feels and is never read back. The load-bearing test here is
`test_the_cosmetic_layer_cannot_move_a_bullet` — everything else is feel.
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pytest

from trenchline.combat.particles import ParticlePool, spec_from_tunables
from trenchline.combat.viewkick import ViewKickProfile, load_viewkick
from trenchline.core.rng import GameRandom
from trenchline.data import load_tunables
from trenchline.physics.character import MoveIntent
from trenchline.session import Session, SessionConfig

TICK = 1.0 / 60.0
WEAPON = "assault_rifle"


@pytest.fixture(scope="module")
def tun():
    return load_tunables()


@pytest.fixture
def kit(tun):
    pool = ParticlePool(tun)
    return load_viewkick(tun, WEAPON, GameRandom(5).derive("vk"), pool), pool


def _basis():
    return (0.0, 0.0, 1.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)


# -- the contract ------------------------------------------------------------


def test_the_cosmetic_layer_cannot_move_a_bullet() -> None:
    """Zero the whole cosmetic layer and the rounds land in the same voxels.

    This is the property the split exists for. If it ever fails, tuning how the
    gun *looks* has started changing how it *shoots*.
    """

    class _NoCosmetics:
        """Stands in for the whole cosmetic layer, doing nothing at all."""

        state = property(lambda self: None)

        def shot(self, *args, **kwargs):
            return None

        def tick(self, dt):
            return None

    def burst(disable_cosmetic: bool) -> list:
        game = Session(SessionConfig(seed=11))
        game.player.yaw = 0.0
        if disable_cosmetic:
            game.viewkick = _NoCosmetics()  # type: ignore[assignment]
        hits = []
        game.intent = MoveIntent(fire=True)
        for _ in range(240):
            game.tick()
            hits.extend((i.voxel, round(i.distance, 9)) for i in game.impacts)
        return hits

    with_cosmetic = burst(False)
    without = burst(True)
    assert with_cosmetic, "the burst hit nothing; the test proves nothing"
    assert with_cosmetic == without


def test_the_cosmetic_layer_is_not_in_the_determinism_digest() -> None:
    """Cosmetic state is excluded on purpose, so retuning weight does not
    invalidate the goldens. The exclusion is only safe because of the test
    above."""
    game = Session(SessionConfig(seed=11))
    before = game.state_digest()
    game.viewkick.state.back = 0.25
    game.viewkick.state.pitch = 9.0
    game.particles.emit((1.0, 2.0, 3.0), (0.0, 1.0, 0.0),
                        spec_from_tunables(game.tun, "particles.brass"), 8)
    assert game.state_digest() == before


def test_no_cosmetic_magnitude_is_hard_coded() -> None:
    source = Path("trenchline/combat/viewkick.py").read_text()
    body = re.sub(r'"""[\s\S]*?"""', "", source)
    body = re.sub(r"#.*", "", body)
    body = re.sub(r"_SETTLE_CONSTANT = [\d.]+", "", body)
    suspicious = [
        literal for literal in re.findall(r"(?<![\w.])\d+\.\d+", body)
        if literal not in {"1.0", "0.0", "2.0", "1e-6", "1e-3", "0.2"}
    ]
    assert not suspicious, f"hard-coded magnitudes in viewkick.py: {suspicious}"


# -- attack timing -----------------------------------------------------------


def test_the_viewmodel_is_at_its_peak_on_the_shot_frame(kit) -> None:
    """Same rule as the aim layer: an attack you can watch reads as weightless."""
    kick, _ = kit
    kick.shot((0, 1.6, 0), *_basis())
    peak_now = abs(kick.state.back)
    later = []
    for _ in range(30):
        kick.tick(TICK)
        later.append(abs(kick.state.back))
    assert peak_now >= max(later), "the viewmodel ramped instead of snapping"


def test_the_viewmodel_overshoots_on_the_way_back(kit, tun) -> None:
    """Under-damping is what reads as mass, and it is allowed here precisely
    because nothing downstream is aiming with it."""
    kick, _ = kit
    assert kick.profile.damping_ratio < 1.0
    kick.shot((0, 1.6, 0), *_basis())
    trace = []
    for _ in range(60):
        kick.tick(TICK)
        trace.append(kick.state.back)
    assert min(trace) < 0.0, "no overshoot: the viewmodel just eased back"


def test_the_aim_layer_still_does_not_overshoot() -> None:
    game = Session(SessionConfig(seed=3))
    game.recoil.shot()
    trace = []
    for _ in range(60):
        game.recoil.tick(TICK)
        trace.append(game.recoil.state.kick_pitch)
    assert min(trace) > -0.02 * max(trace), "the sight picture bounced"


def test_both_layers_settle_together(tun) -> None:
    """A viewmodel still moving after the sight picture has stopped is the
    failure mode of splitting them: it reads as two guns."""
    aim = tun.f("recoil.assault_rifle.settle_time_s")
    cosmetic = ViewKickProfile.from_tunables(tun, WEAPON).settle_time_s
    assert abs(cosmetic - aim) <= 0.08, (
        f"aim settles in {aim}s and the viewmodel in {cosmetic}s"
    )


def test_the_viewmodel_moves_further_than_the_sight_picture(tun) -> None:
    """The whole point: weight lives where it costs nothing."""
    aim = tun.f("recoil.assault_rifle.kick_pitch_deg")
    view = ViewKickProfile.from_tunables(tun, WEAPON).punch_pitch_deg
    assert view > aim * 2.0, f"viewmodel {view} deg vs aim {aim} deg"


def test_the_two_layers_are_driven_by_one_event(kit, tun) -> None:
    """The viewmodel takes the aim kick as an input, so they cannot drift."""
    kick, _ = kit
    assert kick.profile.aim_pitch_follow > 0.0
    kick.shot((0, 1.6, 0), *_basis(), aim_kick_deg=0.0)
    small = kick.state.pitch
    kick.reset()
    kick.shot((0, 1.6, 0), *_basis(), aim_kick_deg=1.0)
    assert kick.state.pitch > small


# -- what a shot throws off --------------------------------------------------


def test_a_shot_makes_a_flash_and_ejects_brass(kit) -> None:
    kick, pool = kit
    kick.shot((0.0, 1.6, 0.0), *_basis())
    assert pool.count >= 2, "expected at least a flash and a case"


def test_the_flash_is_gone_within_a_few_frames(kit) -> None:
    kick, pool = kit
    kick.shot((0.0, 1.6, 0.0), *_basis())
    started = pool.count
    for _ in range(6):
        pool.step(TICK)
    assert pool.count < started, "the muzzle flash is lingering like a flare"


def test_brass_is_thrown_right_and_falls(kit) -> None:
    kick, pool = kit
    kick.shot((0.0, 1.6, 0.0), *_basis())
    for _ in range(20):
        pool.step(TICK)
    assert pool.count, "the brass vanished"
    assert float(pool.position[: pool.count, 0].max()) > 0.05, "brass went nowhere"
    assert float(pool.velocity[: pool.count, 1].min()) < 0.0, "brass is not falling"


def test_a_report_carries_the_transient(kit) -> None:
    """No audio backend is wired; the shape of the sound is emitted anyway so
    the mixer is not invented from scratch later."""
    kick, _ = kit
    report = kick.shot((1.0, 2.0, 3.0), *_basis())
    assert report.peak_db > 100.0
    assert 20.0 < report.low_hz < 500.0
    assert report.length_s > 0.0
    assert report.position != (1.0, 2.0, 3.0), "the muzzle is not the eye"


# -- the particle pool -------------------------------------------------------


def test_particles_expire_and_the_pool_compacts(tun) -> None:
    pool = ParticlePool(tun, capacity=64)
    brass = spec_from_tunables(tun, "particles.brass")
    flash = spec_from_tunables(tun, "particles.muzzle_flash")
    pool.emit((0, 0, 0), (0, 0, 0), brass, 10)
    pool.emit((0, 0, 0), (0, 0, 0), flash, 10)
    assert pool.count == 20
    for _ in range(10):
        pool.step(TICK)
    assert pool.count == 10, "the short-lived particles did not expire"
    for _ in range(120):
        pool.step(TICK)
    assert pool.count == 0


def test_compaction_keeps_the_survivors_own_state(tun) -> None:
    """Survivors are moved down over the dead; they must not inherit."""
    pool = ParticlePool(tun, capacity=64)
    flash = spec_from_tunables(tun, "particles.muzzle_flash")
    brass = spec_from_tunables(tun, "particles.brass")
    pool.emit((9.0, 9.0, 9.0), (0, 0, 0), flash, 4)
    pool.emit((1.0, 2.0, 3.0), (0, 0, 0), brass, 1)
    for _ in range(8):
        pool.step(TICK)
    assert pool.count == 1
    assert float(pool.position[0][0]) == pytest.approx(1.0, abs=1e-4)


def test_the_pool_is_a_ceiling_and_says_so(tun) -> None:
    pool = ParticlePool(tun, capacity=8)
    brass = spec_from_tunables(tun, "particles.brass")
    assert pool.emit((0, 0, 0), (0, 0, 0), brass, 20) == 8
    assert pool.dropped == 12


def test_billboards_fade_over_a_particle_s_life(tun) -> None:
    pool = ParticlePool(tun, capacity=8)
    pool.emit((0, 0, 0), (0, 0, 0), spec_from_tunables(tun, "particles.brass"), 1)
    _, _, first = pool.billboards()
    for _ in range(60):
        pool.step(TICK)
    _, _, later = pool.billboards()
    assert pool.count == 1
    assert int(later[0][3]) < int(first[0][3]), "alpha did not fade"


def test_particles_are_deterministic(tun) -> None:
    def run() -> np.ndarray:
        pool = ParticlePool(tun)
        kick = load_viewkick(tun, WEAPON, GameRandom(21).derive("vk"), pool)
        for _ in range(12):
            kick.shot((0.0, 1.6, 0.0), *_basis())
            for _ in range(5):
                kick.tick(TICK)
                pool.step(TICK)
        return pool.position[: pool.count].copy()

    assert np.array_equal(run(), run())
