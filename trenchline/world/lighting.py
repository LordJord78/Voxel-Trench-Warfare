"""Baked lighting for voxel geometry.

Panda's shader generator emits GLSL 120/130 and the GL profile macOS gives us
is 3.3/4.1 core, which rejects it — so `setShaderAuto`, and with it Panda's
directional lights and shadow maps, are not available here. Rather than fake a
lighting rig that cannot run, the light is baked into vertex colours at mesh
time, which needs no shader at all and costs nothing per frame.

Two terms:

*Directional* — a lambert-ish term per face normal against the sun direction,
flattened toward ambient because the sky is overcast. This separates the six
face orientations by more than a flat palette does.

*Ambient occlusion* — the classic voxel AO: each quad corner is darkened by how
many of the three voxels diagonally around it are solid. This is the term that
makes a trench read as a trench on camera. A parapet lit only by face
orientation is six flat greys; with AO the corners, the revetment joints and
the mouth of a dugout all acquire the shading that tells you the space has
depth. At video bitrate that matters more than texture detail.

Read once at import, like the grid: it is baked into geometry, so changing it
means remeshing the world rather than moving a slider.
"""

from __future__ import annotations

import math
import tomllib
from pathlib import Path
from typing import Final

import numpy as np

_RAW = tomllib.loads(
    (Path(__file__).resolve().parent.parent / "data" / "tunables.toml").read_text(
        encoding="utf-8"
    )
)["lighting"]

SUN_AZIMUTH_DEG: Final[float] = float(_RAW["sun_azimuth_deg"])
SUN_ELEVATION_DEG: Final[float] = float(_RAW["sun_elevation_deg"])
AMBIENT: Final[float] = float(_RAW["ambient"])
DIFFUSE: Final[float] = float(_RAW["diffuse"])
SKY_BOUNCE: Final[float] = float(_RAW["sky_bounce"])
AO_STRENGTH: Final[float] = float(_RAW["ao_strength"])


def sun_vector() -> tuple[float, float, float]:
    """Unit vector pointing at the sun.  Y up, azimuth 0 looking down +z."""
    az = math.radians(SUN_AZIMUTH_DEG)
    el = math.radians(SUN_ELEVATION_DEG)
    horizontal = math.cos(el)
    return (math.sin(az) * horizontal, math.sin(el), math.cos(az) * horizontal)


def face_brightness(normals: tuple[tuple[int, int, int], ...]) -> tuple[float, ...]:
    """Brightness per face orientation: ambient, sun, and a sky bounce term.

    The bounce is what stops downward faces — the underside of a dugout roof,
    the lip of a crater — going to pure black on an overcast day, where in
    reality they still catch light from the whole sky dome.
    """
    sun = sun_vector()
    out = []
    for nx, ny, nz in normals:
        lambert = max(0.0, nx * sun[0] + ny * sun[1] + nz * sun[2])
        # Upward faces see more of the sky than downward ones.
        sky = SKY_BOUNCE * (0.5 + 0.5 * ny)
        out.append(AMBIENT + DIFFUSE * lambert + sky)
    peak = max(out)
    return tuple(value / peak for value in out)


def ao_levels() -> np.ndarray:
    """Brightness multiplier for occlusion 0 (most enclosed) to 3 (open)."""
    steps = np.array([0.0, 1.0 / 3.0, 2.0 / 3.0, 1.0], dtype=np.float32)
    return (1.0 - AO_STRENGTH) + AO_STRENGTH * steps


__all__ = [
    "SUN_AZIMUTH_DEG", "SUN_ELEVATION_DEG", "AMBIENT", "DIFFUSE",
    "SKY_BOUNCE", "AO_STRENGTH", "sun_vector", "face_brightness", "ao_levels",
]
