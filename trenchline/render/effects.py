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
from ..data import Tunables
from .buffers import TRACER_FORMAT, DynamicGeometry, GeomLines


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


__all__ = ["TracerRenderer"]
