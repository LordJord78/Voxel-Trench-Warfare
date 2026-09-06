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
        from .schedule import SchedulePolicy

        self.chunks = ChunkRenderer(
            session.world, scene, SchedulePolicy.from_tunables(tun, 1440.0 / 810.0)
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

        from .effects import ParticleRenderer, TracerRenderer
        from .viewmodel import ViewModel

        self.tracers = TracerRenderer(session.projectiles, scene, tun)
        self.particles = ParticleRenderer(session.particles, scene)
        self.viewmodel = ViewModel(camera, tun)
        self.base_fov = tun.f("camera.fov")
        self.fov_scale = 1.0
        self.fov_lerp = tun.f("camera.fov_lerp_per_s")

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
        self.frame_dt = 1.0 / 60.0

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
        intent.fire = bool(held_keys["left mouse"])
        intent.reload = bool(held_keys["r"])
        intent.periscope = bool(held_keys["v"])

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
        import math

        from ursina import camera, held_keys, mouse, Vec3 as UVec3

        now = time.perf_counter()
        real_dt = now - self._last_time
        self._last_time = now
        self.frame_stats.record(real_dt)
        self.frame_dt = real_dt
        self.frames += 1

        if self._edge("escape", bool(held_keys["escape"])):
            self._mouse_free = not self._mouse_free
            mouse.locked = not self._mouse_free
        if self._edge("f1", bool(held_keys["f1"])):
            self.hud.toggle_perf()

        self._apply_mouse()
        intent = self._read_intent()
        session = self.session
        player = session.player
        for _ in range(session.clock.advance(real_dt)):
            session.intent = intent
            session.tick()

        # The scheduler needs to know where the player is and what they are
        # looking at BEFORE it picks, or it is back to guessing.
        session.world.frame = self.frames
        eye = session.eye_position
        aim = math.radians(player_yaw := player.yaw + session.recoil.yaw)
        pitch = math.radians(player.pitch + session.recoil.pitch)
        self.chunks.look_from(
            (eye.x, eye.y, eye.z),
            (
                math.sin(aim) * math.cos(pitch),
                math.sin(pitch),
                math.cos(aim) * math.cos(pitch),
            ),
        )
        self.chunks.build_pending()
        self.tracers.update()
        self._place_camera(camera, UVec3)
        self._place_viewmodel(camera)

        stats = self.chunks.stats
        self.hud.update(
            real_dt,
            self.frame_stats.summary(),
            f"chunks {stats.nodes}  tris {stats.triangles // 1000}k  "
            f"queue {session.world.dirty_count}  rebuild {stats.last_frame_ms:.2f} ms "
            f"x{stats.last_frame_rebuilds}  near-stale {stats.near_stale}  "
            f"rounds {session.projectiles.count}",
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

        # Recoil moves the camera because it moves the aim: the round already
        # left along session.recoil.aim(), so a camera that ignored it would be
        # pointing somewhere the rifle is not.
        recoil = session.recoil
        p = player.position
        camera.position = UVec3(p.x + sway * 0.4, p.y + eye + bob + dip, p.z)
        camera.rotation = UVec3(
            -(player.pitch + recoil.pitch), player.yaw + recoil.yaw, sway * 12.0
        )

    def _place_viewmodel(self, camera: Any) -> None:
        """Cosmetic recoil, applied to the things it is allowed to touch.

        The FOV pulse and the viewmodel punch both come from `session.viewkick`
        and neither is read back by anything: the round has already left along
        `session.recoil.aim()`.
        """
        import math

        import numpy as np

        session = self.session
        kick = session.viewkick
        # The periscope's narrow field of view is eased into rather than
        # snapped, or raising it reads as a teleport.
        target = session.controller.fov_scale(session.player)
        blend = min(1.0, self.fov_lerp * max(1e-4, self.frame_dt))
        self.fov_scale += (target - self.fov_scale) * blend
        camera.fov = self.base_fov * self.fov_scale + kick.fov_offset

        player = session.player
        speed_ratio = min(1.0, player.horizontal_speed() / 5.0)
        sway = math.sin(player.bob_phase * 0.5) * self.bob_amp * 0.6 * speed_ratio
        self.viewmodel.update(kick, sway=sway, speed_ratio=speed_ratio)

        # Particle quads face the camera, so they need its basis in world space.
        yaw = math.radians(player.yaw + session.recoil.yaw)
        pitch = math.radians(player.pitch + session.recoil.pitch)
        right = np.array([math.cos(yaw), 0.0, -math.sin(yaw)], dtype=np.float32)
        up = np.array(
            [
                -math.sin(yaw) * math.sin(pitch),
                math.cos(pitch),
                -math.cos(yaw) * math.sin(pitch),
            ],
            dtype=np.float32,
        )
        self.particles.update(right, up)

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
