"""Export the movement parity fixtures: the controller's per-tick states on four small worlds.

The TypeScript port (tests/physics/parity.test.ts) builds the same worlds,
replays the same inputs and must match every tick within a millimetre. Each
fixture carries its world as boxes, the controller numbers this controller ran
with, the inputs and the state after every tick. Run from reference/python:

    ../../.venv/bin/python -m tools.export_parity ../../tests/fixtures/parity
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from trenchline.data import load_tunables
from trenchline.physics.character import CharacterController, CharacterState, MoveIntent, Stance
from trenchline.physics.vec import Vec3
from trenchline.world import voxel
from trenchline.world.chunks import VoxelWorld, WorldDims

DIMS = (32, 16, 32)
DT = 1.0 / 60.0

Box = tuple[int, int, int, int, int, int, int]
"""Half-open voxel box (x0, y0, z0, x1, y1, z1) and the material written into it."""

GROUND: Box = (0, 0, 0, 32, 4, 32, voxel.SOD)
"""Every world stands on this: ground whose top is at 2.0 m."""


@dataclass(frozen=True)
class Phase:
    ticks: int
    forward: float = 0.0
    strafe: float = 0.0
    jump: bool = False
    sprint: bool = False
    stance: Stance = Stance.STANDING
    periscope: bool = False
    yaw: float | None = None
    """Turn to this yaw for the phase; None keeps the last."""


@dataclass(frozen=True)
class Scenario:
    boxes: tuple[Box, ...]
    start: tuple[float, float, float]
    yaw: float
    phases: tuple[Phase, ...]


SCENARIOS: dict[str, Scenario] = {
    # Into a wall, along it, a sprint, friction, a strafe away.
    "walk-slide": Scenario(
        boxes=(GROUND, (20, 4, 4, 21, 10, 28, voxel.BRICK)),
        start=(6.0, 2.0, 8.0),
        yaw=90.0,
        phases=(
            Phase(90, forward=1.0),
            Phase(90, forward=1.0, yaw=60.0),
            Phase(60, forward=1.0, sprint=True, yaw=0.0),
            Phase(60),
            Phase(60, strafe=-1.0),
        ),
    ),
    # Up a kerb, down it, onto a timber firing step; the periscope up and down; back off.
    "steps": Scenario(
        boxes=(
            GROUND,
            (8, 4, 0, 12, 5, 32, voxel.SOD),
            (16, 4, 0, 19, 5, 32, voxel.TIMBER),
            (19, 4, 0, 20, 10, 32, voxel.BRICK),
        ),
        start=(2.0, 2.0, 8.0),
        yaw=90.0,
        phases=(Phase(150, forward=1.0), Phase(60, periscope=True), Phase(60), Phase(90, forward=-1.0)),
    ),
    # Crouch under a roof 1.5 m up, try to stand, go prone and crawl, out crouched, stand.
    "ceiling": Scenario(
        boxes=(GROUND, (8, 7, 4, 16, 8, 28, voxel.TIMBER)),
        start=(2.0, 2.0, 8.0),
        yaw=90.0,
        phases=(
            Phase(30, stance=Stance.CROUCHED),
            Phase(120, forward=1.0, stance=Stance.CROUCHED),
            Phase(60, stance=Stance.STANDING),
            Phase(90, stance=Stance.PRONE),
            Phase(120, forward=1.0, stance=Stance.PRONE),
            Phase(60, stance=Stance.STANDING),
            Phase(120, forward=1.0, stance=Stance.CROUCHED),
            Phase(60, stance=Stance.STANDING),
        ),
    ),
    # A jump in place, off a 1 m platform, through a pit of water and out of it.
    "fall-wade": Scenario(
        boxes=(
            GROUND,
            (0, 4, 0, 8, 6, 32, voxel.SOD),
            (16, 3, 0, 20, 4, 32, voxel.AIR),
            (16, 3, 0, 20, 4, 32, voxel.WATER),
        ),
        start=(2.0, 3.0, 8.0),
        yaw=90.0,
        phases=(Phase(1, jump=True), Phase(89), Phase(300, forward=1.0)),
    ),
}


def _controller(c: CharacterController) -> dict[str, Any]:
    return {
        "radius": c.radius,
        "stepUp": c.step_up,
        "gravity": c.gravity,
        "jumpSpeed": c.jump_speed,
        "groundAccel": c.ground_accel,
        "airAccel": c.air_accel,
        "friction": c.friction,
        "maxFall": c.max_fall,
        "headBobHz": c.tun.f("camera.head_bob_hz"),
        "stances": [
            {
                "height": p.height,
                "eyeHeight": p.eye_height,
                "speed": p.speed,
                "sprintSpeed": p.sprint_speed,
                "swayScale": p.sway_scale,
                "exposure": p.exposure,
                "transitionTime": p.transition_time,
                "fovScale": p.fov_scale,
            }
            for p in (c.stances[s] for s in Stance)
        ],
    }


def _state(s: CharacterState) -> dict[str, Any]:
    return {
        "position": list(s.position.as_tuple()),
        "velocity": list(s.velocity.as_tuple()),
        "stance": int(s.stance),
        "height": s.height,
        "onGround": s.on_ground,
        "onFiringStep": s.on_firing_step,
        "wadeDepth": s.wade_depth,
        "landingImpact": s.landing_impact,
        "bobPhase": s.bob_phase,
        "blockedStance": s.blocked_stance,
    }


def run_scenario(name: str) -> dict[str, Any]:
    sc = SCENARIOS[name]
    world = VoxelWorld(WorldDims(*DIMS))
    for x0, y0, z0, x1, y1, z1, material in sc.boxes:
        world.v[x0:x1, y0:y1, z0:z1] = material
    controller = CharacterController(world, load_tunables())
    state = CharacterState(position=Vec3(*sc.start), yaw=sc.yaw, on_ground=True)
    start = {"position": list(sc.start), "yaw": sc.yaw, "pitch": 0.0, "stance": int(state.stance), "height": state.height, "onGround": True}
    ticks: list[dict[str, Any]] = []
    states: list[dict[str, Any]] = []
    yaw = sc.yaw
    for phase in sc.phases:
        if phase.yaw is not None:
            yaw = phase.yaw
        for _ in range(phase.ticks):
            intent = MoveIntent(
                forward=phase.forward,
                strafe=phase.strafe,
                jump=phase.jump,
                sprint=phase.sprint,
                stance=phase.stance,
                periscope=phase.periscope,
            )
            state.yaw = yaw
            state.pitch = 0.0
            controller.tick(state, intent, DT)
            ticks.append(
                {
                    "forward": phase.forward,
                    "strafe": phase.strafe,
                    "jump": phase.jump,
                    "sprint": phase.sprint,
                    "stance": int(phase.stance),
                    "periscope": phase.periscope,
                    "yaw": yaw,
                    "pitch": 0.0,
                }
            )
            states.append(_state(state))
    return {
        "scenario": name,
        "voxel": voxel.VOXEL_SIZE,
        "dims": list(DIMS),
        "boxes": [list(b) for b in sc.boxes],
        "controller": _controller(controller),
        "dt": DT,
        "start": start,
        "ticks": ticks,
        "states": states,
    }


def main(outdir: str) -> None:
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    for name in SCENARIOS:
        fixture = run_scenario(name)
        (out / f"{name}.json").write_text(json.dumps(fixture, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        print(f"{name}: {len(fixture['states'])} ticks")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "parity")
