"""Structural description of the trench network.

The voxels are the truth: whether a traverse blocks fragmentation is decided by
a voxel raycast, not by anything in here.  This module records *where the
features are* so AI can navigate the line, so objectives can be placed, and so
the player's stance options (firing step, dugout, periscope) know what they are
standing next to.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterator

from . import voxel


@dataclass(frozen=True, slots=True)
class Bay:
    """One fire bay, bounded at both ends by a traverse jog.

    Every height in here is absolute voxel y, and every one of them is decided
    per bay at generation time.  `crest_y` is not a global constant the terrain
    has to stay under: it is derived from this bay's own `step_top_y`, so the
    peek works the same in a hollow as it does on a rise.
    """

    line: str
    index: int
    x0: int
    x1: int
    z0: int
    z1: int
    floor_y: int
    facing: int
    """+1 if the enemy lies toward +z, -1 toward -z."""
    step_lo: int
    """Low edge of the firing-step bench, on the trench's cross axis."""
    step_span: int
    """Bench depth in voxels.  Has to be wide enough to actually stand on."""
    step_top_y: int
    crest_y: int
    """Parapet crest.  `step_top_y + floor(standing eye / voxel)` by construction
    on a fire bay, which is what guarantees the standing/crouched split."""
    walk_x: float
    walk_z: float
    """Voxel-space centre of the *clear* walkway: the firing step is standing
    in part of the bay, and spawning on top of it means spawning inside it."""
    long_axis: int = 0
    """0 if the trench runs along x, 2 if along z.  Stored rather than inferred
    from the extents: the last bay on a line is often a stub shorter than the
    trench is wide, and guessing from which side is longer gets it backwards."""
    ground_y: int = 0
    """Local field surface, for reporting how far the parapet stands proud."""

    @property
    def has_firing_step(self) -> bool:
        return self.step_top_y > self.floor_y + 1

    @property
    def centre_voxel(self) -> tuple[int, int, int]:
        return (int(self.walk_x), self.floor_y + 1, int(self.walk_z))

    @property
    def centre_metres(self) -> tuple[float, float, float]:
        s = voxel.VOXEL_SIZE
        return (self.walk_x * s, (self.floor_y + 1) * s, self.walk_z * s)

    @property
    def step_centre(self) -> tuple[float, float]:
        """Voxel-space (x, z) of the middle of the bench."""
        mid = self.step_lo + self.step_span * 0.5
        if self.long_axis == 0:
            return ((self.x0 + self.x1) * 0.5, mid)
        return (mid, (self.z0 + self.z1) * 0.5)

    @property
    def step_metres(self) -> tuple[float, float, float]:
        """Where you stand to look over the parapet."""
        s = voxel.VOXEL_SIZE
        cx, cz = self.step_centre
        return (cx * s, self.step_top_y * s, cz * s)

    @property
    def crest_rise_m(self) -> float:
        """How far this bay's crest stands above its own firing-step bench."""
        return (self.crest_y - self.step_top_y) * voxel.VOXEL_SIZE

    def clearance_m(self, eye_height: float) -> float:
        """How far an eye at `eye_height` on the bench clears this bay's crest.

        Positive for a standing man, negative for a crouched one.  That sign
        flip is the peek, and because both terms come from this bay, it holds
        whatever the ground is doing around it.
        """
        return eye_height - self.crest_rise_m


@dataclass(frozen=True, slots=True)
class Dugout:
    """A covered chamber off the trench.  Overhead concealment; one way out."""

    line: str
    lo: tuple[int, int, int]
    hi: tuple[int, int, int]
    entrance: tuple[int, int, int]

    def contains_voxel(self, x: int, y: int, z: int) -> bool:
        return (
            self.lo[0] <= x < self.hi[0]
            and self.lo[1] <= y < self.hi[1]
            and self.lo[2] <= z < self.hi[2]
        )

    def contains_point(self, px: float, py: float, pz: float) -> bool:
        s = voxel.VOXEL_SIZE
        return self.contains_voxel(int(px // s), int(py // s), int(pz // s))

    @property
    def centre_metres(self) -> tuple[float, float, float]:
        s = voxel.VOXEL_SIZE
        return tuple(((self.lo[i] + self.hi[i]) * 0.5) * s for i in range(3))  # type: ignore[return-value]


@dataclass(frozen=True, slots=True)
class TrenchLine:
    name: str
    side: int
    """0 = friendly, 1 = opposing."""
    floor_y: int
    facing: int
    bays: tuple[Bay, ...]

    def bay_at(self, x: int) -> Bay | None:
        for bay in self.bays:
            if bay.x0 <= x < bay.x1:
                return bay
        return None


@dataclass(slots=True)
class TrenchGraph:
    """Walkable waypoints along the network, for squad movement."""

    nodes: list[tuple[int, int, int]] = field(default_factory=list)
    edges: dict[int, list[int]] = field(default_factory=dict)

    def add_node(self, voxel_pos: tuple[int, int, int]) -> int:
        self.nodes.append(voxel_pos)
        index = len(self.nodes) - 1
        self.edges[index] = []
        return index

    def link(self, a: int, b: int) -> None:
        if b not in self.edges[a]:
            self.edges[a].append(b)
        if a not in self.edges[b]:
            self.edges[b].append(a)


@dataclass(slots=True)
class TrenchNetwork:
    lines: dict[str, TrenchLine] = field(default_factory=dict)
    dugouts: tuple[Dugout, ...] = ()
    graph: TrenchGraph = field(default_factory=TrenchGraph)

    def all_bays(self) -> Iterator[Bay]:
        for line in self.lines.values():
            yield from line.bays

    def dugout_containing(self, px: float, py: float, pz: float) -> Dugout | None:
        for dugout in self.dugouts:
            if dugout.contains_point(px, py, pz):
                return dugout
        return None

    def nearest_bay(self, px: float, pz: float, line: str | None = None) -> Bay | None:
        s = voxel.VOXEL_SIZE
        best: Bay | None = None
        best_d = float("inf")
        for bay in self.all_bays():
            if line is not None and bay.line != line:
                continue
            cx, _, cz = bay.centre_metres
            d = (cx - px) ** 2 + (cz - pz) ** 2
            if d < best_d:
                best_d, best = d, bay
        return best
