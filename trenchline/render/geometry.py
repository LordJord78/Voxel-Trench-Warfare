"""Chunk meshes -> Panda3D geometry.

A thin adapter over `render.buffers`, which is where the numpy -> vertex buffer
memcpy actually lives.  Terrain is the static case: built once per rebuild,
sized exactly, thrown away when the chunk changes.
"""

from __future__ import annotations

from panda3d.core import GeomNode

from ..world.meshing import ChunkMesh
from .buffers import CHUNK_FORMAT, build_static

VERTEX_FORMAT = CHUNK_FORMAT.vertex_format


def mesh_columns(mesh: ChunkMesh) -> dict[str, "object"]:
    return {
        "vertex": mesh.positions,
        "normal": mesh.normals,
        "color": mesh.colours,
    }


def build_geom_node(mesh: ChunkMesh, name: str) -> GeomNode | None:
    """One GeomNode for one chunk, or None if the chunk has no faces."""
    if mesh.is_empty:
        return None
    return build_static(CHUNK_FORMAT, mesh_columns(mesh), mesh.indices, name)


__all__ = ["VERTEX_FORMAT", "build_geom_node", "mesh_columns"]
