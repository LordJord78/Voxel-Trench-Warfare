"""First-person character controller.

Deterministic: given the same state, intent and dt it produces the same result,
which is what lets the headless harness replay a session exactly.

Stance is the infantry player's core tradeoff and it is settled here, because
stance changes height, speed, sway and — through the height — what the trench
geometry does and does not hide.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import IntEnum

from ..data import Tunables
from ..world import voxel
from ..world.chunks import VoxelWorld
from .collision import box_hits_solid, ground_height_under, submerged_depth
from .vec import Vec3, ZERO, yaw_basis


class Stance(IntEnum):
    STANDING = 0
    CROUCHED = 1
    PRONE = 2
    FIRING_STEP = 3


_STANCE_KEY: dict[Stance, str] = {
    Stance.STANDING: "standing",
    Stance.CROUCHED: "crouched",
    Stance.PRONE: "prone",
    Stance.FIRING_STEP: "firing_step",
}


@dataclass(frozen=True, slots=True)
class StanceProfile:
    stance: Stance
    height: float
    eye_height: float
    speed: float
    sprint_speed: float
    sway_scale: float
    exposure: float
    """Multiplier on how much of you an enemy or drone can see and hit."""
    transition_time: float


def load_stances(tun: Tunables) -> dict[Stance, StanceProfile]:
    eyes = {
        Stance.STANDING: tun.f("player.eye_height_standing"),
        Stance.CROUCHED: tun.f("player.eye_height_crouched"),
        Stance.PRONE: tun.f("player.eye_height_prone"),
        Stance.FIRING_STEP: tun.f("player.eye_height_standing"),
    }
    out: dict[Stance, StanceProfile] = {}
    for stance, key in _STANCE_KEY.items():
        section = tun.section(f"stance.{key}")
        out[stance] = StanceProfile(
            stance=stance,
            height=float(section["height"]),
            eye_height=eyes[stance],
            speed=float(section["speed"]),
            sprint_speed=float(section["sprint_speed"]),
            sway_scale=float(section["sway_scale"]),
            exposure=float(section["exposure"]),
            transition_time=float(section["transition_time"]),
        )
    return out


@dataclass(slots=True)
class MoveIntent:
    forward: float = 0.0
    """-1 back, +1 forward."""
    strafe: float = 0.0
    jump: bool = False
    sprint: bool = False
    stance: Stance = Stance.STANDING
    """Requested posture; may be refused by a low ceiling."""


@dataclass(slots=True)
class CharacterState:
    position: Vec3 = field(default_factory=lambda: Vec3(0.0, 0.0, 0.0))
    """Foot centre, in metres."""
    velocity: Vec3 = field(default_factory=lambda: ZERO)
    yaw: float = 0.0
    pitch: float = 0.0
    stance: Stance = Stance.STANDING
    height: float = 1.8
    on_ground: bool = False
    on_firing_step: bool = False
    landing_impact: float = 0.0
    bob_phase: float = 0.0
    wade_depth: float = 0.0
    blocked_stance: bool = False
    """True when a low ceiling refused a stand-up request."""

    @property
    def eye_position(self) -> Vec3:
        return self.position

    def horizontal_speed(self) -> float:
        return self.velocity.horizontal_length


class CharacterController:
    """Moves a `CharacterState` through the voxel world."""

    def __init__(self, world: VoxelWorld, tun: Tunables) -> None:
        self.world = world
        self.tun = tun
        self.stances = load_stances(tun)
        self.radius = tun.f("player.radius")
        self.step_up = tun.f("player.step_up")
        self.gravity = tun.f("player.gravity")
        self.jump_speed = tun.f("player.jump_speed")
        self.ground_accel = tun.f("player.ground_accel")
        self.air_accel = tun.f("player.air_accel")
        self.friction = tun.f("player.ground_friction")
        self.max_fall = tun.f("player.max_fall_speed")

    # -- public ----------------------------------------------------------

    def profile(self, state: CharacterState) -> StanceProfile:
        return self.stances[state.stance]

    def eye_height(self, state: CharacterState) -> float:
        """Interpolated from the body's actual height, so crouching is smooth."""
        profile = self.stances[state.stance]
        ratio = profile.eye_height / profile.height
        return state.height * ratio

    def tick(self, state: CharacterState, intent: MoveIntent, dt: float) -> None:
        self._resolve_stance(state, intent, dt)
        profile = self.stances[state.stance]

        wish = self._wish_velocity(state, intent, profile)
        self._accelerate(state, wish, dt)
        self._apply_gravity(state, intent, dt)
        self._integrate(state, dt)
        self._post_move(state, profile, dt)

    # -- internals -------------------------------------------------------

    def _resolve_stance(
        self, state: CharacterState, intent: MoveIntent, dt: float
    ) -> None:
        wanted = intent.stance
        # Standing on the firing step is a position, not a posture: it applies
        # itself, and it costs you exposure for as long as you stay there.
        if state.on_firing_step and wanted == Stance.STANDING:
            wanted = Stance.FIRING_STEP
        elif not state.on_firing_step and wanted == Stance.FIRING_STEP:
            wanted = Stance.STANDING

        target = self.stances[wanted]
        state.blocked_stance = False
        if target.height > state.height + 1e-4:
            # Refuse to grow into a ceiling — dugouts and the culvert are low.
            probe = Vec3(state.position.x, state.position.y, state.position.z)
            if box_hits_solid(self.world, probe, self.radius, target.height):
                state.blocked_stance = True
                return

        state.stance = wanted
        if target.transition_time <= 1e-4:
            state.height = target.height
            return
        rate = abs(target.height - self.stances[Stance.STANDING].height)
        rate = max(rate, 0.2) / target.transition_time
        delta = target.height - state.height
        if abs(delta) <= rate * dt:
            state.height = target.height
        else:
            state.height += math.copysign(rate * dt, delta)

    def _wish_velocity(
        self, state: CharacterState, intent: MoveIntent, profile: StanceProfile
    ) -> Vec3:
        forward, right = yaw_basis(state.yaw)
        wish = forward * intent.forward + right * intent.strafe
        if wish.length_sq < 1e-8:
            return ZERO
        wish = wish.normalised()
        sprinting = (
            intent.sprint
            and intent.forward > 0.3
            and state.stance in (Stance.STANDING,)
        )
        speed = profile.sprint_speed if sprinting else profile.speed
        # Wading costs you: knee-deep water in a crater is not a shortcut.
        if state.wade_depth > 0.15:
            speed *= max(0.35, 1.0 - state.wade_depth * 0.9)
        return wish * speed

    def _accelerate(self, state: CharacterState, wish: Vec3, dt: float) -> None:
        v = state.velocity
        horizontal = Vec3(v.x, 0.0, v.z)
        accel = self.ground_accel if state.on_ground else self.air_accel

        if wish.length_sq < 1e-8:
            if state.on_ground:
                speed = horizontal.length
                if speed > 1e-4:
                    drop = min(speed, self.friction * dt * max(speed, 1.5))
                    horizontal = horizontal * ((speed - drop) / speed)
                else:
                    horizontal = ZERO
        else:
            delta = wish - horizontal
            step = accel * dt
            if delta.length <= step:
                horizontal = wish
            else:
                horizontal = horizontal + delta.normalised() * step
        state.velocity = Vec3(horizontal.x, v.y, horizontal.z)

    def _apply_gravity(
        self, state: CharacterState, intent: MoveIntent, dt: float
    ) -> None:
        vy = state.velocity.y
        if state.on_ground and intent.jump and state.stance == Stance.STANDING:
            vy = self.jump_speed
            state.on_ground = False
        else:
            vy += self.gravity * dt
            vy = max(vy, -self.max_fall)
        state.velocity = state.velocity.with_y(vy)

    def _integrate(self, state: CharacterState, dt: float) -> None:
        was_grounded = state.on_ground
        pos = state.position
        vel = state.velocity
        h = state.height

        pos, vx = self._slide(pos, Vec3(vel.x * dt, 0.0, 0.0), h, was_grounded, vel.x)
        pos, vz = self._slide(pos, Vec3(0.0, 0.0, vel.z * dt), h, was_grounded, vel.z)

        # Vertical
        vy = vel.y
        candidate = pos.with_y(pos.y + vy * dt)
        if box_hits_solid(self.world, candidate, self.radius, h):
            if vy <= 0.0:
                ground = ground_height_under(
                    self.world, pos, self.radius, abs(vy * dt) + 0.7
                )
                if ground is not None:
                    pos = pos.with_y(ground)
                state.landing_impact = max(state.landing_impact, -vy)
                state.on_ground = True
            vy = 0.0
        else:
            pos = candidate
            state.on_ground = False

        state.position = pos
        state.velocity = Vec3(vx, vy, vz)

        # Grounded probe, plus step-down so walking off a duckboard step does
        # not launch you into an arc.
        if not state.on_ground and state.velocity.y <= 0.0:
            foot = Vec3(pos.x, pos.y - 0.06, pos.z)
            if box_hits_solid(self.world, foot, self.radius, 0.05):
                ground = ground_height_under(self.world, pos, self.radius, 0.3)
                if ground is not None:
                    state.position = pos.with_y(ground)
                state.on_ground = True
                state.velocity = state.velocity.with_y(0.0)
            elif was_grounded and state.velocity.y > -1.0:
                ground = ground_height_under(
                    self.world, pos, self.radius, self.step_up + 0.1
                )
                if ground is not None and pos.y - ground <= self.step_up:
                    state.position = pos.with_y(ground)
                    state.on_ground = True
                    state.velocity = state.velocity.with_y(0.0)

    def _slide(
        self, pos: Vec3, delta: Vec3, height: float, grounded: bool, axis_vel: float
    ) -> tuple[Vec3, float]:
        """Move one horizontal axis, climbing a single step if blocked."""
        if abs(delta.x) < 1e-9 and abs(delta.z) < 1e-9:
            return pos, axis_vel
        candidate = pos + delta
        if not box_hits_solid(self.world, candidate, self.radius, height):
            return candidate, axis_vel
        # Penetration recovery: if we are *already* inside geometry (spawned
        # badly, or an explosion collapsed dirt onto us) never refuse to move,
        # or the body welds itself into the terrain forever.
        if box_hits_solid(self.world, pos, self.radius, height):
            return candidate, axis_vel
        if grounded:
            raised = candidate.with_y(candidate.y + self.step_up)
            if not box_hits_solid(self.world, raised, self.radius, height):
                ground = ground_height_under(
                    self.world, raised, self.radius, self.step_up + 0.2
                )
                if ground is not None and -1e-3 <= ground - pos.y <= self.step_up:
                    return candidate.with_y(ground), axis_vel
        return pos, 0.0

    def _post_move(
        self, state: CharacterState, profile: StanceProfile, dt: float
    ) -> None:
        pos = state.position
        state.wade_depth = submerged_depth(self.world, pos, state.height)

        below = self.world.material_at(pos.x, pos.y - voxel.VOXEL_SIZE * 0.5, pos.z)
        state.on_firing_step = state.on_ground and below == voxel.TIMBER

        speed = state.horizontal_speed()
        if state.on_ground and speed > 0.2:
            hz = self.tun.f("camera.head_bob_hz")
            state.bob_phase += dt * hz * (speed / max(profile.speed, 0.1)) * math.tau
            state.bob_phase %= math.tau
        else:
            state.bob_phase *= 0.90

        state.landing_impact *= max(0.0, 1.0 - dt * 6.0)
