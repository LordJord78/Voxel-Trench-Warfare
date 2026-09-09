"""Greedy meshing for voxel chunks.

Fully vectorised: there is no per-voxel Python loop anywhere in here, because
destruction rebuilds chunks mid-frame and a Python loop over 4096 voxels would
blow the frame budget on its own.

The mesher takes a *padded* chunk (chunk plus a one-voxel border of neighbour
data) so faces on chunk seams are culled correctly.

Output is engine-agnostic numpy arrays.  `render/` turns them into geometry;
simulation and tests can use them without an engine present.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import voxel

# (axis, sign, u_axis, v_axis).  The u/v choice is cyclic so that
# cross(u_hat, v_hat) == +axis_hat and winding needs no special-casing.
_FACES: tuple[tuple[int, int, int, int], ...] = (
    (0, +1, 1, 2),
    (0, -1, 1, 2),
    (1, +1, 2, 0),
    (1, -1, 2, 0),
    (2, +1, 0, 1),
    (2, -1, 0, 1),
)

# Baked directional shading.  No dynamic lights: an overcast sky is a dome of
# flat light, and cheap face shading reads better than a lambert term.
_FACE_SHADE: tuple[float, ...] = (0.79, 0.73, 1.00, 0.50, 0.87, 0.65)

_QUAD_INDICES = np.array([0, 1, 2, 0, 2, 3], dtype=np.uint32)


def quad_indices(quads: int) -> np.ndarray:
    """Two triangles per quad, for `quads` consecutive groups of four.

    Kept here rather than in `render/`: the mesher is engine-agnostic and tests
    index its output without an engine present.  `render.buffers` has the same
    helper for geometry it builds itself.
    """
    base = (np.arange(quads, dtype=np.uint32) * 4)[:, None]
    return (_QUAD_INDICES[None, :] + base).reshape(-1)


_EMPTY_F32 = np.zeros((0, 3), dtype=np.float32)
_EMPTY_U8 = np.zeros((0, 4), dtype=np.uint8)
_EMPTY_U32 = np.zeros((0,), dtype=np.uint32)


@dataclass(slots=True)
class ChunkMesh:
    """Interleave-ready geometry for one chunk, in chunk-local metres."""

    positions: np.ndarray  # (N, 3) float32
    normals: np.ndarray  # (N, 3) float32
    colours: np.ndarray  # (N, 4) uint8
    indices: np.ndarray  # (M,) uint32
    quads: int

    @property
    def is_empty(self) -> bool:
        return self.quads == 0

    @staticmethod
    def empty() -> "ChunkMesh":
        return ChunkMesh(_EMPTY_F32, _EMPTY_F32, _EMPTY_U8, _EMPTY_U32, 0)


def _tint(values: np.ndarray, seeds: np.ndarray, shade: float) -> np.ndarray:
    """Per-quad colour with a deterministic dither so faces are not flat."""
    base = voxel.COLOURS[values].astype(np.float32)
    # Cheap integer hash of the quad's origin -> +/- 6% brightness.
    h = (seeds.astype(np.uint32) * np.uint32(2654435761)) >> np.uint32(16)
    jitter = 0.94 + (h & np.uint32(63)).astype(np.float32) * (0.12 / 63.0)
    scale = (shade * jitter)[:, None]
    rgb = np.clip(base * scale, 0.0, 255.0).astype(np.uint8)
    out = np.empty((values.shape[0], 4), dtype=np.uint8)
    out[:, :3] = rgb
    out[:, 3] = 255
    return out


def _face_quads(
    mask: np.ndarray, size: int, axis: int, u_ax: int, v_ax: int
) -> tuple[np.ndarray, ...]:
    """Greedy-merge one direction's face mask into rectangles.

    Returns (slice_index, u0, u1, v0, v1, material), all 1-D.
    """
    # Reorder to [slice, v, u] so each row of constant v is contiguous in u.
    t = np.ascontiguousarray(np.transpose(mask, (axis, v_ax, u_ax)))
    rows = t.reshape(-1, size)

    # Run boundaries along u.
    bounds = np.empty((rows.shape[0], size + 1), dtype=bool)
    bounds[:, 0] = True
    bounds[:, size] = True
    np.not_equal(rows[:, 1:], rows[:, :-1], out=bounds[:, 1:size])

    row_idx, col_idx = np.nonzero(bounds)
    if row_idx.size < 2:
        return tuple(np.zeros(0, dtype=np.int32) for _ in range(6))

    # Consecutive boundaries within the same row bracket one run.
    same_row = row_idx[:-1] == row_idx[1:]
    r = row_idx[:-1][same_row]
    u0 = col_idx[:-1][same_row]
    u1 = col_idx[1:][same_row]
    material = rows[r, u0]

    keep = material != 0
    if not keep.any():
        return tuple(np.zeros(0, dtype=np.int32) for _ in range(6))
    r, u0, u1, material = r[keep], u0[keep], u1[keep], material[keep]

    s = (r // size).astype(np.int32)
    v = (r % size).astype(np.int32)
    u0 = u0.astype(np.int32)
    u1 = u1.astype(np.int32)

    # Merge identical runs across increasing v.
    order = np.lexsort((v, material, u1, u0, s))
    s, v, u0, u1, material = (a[order] for a in (s, v, u0, u1, material))

    if s.size == 1:
        starts = np.zeros(1, dtype=np.int64)
    else:
        breaks = (
            (s[1:] != s[:-1])
            | (u0[1:] != u0[:-1])
            | (u1[1:] != u1[:-1])
            | (material[1:] != material[:-1])
            | (v[1:] != v[:-1] + 1)
        )
        starts = np.concatenate(([0], np.nonzero(breaks)[0] + 1))
    ends = np.concatenate((starts[1:] - 1, [s.size - 1]))

    return (
        s[starts],
        u0[starts],
        u1[starts],
        v[starts],
        v[ends] + 1,
        material[starts],
    )


def downsample(padded: np.ndarray, step: int) -> np.ndarray:
    """Reduce a padded chunk by `step` for a coarser level of detail.

    A cell becomes solid if any of the fine voxels inside it is, and takes the
    material of the first solid one in a fixed order — deterministic, and it
    keeps thin features like revetment and wire pickets from disappearing
    entirely at range, which picking the centre sample would not.

    Erring toward solid is the safe direction: it over-draws a little at
    distance, where over-drawing is invisible, rather than opening holes in the
    terrain, where it very much is not.
    """
    if step <= 1:
        return padded
    size = padded.shape[0] - 2
    if size % step:
        raise ValueError(f"chunk of {size} does not divide by an LOD step of {step}")
    coarse_size = size // step
    out = np.empty((coarse_size + 2,) * 3, dtype=padded.dtype)

    core = padded[1:-1, 1:-1, 1:-1].reshape(
        coarse_size, step, coarse_size, step, coarse_size, step
    )
    cells = core.transpose(0, 2, 4, 1, 3, 5).reshape(
        coarse_size, coarse_size, coarse_size, step**3
    )
    solid = voxel.SOLID[cells]
    first = np.argmax(solid, axis=-1)
    picked = np.take_along_axis(cells, first[..., None], axis=-1)[..., 0]
    out[1:-1, 1:-1, 1:-1] = np.where(solid.any(axis=-1), picked, np.uint8(voxel.AIR))

    # The border only has to answer "is the neighbour solid here", and the
    # padded input carries one fine voxel of it. Treat that voxel as the whole
    # coarse cell: a wrong answer costs one culled or one extra face on a chunk
    # seam that is, by construction, far enough away to be an LOD chunk.
    out[0, 1:-1, 1:-1] = padded[0, 1:-1:step, 1:-1:step]
    out[-1, 1:-1, 1:-1] = padded[-1, 1:-1:step, 1:-1:step]
    out[1:-1, 0, 1:-1] = padded[1:-1:step, 0, 1:-1:step]
    out[1:-1, -1, 1:-1] = padded[1:-1:step, -1, 1:-1:step]
    out[1:-1, 1:-1, 0] = padded[1:-1:step, 1:-1:step, 0]
    out[1:-1, 1:-1, -1] = padded[1:-1:step, 1:-1:step, -1]
    # Corners and edges are never read by the face masks; fill them anyway so
    # the array is never uninitialised.
    out[0, 0, :] = out[0, -1, :] = out[-1, 0, :] = out[-1, -1, :] = voxel.AIR
    out[:, 0, 0] = out[:, 0, -1] = out[:, -1, 0] = out[:, -1, -1] = voxel.AIR
    out[0, :, 0] = out[0, :, -1] = out[-1, :, 0] = out[-1, :, -1] = voxel.AIR
    return out


def mesh_at_lod(
    padded: np.ndarray, step: int, voxel_size: float = voxel.VOXEL_SIZE
) -> ChunkMesh:
    """Mesh a chunk at a level of detail.  `step` 1 is full resolution.

    A crater at 150 m does not need quarter-metre fidelity, and meshing it as
    though it did is what makes a fine grid unaffordable rather than just
    expensive.
    """
    if step <= 1:
        return greedy_mesh(padded, voxel_size)
    return greedy_mesh(downsample(padded, step), voxel_size * step)


def greedy_mesh(padded: np.ndarray, voxel_size: float = voxel.VOXEL_SIZE) -> ChunkMesh:
    """Mesh one chunk.

    `padded` is (size+2)**3 uint8: the chunk's voxels with a one-voxel border
    of neighbouring chunk data.
    """
    size = padded.shape[0] - 2
    core = padded[1:-1, 1:-1, 1:-1]

    renderable = voxel.RENDERABLE[core]
    if not renderable.any():
        return ChunkMesh.empty()

    pos_chunks: list[np.ndarray] = []
    nrm_chunks: list[np.ndarray] = []
    col_chunks: list[np.ndarray] = []
    total_quads = 0

    for face, (axis, sign, u_ax, v_ax) in enumerate(_FACES):
        lo = 1 + sign
        sl = [slice(1, -1)] * 3
        sl[axis] = slice(lo, lo + size) if lo > 0 else slice(0, size)
        neighbour = padded[tuple(sl)]

        visible = renderable & ~voxel.OPAQUE[neighbour] & (neighbour != core)
        if not visible.any():
            continue

        mask = np.where(visible, core, np.uint8(0))
        s, u0, u1, v0, v1, material = _face_quads(mask, size, axis, u_ax, v_ax)
        n = s.shape[0]
        if n == 0:
            continue

        plane = (s + 1 if sign > 0 else s).astype(np.float32)
        p = np.zeros((n, 4, 3), dtype=np.float32)
        p[:, :, axis] = plane[:, None]
        fu0, fu1 = u0.astype(np.float32), u1.astype(np.float32)
        fv0, fv1 = v0.astype(np.float32), v1.astype(np.float32)
        p[:, 0, u_ax], p[:, 0, v_ax] = fu0, fv0
        p[:, 1, u_ax], p[:, 1, v_ax] = fu1, fv0
        p[:, 2, u_ax], p[:, 2, v_ax] = fu1, fv1
        p[:, 3, u_ax], p[:, 3, v_ax] = fu0, fv1
        # Winding: the u/v pair is chosen so cross(u, v) == +axis in a
        # right-handed frame, but the render target is left-handed
        # (Panda's `y-up-left`), so front faces are the reversed order.
        if sign > 0:
            p = p[:, ::-1, :]

        normal = np.zeros(3, dtype=np.float32)
        normal[axis] = float(sign)

        seeds = (s * 8191 + u0 * 131 + v0 * 17 + face).astype(np.uint32)
        quad_colour = _tint(material, seeds, _FACE_SHADE[face])

        pos_chunks.append(p.reshape(-1, 3))
        nrm_chunks.append(np.broadcast_to(normal, (n * 4, 3)))
        col_chunks.append(np.repeat(quad_colour, 4, axis=0))
        total_quads += n

    if total_quads == 0:
        return ChunkMesh.empty()

    positions = np.concatenate(pos_chunks) * np.float32(voxel_size)
    normals = np.ascontiguousarray(np.concatenate(nrm_chunks), dtype=np.float32)
    colours = np.concatenate(col_chunks)
    indices = quad_indices(total_quads)

    return ChunkMesh(positions, normals, colours, indices, total_quads)
