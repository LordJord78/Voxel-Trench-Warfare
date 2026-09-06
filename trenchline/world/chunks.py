"""Chunked voxel storage.

The world is one contiguous numpy array with a one-voxel border, so a padded
chunk (needed by the greedy mesher for seam culling) is a zero-copy view rather
than a copy.  The border is solid, which both culls the map's outer faces and
gives out-of-bounds queries a sane "you cannot walk off the map" answer.
"""

from __future__ import annotations

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

        # coord -> frame it FIRST went stale. A dict rather than a queue
        # because the order chunks are rebuilt in is a policy decision the
        # renderer makes from where the player is looking, and FIFO is the one
        # ordering that is guaranteed to be wrong: it rebuilds the far side of
        # the map before the wall the player is standing behind.
        self._dirty: dict[ChunkCoord, int] = {}
        self.frame: int = 0
        """Advanced by whoever is drawing. Staleness is measured against it."""
        self.dirtied_total: int = 0
        """Rebuilds the world has asked for. Against the number the renderer
        managed, this is demand against supply, which is the only way to see a
        rebuild queue losing before it has visibly fallen behind."""
        self.coalesced_total: int = 0
        """Dirty marks absorbed by a chunk that was already waiting. A chunk
        shelled three times before it is rebuilt is rebuilt once, at its final
        state, and this counts the two rebuilds that never had to happen."""
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

    def chunk_centre(self, coord: ChunkCoord) -> tuple[float, float, float]:
        s = voxel.VOXEL_SIZE * CHUNK_SIZE
        return ((coord[0] + 0.5) * s, (coord[1] + 0.5) * s, (coord[2] + 0.5) * s)

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
            # Already waiting. Keep the ORIGINAL timestamp: staleness is how
            # long the player has been looking at wrong geometry, which starts
            # at the first change, not the most recent one.
            self.coalesced_total += 1
            return
        self._dirty[coord] = self.frame
        self.dirtied_total += 1

    def mark_region_dirty(self, lo: tuple[int, int, int], hi: tuple[int, int, int]) -> None:
        """Dirty every chunk overlapping an inclusive voxel-space box.

        The box is grown by one *voxel*, which is what the mesher needs to cull
        a seam correctly, and only then converted to chunks. Growing it by one
        *chunk* on every side instead turned a change spanning two chunks into
        a hundred rebuilds — most of them producing geometry identical to what
        was already on the GPU, and no rebuild budget can outrun that.
        """
        n = CHUNK_SIZE
        for cx in range((lo[0] - 1) // n, (hi[0] + 1) // n + 1):
            for cy in range((lo[1] - 1) // n, (hi[1] + 1) // n + 1):
                for cz in range((lo[2] - 1) // n, (hi[2] + 1) // n + 1):
                    self.mark_dirty((cx, cy, cz))

    def mark_all_dirty(self) -> None:
        for coord in self.all_chunks():
            self.mark_dirty(coord)

    @property
    def dirty_count(self) -> int:
        return len(self._dirty)

    def dirty_items(self) -> list[tuple[ChunkCoord, int]]:
        """Every waiting chunk with the frame it first went stale."""
        return list(self._dirty.items())

    def dirty_since(self, coord: ChunkCoord) -> int | None:
        return self._dirty.get(coord)

    def clear_dirty(self, coord: ChunkCoord) -> None:
        self._dirty.pop(coord, None)

    def take_dirty(self, limit: int) -> list[ChunkCoord]:
        """Pop up to `limit` chunks in insertion order.

        Kept for the load-time drain and for tests, where every chunk is
        rebuilt anyway and order cannot matter. Anything drawing a frame should
        be choosing by priority instead.
        """
        out: list[ChunkCoord] = []
        for coord in list(self._dirty)[:limit]:
            del self._dirty[coord]
            out.append(coord)
        return out
