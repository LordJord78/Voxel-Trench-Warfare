"""What to rebuild next, and how stale the thing you can see has got.

Stale near-field geometry is not a performance problem, it is a correctness
one. Collision and raycasts read the voxel array directly, so a chunk that has
not been remeshed is a wall the simulation has already deleted: the player
takes cover behind nothing, and cannot see the breach they just made. A larger
budget does not fix that — it only makes the wrong chunk arrive sooner along
with everything else. Ordering fixes it.

So chunks are rebuilt nearest-and-visible first, and distant unviewed ones are
allowed to stay stale indefinitely. That staleness is invisible by
construction: nobody is looking at it, and nothing that matters is standing
next to it. It is also free, which is the point — the budget is spent where it
buys something.

No engine imports here on purpose. This is the policy, it is arithmetic, and it
should be testable without a window.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

BAND_VISIBLE_NEAR = 0
BAND_HIDDEN_NEAR = 1
BAND_VISIBLE_FAR = 2
BAND_HIDDEN_FAR = 3
"""Ordering bands, most urgent first.

Visible-and-near is geometry the player is looking at and standing next to.
Hidden-and-near comes before visible-and-far because the player can turn round
in one frame, and because collision does not care where the camera points.
"""


@dataclass(frozen=True, slots=True)
class SchedulePolicy:
    near_m: float
    """Inside this, a wrong chunk can be walked into as well as seen."""
    fov_deg: float
    aspect: float
    budget_ms: float
    """Wall-clock spend per frame, not a chunk count: chunks differ by an order
    of magnitude in cost, so a count budget is a time budget with the units
    filed off and the error bars left in."""
    min_rebuilds: int
    """Always do at least this many, however slow, or a single expensive chunk
    can stall the queue forever."""
    lod_full_m: float
    """Inside this, chunks are meshed at full voxel resolution."""
    lod_half_m: float
    """Out to this, at half. Beyond it, at quarter."""
    lod_hysteresis_m: float
    """Slack on the band edges. Without it a player standing on a boundary
    re-meshes the same chunks back and forth every time they breathe."""

    def lod_for(self, distance: float, current: int = 1) -> int:
        """LOD step for a chunk at `distance`, given what it is meshed at now.

        Hysteresis is directional: coarsen only once clearly past the edge,
        refine only once clearly inside it. Widening the band symmetrically
        does not work — it moves the edge the chunk has just crossed to the
        other side of the chunk, and it flip-flops on every sweep. That mistake
        cost 7 ms a frame of pointless re-meshing.
        """
        slack = self.lod_hysteresis_m
        ideal = 1 if distance <= self.lod_full_m else (
            2 if distance <= self.lod_half_m else 4
        )
        if ideal == current:
            return current
        if ideal > current:                                   # coarsening
            edge = self.lod_full_m if current == 1 else self.lod_half_m
            return ideal if distance > edge + slack else current
        edge = self.lod_full_m if ideal == 1 else self.lod_half_m
        return ideal if distance < edge - slack else current

    @property
    def cos_half_fov(self) -> float:
        """Half-angle of the view cone that circumscribes the frustum."""
        half_h = math.radians(self.fov_deg) * 0.5
        half_v = math.atan(math.tan(half_h) / max(1e-6, self.aspect))
        return math.cos(min(math.pi * 0.5 - 1e-3, math.hypot(half_h, half_v)))

    @staticmethod
    def from_tunables(tun, aspect: float = 16.0 / 9.0) -> "SchedulePolicy":
        return SchedulePolicy(
            near_m=tun.f("world.rebuild_near_m"),
            fov_deg=tun.f("camera.fov"),
            aspect=aspect,
            budget_ms=tun.f("world.rebuild_budget_ms"),
            min_rebuilds=tun.i("world.rebuild_min_per_frame"),
            lod_full_m=tun.f("world.lod_full_m"),
            lod_half_m=tun.f("world.lod_half_m"),
            lod_hysteresis_m=tun.f("world.lod_hysteresis_m"),
        )


def rank(
    centres: np.ndarray,
    eye: np.ndarray,
    forward: np.ndarray,
    policy: SchedulePolicy,
    chunk_radius_m: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Order chunk centres by urgency.

    Returns (order, distances, visible) where `order` indexes the inputs, most
    urgent first. Vectorised because the dirty set under shelling is hundreds
    of chunks and this runs every frame.
    """
    if centres.shape[0] == 0:
        empty_i = np.zeros(0, dtype=np.int64)
        return empty_i, np.zeros(0, np.float64), np.zeros(0, bool)

    delta = centres - eye[None, :]
    distance = np.linalg.norm(delta, axis=1)
    safe = np.maximum(distance, 1e-6)
    cos_angle = (delta @ forward) / safe

    # A chunk is "visible" if any part of its bounding sphere could be in the
    # view cone, so the cone is widened by the chunk's angular radius. Being
    # generous here is cheap; being mean means popping geometry at the edge of
    # the screen the moment the player turns.
    slack = np.arcsin(np.clip(chunk_radius_m / safe, 0.0, 1.0))
    limit = np.arccos(np.clip(policy.cos_half_fov, -1.0, 1.0)) + slack
    visible = np.arccos(np.clip(cos_angle, -1.0, 1.0)) <= limit

    near = distance <= policy.near_m
    band = np.where(
        visible & near,
        BAND_VISIBLE_NEAR,
        np.where(
            near,
            BAND_HIDDEN_NEAR,
            np.where(visible, BAND_VISIBLE_FAR, BAND_HIDDEN_FAR),
        ),
    )
    order = np.lexsort((distance, band))
    return order, distance, visible


@dataclass(slots=True)
class StalenessReport:
    """How far behind the geometry the player can actually see has got.

    Queue depth is the wrong number to watch: a thousand stale chunks behind
    the player and across the map cost nothing, and one stale chunk in the
    trench they are standing in is a bug. These are measured over chunks that
    are both in the frustum and within `near_m`.
    """

    worst_frames: int = 0
    """Longest a near, visible chunk has been dirty, counted from the change.

    Includes frames it spent hidden or far away, so it over-states what the
    player was actually shown: a chunk shelled behind you and turned toward two
    seconds later reads as two seconds stale here, when it was a visible lie
    for one frame."""
    worst_distance_m: float = 0.0
    worst_visible_frames: int = 0
    """Consecutive frames a chunk was near, in view, and wrong. This is the
    number the correctness argument is about."""
    worst_visible_distance_m: float = 0.0
    worst_at_frame: int = 0
    samples: list[int] = field(default_factory=list)
    visible_samples: list[int] = field(default_factory=list)
    _watch: dict = field(default_factory=dict)

    def observe(
        self,
        coords: list,
        frames_outstanding: np.ndarray,
        distances: np.ndarray,
        frame: int,
    ) -> None:
        # Tick every chunk that is near, visible and still wrong; drop the ones
        # that have been rebuilt or have left the band.
        still = set(coords)
        for coord in list(self._watch):
            if coord not in still:
                del self._watch[coord]

        if frames_outstanding.size == 0:
            self.samples.append(0)
            self.visible_samples.append(0)
            return

        worst_visible = 0
        for i, coord in enumerate(coords):
            run = self._watch.get(coord, 0) + 1
            self._watch[coord] = run
            if run > worst_visible:
                worst_visible = run
            if run > self.worst_visible_frames:
                self.worst_visible_frames = run
                self.worst_visible_distance_m = float(distances[i])

        i = int(np.argmax(frames_outstanding))
        worst = int(frames_outstanding[i])
        self.samples.append(worst)
        self.visible_samples.append(worst_visible)
        if worst > self.worst_frames:
            self.worst_frames = worst
            self.worst_distance_m = float(distances[i])
            self.worst_at_frame = frame

    def summary(self) -> dict[str, float]:
        empty = {
            "worst_frames": 0.0, "worst_ms": 0.0, "p99_frames": 0.0,
            "mean_frames": 0.0, "worst_distance_m": 0.0,
            "worst_visible_frames": 0.0, "worst_visible_ms": 0.0,
            "p99_visible_frames": 0.0, "mean_visible_frames": 0.0,
            "worst_visible_distance_m": 0.0,
        }
        if not self.samples:
            return empty
        a = np.array(self.samples, dtype=np.float64)
        v = np.array(self.visible_samples, dtype=np.float64)
        return {
            "worst_frames": float(self.worst_frames),
            "worst_ms": float(self.worst_frames) * 1000.0 / 60.0,
            "p99_frames": float(np.percentile(a, 99)),
            "mean_frames": float(a.mean()),
            "worst_distance_m": self.worst_distance_m,
            "worst_visible_frames": float(self.worst_visible_frames),
            "worst_visible_ms": float(self.worst_visible_frames) * 1000.0 / 60.0,
            "p99_visible_frames": float(np.percentile(v, 99)),
            "mean_visible_frames": float(v.mean()),
            "worst_visible_distance_m": self.worst_visible_distance_m,
        }


__all__ = [
    "SchedulePolicy", "StalenessReport", "rank",
    "BAND_VISIBLE_NEAR", "BAND_VISIBLE_FAR", "BAND_HIDDEN_NEAR", "BAND_HIDDEN_FAR",
]
