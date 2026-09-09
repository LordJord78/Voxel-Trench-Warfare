"""Greedy meshing correctness and cost."""

from __future__ import annotations

import time

import numpy as np
import pytest

from trenchline.world import voxel
from trenchline.world.chunks import CHUNK_SIZE, VoxelWorld, WorldDims
from trenchline.world.meshing import greedy_mesh

PAD = CHUNK_SIZE + 2


def _padded(fill: int = voxel.AIR) -> np.ndarray:
    return np.full((PAD, PAD, PAD), fill, dtype=np.uint8)


def test_empty_chunk_makes_no_geometry() -> None:
    assert greedy_mesh(_padded()).is_empty


def test_fully_enclosed_chunk_makes_no_geometry() -> None:
    """Every face is hidden by a neighbour, so nothing should be emitted."""
    assert greedy_mesh(_padded(voxel.MUD)).is_empty


def test_flat_surface_merges_to_one_quad() -> None:
    """The whole point of greedy meshing: 256 coplanar faces become one quad."""
    p = _padded()
    p[:, :9, :] = voxel.MUD
    mesh = greedy_mesh(p)
    assert mesh.quads == 1
    assert mesh.positions.shape == (4, 3)
    assert mesh.indices.shape == (6,)


def test_single_voxel_makes_six_quads() -> None:
    p = _padded()
    p[8, 8, 8] = voxel.SANDBAG
    mesh = greedy_mesh(p)
    assert mesh.quads == 6
    assert mesh.positions.shape == (24, 3)


def test_buffers_are_consistent() -> None:
    p = _padded()
    rng = np.random.default_rng(3)
    p[1:-1, 1:-1, 1:-1] = (rng.random((16, 16, 16)) < 0.35) * voxel.CLAY
    mesh = greedy_mesh(p)
    n = mesh.quads
    assert mesh.positions.shape == (n * 4, 3)
    assert mesh.normals.shape == (n * 4, 3)
    assert mesh.colours.shape == (n * 4, 4)
    assert mesh.indices.shape == (n * 6,)
    assert int(mesh.indices.max()) == n * 4 - 1
    assert mesh.positions.dtype == np.float32
    assert mesh.colours.dtype == np.uint8


def test_geometry_stays_inside_the_chunk() -> None:
    p = _padded()
    rng = np.random.default_rng(9)
    p[1:-1, 1:-1, 1:-1] = (rng.random((16, 16, 16)) < 0.5) * voxel.MUD
    mesh = greedy_mesh(p)
    extent = CHUNK_SIZE * voxel.VOXEL_SIZE
    assert mesh.positions.min() >= 0.0
    assert mesh.positions.max() <= extent + 1e-6


def test_water_surface_is_drawn_but_water_to_water_is_not() -> None:
    p = _padded()
    p[:, :6, :] = voxel.WATER
    top_only = greedy_mesh(p)
    assert top_only.quads >= 1, "the water surface must be visible"

    p2 = _padded(voxel.WATER)
    assert greedy_mesh(p2).is_empty, "water buried in water needs no faces"


def test_seams_are_culled_against_neighbours() -> None:
    """A chunk whose neighbour is solid must not draw its shared face.

    Asserted as "no geometry in that plane" rather than "fewer quads": baked
    occlusion splits merges wherever the shading changes, so a solid neighbour
    can cull one big face and still raise the total quad count by breaking up
    the four faces that meet it.
    """
    lone = _padded()
    lone[1:-1, 1:-1, 1:-1] = voxel.MUD
    with_neighbour = lone.copy()
    with_neighbour[0, :, :] = voxel.MUD

    def seam_faces(mesh) -> int:
        """Quads lying IN the shared plane and facing out of it.

        Position alone is not enough: the four side faces legitimately have
        vertices at x = 0 because they span the chunk.
        """
        outward = mesh.normals[:, 0] < -0.5
        in_plane = mesh.positions[:, 0] <= 1e-6
        return int((outward & in_plane).sum())

    assert seam_faces(greedy_mesh(with_neighbour)) == 0, "the shared face was drawn"
    assert seam_faces(greedy_mesh(lone)) > 0, (
        "the lone chunk should draw that face, or this proves nothing"
    )


def test_meshing_a_real_chunk_fits_the_frame_budget() -> None:
    """A destruction rebuild must not blow a 16.7 ms frame on its own."""
    world = VoxelWorld(WorldDims(64, 64, 64))
    ys = np.arange(64)[None, :, None]
    height = 30 + (np.arange(64)[:, None] % 5)
    world.v[:] = np.where(ys < height[:, :, None].transpose(0, 2, 1), voxel.MUD, voxel.AIR)
    world.v[:, 26:32, 20:24] = voxel.AIR

    times = []
    for coord in world.all_chunks():
        padded = world.padded_chunk(coord)
        t0 = time.perf_counter()
        greedy_mesh(padded)
        times.append((time.perf_counter() - t0) * 1000.0)
    assert max(times) < 8.0, f"worst chunk {max(times):.2f} ms"


@pytest.mark.parametrize("material", [voxel.MUD, voxel.SANDBAG, voxel.CONCRETE])
def test_quad_colour_matches_material(material: int) -> None:
    p = _padded()
    p[:, :9, :] = material
    mesh = greedy_mesh(p)
    base = voxel.COLOURS[material].astype(int)
    got = mesh.colours[0, :3].astype(int)
    # Top faces are unshaded apart from a small deterministic dither.
    assert np.all(np.abs(got - base) <= base * 0.12 + 2)
