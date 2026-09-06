"""Minimal 3-vector.

Deliberately not numpy: these are used a few thousand times a tick on scalar
data, where numpy's per-call overhead costs more than it saves.  Y is up, to
match the render layer's coordinate system, so nothing has to swizzle.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Vec3:
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0

    def __add__(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x + other.x, self.y + other.y, self.z + other.z)

    def __sub__(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x - other.x, self.y - other.y, self.z - other.z)

    def __mul__(self, k: float) -> "Vec3":
        return Vec3(self.x * k, self.y * k, self.z * k)

    __rmul__ = __mul__

    def __truediv__(self, k: float) -> "Vec3":
        return Vec3(self.x / k, self.y / k, self.z / k)

    def __neg__(self) -> "Vec3":
        return Vec3(-self.x, -self.y, -self.z)

    def dot(self, other: "Vec3") -> float:
        return self.x * other.x + self.y * other.y + self.z * other.z

    def cross(self, other: "Vec3") -> "Vec3":
        return Vec3(
            self.y * other.z - self.z * other.y,
            self.z * other.x - self.x * other.z,
            self.x * other.y - self.y * other.x,
        )

    @property
    def length(self) -> float:
        return math.sqrt(self.x * self.x + self.y * self.y + self.z * self.z)

    @property
    def length_sq(self) -> float:
        return self.x * self.x + self.y * self.y + self.z * self.z

    @property
    def horizontal_length(self) -> float:
        return math.hypot(self.x, self.z)

    def normalised(self) -> "Vec3":
        n = self.length
        return Vec3(self.x / n, self.y / n, self.z / n) if n > 1e-9 else ZERO

    def with_y(self, y: float) -> "Vec3":
        return Vec3(self.x, y, self.z)

    def lerp(self, other: "Vec3", t: float) -> "Vec3":
        return Vec3(
            self.x + (other.x - self.x) * t,
            self.y + (other.y - self.y) * t,
            self.z + (other.z - self.z) * t,
        )

    def as_tuple(self) -> tuple[float, float, float]:
        return (self.x, self.y, self.z)


ZERO = Vec3(0.0, 0.0, 0.0)
UP = Vec3(0.0, 1.0, 0.0)


def from_yaw_pitch(yaw_deg: float, pitch_deg: float) -> Vec3:
    """Unit forward vector.  Yaw 0 looks down +z; positive pitch looks up."""
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)
    cp = math.cos(pitch)
    return Vec3(math.sin(yaw) * cp, math.sin(pitch), math.cos(yaw) * cp)


def yaw_basis(yaw_deg: float) -> tuple[Vec3, Vec3]:
    """(forward, right) on the horizontal plane."""
    yaw = math.radians(yaw_deg)
    s, c = math.sin(yaw), math.cos(yaw)
    return Vec3(s, 0.0, c), Vec3(c, 0.0, -s)
