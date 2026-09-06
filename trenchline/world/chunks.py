"""Chunked voxel storage.

The world is one contiguous numpy array with a one-voxel border, so a padded
chunk (needed by the greedy mesher for seam culling) is a zero-copy view rather
than a copy.  The border is solid, which both culls the map's outer faces and
gives out-of-bounds queries a sane "you cannot walk off the map" answer.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Iterator

import numpy as np

from . import voxel

CHUNK_SIZE: int = 16

ChunkCoord = tuple[int, int, int]


@dataclass(frozen=True, slots=True)
class WorldDims:
    x: int
    y: int
    z: int

    def __post_init__(self) -> None:
        for n in (self.x, self.y, self.z):
            if n <= 0 or n % CHUNK_SIZE:
                raise ValueError(f"world dims must be positive multiples of {CHUNK_SIZE}")

    @property
    def chunks(self) -> ChunkCoord:
        return (self.x // CHUNK_SIZE, self.y // CHUNK_SIZE, self.z // CHUNK_SIZE)

    @property
    def metres(self) -> tuple[float, float, float]:
        s = voxel.VOXEL_SIZE
        return (self.x * s, self.y * s, self.z * s)


class VoxelWorld:
    """Mutable voxel grid with a chunk rebuild queue.

    Indices are voxel coordinates with y up.  Metres are voxel * VOXEL_SIZE.
    """

    def __init__(self, dims: WorldDims) -> None:
        self.dims = dims
        self._store = np.zeros((dims.x + 2, dims.y + 2, dims.z + 2), dtype=np.uint8)
        # Solid skirt on every side but the top, so the map edge renders nothing
        # and the sky stays open.
        self._store[0, :, :] = voxel.SUBSOIL
        self._store[-1, :, :] = voxel.SUBSOIL
        self._store[:, 0, :] = voxel.SUBSOIL
        self._store[:, :, 0] = voxel.SUBSOIL
        self._store[:, :, -1] = voxel.SUBSOIL
        self.v: np.ndarray = self._store[1:-1, 1:-1, 1:-1]
        """Interior voxels, shape (x, y, z).  Writes go straight through."""

        self._dirty: set[ChunkCoord] = set()
        self._queue: deque[ChunkCoord] = deque()
        self.water_table: int = 0
        """Voxel y below which open cavities flood.  Set by generation."""

    # -- queries ---------------------------------------------------------

    def in_bounds(self, x: int, y: int, z: int) -> bool:
        return 0 <= x < self.dims.x and 0 <= y < self.dims.y and 0 <= z < self.dims.z

    def get(self, x: int, y: int, z: int) -> int:
        """Material at a voxel.  Out of bounds reads as the solid skirt."""
        if not self.in_bounds(x, y, z):
            return voxel.AIR if y >= self.dims.y else voxel.SUBSOIL
        return int(self.v[x, y, z])

    def solid(self, x: int, y: int, z: int) -> bool:
        return bool(voxel.SOLID[self.get(x, y, z)])

    def solid_at(self, px: float, py: float, pz: float) -> bool:
        """Solidity at a point in metres."""
        s = voxel.VOXEL_SIZE
        return self.solid(int(px // s), int(py // s), int(pz // s))

    def material_at(self, px: float, py: float, pz: float) -> int:
        s = voxel.VOXEL_SIZE
        return self.get(int(px // s), int(py // s), int(pz // s))

    def padded_chunk(self, coord: ChunkCoord) -> np.ndarray:
        """(CHUNK_SIZE+2)**3 view centred on the chunk, including neighbours."""
        cx, cy, cz = coord
        n = CHUNK_SIZE
        return self._store[
            cx * n : cx * n + n + 2,
            cy * n : cy * n + n + 2,
            cz * n : cz * n + n + 2,
        ]

    def chunk_origin(self, coord: ChunkCoord) -> tuple[float, float, float]:
        s = voxel.VOXEL_SIZE * CHUNK_SIZE
        return (coord[0] * s, coord[1] * s, coord[2] * s)

    def all_chunks(self) -> Iterator[ChunkCoord]:
        nx, ny, nz = self.dims.chunks
        for cx in range(nx):
            for cy in range(ny):
                for cz in range(nz):
                    yield (cx, cy, cz)

    # -- mutation --------------------------------------------------------

    def set(self, x: int, y: int, z: int, material: int) -> None:
        if not self.in_bounds(x, y, z):
            return
        if self.v[x, y, z] == material:
            return
        self.v[x, y, z] = material
        self._touch(x, y, z)

    def _touch(self, x: int, y: int, z: int) -> None:
        """Dirty the owning chunk, plus neighbours when on a seam."""
        n = CHUNK_SIZE
        cx, cy, cz = x // n, y // n, z // n
        lx, ly, lz = x % n, y % n, z % n
        for dx in (-1, 0, 1) if lx in (0, n - 1) else (0,):
            if lx == 0 and dx > 0 or lx == n - 1 and dx < 0:
                continue
            for dy in (-1, 0, 1) if ly in (0, n - 1) else (0,):
                if ly == 0 and dy > 0 or ly == n - 1 and dy < 0:
                    continue
                for dz in (-1, 0, 1) if lz in (0, n - 1) else (0,):
                    if lz == 0 and dz > 0 or lz == n - 1 and dz < 0:
                        continue
                    self.mark_dirty((cx + dx, cy + dy, cz + dz))

    def mark_dirty(self, coord: ChunkCoord) -> None:
        nx, ny, nz = self.dims.chunks
        cx, cy, cz = coord
        if not (0 <= cx < nx and 0 <= cy < ny and 0 <= cz < nz):
            return
        if coord in self._dirty:
            return
        self._dirty.add(coord)
        self._queue.append(coord)

    def mark_region_dirty(self, lo: tuple[int, int, int], hi: tuple[int, int, int]) -> None:
        """Dirty every chunk overlapping an inclusive voxel-space box."""
        n = CHUNK_SIZE
        for cx in range(lo[0] // n - 1, hi[0] // n + 2):
            for cy in range(lo[1] // n - 1, hi[1] // n + 2):
                for cz in range(lo[2] // n - 1, hi[2] // n + 2):
                    self.mark_dirty((cx, cy, cz))

    def mark_all_dirty(self) -> None:
        for coord in self.all_chunks():
            self.mark_dirty(coord)

    @property
    def dirty_count(self) -> int:
        return len(self._queue)

    def take_dirty(self, limit: int) -> list[ChunkCoord]:
        """Pop up to `limit` chunks off the rebuild queue."""
        out: list[ChunkCoord] = []
        while self._queue and len(out) < limit:
            coord = self._queue.popleft()
            self._dirty.discard(coord)
            out.append(coord)
        return out
