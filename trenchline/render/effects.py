"""Per-frame geometry: tracers now, dust and debris next.

The first real customer for `buffers.DynamicGeometry`. A tracer lives for a
fraction of a second and there are rarely more than a dozen in the air, so the
buffer is allocated once for the worst case and only ever has a prefix
rewritten — no allocation in the frame that can least afford one.
"""

from __future__ import annotations

import numpy as np
from panda3d.core import ColorAttrib, NodePath

from ..combat.ballistics import ProjectilePool
from ..combat.particles import ParticlePool
from ..data import Tunables
from .buffers import TRACER_FORMAT, DynamicGeometry, GeomLines, quad_indices


class TracerRenderer:
    """One line segment per round in the air, rewritten every frame."""

    __slots__ = ("pool", "length", "colour", "buffer", "path")

    def __init__(
        self, pool: ProjectilePool, parent: NodePath, tun: Tunables
    ) -> None:
        self.pool = pool
        self.length = tun.f("render.tracer_length_m")
        self.colour = np.array(
            [int(c * 255) for c in tun["render.tracer_colour"]] + [255],
            dtype=np.uint8,
        )
        self.buffer = DynamicGeometry(
            TRACER_FORMAT,
            "tracers",
            capacity=pool.capacity * 2,
            index_capacity=pool.capacity * 2,
            primitive_cls=GeomLines,
        )
        self.path = parent.attach_new_node(self.buffer.node)
        self.path.set_attrib(ColorAttrib.make_vertex())
        self.path.set_light_off(1)
        self.path.set_shader_off(1)
        self.path.set_depth_write(False)
        self.path.set_bin("fixed", 40)

    def update(self) -> None:
        head, tail = self.pool.tracer_segments(self.length)
        n = head.shape[0]
        if n == 0:
            self.buffer.clear()
            return
        # Interleaved head/tail pairs: GeomLines takes two vertices per segment.
        vertices = np.empty((n * 2, 3), dtype=np.float32)
        vertices[0::2] = tail
        vertices[1::2] = head
        colours = np.repeat(self.colour[None, :], n * 2, axis=0)
        # The head is bright and the tail fades, so a tracer reads as a streak
        # with a direction rather than a stick.
        colours[0::2, 3] = 40
        self.buffer.write(
            {"vertex": vertices, "color": colours},
            np.arange(n * 2, dtype=np.uint32),
        )


class ParticleRenderer:
    """Camera-facing quads for muzzle flash, brass and debris.

    Four vertices per particle, rewritten every frame into a buffer allocated
    once for the pool's worst case. The quads are built against the camera's
    own right and up vectors rather than with a billboard effect, because the
    whole point of `DynamicGeometry` is that this costs one memcpy — pushing
    the same work into per-particle scene-graph nodes is what the mesh class
    would have done.
    """

    __slots__ = ("pool", "buffer", "path", "_colours")

    def __init__(self, pool: ParticlePool, parent: NodePath) -> None:
        self.pool = pool
        self.buffer = DynamicGeometry(
            TRACER_FORMAT,
            "particles",
            capacity=pool.capacity * 4,
            index_capacity=pool.capacity * 6,
        )
        self.path = parent.attach_new_node(self.buffer.node)
        self.path.set_attrib(ColorAttrib.make_vertex())
        self.path.set_light_off(1)
        self.path.set_shader_off(1)
        self.path.set_depth_write(False)
        self.path.set_bin("fixed", 35)
        self._colours = np.zeros((0, 4), dtype=np.uint8)

    def update(self, right: np.ndarray, up: np.ndarray) -> None:
        centres, half, rgba = self.pool.billboards()
        n = centres.shape[0]
        if n == 0:
            self.buffer.clear()
            return
        r = right[None, :] * half[:, None]
        u = up[None, :] * half[:, None]
        corners = np.empty((n, 4, 3), dtype=np.float32)
        corners[:, 0] = centres - r - u
        corners[:, 1] = centres + r - u
        corners[:, 2] = centres + r + u
        corners[:, 3] = centres - r + u
        self.buffer.write(
            {
                "vertex": corners.reshape(-1, 3),
                "color": np.repeat(rgba, 4, axis=0),
            },
            quad_indices(n),
        )


__all__ = ["TracerRenderer", "ParticleRenderer"]
