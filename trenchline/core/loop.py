"""Fixed-timestep simulation clock, decoupled from render.

The simulation only ever advances in whole 1/60 s ticks.  Rendering happens at
whatever rate it happens at, and interpolates using `alpha`.  This is what makes
`--headless --seed N --ticks N` produce bit-identical results to a windowed run
of the same length.
"""

from __future__ import annotations

from dataclasses import dataclass, field

TICK_HZ: int = 60
TICK_DT: float = 1.0 / TICK_HZ


@dataclass(slots=True)
class FixedClock:
    """Accumulator that converts wall-clock deltas into whole sim ticks."""

    tick_hz: int = TICK_HZ
    max_substeps: int = 5
    """Ceiling on catch-up ticks per frame, so a stall cannot spiral."""

    accumulator: float = 0.0
    tick: int = 0
    dropped_ticks: int = 0
    _alpha: float = 0.0

    @property
    def dt(self) -> float:
        return 1.0 / self.tick_hz

    @property
    def alpha(self) -> float:
        """Fraction into the next tick, for render interpolation."""
        return self._alpha

    @property
    def sim_time(self) -> float:
        return self.tick * self.dt

    def advance(self, real_dt: float) -> int:
        """Feed a frame's wall-clock delta; returns how many ticks to run."""
        # Clamp pathological deltas (debugger pauses, window drags).
        self.accumulator += min(real_dt, 0.25)
        steps = int(self.accumulator / self.dt)
        if steps > self.max_substeps:
            self.dropped_ticks += steps - self.max_substeps
            self.accumulator = self.dt * self.max_substeps + (
                self.accumulator % self.dt
            )
            steps = self.max_substeps
        self.accumulator -= steps * self.dt
        self._alpha = self.accumulator / self.dt
        self.tick += steps
        return steps


@dataclass(slots=True)
class FrameStats:
    """Rolling frame-time record, reported at each milestone."""

    window: int = 240
    samples: list[float] = field(default_factory=list)

    def record(self, frame_seconds: float) -> None:
        self.samples.append(frame_seconds * 1000.0)
        if len(self.samples) > self.window:
            del self.samples[: len(self.samples) - self.window]

    def summary(self) -> dict[str, float]:
        if not self.samples:
            return {"mean": 0.0, "p50": 0.0, "p95": 0.0, "max": 0.0, "fps": 0.0}
        ordered = sorted(self.samples)
        n = len(ordered)
        mean = sum(ordered) / n
        return {
            "mean": mean,
            "p50": ordered[n // 2],
            "p95": ordered[min(n - 1, int(n * 0.95))],
            "max": ordered[-1],
            "fps": 1000.0 / mean if mean else 0.0,
        }
