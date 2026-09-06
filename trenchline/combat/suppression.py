"""Being shot at, with nothing hitting you.

Suppression is the whole reason small-arms fire matters at trench ranges: most
rounds miss, and the ones that miss are still doing the work. A rifle that only
mattered when it connected would make a hundred metres of open ground a
formality.

Two things raise it, and they are deliberately different:

*Cracks* — a supersonic round passing close to your head. This is the one that
actually suppresses people. It is measured against the round's flight segment
rather than its endpoint, because a bullet travels 3.7 m per tick and a test
that only looked at where it stopped would miss every round that went past.

*Impacts* — something striking the ground near you. Lower weight per event,
because dirt kicking up beside you is frightening but a crack past your ear is
frightening *and* means they have your range.

What it does, in order of how much it is felt: takes your movement away, takes
your aim apart, pushes you off the firing step, and greys out the world. The
first three are simulation and are what make it a mechanic; the fourth is the
renderer's business and is only how it is communicated.

Deterministic. The only randomness is the flinch direction, from a named
stream, and the level itself is a pure function of what has been shot at you.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..core.rng import GameRandom
from ..data import Tunables
from ..physics.vec import Vec3

_KEYS = (
    "crack_radius_m",
    "crack_amount",
    "impact_radius_m",
    "impact_amount",
    "decay_per_s",
    "hold_s",
    "max_level",
    "sway_at_full",
    "speed_at_full",
    "flinch_deg",
    "flinch_recovery_s",
    "eject_from_step_at",
    "shake_deg_at_full",
    "shake_hz",
    "desaturate_at_full",
    "vignette_at_full",
    "blur_at_full",
)


@dataclass(frozen=True, slots=True)
class SuppressionProfile:
    crack_radius_m: float
    """How close a round has to pass. Beyond this you hear it; inside it you
    duck."""
    crack_amount: float
    impact_radius_m: float
    impact_amount: float
    decay_per_s: float
    hold_s: float
    """Grace before recovery starts, so a burst does not begin bleeding off
    between its own rounds."""
    max_level: float
    sway_at_full: float
    speed_at_full: float
    """Movement multiplier at full suppression. Well under 1: being pinned
    should mean pinned."""
    flinch_deg: float
    flinch_recovery_s: float
    eject_from_step_at: float
    """Above this you cannot stay on the firing step. Not a suggestion."""
    shake_deg_at_full: float
    shake_hz: float
    desaturate_at_full: float
    vignette_at_full: float
    blur_at_full: float

    @staticmethod
    def from_tunables(tun: Tunables) -> "SuppressionProfile":
        values = dict(tun.section("suppression"))
        missing = [name for name in _KEYS if name not in values]
        if missing:
            raise KeyError(f"[suppression] is missing {missing}")
        return SuppressionProfile(**{name: float(values[name]) for name in _KEYS})


def segment_distance(
    a: Vec3, b: Vec3, point: Vec3
) -> float:
    """Closest approach of the segment a->b to `point`.

    A round covers metres per tick, so "did it pass near my head" is a question
    about the path, not about either endpoint.
    """
    dx, dy, dz = b.x - a.x, b.y - a.y, b.z - a.z
    length_sq = dx * dx + dy * dy + dz * dz
    if length_sq < 1e-12:
        return math.dist((a.x, a.y, a.z), (point.x, point.y, point.z))
    t = ((point.x - a.x) * dx + (point.y - a.y) * dy + (point.z - a.z) * dz) / length_sq
    t = max(0.0, min(1.0, t))
    return math.dist(
        (a.x + dx * t, a.y + dy * t, a.z + dz * t), (point.x, point.y, point.z)
    )


@dataclass(slots=True)
class SuppressionState:
    level: float = 0.0
    since_event: float = 1e9
    flinch_pitch: float = 0.0
    flinch_yaw: float = 0.0
    shake_phase: float = 0.0
    cracks: int = 0
    impacts: int = 0
    ejected: int = 0
    """How many times it has thrown the player off the firing step."""


class Suppression:
    """One person's willingness to keep their head up."""

    __slots__ = ("profile", "rng", "state")

    def __init__(self, profile: SuppressionProfile, rng: GameRandom) -> None:
        self.profile = profile
        self.rng = rng
        self.state = SuppressionState()

    # -- events ----------------------------------------------------------

    def crack(self, miss_distance: float) -> None:
        """A round went past at `miss_distance` metres."""
        p = self.profile
        if miss_distance > p.crack_radius_m:
            return
        # Closer is worse, and non-linearly so: a round that parts your hair is
        # not twice as bad as one two metres away, it is far worse.
        nearness = 1.0 - (miss_distance / p.crack_radius_m)
        self._add(p.crack_amount * nearness * nearness)
        self.state.cracks += 1
        self._flinch(nearness)

    def impact(self, distance: float) -> None:
        p = self.profile
        if distance > p.impact_radius_m:
            return
        nearness = 1.0 - (distance / p.impact_radius_m)
        self._add(p.impact_amount * nearness * nearness)
        self.state.impacts += 1

    def _add(self, amount: float) -> None:
        self.state.level = min(self.profile.max_level, self.state.level + amount)
        self.state.since_event = 0.0

    def _flinch(self, nearness: float) -> None:
        magnitude = self.profile.flinch_deg * nearness
        self.state.flinch_pitch += magnitude
        self.state.flinch_yaw += self.rng.jitter(magnitude)

    # -- clock -----------------------------------------------------------

    def tick(self, dt: float) -> None:
        state = self.state
        p = self.profile
        state.since_event += dt
        if state.since_event >= p.hold_s:
            state.level = max(0.0, state.level - p.decay_per_s * dt)
        decay = math.exp(-dt / max(1e-3, p.flinch_recovery_s))
        state.flinch_pitch *= decay
        state.flinch_yaw *= decay
        if state.level > 0.0:
            state.shake_phase = (state.shake_phase + dt * p.shake_hz * math.tau) % math.tau
        else:
            state.shake_phase = 0.0

    def reset(self) -> None:
        self.state = SuppressionState()

    # -- what it costs ---------------------------------------------------

    @property
    def level(self) -> float:
        return self.state.level

    def _blend(self, at_full: float) -> float:
        return 1.0 + (at_full - 1.0) * self.state.level

    @property
    def sway_scale(self) -> float:
        return self._blend(self.profile.sway_at_full)

    @property
    def speed_scale(self) -> float:
        return self._blend(self.profile.speed_at_full)

    @property
    def forced_off_the_step(self) -> bool:
        return self.state.level >= self.profile.eject_from_step_at

    @property
    def aim_offset(self) -> tuple[float, float]:
        """(yaw, pitch) the flinch is dragging your muzzle to right now."""
        return (self.state.flinch_yaw, self.state.flinch_pitch)

    def shake(self) -> tuple[float, float]:
        """(pitch, roll) camera shake, in degrees."""
        amount = self.profile.shake_deg_at_full * self.state.level
        if amount <= 0.0:
            return (0.0, 0.0)
        phase = self.state.shake_phase
        return (math.sin(phase * 1.7) * amount, math.sin(phase) * amount * 0.7)

    @property
    def desaturation(self) -> float:
        return self.profile.desaturate_at_full * self.state.level

    @property
    def vignette(self) -> float:
        return self.profile.vignette_at_full * self.state.level

    @property
    def blur(self) -> float:
        return self.profile.blur_at_full * self.state.level


def load_suppression(tun: Tunables, rng: GameRandom) -> Suppression:
    return Suppression(SuppressionProfile.from_tunables(tun), rng)


__all__ = [
    "SuppressionProfile", "SuppressionState", "Suppression",
    "load_suppression", "segment_distance",
]
