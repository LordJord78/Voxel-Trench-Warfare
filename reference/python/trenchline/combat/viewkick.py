"""Cosmetic recoil: everything you feel, nothing that moves the bullet.

`recoil.py` owns the aim. This owns the *impression* — viewmodel punch, a small
FOV pulse, muzzle flash, brass — and it is a strict rule of this module that
none of it is ever read back by ballistics, collision or AI. The weapon fires
along `Recoil.aim()`; if this file were deleted the rounds would land in exactly
the same voxels.

That separation is the point. Aim recoil has to stay light and honest or the
gun becomes a fight, which caps how much *weight* it can carry. Weight can then
be spent freely here, where being over-damped or over-sized costs nothing but
taste. The two tune independently: `[recoil.*]` decides difficulty and
`[viewkick.*]` decides how heavy the rifle feels.

The known failure mode of doing it this way is the layers reading as unrelated —
a viewmodel that lurches while the sight picture sits still looks like two guns.
The defences are that both layers are driven by the same shot event on the same
frame, that the viewmodel's pitch punch is scaled from the aim kick rather than
dialled in separately, and that the cosmetic settle time is kept close to the
aim one so they finish together.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..core.rng import GameRandom
from ..data import Tunables
from .particles import ParticlePool, ParticleSpec, spec_from_tunables
from .recoil import advance_spring

_SETTLE_CONSTANT = 5.83
"""Same displacement-response constant the aim layer uses; see recoil.py."""

_KEYS = (
    "punch_back_m",
    "punch_up_m",
    "punch_side_m",
    "punch_pitch_deg",
    "punch_yaw_deg",
    "punch_roll_deg",
    "aim_pitch_follow",
    "settle_time_s",
    "damping_ratio",
    "fov_pulse_deg",
    "fov_settle_s",
    "fov_damping_ratio",
    "brass_count",
    "brass_speed",
    "brass_spread",
    "brass_up",
    "muzzle_forward_m",
    "muzzle_side_m",
    "muzzle_down_m",
    "report_peak_db",
    "report_low_hz",
    "report_length_s",
    "jitter_scale",
)


@dataclass(frozen=True, slots=True)
class ViewKickProfile:
    """How heavy the weapon feels.  Every field from the tuning file."""

    key: str
    punch_back_m: float
    """Viewmodel shoved toward the eye. The single biggest weight cue."""
    punch_up_m: float
    punch_side_m: float
    punch_pitch_deg: float
    punch_yaw_deg: float
    punch_roll_deg: float
    aim_pitch_follow: float
    """Extra viewmodel pitch per degree of *aim* kick, so the two layers are
    visibly the same event rather than two guns going off near each other."""
    settle_time_s: float
    damping_ratio: float
    """Below 1 the viewmodel overshoots on the way back, which reads as mass.
    Nothing on the aim axis may do this; here it is free."""
    fov_pulse_deg: float
    fov_settle_s: float
    fov_damping_ratio: float
    brass_count: float
    brass_speed: float
    brass_spread: float
    brass_up: float
    muzzle_forward_m: float
    muzzle_side_m: float
    muzzle_down_m: float
    report_peak_db: float
    report_low_hz: float
    """Where the transient's body sits. No audio backend is wired yet; the
    report event carries these so the mixer has them the day one is."""
    report_length_s: float
    jitter_scale: float

    @staticmethod
    def from_tunables(tun: Tunables, key: str) -> "ViewKickProfile":
        values = dict(tun.section("viewkick.defaults"))
        values.update(tun.section(f"viewkick.{key}"))
        missing = [name for name in _KEYS if name not in values]
        if missing:
            raise KeyError(
                f"viewkick profile {key!r} is missing {missing}; add them to "
                f"[viewkick.{key}] or [viewkick.defaults]"
            )
        return ViewKickProfile(key=key, **{n: float(values[n]) for n in _KEYS})


@dataclass(frozen=True, slots=True)
class WeaponReport:
    """The audio transient one shot should make, as data.

    Emitted rather than played: Panda's audio is switched off in this build, so
    nothing consumes this yet. It exists now so the mixer has a shape to read
    when it arrives, instead of the sound being invented later from scratch.
    """

    peak_db: float
    low_hz: float
    length_s: float
    position: tuple[float, float, float]


@dataclass(slots=True)
class ViewKickState:
    back: float = 0.0
    up: float = 0.0
    side: float = 0.0
    pitch: float = 0.0
    yaw: float = 0.0
    roll: float = 0.0
    back_v: float = 0.0
    up_v: float = 0.0
    side_v: float = 0.0
    pitch_v: float = 0.0
    yaw_v: float = 0.0
    roll_v: float = 0.0
    fov: float = 0.0
    fov_v: float = 0.0


class ViewKick:
    """Viewmodel punch, FOV pulse, flash and brass."""

    __slots__ = ("profile", "rng", "state", "particles", "flash", "brass", "scale")

    def __init__(
        self,
        profile: ViewKickProfile,
        rng: GameRandom,
        particles: ParticlePool,
        flash: ParticleSpec,
        brass: ParticleSpec,
    ) -> None:
        self.profile = profile
        self.rng = rng
        self.particles = particles
        self.flash = flash
        self.brass = brass
        self.state = ViewKickState()
        self.scale = 1.0

    # -- events ----------------------------------------------------------

    def shot(
        self,
        eye: tuple[float, float, float],
        forward: tuple[float, float, float],
        right: tuple[float, float, float],
        up: tuple[float, float, float],
        aim_kick_deg: float = 0.0,
    ) -> WeaponReport:
        """One round has gone off.  Returns the report the mixer would play."""
        p = self.profile
        st = self.state
        j = self._jitter

        # Displaced, not impulsed — same reasoning as the aim layer. The
        # viewmodel is at its peak on the frame the round leaves.
        st.back += (p.punch_back_m + j(p.punch_back_m)) * self.scale
        st.up += (p.punch_up_m + j(p.punch_up_m)) * self.scale
        st.side += (p.punch_side_m + j(p.punch_side_m)) * self.scale
        st.pitch += (
            p.punch_pitch_deg + aim_kick_deg * p.aim_pitch_follow + j(p.punch_pitch_deg)
        ) * self.scale
        st.yaw += (p.punch_yaw_deg + j(p.punch_yaw_deg)) * self.scale
        st.roll += (p.punch_roll_deg + j(p.punch_roll_deg)) * self.scale
        st.fov += p.fov_pulse_deg * self.scale

        muzzle = (
            eye[0] + forward[0] * p.muzzle_forward_m + right[0] * p.muzzle_side_m - up[0] * p.muzzle_down_m,
            eye[1] + forward[1] * p.muzzle_forward_m + right[1] * p.muzzle_side_m - up[1] * p.muzzle_down_m,
            eye[2] + forward[2] * p.muzzle_forward_m + right[2] * p.muzzle_side_m - up[2] * p.muzzle_down_m,
        )
        self.particles.emit(
            muzzle,
            (forward[0] * 2.0, forward[1] * 2.0, forward[2] * 2.0),
            self.flash,
            count=1,
        )
        # Brass out to the right and up, tumbling away from the shooter.
        eject = (
            right[0] * p.brass_speed + up[0] * p.brass_up,
            right[1] * p.brass_speed + up[1] * p.brass_up,
            right[2] * p.brass_speed + up[2] * p.brass_up,
        )
        self.particles.emit(
            muzzle, eject, self.brass, count=int(p.brass_count),
            rng=self.rng, spread=p.brass_spread, speed_jitter=0.2,
        )
        return WeaponReport(
            peak_db=p.report_peak_db,
            low_hz=p.report_low_hz,
            length_s=p.report_length_s,
            position=muzzle,
        )

    def _jitter(self, magnitude: float) -> float:
        scale = self.profile.jitter_scale
        return self.rng.jitter(abs(magnitude) * scale) if scale > 0.0 else 0.0

    # -- clock -----------------------------------------------------------

    def tick(self, dt: float) -> None:
        p = self.profile
        st = self.state
        omega = _SETTLE_CONSTANT / max(1e-3, p.settle_time_s)
        zeta = p.damping_ratio
        st.back, st.back_v = advance_spring(st.back, st.back_v, omega, zeta, dt)
        st.up, st.up_v = advance_spring(st.up, st.up_v, omega, zeta, dt)
        st.side, st.side_v = advance_spring(st.side, st.side_v, omega, zeta, dt)
        st.pitch, st.pitch_v = advance_spring(st.pitch, st.pitch_v, omega, zeta, dt)
        st.yaw, st.yaw_v = advance_spring(st.yaw, st.yaw_v, omega, zeta, dt)
        st.roll, st.roll_v = advance_spring(st.roll, st.roll_v, omega, zeta, dt)

        fov_omega = _SETTLE_CONSTANT / max(1e-3, p.fov_settle_s)
        st.fov, st.fov_v = advance_spring(
            st.fov, st.fov_v, fov_omega, p.fov_damping_ratio, dt
        )

    def reset(self) -> None:
        self.state = ViewKickState()

    # -- output ----------------------------------------------------------

    @property
    def offset(self) -> tuple[float, float, float]:
        """Viewmodel translation in view space: (right, up, back)."""
        return (self.state.side, self.state.up, self.state.back)

    @property
    def rotation(self) -> tuple[float, float, float]:
        """Viewmodel rotation in degrees: (pitch, yaw, roll)."""
        return (self.state.pitch, self.state.yaw, self.state.roll)

    @property
    def fov_offset(self) -> float:
        return self.state.fov


def load_viewkick(
    tun: Tunables, key: str, rng: GameRandom, particles: ParticlePool
) -> ViewKick:
    return ViewKick(
        ViewKickProfile.from_tunables(tun, key),
        rng,
        particles,
        spec_from_tunables(tun, "particles.muzzle_flash"),
        spec_from_tunables(tun, "particles.brass"),
    )


__all__ = [
    "ViewKickProfile", "ViewKickState", "ViewKick", "WeaponReport", "load_viewkick",
]
