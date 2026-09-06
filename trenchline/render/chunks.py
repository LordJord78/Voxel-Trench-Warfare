"""Chunk geometry manager.

Owns one NodePath per non-empty chunk and drains the world's dirty queue at a
fixed budget per frame, so blowing a hole in a trench costs a few milliseconds
spread over a few frames instead of a visible hitch.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from panda3d.core import ColorAttrib, NodePath

import numpy as np

from ..world import voxel
from ..world.chunks import CHUNK_SIZE, ChunkCoord, VoxelWorld
from ..world.meshing import greedy_mesh
from .geometry import build_geom_node
from .schedule import SchedulePolicy, StalenessReport, rank


@dataclass(slots=True)
class ChunkStats:
    rebuilds: int = 0
    mesh_ms: float = 0.0
    upload_ms: float = 0.0
    nodes: int = 0
    triangles: int = 0
    last_frame_ms: float = 0.0
    last_frame_rebuilds: int = 0
    near_stale: int = 0
    """Chunks the player can see, is standing next to, and is being lied to
    about right now."""
    recent: list[float] = field(default_factory=list)

    def note(self, ms: float, rebuilds: int = 0) -> None:
        self.last_frame_ms = ms
        self.last_frame_rebuilds = rebuilds
        self.recent.append(ms)
        if len(self.recent) > 120:
            del self.recent[:-120]


class ChunkRenderer:
    """Owns one NodePath per non-empty chunk and decides what to rebuild next.

    The decision is the interesting part. Draining the queue in the order it
    was filled means rebuilding whatever was shelled first, which under
    artillery is reliably somewhere nobody is standing — while the trench the
    player is in stays wrong. Chunks are ranked by distance and view-frustum
    membership instead, and the budget is milliseconds rather than a count.
    """

    def __init__(
        self,
        world: VoxelWorld,
        parent: NodePath,
        policy: SchedulePolicy,
        chunk_radius_m: float | None = None,
    ) -> None:
        self.world = world
        self.policy = policy
        self.eye = np.zeros(3, dtype=np.float64)
        self.forward = np.array([0.0, 0.0, 1.0], dtype=np.float64)
        self.chunk_radius_m = (
            chunk_radius_m
            if chunk_radius_m is not None
            else CHUNK_SIZE * voxel.VOXEL_SIZE * 0.866
        )
        self.staleness = StalenessReport()
        self.root = parent.attach_new_node("voxel-world")
        # Vertex colours, no lighting, no shader: the face shading is baked
        # into the mesh and an overcast sky has no interesting light to model.
        self.root.set_attrib(ColorAttrib.make_vertex())
        self.root.set_light_off(1)
        self.root.set_shader_off(1)
        self.nodes: dict[ChunkCoord, NodePath] = {}
        self.stats = ChunkStats()

    def look_from(self, eye, forward) -> None:
        """Tell the scheduler where the player is and what they are looking at."""
        self.eye[:] = eye
        self.forward[:] = forward
        norm = float(np.linalg.norm(self.forward))
        if norm > 1e-9:
            self.forward /= norm

    def build_pending(self, limit: int | None = None) -> int:
        """Rebuild the most urgent dirty chunks within this frame's budget."""
        pending = self.world.dirty_items()
        if not pending:
            self.stats.note(0.0, 0)
            self.stats.near_stale = 0
            self.staleness.observe(
                [], np.zeros(0, np.int64), np.zeros(0, np.float64), self.world.frame
            )
            return 0

        coords = [coord for coord, _ in pending]
        centres = np.array(
            [self.world.chunk_centre(coord) for coord in coords], dtype=np.float64
        )
        order, distance, visible = rank(
            centres, self.eye, self.forward, self.policy, self.chunk_radius_m
        )

        budget_ms = self.policy.budget_ms
        floor = self.policy.min_rebuilds if limit is None else limit
        frame_start = time.perf_counter()
        done = 0
        for index in order:
            if done >= floor and (time.perf_counter() - frame_start) * 1000.0 >= budget_ms:
                break
            if limit is not None and done >= limit:
                break
            coord = coords[int(index)]
            self.world.clear_dirty(coord)
            self._rebuild(coord)
            done += 1

        elapsed = (time.perf_counter() - frame_start) * 1000.0
        self.stats.note(elapsed, done)
        self._observe_staleness(coords, order[done:], distance, visible, pending)
        return done

    def _observe_staleness(self, coords, remaining, distance, visible, pending) -> None:
        """Record how far behind the geometry the player can see has got.

        Only chunks that are both in the frustum and inside `near_m` count.
        Everything else is stale for free: nobody is looking at it and nobody
        is standing next to it.
        """
        frame = self.world.frame
        if remaining.size == 0:
            idx = np.zeros(0, dtype=np.int64)
        else:
            idx = remaining[
                visible[remaining] & (distance[remaining] <= self.policy.near_m)
            ]
        self.stats.near_stale = int(idx.size)
        if idx.size == 0:
            self.staleness.observe(
                [], np.zeros(0, np.int64), np.zeros(0, np.float64), frame
            )
            return
        late = [coords[int(i)] for i in idx]
        since = np.array([pending[int(i)][1] for i in idx], dtype=np.int64)
        self.staleness.observe(late, frame - since, distance[idx], frame)

    def build_all(self, progress: bool = False) -> None:
        """Drain the whole queue.  Used once at load."""
        total = self.world.dirty_count
        done = 0
        while self.world.dirty_count:
            done += self.build_pending(limit=64)
            if progress and total and done % 256 < 64:
                print(f"  meshing {done}/{total} chunks", end="\r", flush=True)
        if progress:
            print(" " * 40, end="\r")

    def _rebuild(self, coord: ChunkCoord) -> None:
        t0 = time.perf_counter()
        mesh = greedy_mesh(self.world.padded_chunk(coord))
        t1 = time.perf_counter()

        existing = self.nodes.pop(coord, None)
        if existing is not None:
            self.stats.triangles -= existing.get_python_tag("tris") or 0
            existing.remove_node()
            self.stats.nodes -= 1

        node = build_geom_node(mesh, f"chunk{coord[0]}_{coord[1]}_{coord[2]}")
        if node is not None:
            path = self.root.attach_new_node(node)
            ox, oy, oz = self.world.chunk_origin(coord)
            path.set_pos(ox, oy, oz)
            tris = mesh.indices.shape[0] // 3
            path.set_python_tag("tris", tris)
            self.nodes[coord] = path
            self.stats.nodes += 1
            self.stats.triangles += tris

        t2 = time.perf_counter()
        self.stats.rebuilds += 1
        self.stats.mesh_ms += (t1 - t0) * 1000.0
        self.stats.upload_ms += (t2 - t1) * 1000.0
