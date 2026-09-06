"""The rifle in your hands.

Blocky, like everything else, and built out of axis-aligned boxes through the
same static buffer writer the terrain uses — there is no model format in this
project and adding one to hold six boxes would be silly.

It exists so the cosmetic recoil layer has something to move. A viewmodel is
the only place a heavy weapon can *look* heavy without the sight picture
lurching, which is the whole reason the recoil system is split in two.
"""

from __future__ import annotations

import numpy as np
from panda3d.core import ColorAttrib, NodePath

from ..combat.viewkick import ViewKick
from ..data import Tunables
from .buffers import CHUNK_FORMAT, build_static, quad_indices

# (lo, hi, colour) in view space: x right, y up, z forward, metres from the eye.
_PARTS: tuple[tuple[tuple[float, float, float], tuple[float, float, float], tuple[int, int, int]], ...] = (
    ((-0.030, -0.030, 0.00), (0.030, 0.030, 0.34), (58, 58, 62)),    # receiver
    ((-0.012, -0.005, 0.34), (0.012, 0.020, 0.72), (46, 46, 50)),    # barrel
    ((-0.022, -0.155, 0.10), (0.022, -0.030, 0.19), (52, 52, 56)),   # magazine
    ((-0.025, -0.045, -0.26), (0.025, 0.020, 0.00), (86, 62, 40)),   # stock
    ((-0.030, -0.070, 0.30), (0.030, -0.020, 0.42), (86, 62, 40)),   # foregrip
    ((-0.008, 0.020, 0.655), (0.008, 0.060, 0.685), (40, 40, 44)),   # front sight
    ((-0.011, 0.030, 0.300), (0.011, 0.052, 0.330), (40, 40, 44)),   # rear sight
)

_FACES: tuple[tuple[int, int, int, int], ...] = (
    (0, +1, 1, 2), (0, -1, 1, 2),
    (1, +1, 2, 0), (1, -1, 2, 0),
    (2, +1, 0, 1), (2, -1, 0, 1),
)
_SHADE: tuple[float, ...] = (0.82, 0.74, 1.00, 0.55, 0.90, 0.68)
"""Same baked face shading the terrain uses, so the rifle sits in the same
light as the world instead of looking like a sticker."""


def _box(lo, hi, colour) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    positions, normals, colours = [], [], []
    for face, (axis, sign, u_ax, v_ax) in enumerate(_FACES):
        plane = hi[axis] if sign > 0 else lo[axis]
        quad = np.zeros((4, 3), dtype=np.float32)
        quad[:, axis] = plane
        u0, u1 = lo[u_ax], hi[u_ax]
        v0, v1 = lo[v_ax], hi[v_ax]
        quad[0, u_ax], quad[0, v_ax] = u0, v0
        quad[1, u_ax], quad[1, v_ax] = u1, v0
        quad[2, u_ax], quad[2, v_ax] = u1, v1
        quad[3, u_ax], quad[3, v_ax] = u0, v1
        if sign > 0:
            quad = quad[::-1]
        normal = np.zeros(3, dtype=np.float32)
        normal[axis] = float(sign)
        shade = _SHADE[face]
        rgba = np.array(
            [*(min(255, int(c * shade)) for c in colour), 255], dtype=np.uint8
        )
        positions.append(quad)
        normals.append(np.broadcast_to(normal, (4, 3)))
        colours.append(np.broadcast_to(rgba, (4, 4)))
    return (
        np.concatenate(positions),
        np.ascontiguousarray(np.concatenate(normals), dtype=np.float32),
        np.ascontiguousarray(np.concatenate(colours), dtype=np.uint8),
    )


class ViewModel:
    """A rifle hung off the camera, shoved about by the cosmetic recoil layer."""

    __slots__ = ("path", "rest", "hidden")

    def __init__(self, camera: NodePath, tun: Tunables) -> None:
        parts = [_box(lo, hi, colour) for lo, hi, colour in _PARTS]
        positions = np.concatenate([p for p, _, _ in parts])
        normals = np.concatenate([n for _, n, _ in parts])
        colours = np.concatenate([c for _, _, c in parts])
        node = build_static(
            CHUNK_FORMAT,
            {"vertex": positions, "normal": normals, "color": colours},
            quad_indices(positions.shape[0] // 4),
            "viewmodel",
        )
        self.path = camera.attach_new_node(node)
        self.path.set_attrib(ColorAttrib.make_vertex())
        self.path.set_light_off(1)
        self.path.set_shader_off(1)
        # In front of everything, and not fogged: the rifle is 60 cm away and
        # the fog starts at 14 m, so without this it is tinted by weather.
        self.path.set_bin("fixed", 30)
        self.path.set_depth_test(False)
        self.path.set_fog_off(1)
        self.rest = (
            tun.f("viewmodel.rest_right_m"),
            tun.f("viewmodel.rest_up_m"),
            tun.f("viewmodel.rest_forward_m"),
        )
        self.hidden = False

    def update(self, kick: ViewKick, sway: float = 0.0, speed_ratio: float = 0.0) -> None:
        side, up, back = kick.offset
        pitch, yaw, roll = kick.rotation
        rx, ry, rz = self.rest
        # `back` is toward the eye, so it subtracts from forward.
        self.path.set_pos(
            rx + side + sway * 0.5,
            ry + up - speed_ratio * 0.012,
            rz - back,
        )
        self.path.set_hpr(yaw, pitch, roll)

    def set_visible(self, visible: bool) -> None:
        if visible == (not self.hidden):
            return
        self.hidden = not visible
        (self.path.show if visible else self.path.hide)()


__all__ = ["ViewModel"]
