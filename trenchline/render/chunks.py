"""Chunk geometry manager.

Owns one NodePath per non-empty chunk and drains the world's dirty queue at a
fixed budget per frame, so blowing a hole in a trench costs a few milliseconds
spread over a few frames instead of a visible hitch.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from panda3d.core import ColorAttrib, NodePath

from ..world.chunks import ChunkCoord, VoxelWorld
from ..world.meshing import greedy_mesh
from .geometry import build_geom_node


@dataclass(slots=True)
class ChunkStats:
    rebuilds: int = 0
    mesh_ms: float = 0.0
    upload_ms: float = 0.0
    nodes: int = 0
    triangles: int = 0
    last_frame_ms: float = 0.0
    recent: list[float] = field(default_factory=list)

    def note(self, ms: float) -> None:
        self.last_frame_ms = ms
        self.recent.append(ms)
        if len(self.recent) > 120:
            del self.recent[:-120]


class ChunkRenderer:
    def __init__(self, world: VoxelWorld, parent: NodePath, budget: int = 4) -> None:
        self.world = world
        self.budget = budget
        self.root = parent.attach_new_node("voxel-world")
        # Vertex colours, no lighting, no shader: the face shading is baked
        # into the mesh and an overcast sky has no interesting light to model.
        self.root.set_attrib(ColorAttrib.make_vertex())
        self.root.set_light_off(1)
        self.root.set_shader_off(1)
        self.nodes: dict[ChunkCoord, NodePath] = {}
        self.stats = ChunkStats()

    def build_pending(self, limit: int | None = None) -> int:
        """Rebuild up to `limit` dirty chunks.  Returns how many were done."""
        coords = self.world.take_dirty(self.budget if limit is None else limit)
        if not coords:
            self.stats.note(0.0)
            return 0
        frame_start = time.perf_counter()
        for coord in coords:
            self._rebuild(coord)
        self.stats.note((time.perf_counter() - frame_start) * 1000.0)
        return len(coords)

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
