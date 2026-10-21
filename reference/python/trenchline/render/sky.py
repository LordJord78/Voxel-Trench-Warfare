"""The sky, as a graded dome rather than a clear colour.

A flat clear colour reads as "unfinished" more than almost anything else on
camera: the horizon vanishes, distant geometry has nothing to sit against, and
fog blends toward a colour that appears nowhere in the scene.

This is a vertex-coloured dome, built through the same static buffer writer as
the terrain. Overcast, so there is no sun disc — just a broad brightening where
the sun is behind the cloud, taken from the same [lighting] sun position the
terrain shading is baked from, so the light in the sky and the light on the mud
agree with each other.

The horizon band is the colour the distance fog blends to. That is the whole
trick: fog toward the horizon colour makes the far treeline dissolve into the
sky instead of into a grey wall, and it hides the LOD transition and the edge
of the map for free.
"""

from __future__ import annotations

import math

import numpy as np
from panda3d.core import ColorAttrib, NodePath

from ..data import Tunables
from ..world import lighting
from .buffers import TRACER_FORMAT, build_static

_SEGMENTS = 32
_RINGS = 18
_BOTTOM_DEG = -25.0
"""A skirt below the horizon, so looking down off the edge of the map still
finds sky rather than the void."""


def _colour(
    elevation: float,
    direction: tuple[float, float, float],
    horizon: np.ndarray,
    zenith: np.ndarray,
    sun: tuple[float, float, float],
    glow: float,
    glow_power: float,
) -> np.ndarray:
    t = min(1.0, max(0.0, elevation / 55.0)) ** 0.75
    base = horizon + (zenith - horizon) * t
    # Overcast: a wide, soft brightening rather than a disc.
    towards = max(0.0, sum(direction[i] * sun[i] for i in range(3)))
    return base + (1.0 - base) * (glow * towards**glow_power)


class Sky:
    """A dome that follows the camera and never writes depth."""

    __slots__ = ("path", "horizon", "zenith")

    def __init__(self, parent: NodePath, tun: Tunables, radius: float) -> None:
        self.horizon = np.array(tun["weather.horizon_colour"], dtype=np.float32)
        self.zenith = np.array(tun["weather.zenith_colour"], dtype=np.float32)
        glow = tun.f("weather.sun_glow")
        glow_power = tun.f("weather.sun_glow_power")
        sun = lighting.sun_vector()

        positions: list[list[float]] = []
        colours: list[list[int]] = []
        indices: list[int] = []
        for ring in range(_RINGS + 1):
            elevation = _BOTTOM_DEG + (90.0 - _BOTTOM_DEG) * (ring / _RINGS)
            phi = math.radians(elevation)
            for seg in range(_SEGMENTS + 1):
                theta = math.tau * seg / _SEGMENTS
                direction = (
                    math.cos(phi) * math.sin(theta),
                    math.sin(phi),
                    math.cos(phi) * math.cos(theta),
                )
                positions.append([c * radius for c in direction])
                rgb = _colour(
                    elevation, direction, self.horizon, self.zenith,
                    sun, glow, glow_power,
                )
                colours.append(
                    [int(np.clip(c, 0.0, 1.0) * 255) for c in rgb] + [255]
                )

        stride = _SEGMENTS + 1
        for ring in range(_RINGS):
            for seg in range(_SEGMENTS):
                a = ring * stride + seg
                b = a + 1
                c = a + stride
                d = c + 1
                # Wound to be seen from inside the dome.
                indices.extend([a, c, b, b, c, d])

        node = build_static(
            TRACER_FORMAT,
            {
                "vertex": np.array(positions, dtype=np.float32),
                "color": np.array(colours, dtype=np.uint8),
            },
            np.array(indices, dtype=np.uint32),
            "sky",
        )
        self.path = parent.attach_new_node(node)
        self.path.set_attrib(ColorAttrib.make_vertex())
        self.path.set_light_off(1)
        self.path.set_shader_off(1)
        self.path.set_fog_off(1)
        self.path.set_two_sided(True)
        self.path.set_depth_write(False)
        self.path.set_bin("background", 0)

    def follow(self, x: float, y: float, z: float) -> None:
        """Keep the dome centred on the eye without letting it rotate."""
        self.path.set_pos(x, y, z)

    @property
    def fog_colour(self) -> tuple[float, float, float]:
        """What distance should fade to: the band the horizon actually is."""
        return (float(self.horizon[0]), float(self.horizon[1]), float(self.horizon[2]))


__all__ = ["Sky"]
