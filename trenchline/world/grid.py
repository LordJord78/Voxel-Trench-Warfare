"""The voxel grid itself: how big a voxel is, and how big a chunk is.

Structural rather than a feel value, which is why it is read once at import
from the tuning file and then treated as a constant. Changing it changes what
every other number in the project means, so it is not something to override per
session with `--tunables`.

Everything derived from the grid is derived *in metres* and converted here.
That is the whole point of this module: at 0.5 m voxels a fire step was three
voxels and at 0.25 m it is six, and a codebase full of the literal 3 cannot
tell you which of those it meant.
"""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Final

_RAW = tomllib.loads(
    (Path(__file__).resolve().parent.parent / "data" / "tunables.toml").read_text(
        encoding="utf-8"
    )
)

VOXEL_SIZE: Final[float] = float(_RAW["world"]["voxel_size"])
"""Edge length of one voxel in metres."""

CHUNK_SIZE: Final[int] = int(_RAW["world"]["chunk_voxels"])
"""Voxels per chunk edge.  Bigger means fewer, fatter rebuilds."""

CHUNK_METRES: Final[float] = CHUNK_SIZE * VOXEL_SIZE

_LEGACY_VOXEL_SIZE: Final[float] = 0.5
"""The grid this project's decorative geometry was first written against.

Trench geometry is re-derived from metres. Wrecked buildings, culverts, hulls
and treelines are not: their shapes were authored as voxel counts against a
0.5 m grid, and `scale()` keeps them the same physical size on a finer one
rather than pretending they were ever specified in metres.
"""


def vx(metres: float) -> int:
    """Voxels spanning `metres`, rounded half up.

    Not `round()`: that rounds halves to even, so a 2.25 m trench is 5 voxels
    on one grid and 4 on another for reasons nobody reading the tuning file
    would ever guess.
    """
    import math

    return int(math.floor(metres / VOXEL_SIZE + 0.5))


def vx_at_least(metres: float) -> int:
    """Voxels spanning at least `metres`.  For clearances that may not shrink."""
    import math

    return int(math.ceil(metres / VOXEL_SIZE - 1e-9))


def metres(voxels: float) -> float:
    return voxels * VOXEL_SIZE


def scale(legacy_voxels: int) -> int:
    """Re-express a count authored against the 0.5 m grid, same physical size."""
    return max(1, int(round(legacy_voxels * (_LEGACY_VOXEL_SIZE / VOXEL_SIZE))))


__all__ = [
    "VOXEL_SIZE", "CHUNK_SIZE", "CHUNK_METRES",
    "vx", "vx_at_least", "metres", "scale",
]
