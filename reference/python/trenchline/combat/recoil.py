"""Recoil: a shared impulse and a damped spring.

One system, one set of equations, one place to tune. A weapon's character is
entirely in its numbers — `RecoilProfile` reads every one of them out of
`tunables.toml` and there is no magnitude anywhere in this module or in the
weapon classes. Adding the seventh weapon is a new `[recoil.<key>]` table.

Two terms, because two different things happen when you pull the trigger and
they recover on different timescales:

**Kick** is the snap. Each round *displaces* a damped spring anchored at zero
and the spring pulls it straight back, so the muzzle is already at its peak on
the frame the round leaves and every frame after that is recovery. It is
deliberately small and deliberately fast: you should never be fighting it.

The attack has to be instantaneous, and this is the whole reason the kick is a
displacement rather than an impulse. Feeding the spring velocity instead means
the muzzle takes about 1/w seconds to reach its peak — two frames at 60 Hz —
and a rise you can watch reads as weightless no matter how large it is. Firing
a gun is not a ramp.

**Climb** is the pattern. Each round adds to an offset that decays only slowly,
so a burst walks the muzzle up and — after enough rounds — sideways. It
approaches a ceiling rather than rising without limit, so holding the trigger
plateaus instead of pointing you at the sky, and it bleeds off when you stop.

Total offset is kick + climb. The kick is what you feel; the climb is what you
have to correct. Keeping them separate is what allows a gun that is snappy
without being a fight.

Deterministic: the integrator is fixed-step and the only randomness is a
per-shot jitter drawn from an injected stream.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..core.rng import GameRandom
from ..data import Tunables

def advance_spring(
    x: float, v: float, omega: float, zeta: float, dt: float
) -> tuple[float, float]:
    """Exact step of  x'' = -w^2 x - 2 z w x'  over `dt`.

    Not Euler.  A 0.15 s settling time means w*dt is about 0.45 at 60 Hz and
    the damping term alone eats most of the velocity in a single step: stepped
    explicitly, a kick tuned to 0.34 deg peaks at 0.04 and takes twice as long
    to settle as the tuning file says. Integrating the closed form instead
    makes the numbers in `tunables.toml` mean what they say, costs a couple of
    transcendentals per frame, and — because it has no stability limit — gives
    the same recoil whatever the tick rate.
    """
    if omega <= 0.0:
        return x, v
    if zeta < 1.0 - 1e-6:
        wd = omega * math.sqrt(1.0 - zeta * zeta)
        decay = math.exp(-zeta * omega * dt)
        cos, sin = math.cos(wd * dt), math.sin(wd * dt)
        new_x = decay * (x * cos + (v + zeta * omega * x) / wd * sin)
        new_v = decay * (
            v * cos - (omega * omega * x + zeta * omega * v) / wd * sin
        )
        return new_x, new_v
    if zeta > 1.0 + 1e-6:
        rate = omega * math.sqrt(zeta * zeta - 1.0)
        a, b = -zeta * omega + rate, -zeta * omega - rate
        c2 = (v - a * x) / (b - a)
        c1 = x - c2
        ea, eb = math.exp(a * dt), math.exp(b * dt)
        return c1 * ea + c2 * eb, c1 * a * ea + c2 * b * eb
    # Critically damped: x = (A + Bt) e^-wt.
    decay = math.exp(-omega * dt)
    b = v + omega * x
    return (x + b * dt) * decay, (b - omega * (x + b * dt)) * decay


_SETTLE_CONSTANT = 5.83
"""w * settle_time for a *displacement* response to fall to 2% of its peak.

Released from x0 with no velocity, a critically damped spring gives
x(t) = x0 (1 + wt) e^-wt, whose derivative is -x0 w^2 t e^-wt: never positive,
so the peak is at t = 0 and the whole response is decay. Solving
(1 + u) e^-u = 0.02 gives u = 5.83. The impulse form of the same question
answers 6.83, so swapping the attack without swapping this would have
stretched every settling time in the tuning file by about 17%.
"""

_KEYS = (
    "kick_pitch_deg",
    "kick_yaw_deg",
    "settle_time_s",
    "damping_ratio",
    "climb_ceiling_deg",
    "climb_per_shot_deg",
    "climb_recovery_s",
    "drift_yaw_deg",
    "drift_onset_shots",
    "drift_ramp_shots",
    "jitter_pitch_deg",
    "jitter_yaw_deg",
    "burst_reset_s",
)


@dataclass(frozen=True, slots=True)
class RecoilProfile:
    """One weapon's fingerprint.  Every field comes from the tuning file."""

    key: str
    kick_pitch_deg: float
    """Vertical impulse per round, before the spring pulls it back."""
    kick_yaw_deg: float
    settle_time_s: float
    """How long the kick takes to disappear.  This is the "fraction of a
    second" figure, set directly rather than inferred from a spring constant."""
    damping_ratio: float
    """1.0 is critically damped: fastest return with no bounce.  Below 1
    overshoots, which reads as a springy, cheaper gun."""
    climb_ceiling_deg: float
    """Where a held burst plateaus.  Without this a long burst points at the sky."""
    climb_per_shot_deg: float
    climb_recovery_s: float
    """How fast the plateau bleeds off once you stop firing."""
    drift_yaw_deg: float
    drift_onset_shots: float
    """Rounds before the horizontal walk shows at all."""
    drift_ramp_shots: float
    jitter_pitch_deg: float
    jitter_yaw_deg: float
    burst_reset_s: float
    """Gap in fire after which the climb pattern starts again from round one."""

    @property
    def stiffness(self) -> float:
        """Spring constant derived from the settling time you actually wanted.

        An impulse into a critically damped spring gives x(t) = v0 t e^-wt,
        which peaks at t = 1/w and is back to 2% of that peak at w t ~ 6.83
        (the root of u e^(1-u) = 0.02).  Four time constants is the figure for
        a *step* response and is wrong here by nearly a factor of two, which is
        the difference between a kick that settles when the tuning file says it
        does and one that takes 0.27 s to clear a 0.15 s setting.
        """
        omega = _SETTLE_CONSTANT / max(1e-3, self.settle_time_s)
        return omega * omega

    @property
    def damping(self) -> float:
        return 2.0 * self.damping_ratio * math.sqrt(self.stiffness)

    @staticmethod
    def from_tunables(tun: Tunables, key: str) -> "RecoilProfile":
        """`[recoil.defaults]`, overridden by `[recoil.<key>]`.

        Shared feel lives in the defaults so a weapon's own table holds only
        what makes it that weapon.
        """
        values = dict(tun.section("recoil.defaults"))
        values.update(tun.section(f"recoil.{key}"))
        missing = [name for name in _KEYS if name not in values]
        if missing:
            raise KeyError(
                f"recoil profile {key!r} is missing {missing}; add them to "
                f"[recoil.{key}] or [recoil.defaults]"
            )
        return RecoilProfile(key=key, **{name: float(values[name]) for name in _KEYS})


@dataclass(slots=True)
class RecoilState:
    kick_pitch: float = 0.0
    kick_yaw: float = 0.0
    kick_pitch_vel: float = 0.0
    kick_yaw_vel: float = 0.0
    climb_pitch: float = 0.0
    climb_yaw: float = 0.0
    shots: int = 0
    """Rounds in the current burst, which is what the pattern is a function of."""
    since_shot: float = 1e9

    @property
    def pitch(self) -> float:
        return self.kick_pitch + self.climb_pitch

    @property
    def yaw(self) -> float:
        return self.kick_yaw + self.climb_yaw


class Recoil:
    """The impulse-and-spring system, driving one weapon's offset."""

    __slots__ = ("profile", "rng", "state", "scale")

    def __init__(self, profile: RecoilProfile, rng: GameRandom) -> None:
        self.profile = profile
        self.rng = rng
        self.state = RecoilState()
        self.scale = 1.0
        """Stance multiplier: prone shoulders more of the impulse than standing."""

    # -- events ----------------------------------------------------------

    def shot(self) -> None:
        """One round has gone off."""
        p = self.profile
        state = self.state
        if state.since_shot > p.burst_reset_s:
            state.shots = 0
        state.since_shot = 0.0
        state.shots += 1

        # Kick: the muzzle is displaced NOW, on this frame, and the spring
        # spends the next fraction of a second pulling it back. Adding to the
        # spring's velocity instead would make it climb to its peak over a
        # couple of frames, which is what made a perfectly reasonable 0.34 deg
        # read as weightless — an attack you can watch is not an attack.
        #
        # kick_pitch_deg is therefore exactly the angle the muzzle jumps, with
        # no gain term between the tuning file and the result.
        state.kick_pitch += (
            p.kick_pitch_deg + self._jitter(p.jitter_pitch_deg)
        ) * self.scale
        state.kick_yaw += (
            p.kick_yaw_deg + self._jitter(p.jitter_yaw_deg)
        ) * self.scale

        # Climb: approaches its ceiling rather than accumulating without limit.
        headroom = 1.0 - (abs(state.climb_pitch) / max(1e-6, p.climb_ceiling_deg))
        state.climb_pitch += p.climb_per_shot_deg * max(0.0, headroom) * self.scale

        # Drift: nothing for the first few rounds, then it ramps in.
        gain = (state.shots - p.drift_onset_shots) / max(1e-6, p.drift_ramp_shots)
        state.climb_yaw += p.drift_yaw_deg * min(1.0, max(0.0, gain)) * self.scale

    def _jitter(self, magnitude: float) -> float:
        return self.rng.jitter(magnitude) if magnitude > 0.0 else 0.0

    # -- clock -----------------------------------------------------------

    def tick(self, dt: float) -> None:
        p = self.profile
        state = self.state
        state.since_shot += dt

        omega, zeta = math.sqrt(p.stiffness), p.damping_ratio
        state.kick_pitch, state.kick_pitch_vel = advance_spring(
            state.kick_pitch, state.kick_pitch_vel, omega, zeta, dt
        )
        state.kick_yaw, state.kick_yaw_vel = advance_spring(
            state.kick_yaw, state.kick_yaw_vel, omega, zeta, dt
        )

        # The climb only bleeds off once you are off the trigger.
        if state.since_shot > p.burst_reset_s and p.climb_recovery_s > 0.0:
            decay = math.exp(-dt / p.climb_recovery_s)
            state.climb_pitch *= decay
            state.climb_yaw *= decay

    def reset(self) -> None:
        self.state = RecoilState()

    # -- output ----------------------------------------------------------

    @property
    def pitch(self) -> float:
        """Degrees the muzzle is off the player's own aim, positive is up."""
        return self.state.pitch

    @property
    def yaw(self) -> float:
        return self.state.yaw

    def aim(self, yaw: float, pitch: float) -> tuple[float, float]:
        """The player's aim with this frame's recoil applied."""
        return yaw + self.state.yaw, pitch + self.state.pitch


def load_recoil(tun: Tunables, key: str, rng: GameRandom) -> Recoil:
    return Recoil(RecoilProfile.from_tunables(tun, key), rng)


__all__ = [
    "RecoilProfile", "RecoilState", "Recoil", "load_recoil", "advance_spring",
]
