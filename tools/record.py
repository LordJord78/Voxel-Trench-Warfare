"""Record a scripted gameplay take to an MP4, rendered offscreen.

Not a screen grab. The simulation is stepped at a fixed rate and each rendered
frame is pulled straight out of the framebuffer and piped to ffmpeg, so the
output has perfectly even frame pacing regardless of how fast this machine
actually renders it — stutter is far more visible in a recording than in play,
and this removes the possibility entirely.

It also means the take is deterministic: same seed, same script, same frames.
Re-render an identical take after changing the lighting instead of
re-performing it.

    python -m tools.record --seed 7 --out take.mp4
    python -m tools.record --seed 7 --width 1280 --height 720 --fps 30
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

BUNDLED_FFMPEG = (
    Path(__file__).resolve().parent.parent
    / ".venv/lib/python3.14/site-packages/imageio_ffmpeg/binaries"
    / "ffmpeg-macos-aarch64-v7.1"
)


def find_ffmpeg() -> str:
    """Prefer a system ffmpeg; fall back to the one imageio-ffmpeg bundles."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    if BUNDLED_FFMPEG.exists():
        return str(BUNDLED_FFMPEG)
    raise SystemExit(
        "no ffmpeg: install one, or `pip install imageio-ffmpeg` for a bundled build"
    )


# --- the take ---------------------------------------------------------------
#
# (start_second, label) — what the player is doing, in order. Timings are
# generous: on video a beat needs longer than it does in the hand.
BEATS: tuple[tuple[float, str], ...] = (
    (0.0, "in the fire bay"),
    (6.0, "turn to the parapet"),
    (8.5, "mount the firing step"),
    (11.5, "look over no-man's-land"),
    (16.0, "open fire"),
    (21.0, "artillery walks in"),
    (28.0, "pinned, and off the step"),
    (35.0, "end"),
)
"""The take, as beats.

Deliberately staged inside ONE bay rather than walked down the line. A scripted
walk has to negotiate the traverses, and a traverse is specifically designed to
stop anything moving in a straight line — every take that tried it ended with
the camera shoved into a corner. Panning in place shows the trench just as
well and cannot fail.
"""


def _beat(t: float) -> str:
    label = BEATS[0][1]
    for start, name in BEATS:
        if t >= start:
            label = name
    return label


def drive(session, t: float, dt: float, rng) -> None:
    """Scripted input for one tick at take-time `t`."""
    import math

    from trenchline.physics.character import MoveIntent, Stance

    intent = MoveIntent(stance=Stance.STANDING)
    beat = _beat(t)
    bay = session.network.nearest_bay(
        session.player.position.x, session.player.position.z, "front"
    )
    facing = 0.0 if bay is None or bay.facing > 0 else 180.0

    if beat == "in the fire bay":
        # Pan across the bay: revetment, duckboards, the firing step, the
        # parapet standing over all of it. This is the shot that has to sell
        # the trench having depth.
        session.player.yaw = facing + 118.0 * math.cos(t * 0.42)
        session.player.pitch = -13.0 + 9.0 * math.sin(t * 0.55)
    elif beat == "turn to the parapet":
        blend = min(1.0, (t - 6.0) / 2.3)
        eased = blend * blend * (3.0 - 2.0 * blend)
        start_yaw = facing + 118.0 * math.cos(6.0 * 0.42)
        delta = (facing - start_yaw + 180.0) % 360.0 - 180.0
        session.player.yaw = (start_yaw + delta * eased) % 360.0
        session.player.pitch = -8.0 + 8.0 * eased
    elif beat == "mount the firing step":
        session.player.yaw = facing
        intent.forward = 0.0 if session.player.on_firing_step else 1.0
        session.player.pitch = 0.0
    elif beat == "look over no-man's-land":
        session.player.yaw = facing - 15.0 + 30.0 * ((t - 11.5) / 4.5)
        session.player.pitch = 1.0
    elif beat == "open fire":
        session.player.yaw = facing + 5.0 * math.sin((t - 16.0) * 1.5)
        session.player.pitch = 0.8
        phase = (t - 16.0) % 2.4
        intent.fire = phase < 1.1
    elif beat == "artillery walks in":
        session.player.yaw = facing + 3.0
        session.player.pitch = 0.0
    elif beat == "pinned, and off the step":
        session.player.yaw = facing + 2.0
        session.player.pitch = 0.0

    session.intent = intent


def shell_schedule(session, t: float, fired: set) -> None:
    """Walk a stick of shells across the ground in front of the parapet."""
    from trenchline.physics.vec import Vec3
    from trenchline.world import destruction, voxel
    import numpy as np

    if not (21.0 <= t < 28.0):
        return
    index = int((t - 21.0) / 0.85)
    if index in fired:
        return
    fired.add(index)

    eye = session.eye_position
    rng = session.stream("record.shells")
    x = eye.x + rng.jitter(9.0)
    z = eye.z + 16.0 + index * 2.2 + rng.jitter(3.0)
    column = session.world.v[int(x / voxel.VOXEL_SIZE), :, int(z / voxel.VOXEL_SIZE)]
    solid = np.nonzero(voxel.SOLID[column])[0]
    if not solid.size:
        return
    y = float(solid[-1]) * voxel.VOXEL_SIZE
    destruction.detonate(
        session.world, (x, y, z), rng.uniform(2.2, 3.4), rng, session.tun
    )


def _firing_bay(session):
    """The bay the take ends up shooting from.

    Chosen for the view, not for convenience: generation deliberately puts
    direct hits on the line, so a bay picked by index is quite often a flooded
    hole with its parapet blown off. That is an interesting thing to walk past
    and a poor thing to shoot from — the camera ends up jammed against a crater
    lip with two metres of near-field spoil filling the corners of frame.

    Wants a dry, unshelled bay with a firing step and the longest clear view
    over its own parapet.
    """
    from trenchline.physics.vec import Vec3
    from trenchline.world import voxel
    from trenchline.world.entrenching import fill_in
    from trenchline.world.raycast import raycast

    best, best_view = None, -1.0
    for bay in session.network.lines["front"].bays:
        if not bay.has_firing_step:
            continue
        box = ((bay.x0, bay.floor_y + 1, bay.z0), (bay.x1, bay.floor_y + 5, bay.z1))
        block = session.world.v[
            box[0][0]:box[1][0], box[0][1]:box[1][1], box[0][2]:box[1][2]
        ]
        if (block == voxel.WATER).any() or fill_in(session.world, *box):
            continue
        sx, sy, sz = bay.step_metres
        hit = raycast(
            session.world, Vec3(sx, sy + 1.62, sz), Vec3(0, 0, float(bay.facing)), 120.0
        )
        view = hit.distance if hit else 120.0
        if view > best_view:
            best_view, best = view, bay
    return best or session.network.lines["front"].bays[0], best_view


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", type=Path, default=Path("take.mp4"))
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--seconds", type=float, default=35.0)
    ap.add_argument("--hide-hud", action="store_true",
                    help="no HUD at all")
    ap.add_argument("--hide-debug", action="store_true",
                    help="keep the gameplay HUD, drop the developer readouts")
    ap.add_argument("--crf", type=int, default=18, help="lower is better quality")
    args = ap.parse_args()

    from panda3d.core import (
        FrameBufferProperties,
        GraphicsOutput,
        GraphicsPipe,
        Texture,
        WindowProperties,
        loadPrcFileData,
    )

    loadPrcFileData("", "window-type offscreen")
    loadPrcFileData("", f"win-size {args.width} {args.height}")

    from trenchline.physics.character import MoveIntent
    from trenchline.physics.vec import Vec3
    from trenchline.render.app import Frontend, _configure_panda
    from trenchline.session import Session, SessionConfig

    _configure_panda(vsync=False)
    session = Session(SessionConfig(seed=args.seed))

    # Start in a fire bay a little along the line, so walking forward has
    # somewhere to go and the opening frame is inside the trench.
    target, view = _firing_bay(session)
    cx, cy, cz = target.centre_metres
    session.player.position = Vec3(cx, cy + 0.05, cz)
    session.player.yaw = 0.0 if target.facing > 0 else 180.0
    print(
        f"staged in front bay {target.index} "
        f"({view:.0f} m of view over its parapet)"
    )

    frontend = Frontend(session, size=(args.width, args.height))
    frontend._read_intent = lambda: session.intent
    frontend._apply_mouse = lambda: None
    if args.hide_hud:
        frontend.hud.root.hide()
    if args.hide_debug:
        # Frame times and chunk counts are for me, not for the video.
        frontend.hud.show_perf = False
        frontend.hud.perf.hide()
        frontend.hud.hint.hide()


    # Render into a real offscreen framebuffer rather than the window.
    #
    # Panda clamps a window — even an "offscreen" one — to the display, so on a
    # 1512-wide laptop panel asking for 1920x1080 quietly gives you 1512x840 and
    # a recording that was never HD. An FBO has no such limit, and on macOS it
    # also sidesteps Retina entirely: the buffer is exactly the pixels asked
    # for, not a backing-scale multiple of them that gets downsampled.
    base = frontend.app
    fb_props = FrameBufferProperties()
    fb_props.set_rgb_color(True)
    fb_props.set_rgba_bits(8, 8, 8, 8)
    fb_props.set_depth_bits(24)
    buffer = base.graphicsEngine.make_output(
        base.pipe,
        "record",
        -100,
        fb_props,
        WindowProperties.size(args.width, args.height),
        GraphicsPipe.BFRefuseWindow,
        base.win.get_gsg(),
        base.win,
    )
    if buffer is None:
        raise SystemExit("could not create an offscreen framebuffer")

    grab = Texture()
    buffer.add_render_texture(grab, GraphicsOutput.RTMCopyRam)
    # Shares the lens, so the periscope's narrowing and the firing FOV pulse
    # reach the recording; parented to the main camera, so it inherits every
    # bit of the head bob, recoil and suppression shake.
    base.makeCamera(buffer, lens=base.camLens)
    base.makeCamera2d(buffer)
    base.camLens.set_aspect_ratio(args.width / args.height)

    actual = (buffer.get_x_size(), buffer.get_y_size())
    print(f"backbuffer: {actual[0]}x{actual[1]} (asked for {args.width}x{args.height})")
    if actual != (args.width, args.height):
        print("  WARNING: not the size requested")

    ffmpeg = find_ffmpeg()
    command = [
        ffmpeg, "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-s", f"{actual[0]}x{actual[1]}", "-r", str(args.fps),
        "-i", "-",
        # Panda hands back a bottom-up image.
        "-vf", "vflip",
        "-an", "-c:v", "libx264", "-preset", "medium",
        "-crf", str(args.crf), "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(args.out),
    ]
    encoder = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    assert encoder.stdin is not None

    ticks_per_frame = max(1, round(60 / args.fps))
    total = int(args.seconds * args.fps)
    fired: set[int] = set()
    rng = session.stream("record")
    t0 = time.perf_counter()
    last_beat = ""

    for frame in range(total):
        t = frame / args.fps
        beat = _beat(t)
        if beat != last_beat:
            print(f"  {t:5.1f}s  {beat}")
            last_beat = beat
        if beat == "pinned, and off the step":
            session.config.incoming_rpm = 520.0
            session.config.incoming_range_m = 26.0

        for _ in range(ticks_per_frame):
            drive(session, t, 1.0 / 60.0, rng)
            session.tick()
        shell_schedule(session, t, fired)

        frontend.app.taskMgr.step()
        frontend.app.graphicsEngine.render_frame()
        data = grab.get_ram_image_as("BGR")
        if data:
            encoder.stdin.write(bytes(data))

    encoder.stdin.close()
    encoder.wait()
    elapsed = time.perf_counter() - t0
    size_mb = args.out.stat().st_size / 1e6 if args.out.exists() else 0.0
    print(
        f"\nwrote {args.out} — {total} frames, {args.seconds:.0f}s at {args.fps} fps, "
        f"{size_mb:.1f} MB, rendered in {elapsed:.0f}s"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
