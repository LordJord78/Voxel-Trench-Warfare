"""Voxel material table.

Pure data plus numpy lookup tables.  This module must never import an engine.
Colours are a deliberately narrow palette: mud browns, wet clay, waterlogged
greys, bleached timber, burnt treeline.
"""

from __future__ import annotations

from typing import Final

import numpy as np

from .grid import VOXEL_SIZE as _VOXEL_SIZE

AIR: Final[int] = 0
SOD: Final[int] = 1
MUD: Final[int] = 2
CLAY: Final[int] = 3
SUBSOIL: Final[int] = 4
SPOIL: Final[int] = 5
SANDBAG: Final[int] = 6
DUCKBOARD: Final[int] = 7
TIMBER: Final[int] = 8
CORRUGATE: Final[int] = 9
CONCRETE: Final[int] = 10
BRICK: Final[int] = 11
TRUNK: Final[int] = 12
BRANCH: Final[int] = 13
WATER: Final[int] = 14
RUBBLE: Final[int] = 15
WIRE: Final[int] = 16
HULL: Final[int] = 17

MATERIAL_COUNT: Final[int] = 18

NAMES: Final[tuple[str, ...]] = (
    "air", "sod", "mud", "clay", "subsoil", "spoil", "sandbag", "duckboard",
    "timber", "corrugate", "concrete", "brick", "trunk", "branch", "water",
    "rubble", "wire", "hull",
)

# (r, g, b) 0-255.
_COLOURS: Final[tuple[tuple[int, int, int], ...]] = (
    (0, 0, 0),          # air (unused)
    (104, 102, 72),     # sod - dead winter grass over dirt
    (112, 90, 68),      # mud
    (142, 122, 96),     # wet clay, lighter and yellower
    (118, 104, 88),     # subsoil
    (92, 72, 54),       # freshly turned spoil, darker than settled ground
    (152, 144, 114),    # sandbag hessian
    (130, 108, 76),     # duckboard planking
    (106, 86, 64),      # revetment timber
    (132, 132, 126),    # corrugated steel
    (160, 158, 150),    # concrete
    (140, 92, 74),      # brick
    (68, 56, 46),       # burnt trunk
    (86, 74, 58),       # burnt branch
    (92, 106, 104),     # standing water, cold grey-green
    (118, 112, 98),     # rubble
    (100, 98, 90),      # wire pickets
    (54, 50, 48),       # burnt-out armour, near black
)

# Renderable: produces geometry.
_RENDERABLE = np.ones(MATERIAL_COUNT, dtype=bool)
_RENDERABLE[AIR] = False

# Opaque: hides the face of the voxel behind it.
_OPAQUE = _RENDERABLE.copy()
_OPAQUE[WATER] = False
_OPAQUE[WIRE] = False

# Solid: blocks movement and bullets.
_SOLID = _RENDERABLE.copy()
_SOLID[WATER] = False
_SOLID[WIRE] = False

# Blocks line of sight for the observation layer.
_BLOCKS_SIGHT = _SOLID.copy()

# Diggable: can be carved by explosions.  Concrete resists, and we never carve
# water because water is a fill result, not a structural material.
_HARDNESS = np.array(
    [0.0, 1.0, 1.0, 1.1, 1.2, 0.8, 1.4, 0.9, 1.0, 1.3, 4.0, 2.6, 1.6, 0.7,
     0.0, 1.2, 0.5, 3.4],
    dtype=np.float32,
)

# What a voxel becomes when an explosion carves it but does not fully remove it.
_SPOIL_OF = np.array(
    [AIR, SPOIL, SPOIL, SPOIL, SPOIL, SPOIL, SPOIL, RUBBLE, RUBBLE, RUBBLE,
     RUBBLE, RUBBLE, BRANCH, AIR, WATER, RUBBLE, AIR, RUBBLE],
    dtype=np.uint8,
)

# Granular: loose material with no tensile strength.  It falls when whatever
# was underneath it is blown away, which is what turns an undercut crater wall
# into dirt in the bottom of the trench.  Timber, corrugate, concrete and brick
# are left out on purpose: revetment and masonry hold their own weight, and a
# dugout roof that slumps the moment a shell lands nearby is not a dugout.
_GRANULAR = np.zeros(MATERIAL_COUNT, dtype=bool)
for _material in (SOD, MUD, CLAY, SUBSOIL, SPOIL, SANDBAG, RUBBLE):
    _GRANULAR[_material] = True

# Loose: granular AND already disturbed, so it also slumps sideways to find its
# angle of repose. Undisturbed strata do not — a ploughed field is full of
# one-voxel steps, and soil that slides off every one of them erodes the whole
# map into a plain the first time anything settles.
_LOOSE = np.zeros(MATERIAL_COUNT, dtype=bool)
for _material in (SPOIL, RUBBLE, SANDBAG):
    _LOOSE[_material] = True

COLOURS: Final[np.ndarray] = np.array(_COLOURS, dtype=np.uint8)
RENDERABLE: Final[np.ndarray] = _RENDERABLE
OPAQUE: Final[np.ndarray] = _OPAQUE
SOLID: Final[np.ndarray] = _SOLID
BLOCKS_SIGHT: Final[np.ndarray] = _BLOCKS_SIGHT
HARDNESS: Final[np.ndarray] = _HARDNESS
SPOIL_OF: Final[np.ndarray] = _SPOIL_OF
GRANULAR: Final[np.ndarray] = _GRANULAR
LOOSE: Final[np.ndarray] = _LOOSE

VOXEL_SIZE: Final[float] = _VOXEL_SIZE
"""Edge length of one voxel in metres.  Defined in `grid`, re-exported here
because half the project already asks `voxel.VOXEL_SIZE` for it."""


def is_solid(material: int) -> bool:
    return bool(SOLID[material])


def colour_of(material: int) -> tuple[int, int, int]:
    r, g, b = COLOURS[material]
    return int(r), int(g), int(b)
