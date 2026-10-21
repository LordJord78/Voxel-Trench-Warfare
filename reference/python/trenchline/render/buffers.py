"""numpy -> Panda3D vertex buffers.

Ursina's `Mesh` builds vertex buffers with per-vertex Python loops.  At the
vertex counts a voxel world produces that is not slow, it is impossible: a
single chunk rebuild would cost more than the whole frame.  Everything here
writes interleaved bytes straight into a `GeomVertexData` instead, which is a
memcpy.  Measured: ~0.14 ms for a 4 000-vertex chunk, against tens of
milliseconds through the engine's own mesh class.

Chunks were the first thing to need this.  Tracers, muzzle dust, impact debris
and the drone overlay all hit the same wall, so the path is here rather than
inside the chunk renderer.

Two lifetimes, because they want opposite things:

`StaticGeometry` is built once and never touched — terrain.  Its buffer is
sized exactly, marked `UH_static`, and thrown away when the chunk is rebuilt.

`DynamicGeometry` is rewritten every frame and mostly empty — tracers, debris.
It allocates its worst case once and then only ever memcpies a prefix and moves
the draw count, so a frame with nine tracers costs nine tracers' worth of copy
and no allocation at all.  Reallocating a vertex buffer per frame is what makes
particle systems stutter, and it is the whole reason these are separate types.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

import numpy as np
from panda3d.core import (
    Geom,
    GeomEnums,
    GeomLines,
    GeomNode,
    GeomPoints,
    GeomPrimitive,
    GeomTriangles,
    GeomVertexArrayFormat,
    GeomVertexData,
    GeomVertexFormat,
    InternalName,
)

_INTERNAL_NAMES = {
    "vertex": InternalName.get_vertex,
    "normal": InternalName.get_normal,
    "color": InternalName.get_color,
    "texcoord": InternalName.get_texcoord,
}


@dataclass(frozen=True, slots=True)
class Attribute:
    """One interleaved column: what it is called, how wide, and in what type."""

    name: str
    count: int
    numeric_type: int
    contents: int
    dtype: np.dtype

    @property
    def nbytes(self) -> int:
        return self.count * self.dtype.itemsize

    def internal_name(self) -> InternalName:
        factory = _INTERNAL_NAMES.get(self.name)
        if factory is None:
            return InternalName.make(self.name)
        return factory()


POSITION = Attribute("vertex", 3, GeomEnums.NT_float32, GeomEnums.C_point,
                     np.dtype(np.float32))
NORMAL = Attribute("normal", 3, GeomEnums.NT_float32, GeomEnums.C_normal,
                   np.dtype(np.float32))
COLOUR = Attribute("color", 4, GeomEnums.NT_uint8, GeomEnums.C_color,
                   np.dtype(np.uint8))
TEXCOORD = Attribute("texcoord", 2, GeomEnums.NT_float32, GeomEnums.C_texcoord,
                     np.dtype(np.float32))


class BufferFormat:
    """An interleaved vertex layout, and the numpy packing that matches it."""

    __slots__ = ("attributes", "stride", "_offsets", "_vertex_format")

    def __init__(self, attributes: tuple[Attribute, ...]) -> None:
        self.attributes = attributes
        offsets: dict[str, tuple[int, int]] = {}
        cursor = 0
        for attribute in attributes:
            offsets[attribute.name] = (cursor, cursor + attribute.nbytes)
            cursor += attribute.nbytes
        self.stride = cursor
        self._offsets = offsets

        array = GeomVertexArrayFormat()
        for attribute in attributes:
            array.add_column(
                attribute.internal_name(),
                attribute.count,
                attribute.numeric_type,
                attribute.contents,
            )
        self._vertex_format = GeomVertexFormat.register_format(
            GeomVertexFormat(array)
        )

    @property
    def vertex_format(self) -> GeomVertexFormat:
        return self._vertex_format

    def interleave(self, columns: Mapping[str, np.ndarray]) -> tuple[bytes, int]:
        """Pack per-attribute arrays into one interleaved block.

        Every attribute in the format must be supplied and every column must
        agree on its vertex count; a format silently short of one column
        produces geometry that renders as garbage rather than as an error.
        """
        counts = set()
        for attribute in self.attributes:
            column = columns.get(attribute.name)
            if column is None:
                raise KeyError(
                    f"format wants a {attribute.name!r} column and was not given one"
                )
            counts.add(column.shape[0])
        if len(counts) > 1:
            raise ValueError(f"columns disagree on vertex count: {sorted(counts)}")
        n = counts.pop() if counts else 0
        if n == 0:
            return b"", 0

        buffer = np.empty((n, self.stride), dtype=np.uint8)
        for attribute in self.attributes:
            column = np.ascontiguousarray(columns[attribute.name], dtype=attribute.dtype)
            lo, hi = self._offsets[attribute.name]
            buffer[:, lo:hi] = column.view(np.uint8).reshape(n, attribute.nbytes)
        return buffer.tobytes(), n


CHUNK_FORMAT = BufferFormat((POSITION, NORMAL, COLOUR))
"""Terrain, debris, dust: shaded solids with baked vertex colour."""

TRACER_FORMAT = BufferFormat((POSITION, COLOUR))
"""Line geometry, which has no normal worth carrying."""

OVERLAY_FORMAT = BufferFormat((POSITION, TEXCOORD, COLOUR))
"""Textured screen-space quads, for the drone feed."""

_INDEX_DTYPE = np.uint32


def quad_indices(quads: int) -> np.ndarray:
    """Two triangles per quad, for `quads` consecutive groups of four."""
    pattern = np.array([0, 1, 2, 0, 2, 3], dtype=_INDEX_DTYPE)
    base = (np.arange(quads, dtype=_INDEX_DTYPE) * 4)[:, None]
    return (pattern[None, :] + base).reshape(-1)


def _make_primitive(primitive_cls: type[GeomPrimitive], usage: int) -> GeomPrimitive:
    prim = primitive_cls(usage)
    prim.set_index_type(GeomEnums.NT_uint32)
    return prim


def build_static(
    fmt: BufferFormat,
    columns: Mapping[str, np.ndarray],
    indices: np.ndarray,
    name: str,
    primitive_cls: type[GeomPrimitive] = GeomTriangles,
) -> GeomNode | None:
    """One GeomNode, sized exactly, uploaded once.  None if there is nothing."""
    data, n = fmt.interleave(columns)
    if n == 0 or indices.size == 0:
        return None

    vdata = GeomVertexData(name, fmt.vertex_format, GeomEnums.UH_static)
    vdata.unclean_set_num_rows(n)
    vdata.modify_array(0).modify_handle().set_data(data)

    prim = _make_primitive(primitive_cls, GeomEnums.UH_static)
    handle = prim.modify_vertices()
    handle.unclean_set_num_rows(indices.shape[0])
    handle.modify_handle().set_data(
        np.ascontiguousarray(indices, dtype=_INDEX_DTYPE).tobytes()
    )

    geom = Geom(vdata)
    geom.add_primitive(prim)
    node = GeomNode(name)
    node.add_geom(geom)
    return node


class DynamicGeometry:
    """A buffer sized for its worst case once and rewritten in place.

    `capacity` is a hard ceiling, not a hint: `write` takes the first
    `capacity` vertices and reports what it dropped, because a tracer that
    silently vanishes is a worse bug than one that is counted.
    """

    __slots__ = (
        "fmt", "name", "capacity", "index_capacity", "node", "dropped",
        "vertices_per_primitive", "_vdata", "_prim", "_geom", "_live",
    )

    def __init__(
        self,
        fmt: BufferFormat,
        name: str,
        capacity: int,
        index_capacity: int | None = None,
        primitive_cls: type[GeomPrimitive] = GeomTriangles,
        usage: int = GeomEnums.UH_dynamic,
    ) -> None:
        if capacity <= 0:
            raise ValueError("a dynamic buffer needs a positive capacity")
        self.fmt = fmt
        self.name = name
        self.capacity = capacity
        self.index_capacity = index_capacity if index_capacity is not None else capacity * 3
        self.dropped = 0
        self._live = 0
        # Overflow has to drop whole triangles or whole line segments; half a
        # triangle indexes a vertex that is no longer there.
        self.vertices_per_primitive = {
            GeomTriangles: 3, GeomLines: 2, GeomPoints: 1,
        }.get(primitive_cls, 3)

        # `unclean_set_num_rows` is the fast path precisely because it does not
        # initialise, which for an index buffer means it comes back full of
        # whatever was in that memory. Panda validates indices against the row
        # count when the primitive is added, so the allocation is zeroed once
        # here. Doing it lazily is not an option: it fails only when the garbage
        # happens to be out of range, which is the worst kind of intermittent.
        self._vdata = GeomVertexData(name, fmt.vertex_format, usage)
        self._vdata.unclean_set_num_rows(capacity)
        self._vdata.modify_array(0).modify_handle().set_data(
            bytes(capacity * fmt.stride)
        )
        self._prim = _make_primitive(primitive_cls, usage)
        handle = self._prim.modify_vertices()
        handle.unclean_set_num_rows(self.index_capacity)
        handle.modify_handle().set_data(
            bytes(self.index_capacity * _INDEX_DTYPE().itemsize)
        )
        self._geom = Geom(self._vdata)
        self._geom.add_primitive(self._prim)
        self.node = GeomNode(name)
        self.node.add_geom(self._geom)
        self.clear()

    @property
    def live_indices(self) -> int:
        return self._live

    def clear(self) -> None:
        """Draw nothing, without touching the allocation."""
        self._live = 0
        self._prim.modify_vertices().unclean_set_num_rows(0)

    def _surviving_primitives(self, indices: np.ndarray, limit: int) -> np.ndarray:
        """Keep only primitives whose every vertex survived the truncation."""
        k = self.vertices_per_primitive
        if indices.size == 0:
            return indices
        usable = (indices.shape[0] // k) * k
        grouped = np.asarray(indices[:usable]).reshape(-1, k)
        return grouped[(grouped < limit).all(axis=1)].reshape(-1)

    def write(
        self, columns: Mapping[str, np.ndarray], indices: np.ndarray
    ) -> int:
        """Replace this frame's contents.  Returns vertices actually written."""
        counts = {c.shape[0] for c in columns.values()}
        n = min(counts) if counts else 0
        if n > self.capacity:
            self.dropped += n - self.capacity
            n = self.capacity
            columns = {key: value[:n] for key, value in columns.items()}
            indices = self._surviving_primitives(indices, n)

        data, written = self.fmt.interleave(columns)
        if written == 0 or indices.size == 0:
            self.clear()
            return 0

        k = self.vertices_per_primitive
        count = (min(int(indices.shape[0]), self.index_capacity) // k) * k
        # Only the prefix is copied; the tail of the allocation keeps whatever
        # was there last frame and is simply never indexed.
        self._vdata.modify_array(0).modify_handle().set_subdata(0, len(data), data)
        handle = self._prim.modify_vertices()
        handle.unclean_set_num_rows(count)
        handle.modify_handle().set_subdata(
            0,
            count * _INDEX_DTYPE().itemsize,
            np.ascontiguousarray(indices[:count], dtype=_INDEX_DTYPE).tobytes(),
        )
        self._live = count
        return written


__all__ = [
    "Attribute", "BufferFormat", "DynamicGeometry",
    "POSITION", "NORMAL", "COLOUR", "TEXCOORD",
    "CHUNK_FORMAT", "TRACER_FORMAT", "OVERLAY_FORMAT",
    "build_static", "quad_indices",
    "GeomLines", "GeomPoints", "GeomTriangles",
]
