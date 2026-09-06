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
    """One fire bay, bounded at both ends by a traverse jog."""

    line: str
    index: int
    x0: int
    x1: int
    z0: int
    z1: int
    floor_y: int
    facing: int
    """+1 if the enemy lies toward +z, -1 toward -z."""
    step_z: int
    """Voxel z of the firing-step column (voxel x for a trench running in z)."""
    step_top_y: int
    walk_x: float
    walk_z: float
    """Voxel-space centre of the *clear* walkway: the firing step is standing
    in part of the bay, and spawning on top of it means spawning inside it."""

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
    def step_metres(self) -> tuple[float, float, float]:
        """Where you stand to look over the parapet."""
        s = voxel.VOXEL_SIZE
        return (self.walk_x * s, self.step_top_y * s, (self.step_z + 0.5) * s)


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
