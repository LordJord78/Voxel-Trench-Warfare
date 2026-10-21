"""Heads-up display.

Built on Panda3D's `TextNode` rather than `ursina.Text`, for the same reason the
chunk renderer bypasses `ursina.Mesh`: the engine's convenience wrappers are the
fragile part.  Ursina's Text does not draw at all under the GL profile Panda
selects on macOS, and it rebuilds a mesh in Python on every assignment.  A
TextNode is C++ and simply works.

Deliberately sparse.  What you need to know in a trench is: what posture am I
in, how much of me is showing, and is there water under my feet.
"""

from __future__ import annotations

from typing import Any

from panda3d.core import (
    CardMaker,
    NodePath,
    TextNode,
    TransparencyAttrib,
)

from ..physics.character import Stance
from ..session import Session

_STANCE_LABEL: dict[Stance, str] = {
    Stance.STANDING: "STANDING",
    Stance.CROUCHED: "CROUCHED",
    Stance.PRONE: "PRONE",
    Stance.FIRING_STEP: "ON THE FIRING STEP",
    Stance.PERISCOPE: "PERISCOPE UP",
}

_INK = (0.86, 0.85, 0.81, 1.0)
_DIM = (0.62, 0.61, 0.57, 1.0)


class Hud:
    """Owns the on-screen text.  Refreshed at a low rate; nothing here needs to
    change 500 times a second."""

    UPDATE_HZ = 10.0

    def __init__(self, session: Session, base: Any) -> None:
        self.session = session
        self.base = base
        self._accum = 0.0
        self.root: NodePath = base.aspect2d.attach_new_node("hud")
        self.root.set_shader_off(1)
        self.root.set_light_off(1)
        self.root.set_transparency(TransparencyAttrib.M_alpha)

        aspect = base.get_aspect_ratio()
        left = -aspect + 0.05

        self.font = self._load_font(base)
        self.title = self._text("title", left, 0.90, _INK, 0.048)
        self.title.node().set_text(
            f"{session.generated.name}    {session.config.callsign}"
        )
        # Three lines now that the weapon is on it, so it starts higher.
        self.stance = self._text("stance", left, -0.72, _INK, 0.048)
        self.status = self._text("status", left, -0.905, _DIM, 0.040)
        self.hint = self._text("hint", left, -0.965, _DIM, 0.034)
        self.hint.node().set_text(
            "WASD move    SHIFT sprint    CTRL crouch    C prone    "
            "SPACE jump    V periscope    F dig    F1 stats    ESC free mouse"
        )
        self.perf = self._text(
            "perf", aspect - 0.05, 0.90, _DIM, 0.040, align=TextNode.A_right
        )
        self._build_reticle()
        self.show_perf = True

    # -- construction ----------------------------------------------------

    @staticmethod
    def _load_font(base: Any):
        """Ursina ships a monospace face; fall back to Panda's built-in."""
        try:
            import ursina

            path = __import__("pathlib").Path(ursina.__file__).parent / "fonts" / "VeraMono.ttf"
            if path.exists():
                font = base.loader.load_font(str(path))
                if font is not None:
                    font.set_pixels_per_unit(64)
                    return font
        except Exception:
            pass
        return None

    def _text(
        self,
        name: str,
        x: float,
        y: float,
        colour: tuple[float, float, float, float],
        scale: float,
        align: int = TextNode.A_left,
    ) -> NodePath:
        node = TextNode(name)
        node.set_align(align)
        node.set_text_color(*colour)
        # A hard shadow, because half this HUD sits over wet clay.
        node.set_shadow(0.055, 0.055)
        node.set_shadow_color(0.04, 0.04, 0.04, 0.85)
        if self.font is not None:
            node.set_font(self.font)
        path = self.root.attach_new_node(node)
        path.set_scale(scale)
        # Ursina puts Panda into `y-up-left`, so aspect2d's vertical axis is Y,
        # not the Z it would be under Panda's own default.
        path.set_pos(x, y, 0.0)
        return path

    def _build_reticle(self) -> None:
        """Four ticks around a gap: reads against mud, does not hide the target."""
        self.reticle = self.root.attach_new_node("reticle")
        gap, length, thick = 0.014, 0.020, 0.0022
        spans = (
            (0.0, gap, thick, length),
            (0.0, -gap - length, thick, length),
            (gap + length * 0.5, -thick * 0.5, length, thick),
            (-gap - length * 0.5, -thick * 0.5, length, thick),
        )
        for i, (x, y, w, h) in enumerate(spans):
            maker = CardMaker(f"tick{i}")
            maker.set_frame(-w * 0.5, w * 0.5, 0.0, h)
            card = self.reticle.attach_new_node(maker.generate())
            # CardMaker builds in the X-Z plane; stand it up for a Y-up world.
            card.set_p(-90.0)
            card.set_pos(x, y, 0.0)
            card.set_color(0.92, 0.91, 0.86, 0.95)

    # -- updates ---------------------------------------------------------

    def toggle_perf(self) -> None:
        self.show_perf = not self.show_perf
        (self.perf.show if self.show_perf else self.perf.hide)()

    def update(self, dt: float, frame_stats: dict[str, float], chunk_line: str) -> None:
        self._accum += dt
        if self._accum < 1.0 / self.UPDATE_HZ:
            return
        self._accum = 0.0

        session = self.session
        player = session.player
        exposure = session.exposure()
        label = _STANCE_LABEL[player.stance]
        if player.blocked_stance:
            label += "  (no headroom)"
        filled = max(0, min(14, int(round(exposure * 10))))
        bar = "#" * filled + "." * (14 - filled)
        weapon = session.weapon
        ammo = (
            "RELOADING"
            if weapon.state.reloading
            else f"{weapon.state.rounds:2d}/{weapon.spec.magazine}"
        )
        self.stance.node().set_text(
            f"{label}\nEXPOSURE [{bar}] {exposure:.2f}\n"
            f"{weapon.spec.name.upper()}   {ammo}"
        )

        p = player.position
        bay = session.network.nearest_bay(p.x, p.z)
        where = f"{bay.line.replace('_', ' ')} bay {bay.index}" if bay else "open ground"
        notes = []
        if session.digging:
            tool = session.entrenching
            done = int(tool.target_fraction * 8)
            notes.append(f"DIGGING [{'#' * done}{'.' * (8 - done)}]"
                         if tool.target else "NOTHING TO CLEAR")
        if player.on_firing_step:
            notes.append("HEAD UP")
        if player.wade_depth > 0.15:
            notes.append(f"WADING {player.wade_depth:.1f} m")
        suffix = ("    " + "   ".join(notes)) if notes else ""
        self.status.node().set_text(
            f"{p.x:6.1f} {p.y:5.1f} {p.z:6.1f}    {where}{suffix}"
        )

        if self.show_perf:
            self.perf.node().set_text(
                f"frame {frame_stats['mean']:5.2f} ms   p95 {frame_stats['p95']:5.2f}   "
                f"{frame_stats['fps']:4.0f} fps\n{chunk_line}"
            )
