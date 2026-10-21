"""The numpy -> GeomVertexData path, which everything with geometry uses.

Chunks were the first caller; tracers, dust, debris and the drone overlay are
the next.  These assert the properties that make it reusable rather than
chunk-shaped: that the packing matches the declared format byte for byte, that
a mismatched column is an error rather than garbage geometry, and that the
dynamic buffer rewrites in place instead of reallocating.
"""

from __future__ import annotations

import numpy as np
import pytest

from trenchline.render import buffers as B


def _cols(n: int) -> dict[str, np.ndarray]:
    return {
        "vertex": np.arange(n * 3, dtype=np.float32).reshape(n, 3),
        "normal": np.zeros((n, 3), dtype=np.float32),
        "color": np.arange(n * 4, dtype=np.uint8).reshape(n, 4),
    }


# -- formats -----------------------------------------------------------------


def test_stride_is_the_sum_of_its_columns() -> None:
    assert B.CHUNK_FORMAT.stride == 3 * 4 + 3 * 4 + 4      # pos, normal, rgba
    assert B.TRACER_FORMAT.stride == 3 * 4 + 4
    assert B.OVERLAY_FORMAT.stride == 3 * 4 + 2 * 4 + 4


def test_interleave_lays_columns_out_where_the_format_says() -> None:
    """The GPU reads this by offset; if packing and format disagree, the
    geometry renders as noise rather than raising anything."""
    n = 5
    columns = _cols(n)
    data, count = B.CHUNK_FORMAT.interleave(columns)
    assert count == n
    raw = np.frombuffer(data, dtype=np.uint8).reshape(n, B.CHUNK_FORMAT.stride)

    assert np.array_equal(
        raw[:, 0:12].copy().view(np.float32).reshape(n, 3), columns["vertex"]
    )
    assert np.array_equal(
        raw[:, 12:24].copy().view(np.float32).reshape(n, 3), columns["normal"]
    )
    assert np.array_equal(raw[:, 24:28], columns["color"])


def test_a_missing_column_is_an_error() -> None:
    columns = _cols(4)
    del columns["normal"]
    with pytest.raises(KeyError, match="normal"):
        B.CHUNK_FORMAT.interleave(columns)


def test_columns_disagreeing_on_length_is_an_error() -> None:
    columns = _cols(4)
    columns["color"] = columns["color"][:3]
    with pytest.raises(ValueError, match="vertex count"):
        B.CHUNK_FORMAT.interleave(columns)


def test_interleave_accepts_a_non_contiguous_column() -> None:
    """Meshing hands over slices and broadcasts; copying is the writer's job."""
    n = 6
    columns = _cols(n)
    columns["normal"] = np.broadcast_to(np.float32([0, 1, 0]), (n, 3))
    columns["vertex"] = np.asfortranarray(columns["vertex"])
    data, count = B.CHUNK_FORMAT.interleave(columns)
    assert count == n
    raw = np.frombuffer(data, dtype=np.uint8).reshape(n, B.CHUNK_FORMAT.stride)
    assert np.array_equal(
        raw[:, 12:24].copy().view(np.float32).reshape(n, 3), columns["normal"]
    )


def test_empty_input_makes_no_bytes() -> None:
    data, count = B.CHUNK_FORMAT.interleave(_cols(0))
    assert (data, count) == (b"", 0)


# -- indices -----------------------------------------------------------------


def test_quad_indices_wind_two_triangles_per_quad() -> None:
    assert np.array_equal(B.quad_indices(1), [0, 1, 2, 0, 2, 3])
    assert np.array_equal(B.quad_indices(2)[6:], [4, 5, 6, 4, 6, 7])
    assert B.quad_indices(100).shape == (600,)
    assert B.quad_indices(0).shape == (0,)


def test_quad_indices_match_the_meshers_own() -> None:
    """Two copies exist on purpose — the mesher must not import an engine — so
    they have to agree."""
    from trenchline.world.meshing import quad_indices as mesher_quads

    assert np.array_equal(B.quad_indices(37), mesher_quads(37))


# -- static ------------------------------------------------------------------


def test_static_build_produces_one_geom() -> None:
    node = B.build_static(B.CHUNK_FORMAT, _cols(8), B.quad_indices(2), "chunk")
    assert node is not None
    assert node.get_num_geoms() == 1
    geom = node.get_geom(0)
    assert geom.get_vertex_data().get_num_rows() == 8
    assert geom.get_primitive(0).get_num_vertices() == 12


def test_static_build_of_nothing_is_none() -> None:
    """A chunk of pure air must produce no node at all, not an empty one."""
    assert B.build_static(B.CHUNK_FORMAT, _cols(0), B.quad_indices(0), "empty") is None
    assert B.build_static(B.CHUNK_FORMAT, _cols(4), B.quad_indices(0), "no-idx") is None


# -- dynamic -----------------------------------------------------------------


def _tracer_cols(n: int) -> dict[str, np.ndarray]:
    return {
        "vertex": np.arange(n * 3, dtype=np.float32).reshape(n, 3),
        "color": np.full((n, 4), 255, dtype=np.uint8),
    }


def test_dynamic_allocates_once_and_keeps_its_allocation() -> None:
    """This is the whole reason dynamic is a separate type: a per-frame
    reallocation is what makes a particle system stutter."""
    buf = B.DynamicGeometry(
        B.TRACER_FORMAT, "tracers", capacity=256, index_capacity=256,
        primitive_cls=B.GeomLines,
    )
    vdata = buf.node.get_geom(0).get_vertex_data()
    assert vdata.get_num_rows() == 256

    for live in (2, 40, 6, 0, 128):
        buf.write(_tracer_cols(live), np.arange(live, dtype=np.uint32))
        assert vdata.get_num_rows() == 256, "the vertex buffer was resized"
        assert buf.live_indices == live


@pytest.mark.parametrize("capacity", [1, 2, 17, 256, 4096])
def test_dynamic_never_hands_panda_uninitialised_indices(capacity: int) -> None:
    """Regression: the allocation was made with unclean_set_num_rows and left
    full of whatever was in that memory, so Panda's index validation failed
    only when the garbage happened to be out of range."""
    for primitive, k in ((B.GeomTriangles, 3), (B.GeomLines, 2), (B.GeomPoints, 1)):
        buf = B.DynamicGeometry(
            B.TRACER_FORMAT, f"buf{capacity}", capacity=capacity,
            index_capacity=capacity * k, primitive_cls=primitive,
        )
        geom = buf.node.get_geom(0)
        assert geom.get_primitive(0).get_num_vertices() == 0
        assert geom.get_vertex_data().get_num_rows() == capacity


def test_dynamic_draws_only_what_was_written() -> None:
    buf = B.DynamicGeometry(
        B.TRACER_FORMAT, "tracers", capacity=64, index_capacity=64,
        primitive_cls=B.GeomLines,
    )
    buf.write(_tracer_cols(8), np.arange(8, dtype=np.uint32))
    assert buf.node.get_geom(0).get_primitive(0).get_num_vertices() == 8
    buf.write(_tracer_cols(2), np.arange(2, dtype=np.uint32))
    assert buf.node.get_geom(0).get_primitive(0).get_num_vertices() == 2


def test_dynamic_clear_draws_nothing_without_freeing() -> None:
    buf = B.DynamicGeometry(B.TRACER_FORMAT, "t", capacity=32, index_capacity=32,
                            primitive_cls=B.GeomLines)
    buf.write(_tracer_cols(10), np.arange(10, dtype=np.uint32))
    buf.clear()
    assert buf.live_indices == 0
    assert buf.node.get_geom(0).get_primitive(0).get_num_vertices() == 0
    assert buf.node.get_geom(0).get_vertex_data().get_num_rows() == 32


def test_dynamic_overflow_is_counted_not_silent() -> None:
    """A tracer that quietly vanishes is a worse bug than one that is counted."""
    buf = B.DynamicGeometry(B.TRACER_FORMAT, "t", capacity=16, index_capacity=16,
                            primitive_cls=B.GeomLines)
    written = buf.write(_tracer_cols(40), np.arange(40, dtype=np.uint32))
    assert written == 16
    assert buf.dropped == 24
    assert buf.live_indices <= 16


def test_dynamic_data_actually_reaches_the_buffer() -> None:
    buf = B.DynamicGeometry(B.TRACER_FORMAT, "t", capacity=16, index_capacity=16,
                            primitive_cls=B.GeomLines)
    columns = _tracer_cols(4)
    columns["vertex"][:] = np.float32([[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]])
    buf.write(columns, np.arange(4, dtype=np.uint32))

    vdata = buf.node.get_geom(0).get_vertex_data()
    raw = np.frombuffer(
        bytes(vdata.get_array(0).get_handle().get_data()), dtype=np.uint8
    ).reshape(16, B.TRACER_FORMAT.stride)
    assert np.array_equal(
        raw[:4, 0:12].copy().view(np.float32).reshape(4, 3), columns["vertex"]
    )
