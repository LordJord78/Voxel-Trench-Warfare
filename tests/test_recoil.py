"""Recoil is a feel system, so these assert the feel as numbers.

The brief for the assault rifle was: tiny kick, fast recovery, a quick vertical
climb that plateaus, and a mild rightward drift after about six rounds. Each of
those is a test. They are written against the tuning file rather than against
hard-coded constants, so retuning the weapon does not break them — only
changing what kind of weapon it is does.
"""

from __future__ import annotations

import math
import re

import pytest

from trenchline.combat.recoil import Recoil, RecoilProfile, advance_spring, load_recoil
from trenchline.core.rng import GameRandom
from trenchline.data import TUNABLES_PATH, load_tunables

TICK = 1.0 / 60.0
WEAPON = "assault_rifle"


@pytest.fixture(scope="module")
def tun():
    return load_tunables()


@pytest.fixture
def recoil(tun) -> Recoil:
    return load_recoil(tun, WEAPON, GameRandom(11).derive("recoil"))


def _fire_burst(recoil: Recoil, rounds: int, rpm: float = 650.0) -> list[tuple[int, float, float]]:
    """Hold the trigger.  Returns (round, pitch, yaw) sampled at each shot."""
    interval = 60.0 / rpm
    samples: list[tuple[int, float, float]] = []
    t = 0.0
    next_shot = 0.0
    fired = 0
    while fired < rounds:
        if t >= next_shot:
            recoil.shot()
            fired += 1
            next_shot += interval
            samples.append((fired, recoil.pitch, recoil.yaw))
        recoil.tick(TICK)
        t += TICK
    return samples


# -- everything is data ------------------------------------------------------


def test_no_recoil_magnitude_is_hard_coded() -> None:
    """The point of the profile is that a weapon's feel is entirely in the
    tuning file.  A bare number in here is a value someone cannot retune."""
    source = (
        __import__("pathlib").Path("trenchline/combat/recoil.py").read_text()
    )
    body = re.sub(r'"""[\s\S]*?"""', "", source)          # drop docstrings
    body = re.sub(r"#.*", "", body)                        # drop comments
    body = re.sub(r"_SETTLE_CONSTANT = [\d.]+", "", body)  # a derivation, not a feel value
    suspicious = [
        literal for literal in re.findall(r"(?<![\w.])\d+\.\d+", body)
        if literal not in {"1.0", "0.0", "2.0", "1e-6", "1e-3", "0.02"}
    ]
    assert not suspicious, f"hard-coded magnitudes in recoil.py: {suspicious}"


def test_every_weapon_recoil_key_resolves(tun) -> None:
    for key in tun.sections("recoil"):
        if key == "defaults":
            continue
        profile = RecoilProfile.from_tunables(tun, key)
        assert profile.settle_time_s > 0.0
        assert profile.climb_ceiling_deg > 0.0


def test_a_profile_missing_a_field_says_which(tun) -> None:
    raw = {"recoil": {"defaults": {"kick_pitch_deg": 0.3}, "broken": {}}}
    from trenchline.data import Tunables

    with pytest.raises(KeyError, match="settle_time_s"):
        RecoilProfile.from_tunables(Tunables(raw), "broken")


def test_the_weapon_defines_itself_only_where_it_differs(tun) -> None:
    """Shared feel belongs in [recoil.defaults]; the weapon table holds what
    makes it that weapon."""
    text = TUNABLES_PATH.read_text(encoding="utf-8")
    assert "[recoil.defaults]" in text
    assert f"[recoil.{WEAPON}]" in text


# -- the kick ----------------------------------------------------------------


def test_the_kick_peaks_at_the_angle_it_was_tuned_to(recoil) -> None:
    """kick_pitch_deg is degrees of muzzle rise, not an opaque spring unit."""
    recoil.shot()
    assert recoil.state.kick_pitch == pytest.approx(
        recoil.profile.kick_pitch_deg, rel=0.25
    )


def test_the_kick_is_at_its_peak_on_the_frame_the_round_leaves(recoil) -> None:
    """An attack you can watch reads as weightless whatever its size.

    Regression: the kick was an impulse into the spring's velocity, so the
    muzzle climbed to its peak over 1/w seconds — two frames at 60 Hz. Firing
    a gun is not a ramp. It is now a displacement, so the peak is frame zero
    and everything after it is recovery.
    """
    recoil.shot()
    at_shot = recoil.state.kick_pitch
    after = _peak_kick(recoil)
    assert at_shot >= max(after), (
        f"kick reached {max(after):.3f} deg after the shot frame, having been "
        f"{at_shot:.3f} deg on it"
    )


def test_the_kick_only_ever_decays(recoil) -> None:
    recoil.shot()
    trace = _peak_kick(recoil)
    assert trace == sorted(trace, reverse=True), "the muzzle rose again mid-recovery"


def _peak_kick(recoil: Recoil, ticks: int = 120) -> list[float]:
    seen = []
    for _ in range(ticks):
        recoil.tick(TICK)
        seen.append(recoil.state.kick_pitch)
    return seen


def test_the_kick_is_tiny(recoil) -> None:
    """LIGHT. Half a degree of muzzle rise per round, not two."""
    recoil.shot()
    assert max(_peak_kick(recoil)) < 0.6


def test_the_kick_is_gone_within_its_settling_time(recoil) -> None:
    """"Never fighting the gun for more than a fraction of a second" is a
    number in the tuning file, and this is it."""
    recoil.shot()
    trace = _peak_kick(recoil)
    peak = max(trace)
    settle_tick = int(math.ceil(recoil.profile.settle_time_s / TICK))
    assert abs(trace[settle_tick]) < 0.05 * peak, (
        f"kick still at {trace[settle_tick]:.3f} deg after "
        f"{recoil.profile.settle_time_s}s (peak {peak:.3f})"
    )


def test_a_critically_damped_kick_does_not_bounce(recoil) -> None:
    assert recoil.profile.damping_ratio == pytest.approx(1.0, abs=0.05)
    recoil.shot()
    trace = _peak_kick(recoil)
    assert min(trace) > -0.02 * max(trace), "the muzzle dipped below zero"


# -- the climb ---------------------------------------------------------------


def test_the_climb_rises_fast_and_then_plateaus(recoil) -> None:
    samples = _fire_burst(recoil, 30)
    pitches = [p for _, p, _ in samples]

    early = pitches[4] - pitches[0]
    late = pitches[29] - pitches[25]
    assert early > 0.0, "the muzzle should walk up over the first few rounds"
    assert late < early * 0.25, (
        f"still climbing {late:.3f} deg per 5 rounds at round 30; this is a "
        "ramp, not a plateau"
    )
    assert pitches[-1] <= recoil.profile.climb_ceiling_deg * 1.35


def test_the_climb_never_points_you_at_the_sky(recoil) -> None:
    samples = _fire_burst(recoil, 120)
    assert samples[-1][1] < recoil.profile.climb_ceiling_deg * 1.5


def test_the_climb_bleeds_off_when_you_stop(recoil) -> None:
    _fire_burst(recoil, 12)
    held = recoil.state.climb_pitch
    assert held > 0.0
    for _ in range(int(1.5 / TICK)):
        recoil.tick(TICK)
    assert recoil.state.climb_pitch < held * 0.2, "the climb did not recover"


def test_a_gap_in_fire_restarts_the_pattern(recoil) -> None:
    _fire_burst(recoil, 10)
    assert recoil.state.shots == 10
    for _ in range(int((recoil.profile.burst_reset_s + 0.1) / TICK)):
        recoil.tick(TICK)
    recoil.shot()
    assert recoil.state.shots == 1, "the burst counter did not reset"


# -- the drift ---------------------------------------------------------------


def test_the_drift_is_rightward_and_late(recoil) -> None:
    """The fingerprint: nothing sideways early, a mild rightward walk after
    about six rounds."""
    onset = int(recoil.profile.drift_onset_shots)
    samples = _fire_burst(recoil, 24)
    by_round = {n: yaw for n, _, yaw in samples}

    assert abs(by_round[onset]) < 0.12, (
        f"{by_round[onset]:.3f} deg of drift by round {onset}; it should not "
        "have started yet"
    )
    assert by_round[24] > 0.3, f"only {by_round[24]:.3f} deg of drift by round 24"
    assert by_round[24] > by_round[onset + 4] > by_round[onset]
    assert by_round[24] < 3.0, "this is a mild drift, not a swing"


def test_drift_is_the_only_horizontal_component(tun) -> None:
    """The rifle has no per-shot sideways kick; the walk is the whole story."""
    assert RecoilProfile.from_tunables(tun, WEAPON).kick_yaw_deg == 0.0


# -- integration -------------------------------------------------------------


def test_the_spring_is_integrated_exactly_not_stepped(recoil) -> None:
    """The analytic solution has no stability limit, so the same recoil comes
    out at any tick rate.  Explicit Euler at 60 Hz lost most of the kick."""
    coarse = load_recoil(
        load_tunables(), WEAPON, GameRandom(11).derive("recoil")
    )
    fine = load_recoil(load_tunables(), WEAPON, GameRandom(11).derive("recoil"))
    coarse.shot()
    fine.shot()
    for _ in range(30):
        coarse.tick(TICK)
        for _ in range(8):
            fine.tick(TICK / 8)
    assert coarse.state.kick_pitch == pytest.approx(fine.state.kick_pitch, abs=2e-3)


@pytest.mark.parametrize("zeta", [0.4, 1.0, 1.8])
def test_the_spring_always_returns_to_rest(zeta: float) -> None:
    x, v = 0.0, 12.0
    for _ in range(400):
        x, v = advance_spring(x, v, 30.0, zeta, TICK)
    assert abs(x) < 1e-3 and abs(v) < 1e-2


def test_an_underdamped_spring_overshoots_and_a_critical_one_does_not() -> None:
    def trace(zeta: float) -> list[float]:
        x, v, out = 0.0, 12.0, []
        for _ in range(120):
            x, v = advance_spring(x, v, 30.0, zeta, TICK)
            out.append(x)
        return out

    assert min(trace(0.35)) < -0.01, "an underdamped spring should overshoot"
    assert min(trace(1.0)) > -1e-6, "a critically damped one should not"


# -- stance and determinism --------------------------------------------------


def test_a_tighter_stance_shoulders_more_of_it(recoil, tun) -> None:
    prone = load_recoil(tun, WEAPON, GameRandom(11).derive("recoil"))
    prone.scale = tun.f("stance.prone.sway_scale")
    _fire_burst(recoil, 10)
    _fire_burst(prone, 10)
    assert prone.pitch < recoil.pitch


def test_the_same_seed_gives_the_same_pattern(tun) -> None:
    def pattern(seed: int) -> list[tuple[float, float]]:
        r = load_recoil(tun, WEAPON, GameRandom(seed).derive("recoil"))
        return [(round(p, 9), round(y, 9)) for _, p, y in _fire_burst(r, 20)]

    assert pattern(4) == pattern(4)
    assert pattern(4) != pattern(5)
