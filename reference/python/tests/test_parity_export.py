"""The movement parity fixtures: the same every run, and exercising what they claim.

tools/export_parity.py records the controller's per-tick states on four small
worlds; the TypeScript port must replay them within a millimetre a tick. A
fixture that never reaches the firing step, or never lands hard, would let a
broken port pass, so each scenario's purpose is checked here.
"""

from __future__ import annotations

from tools.export_parity import SCENARIOS, run_scenario
from trenchline.physics.character import Stance


def test_scenarios_are_deterministic() -> None:
    for name in SCENARIOS:
        assert run_scenario(name) == run_scenario(name)


def test_walk_slide_slides_along_the_wall_without_entering_it() -> None:
    states = run_scenario("walk-slide")["states"]
    assert max(s["position"][0] for s in states) <= 10.0 - 0.30 + 1e-6
    # Ticks 90-179 press into the wall at yaw 60: the wall carries the player along it.
    assert states[179]["position"][2] - states[89]["position"][2] >= 1.0


def test_steps_mount_the_kerb_and_the_firing_step_and_raise_the_periscope() -> None:
    states = run_scenario("steps")["states"]
    stances = [s["stance"] for s in states]
    assert Stance.FIRING_STEP in stances
    assert Stance.PERISCOPE in stances[stances.index(Stance.FIRING_STEP) :]
    assert any(s["onGround"] and abs(s["position"][1] - 2.5) < 1e-9 for s in states)


def test_ceiling_refuses_standing_and_allows_prone() -> None:
    states = run_scenario("ceiling")["states"]
    assert any(s["blockedStance"] for s in states)
    assert any(s["stance"] == Stance.PRONE and abs(s["height"] - 0.55) < 1e-9 for s in states)
    assert states[-1]["stance"] == Stance.STANDING
    assert abs(states[-1]["height"] - 1.8) < 1e-9


def test_fall_wade_lands_hard_wades_and_climbs_out() -> None:
    states = run_scenario("fall-wade")["states"]
    assert max(s["landingImpact"] for s in states) > 3.0
    # Depth is sampled at voxel centres, so one 0.5 m voxel of water reads 0.25: past the 0.15 that slows.
    assert max(s["wadeDepth"] for s in states) > 0.15
    assert states[-1]["onGround"]
    assert abs(states[-1]["position"][1] - 2.0) < 1e-9
