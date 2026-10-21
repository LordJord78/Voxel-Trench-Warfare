"""Print an ASCII cross-section of a generated map.

A window is a slow way to check whether a trench is the right depth.  This is
the fast way, and it works over ssh.

    python -m tools.section --seed 7 --axis z --at 86 --x 60 100
"""

from __future__ import annotations

import argparse

import numpy as np

from trenchline.core.rng import GameRandom
from trenchline.data import load_tunables
from trenchline.world import voxel
from trenchline.world.generation import generate

GLYPH = {
    voxel.AIR: " ", voxel.SOD: "\"", voxel.MUD: "m", voxel.CLAY: "c",
    voxel.SUBSOIL: ".", voxel.SPOIL: "s", voxel.SANDBAG: "B", voxel.DUCKBOARD: "=",
    voxel.TIMBER: "#", voxel.CORRUGATE: "T", voxel.CONCRETE: "C", voxel.BRICK: "H",
    voxel.TRUNK: "|", voxel.BRANCH: ",", voxel.WATER: "~", voxel.RUBBLE: "o",
    voxel.WIRE: "x",
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--axis", choices=("x", "z"), default="x",
                    help="axis held constant; the section runs along the other")
    ap.add_argument("--at", type=int, default=None)
    ap.add_argument("--range", type=int, nargs=2, default=None)
    ap.add_argument("--y", type=int, nargs=2, default=(18, 42))
    args = ap.parse_args()

    tun = load_tunables()
    gen = generate(GameRandom(args.seed), tun)
    v = gen.world.v
    nx, ny, nz = v.shape

    if args.axis == "x":
        at = args.at if args.at is not None else nx // 2
        lo, hi = args.range or (0, nz)
        plane = v[at, :, lo:hi]
        along = "z"
    else:
        at = args.at if args.at is not None else nz // 2
        lo, hi = args.range or (0, nx)
        plane = v[lo:hi, :, at]
        along = "x"
        plane = plane.T[::1]
        plane = v[lo:hi, :, at].T  # (y, along)

    if args.axis == "x":
        plane = plane  # (y, along)

    y0, y1 = args.y
    y1 = min(y1, ny)
    print(f"{gen.name}  seed={args.seed}  section {args.axis}={at}  "
          f"along {along} {lo}..{hi}  water_table={gen.world.water_table}")
    header = "".join(str((lo + i) // 10 % 10) if (lo + i) % 10 == 0 else " "
                     for i in range(hi - lo))
    print("     " + header)
    for y in range(y1 - 1, y0 - 1, -1):
        row = "".join(GLYPH.get(int(m), "?") for m in plane[y])
        print(f"{y:4d} |{row}|")
    print("     " + "-" * (hi - lo))


if __name__ == "__main__":
    main()
