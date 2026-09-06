"""Ursina/Panda3D front end.

This module, `render.geometry`, `render.chunks` and `ui/` are the only places an
engine is imported.  Everything they touch on the simulation side is read-only:
the renderer looks at a `Session`, it never reaches into one to change it,
except to hand it player input.
"""

from __future__ import annotations

import time
from typing import Any

from ..core.loop import FrameStats
from ..physics.character import MoveIntent, Stance
from ..session import Session, SessionConfig


def _configure_panda(vsync: bool) -> None:
    """Must run before ursina is imported: these are read at import time."""
    from panda3d.core import loadPrcFileData

    loadPrcFileData("", f"sync-video {'#t' if vsync else '#f'}")
    loadPrcFileData("", "audio-library-name null")
    loadPrcFileData("", "gl-check-errors #f")
    loadPrcFileData("", "textures-auto-power-2 #t")
    loadPrcFileData("", "notify-level-display error")


class Frontend:
    def __init__(self, session: Session, *, fullscreen: bool = False) -> None:
        from ursina import Ursina, camera, color, mouse, scene, window
        from panda3d.core import Fog

        self.session = session
        tun = session.tun

        self.app = Ursina(
            title="TRENCHLINE",
            borderless=False,
            fullscreen=fullscreen,
            development_mode=False,
            size=(1440, 810),
        )
        window.color = color.rgb32(*[int(c * 255) for c in tun["weather.sky_colour"]])
        window.exit_button.visible = False
        window.fps_counter.enabled = False
        mouse.locked = True

        from .chunks import ChunkRenderer

        print(f"meshing {session.world.dirty_count} chunks ...")
        t0 = time.perf_counter()
        self.chunks = ChunkRenderer(
            session.world, scene, budget=tun.i("world.chunk_rebuilds_per_frame")
        )
        self.chunks.build_all(progress=True)
        build_ms = (time.perf_counter() - t0) * 1000.0
        print(
            f"  {self.chunks.stats.nodes} chunk nodes, "
            f"{self.chunks.stats.triangles} triangles, {build_ms:.0f} ms "
            f"(mesh {self.chunks.stats.mesh_ms:.0f} / upload {self.chunks.stats.upload_ms:.0f})"
        )

        fog = Fog("overcast")
        fog.set_color(*tun["weather.sky_colour"])
        fog.set_linear_range(tun.f("weather.fog_near"), tun.f("weather.fog_far"))
        scene.set_fog(fog)

        camera.fov = tun.f("camera.fov")
        camera.clip_plane_near = tun.f("camera.near_plane")
        camera.clip_plane_far = tun.f("camera.far_plane")

        from ..ui.hud import Hud

        self.hud = Hud(session, self.app)
        self.frame_stats = FrameStats()
        self.sensitivity = tun.f("player.mouse_sensitivity")
        self.pitch_limit = tun.f("player.pitch_limit")
        self.bob_amp = tun.f("camera.head_bob_amplitude")
        self.landing_dip = tun.f("camera.landing_dip")
        self._prev_keys: dict[str, bool] = {}
        self._prone_latched = False
        self._last_time = time.perf_counter()
        self._mouse_free = False
        self.frames = 0

        self.app.taskMgr.add(self._frame, "trenchline-frame", sort=45)

    # -- input -----------------------------------------------------------

    def _edge(self, key: str, down: bool) -> bool:
        was = self._prev_keys.get(key, False)
        self._prev_keys[key] = down
        return down and not was

    def _read_intent(self) -> MoveIntent:
        from ursina import held_keys

        intent = MoveIntent()
        intent.forward = float(held_keys["w"]) - float(held_keys["s"])
        intent.strafe = float(held_keys["d"]) - float(held_keys["a"])
        intent.sprint = bool(held_keys["shift"])
        intent.jump = bool(held_keys["space"])

        if self._edge("c", bool(held_keys["c"])):
            self._prone_latched = not self._prone_latched
        if held_keys["control"]:
            self._prone_latched = False
            intent.stance = Stance.CROUCHED
        elif self._prone_latched:
            intent.stance = Stance.PRONE
        else:
            intent.stance = Stance.STANDING
        return intent

    def _apply_mouse(self) -> None:
        from ursina import mouse

        if self._mouse_free:
            return
        player = self.session.player
        player.yaw = (player.yaw + mouse.velocity[0] * self.sensitivity * 100.0) % 360.0
        player.pitch = max(
            -self.pitch_limit,
            min(self.pitch_limit, player.pitch + mouse.velocity[1] * self.sensitivity * 100.0),
        )

    # -- frame -----------------------------------------------------------

    def _frame(self, task: Any) -> Any:
        from ursina import camera, held_keys, mouse, Vec3 as UVec3

        now = time.perf_counter()
        real_dt = now - self._last_time
        self._last_time = now
        self.frame_stats.record(real_dt)
        self.frames += 1

        if self._edge("escape", bool(held_keys["escape"])):
            self._mouse_free = not self._mouse_free
            mouse.locked = not self._mouse_free
        if self._edge("f1", bool(held_keys["f1"])):
            self.hud.toggle_perf()

        self._apply_mouse()
        intent = self._read_intent()
        session = self.session
        for _ in range(session.clock.advance(real_dt)):
            session.intent = intent
            session.tick()

        self.chunks.build_pending()
        self._place_camera(camera, UVec3)

        stats = self.chunks.stats
        self.hud.update(
            real_dt,
            self.frame_stats.summary(),
            f"chunks {stats.nodes}  tris {stats.triangles // 1000}k  "
            f"queue {session.world.dirty_count}  rebuild {stats.last_frame_ms:.2f} ms",
        )
        return task.cont

    def _place_camera(self, camera: Any, UVec3: Any) -> None:
        import math

        session = self.session
        player = session.player
        eye = session.controller.eye_height(player)

        speed_ratio = min(1.0, player.horizontal_speed() / 5.0)
        bob = math.sin(player.bob_phase) * self.bob_amp * speed_ratio
        sway = math.sin(player.bob_phase * 0.5) * self.bob_amp * 0.6 * speed_ratio
        dip = -min(player.landing_impact, 8.0) / 8.0 * self.landing_dip

        p = player.position
        camera.position = UVec3(p.x + sway * 0.4, p.y + eye + bob + dip, p.z)
        camera.rotation = UVec3(-player.pitch, player.yaw, sway * 12.0)

    def run(self, frames: int = 0) -> int:
        if frames > 0:
            for _ in range(frames):
                self.app.taskMgr.step()
            summary = self.frame_stats.summary()
            print(
                f"ran {frames} frames: mean {summary['mean']:.2f} ms, "
                f"p95 {summary['p95']:.2f} ms, {summary['fps']:.0f} fps"
            )
            return 0
        self.app.run()
        return 0


def run(
    config: SessionConfig,
    *,
    fullscreen: bool = False,
    vsync: bool = True,
    frames: int = 0,
) -> int:
    _configure_panda(vsync)
    session = Session(config)
    print(session.describe())
    frontend = Frontend(session, fullscreen=fullscreen)
    return frontend.run(frames=frames)
