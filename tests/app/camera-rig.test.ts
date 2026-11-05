import { describe, expect, it } from 'vitest';
import { loadTunables, Tunables } from '../../src/core/tunables';
import { CameraRig, rigTunables } from '../../src/app/camera-rig';
import { handlingTunables } from '../../src/combat/handling';
import { rifleModel } from '../../src/combat/rifle-model';
import { viewmodelTunables } from '../../src/combat/viewmodel';
import { type MoveIntent, Stance } from '../../src/physics/character';
import { Vec3 } from '../../src/physics/vec';
import { Rng } from '../../src/core/rng';
import { cameraBasis, type CameraPose } from '../../src/render/camera';
import { idleIntent, Session } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

const tun = loadTunables();
function standing(t = tun): Session {
  const map = new BrickMap({ x: 64, y: 64, z: 64 });
  map.fillBox(0, 0, 0, 64, 20, 64, P.SOD);
  const s = Session.create({ map, plan: null, spawn: { position: [3.2, 2.0, 3.2] } }, t, 7);
  for (let k = 0; k < 10; k++) s.tick();
  // Settling from the spawn is itself a small landing; these tests want none, in either of the last
  // two ticks (the eye's dip is drawn between them).
  s.player.landingImpact = 0;
  s.prevLandingImpact = 0;
  return s;
}

describe('the camera rig', () => {
  it("carries recoil, flinch, shake, the camera's roll and the FOV pulse in the pose, and the shot's shake in the eye, eased between ticks as the foot is", () => {
    // Mouse look turns the view every frame, and frames do not fall on ticks: offsets that moved
    // only on ticks would judder against it.
    const s = standing();
    s.intent = { ...s.intent, fire: true };
    for (let t = 0; t < 12; t++) s.tick();
    s.suppression.crack(0.5, Rng.root(1).derive('crack'));
    const offsets = () => {
      const shake = s.suppression.shake;
      // The view kick's camera: its roll, and a shot's shake, which turns the view and moves the eye.
      const k = s.viewKick;
      return {
        yaw: s.recoil.yaw + s.suppression.flinchYaw + k.shake.yaw,
        pitch: s.recoil.pitch + s.suppression.flinchPitch + shake.pitch + k.shake.pitch,
        roll: shake.roll + k.camRoll,
        fov: k.fovOffset,
        x: k.shake.offset[0],
        y: k.shake.offset[1],
        z: k.shake.offset[2],
      };
    };
    const before = offsets();
    s.tick();
    const after = offsets();
    expect(Math.abs(s.recoil.pitch)).toBeGreaterThan(0);
    expect(Math.abs(s.suppression.flinchPitch)).toBeGreaterThan(0);
    expect(Math.abs(after.roll)).toBeGreaterThan(0);
    expect(Math.abs(after.pitch - before.pitch)).toBeGreaterThan(1e-3);
    // A shot's own: the camera rolled, and the eye shaking on both ticks.
    expect(Math.abs(s.viewKick.camRoll)).toBeGreaterThan(0);
    for (const o of [before, after]) expect(Math.hypot(o.x, o.y, o.z)).toBeGreaterThan(0);
    const rig = new CameraRig(rigTunables(tun));
    // Standing still, the eye is the foot's, raised: no bob, lean, dip or step to ease.
    const eye = () => {
      const f = s.footAt();
      return [f.x, f.y + s.controller.eyeHeight(s.player), f.z];
    };
    // No tick runs while the frames creep a quarter, then three quarters, of the way to the next.
    for (const [creep, alpha] of [[0, 0], [0.25, 0.25], [0.5, 0.75]]) {
      expect(s.clock.advance(creep / 60)).toBe(0);
      expect(s.clock.alpha).toBeCloseTo(alpha, 9);
      const pose = rig.pose(s, creep / 60);
      const at = (k: keyof typeof before) => before[k] + (after[k] - before[k]) * alpha;
      expect(pose.yaw).toBeCloseTo(s.player.yaw + at('yaw'), 9);
      expect(pose.pitch).toBeCloseTo(s.player.pitch + at('pitch'), 9);
      expect(pose.roll).toBeCloseTo(at('roll'), 9);
      expect(pose.fov).toBeCloseTo(tun.f('camera.fov') + at('fov'), 9);
      const e = eye();
      (['x', 'y', 'z'] as const).forEach((c, i) => expect(pose.position[i], c).toBeCloseTo(e[i] + at(c), 9));
    }
  });

  it('puts the eye 1.62 m over a standing player and 1.10 m over a crouched one', () => {
    const s = standing();
    expect(new CameraRig(rigTunables(tun)).pose(s, 1 / 60).position[1]).toBeCloseTo(2.0 + 1.62, 9);
    s.player.stance = Stance.CROUCHED;
    s.player.height = 1.25;
    // A fresh rig: one that had drawn the standing eye would ease down to this (see below).
    expect(new CameraRig(rigTunables(tun)).pose(s, 1 / 60).position[1]).toBeCloseTo(2.0 + 1.1, 9);
  });

  it('bobs only while moving, by at most the amplitude', () => {
    const s = standing();
    const rig = new CameraRig(rigTunables(tun));
    s.player.bobPhase = Math.PI / 2;
    expect(rig.pose(s, 1 / 60).position[1]).toBeCloseTo(3.62, 9);
    s.player.velocity = new Vec3(5, 0, 0);
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 64; k++) {
      s.player.bobPhase = (k / 64) * 2 * Math.PI;
      const y = rig.pose(s, 1 / 60).position[1] - 3.62;
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    expect(hi).toBeCloseTo(0.035, 6);
    expect(lo).toBeCloseTo(-0.035, 6);
  });

  it('dips the eye 0.11 m on a hard landing', () => {
    // As both of the last two ticks left it, so any frame between them.
    const s = standing();
    const rig = new CameraRig(rigTunables(tun));
    s.prevLandingImpact = s.player.landingImpact = 8;
    expect(rig.pose(s, 1 / 60).position[1]).toBeCloseTo(3.62 - 0.11, 9);
    s.prevLandingImpact = s.player.landingImpact = 20;
    expect(rig.pose(s, 1 / 60).position[1]).toBeCloseTo(3.62 - 0.11, 9);
    // Midway between a tick with no landing and one over the hard landing's speed: midway between
    // their dips, not the dip of midway between their speeds (10 m/s, over it: the full dip).
    s.clock.advance(s.clock.dt * 0.5);
    s.prevLandingImpact = 0;
    s.player.landingImpact = 20;
    expect(rig.pose(s, 1 / 60).position[1]).toBeCloseTo(3.62 - 0.055, 9);
  });

  it("dips the eye all of [camera] landing_dip at [handling] landing_hard_mps, the gun's full dip: at 4, a landing at 4 m/s", () => {
    // One full-dip speed for the eye and the gun, read from one key; the muzzle the session places
    // (rifleToWorld) carries the eye's dip, so it reads the key too.
    const raw = tun.raw();
    (raw.handling as Record<string, unknown>).landing_hard_mps = 4;
    const t = new Tunables(raw);
    const s = standing(t);
    const rig = new CameraRig(rigTunables(t));
    const undipped = s.muzzle()[1];
    s.prevLandingImpact = s.player.landingImpact = 4;
    expect(rig.pose(s, 1 / 60).position[1]).toBeCloseTo(3.62 - t.f('camera.landing_dip'), 9);
    expect(s.muzzle()[1] - undipped).toBeCloseTo(-t.f('camera.landing_dip'), 12);
    // Half as hard, half the dip.
    s.prevLandingImpact = s.player.landingImpact = 2;
    expect(rig.pose(s, 1 / 60).position[1]).toBeCloseTo(3.62 - t.f('camera.landing_dip') / 2, 9);
  });

  it("eases the eye's landing dip between ticks, as the foot is: at alpha 0.5, midway between the two ticks' dips", () => {
    // A standing jump on flat ground lands at about its jump speed, and the dip it records falls a
    // tenth a tick. Drawn as the tick left it, the eye would step at 60 Hz, each step held for 2–4
    // frames at 120–240 Hz; every frame between two ticks is drawn between their dips instead.
    const s = standing();
    expect(s.clock.advance(s.clock.dt * 0.5)).toBe(0);
    expect(s.clock.alpha).toBe(0.5);
    const hard = tun.f('handling.landing_hard_mps');
    const dipOf = (impact: number) => (-Math.min(impact, hard) / hard) * tun.f('camera.landing_dip');
    s.intent = { ...idleIntent(), jump: true };
    s.tick();
    s.intent = idleIntent();
    expect(s.player.onGround).toBe(false);
    let after = -1;
    for (let k = 0; k < 120 && after < 20; k++) {
      const was = s.player.landingImpact;
      s.tick();
      if (after < 0 && !s.player.onGround) continue;
      after++;
      const [a, b] = [dipOf(was), dipOf(s.player.landingImpact)];
      // On the landing tick the dip comes in, most of 6 cm at once.
      if (after === 0) expect(b - a).toBeLessThan(-0.04);
      // A fresh rig (no step of the eye's to ease), standing still (no bob or lean) and no shot (no shake).
      const rig = new CameraRig(rigTunables(tun));
      const eye = rig.pose(s, 1 / 60).position[1] - (s.footAt().y + s.controller.eyeHeight(s.player));
      expect(eye, `${after} ticks after landing`).toBeCloseTo((a + b) / 2, 12);
    }
    expect(after).toBe(20);
  });

  it("a teleport (a respawn) lets the last place's landing go: the eye is not dipped by it in any frame after", () => {
    // Down off a jump, a tick on, then put elsewhere before the next tick runs: the frames between
    // draw the eye at the new place undipped, as they draw the foot there unmoved.
    const s = standing();
    expect(s.clock.advance(s.clock.dt * 0.5)).toBe(0);
    s.intent = { ...idleIntent(), jump: true };
    s.tick();
    s.intent = idleIntent();
    for (let k = 0; k < 60 && !s.player.onGround; k++) s.tick();
    s.tick();
    expect(s.landingDipAt()).toBeLessThan(-0.04);
    s.teleport([3.2, 2.0, 3.2], 0, 0);
    const rig = new CameraRig(rigTunables(tun));
    expect(rig.pose(s, 1 / 60).position[1] - (s.footAt().y + s.controller.eyeHeight(s.player))).toBeCloseTo(0, 12);
  });

  it('standing still for 2 s, no landing is recorded and the eye is not dipped at all', () => {
    // A body standing on the ground lands on no tick (character.ts records a landing as the body
    // comes down), so nothing holds the eye low at rest. standing() has let the spawn's own go.
    const s = standing();
    const rig = new CameraRig(rigTunables(tun));
    for (let k = 0; k < 120; k++) {
      s.tick();
      expect(s.player.landingImpact, `tick ${k}`).toBe(0);
      const foot = s.footAt();
      expect(rig.pose(s, 1 / 60).position[1] - (foot.y + s.controller.eyeHeight(s.player)), `tick ${k}`).toBeCloseTo(0, 12);
    }
  });

  it('eases the field of view into the periscope', () => {
    const s = standing();
    const rig = new CameraRig(rigTunables(tun));
    s.player.stance = Stance.PERISCOPE;
    expect(rig.pose(s, 1 / 60).fov! / 90).toBeCloseTo(0.9323, 4);
    for (let f = 1; f < 60; f++) rig.pose(s, 1 / 60);
    expect(Math.abs(rig.fovScale - 0.42)).toBeLessThan(0.001);
  });
});

describe('the eye over steps', () => {
  const FRAME = 1 / 60;
  /** A frame of the game running: its clock moves on, the player's foot goes straight to y (as a tick that snapped it would), and it is drawn. */
  function snapTo(s: Session, rig: CameraRig, y: number, vy = 0) {
    s.clock.advance(FRAME);
    const p = s.player.position;
    s.prevPosition = new Vec3(p.x, y, p.z);
    s.player.position = new Vec3(p.x, y, p.z);
    s.player.velocity = new Vec3(0, vy, 0);
    return rig.pose(s, FRAME).position[1];
  }

  it('eases up a 0.3 m step instead of jumping, and arrives', () => {
    const s = standing();
    const rig = new CameraRig(rigTunables(tun));
    let before = snapTo(s, rig, 2.0);
    let worst = 0;
    for (let f = 0; f < 18; f++) {
      const now = snapTo(s, rig, 2.3);
      worst = Math.max(worst, Math.abs(now - before));
      before = now;
    }
    expect(worst).toBeLessThan(0.12);
    expect(Math.abs(before - (2.3 + 1.62))).toBeLessThan(0.005);
  });

  it('eases a stand from a crouch the same way', () => {
    const s = standing();
    const rig = new CameraRig(rigTunables(tun));
    s.player.stance = Stance.CROUCHED;
    s.player.height = 1.25;
    let before = rig.pose(s, FRAME).position[1];
    s.player.stance = Stance.STANDING;
    s.player.height = 1.8;
    let worst = 0;
    for (let f = 0; f < 24; f++) {
      const now = rig.pose(s, FRAME).position[1];
      worst = Math.max(worst, Math.abs(now - before));
      before = now;
    }
    expect(worst).toBeLessThan(0.15);
    expect(Math.abs(before - (2.0 + 1.62))).toBeLessThan(0.005);
  });

  it('follows a fall exactly: continuous motion is not a step', () => {
    const s = standing();
    const rig = new CameraRig(rigTunables(tun));
    snapTo(s, rig, 20);
    for (let f = 1; f <= 30; f++) {
      const y = 20 - 10 * f * FRAME;
      expect(Math.abs(snapTo(s, rig, y, -10) - (y + 1.62))).toBeLessThan(0.01);
    }
  });

  it('holds still while the game is paused, even mid-fall', () => {
    const s = standing();
    const rig = new CameraRig(rigTunables(tun));
    snapTo(s, rig, 20);
    const falling = snapTo(s, rig, 20 - 10 * FRAME, -10);
    // Paused: frames are drawn, but the clock and the player stand still.
    for (let f = 0; f < 30; f++) expect(rig.pose(s, FRAME).position[1]).toBe(falling);
  });

  it('follows a fall through a hitch the simulation could not keep up with', () => {
    const s = standing();
    const rig = new CameraRig(rigTunables(tun));
    snapTo(s, rig, 20, -10);
    // A 0.3 s frame: the clock runs at most five ticks of it, and the app's frame time is capped at 0.1 s.
    const before = s.clock.simTime + s.clock.alpha * s.clock.dt;
    s.clock.advance(0.3);
    const ran = s.clock.simTime + s.clock.alpha * s.clock.dt - before;
    const y = 20 - 10 * ran;
    const p = s.player.position;
    s.prevPosition = new Vec3(p.x, y, p.z);
    s.player.position = new Vec3(p.x, y, p.z);
    expect(Math.abs(rig.pose(s, 0.1).position[1] - (y + 1.62))).toBeLessThan(0.01);
  });

  it('snaps to a teleport', () => {
    const s = standing();
    const rig = new CameraRig(rigTunables(tun));
    snapTo(s, rig, 2.0);
    expect(Math.abs(snapTo(s, rig, 9.0) - (9.0 + 1.62))).toBeLessThan(0.01);
  });

  it('a landing lets no teleport go uneased: put half a metre up, its settle a landing in the same frame (as every respawn is), the eye eases there', () => {
    // A respawn's first frame runs its first tick, on which the body put down settles: a landing,
    // whose own motion (none here) the eye follows. The height it was put at is the teleport's, which
    // the eye eases under a metre and snaps over one, as it always has. The game's frames, 60 a second.
    const map = new BrickMap({ x: 64, y: 64, z: 64 });
    map.fillBox(0, 0, 0, 64, 20, 64, P.SOD);
    map.fillBox(40, 20, 0, 64, 25, 64, P.SOD);
    const s = Session.create({ map, plan: null, spawn: { position: [3.2, 2.0, 3.2] } }, tun, 7);
    const rig = new CameraRig(rigTunables(tun));
    const frame = () => {
      expect(s.advance(FRAME)).toBe(1);
      return rig.pose(s, FRAME).position[1];
    };
    for (let f = 0; f < 30; f++) frame();
    s.teleport([5.2, 2.5, 3.2], 0, 0);
    let eye = frame();
    expect(s.landedTick).toBe(s.ticks);
    expect(s.player.position.y).toBeCloseTo(2.5, 9);
    // Still most of the way down, as a step half a metre up is, and there in half a second.
    expect(2.5 + 1.62 - eye).toBeGreaterThan(0.3);
    for (let f = 1; f < 30; f++) eye = frame();
    expect(Math.abs(eye - (2.5 + 1.62))).toBeLessThan(0.005);
  });

  /**
   * One rig, kept as the game keeps it, drawing every frame at `hz`, the ticks run as Session.advance
   * runs them: `intentFor` gives each tick's intent (by the tick's number, and whether the landing has
   * come), and `edit` runs before each frame. The first landing from here (`landedTick`): its tick and
   * how far the foot rose on it. Then the eye's trail (the kept rig's eye less a fresh rig's, which
   * draws the body's own eye: nothing to ease) on the first frame after it that draws the foot at `top`,
   * and half a second after that.
   */
  function overTheRise(s: Session, hz: number, top: number, intentFor: (tick: number, down: boolean) => MoveIntent, edit?: (f: number) => void) {
    const rig = new CameraRig(rigTunables(tun));
    let [landed, rise, up, there, trail] = [-1, 0, -1, NaN, NaN];
    for (let f = 0; up < 0 ? f < 4 * hz : f - up <= 0.5 * hz; f++) {
      edit?.(f);
      const ticks = s.clock.advance(1 / hz);
      for (let i = 0; i < ticks; i++) {
        s.intent = intentFor(s.ticks + 1, landed >= 0);
        const y = s.player.position.y;
        s.tick();
        if (landed < 0 && s.landedTick === s.ticks) [landed, rise] = [s.ticks, s.player.position.y - y];
      }
      trail = rig.pose(s, 1 / hz).position[1] - new CameraRig(rigTunables(tun)).pose(s, 1 / hz).position[1];
      if (landed >= 0 && up < 0 && s.footAt().y >= top - 1e-9) [up, there] = [f, trail];
    }
    return { landed, rise, there, after: trail };
  }

  it('a step taken as the body lands is still a step: a tapped jump that comes down on the face of a lip 0.3 m high steps up onto it on its landing tick, and the eye eases up after it, at 60 Hz and at 30 to 240', () => {
    // In the air with jump not held (a tap: the mantle wants it held), a body moving into a lip up to
    // [player] air_step_up over its feet steps up onto it, and its fall meets the lip's top at once: the
    // landing tick rises. That rise is a step, not the body's own motion (a landing comes down), so the
    // eye eases it as it eases any step; the fall before it is the body's own, which the eye follows.
    const JUMP_AT = 27;
    for (const hz of [60, 120, 144, 240, 30]) {
      const map = new BrickMap({ x: 64, y: 64, z: 64 });
      map.fillBox(0, 0, 0, 64, 20, 64, P.SOD);
      map.fillBox(40, 20, 0, 64, 23, 64, P.SOD);
      // Facing +x, the lip's face 3.4 m ahead: walking at it, a tap of jump; once down, still.
      const s = Session.create({ map, plan: null, spawn: { position: [0.6, 2.0, 3.2] } }, tun, 7, 90);
      for (let k = 0; k < 10; k++) s.tick();
      const { landed, rise, there, after } = overTheRise(s, hz, 2.3, (tick, down) => ({ ...idleIntent(), forward: down ? 0 : 1, jump: tick === JUMP_AT }));
      const label = `${hz} Hz`;
      // It came down on the lip's face, well after the tap, and rose onto its top on the landing tick.
      expect(landed, label).toBeGreaterThan(JUMP_AT + 10);
      expect(rise, label).toBeGreaterThan(0.1);
      // The frame that first draws the body on the lip's top draws the eye most of the step below it,
      // as any step is drawn, not up there with it; and the eye is there in half a second.
      expect(there, label).toBeLessThan(-rise / 2);
      expect(Math.abs(after), label).toBeLessThan(0.005);
    }
  });

  it("the controller's unstick, lifting a buried body out and landing it there in one tick, is eased as it always was", () => {
    // A body inside the world [player] unstick_ticks running is lifted to the nearest free space (here
    // out of ground piled 0.6 m over its feet), still, and comes down on it in the same tick: a landing
    // that rose. The lift is no motion of the body's own, so the eye eases it, as it eases a teleport
    // under a metre. The ground is piled outside the session's edits, whose own lift (liftOut) would
    // come first.
    for (const hz of [60, 120, 144, 240, 30]) {
      const map = new BrickMap({ x: 64, y: 64, z: 64 });
      map.fillBox(0, 0, 0, 64, 20, 64, P.SOD);
      const s = Session.create({ map, plan: null, spawn: { position: [3.2, 2.0, 3.2] } }, tun, 7);
      for (let k = 0; k < 30; k++) s.tick();
      const pile = (f: number) => {
        if (f === 5) map.fillBox(0, 20, 0, 64, 26, 64, P.SOD);
      };
      const { landed, rise, there, after } = overTheRise(s, hz, 2.6, () => idleIntent(), pile);
      const label = `${hz} Hz`;
      expect(landed, label).toBeGreaterThan(0);
      expect(rise, label).toBeCloseTo(0.6, 9);
      expect(there, label).toBeLessThan(-rise / 2);
      expect(Math.abs(after), label).toBeLessThan(0.005);
    }
  });
});

describe('the rifle as the rig draws it', () => {
  /** A model point (metres) through a 3×4 column-major transform. */
  const through = (m: Float32Array, p: readonly number[]) => [0, 1, 2].map((k) => m[k] * p[0] + m[3 + k] * p[1] + m[6 + k] * p[2] + m[9 + k]);

  it("its muzzle is drawn where the session fires from", () => {
    const s = standing();
    // The hands held still: no tick runs between these, so the rig draws the last tick but one (alpha
    // 0) and the session fires from the last, and a still gun breathes between the two. A shot's own
    // muzzle is carried to the drawn gun's in effects-frame (its drift), as in play.
    s.handsStill = true;
    const rig = new CameraRig(rigTunables(tun));
    const drawn = through(rig.rifle(s, rig.pose(s, 1 / 60)).toWorld, rifleModel().muzzle);
    const fired = s.muzzle();
    for (let k = 0; k < 3; k++) expect(drawn[k]).toBeCloseTo(fired[k], 5);
  });

  it('its muzzle is drawn where the session fires from with the camera rolled and shaken by a shot', () => {
    // The gun is held in the view: the camera's roll turns it and the shot's shake moves it with the
    // eye, so the session's muzzle (where the tracer and flash start) is carried by both as well.
    const s = standing();
    s.handsStill = true;
    s.intent = { ...idleIntent(), fire: true };
    s.tick();
    s.intent = idleIntent();
    s.tick();
    expect(Math.abs(s.viewKick.camRoll)).toBeGreaterThan(0);
    expect(Math.hypot(...s.viewKick.shake.offset)).toBeGreaterThan(0);
    // A frame a whisker short of the next tick: drawn as the last tick left the view.
    expect(s.clock.advance(s.clock.dt * (1 - 1e-9))).toBe(0);
    const rig = new CameraRig(rigTunables(tun));
    const drawn = through(rig.rifle(s, rig.pose(s, 1 / 60)).toWorld, rifleModel().muzzle);
    const fired = s.muzzle();
    for (let k = 0; k < 3; k++) expect(drawn[k]).toBeCloseTo(fired[k], 5);
  });

  it("its muzzle is drawn where the session fires from after a jump's landing: the eye's dip carries both", () => {
    // A standing jump on flat ground: the eye dips most of 6 cm on landing and recovers over 0.3 s, and
    // the drawn gun, held in the view, dips with it, so the muzzle the session puts the flash, the
    // tracer's start, the brass and the cues at must as well. Frames a whisker short of the next tick
    // (drawn as the last tick left everything), each by a fresh rig: no step of the eye's to ease.
    const s = standing();
    expect(s.clock.advance(s.clock.dt * (1 - 1e-9))).toBe(0);
    s.intent = { ...idleIntent(), jump: true };
    s.tick();
    s.intent = idleIntent();
    for (let k = 0; k < 60 && !s.player.onGround; k++) s.tick();
    expect(s.player.onGround).toBe(true);
    const hard = tun.f('handling.landing_hard_mps');
    expect((Math.min(s.player.landingImpact, hard) / hard) * tun.f('camera.landing_dip')).toBeGreaterThan(0.04);
    for (let k = 0; k <= 30; k++) {
      if (k > 0) s.tick();
      const rig = new CameraRig(rigTunables(tun));
      const drawn = through(rig.rifle(s, rig.pose(s, 1 / 60)).toWorld, s.arm.spec.muzzle);
      const fired = s.muzzle();
      for (let c = 0; c < 3; c++) expect(Math.abs(drawn[c] - fired[c]), `${k} ticks after landing, axis ${c}`).toBeLessThan(1e-6);
    }
  });

  it("a landing is not a step: one rig, drawing every frame, keeps the muzzle on the session's through a jump's landing and a 1.5 m fall's, at 120 Hz and at 30 to 240", () => {
    // The landing tick ends the fall at a standstill, the ground's catch with it (the probe sets a body
    // down that ends its tick within 6 cm of the ground), so the velocity explains none of the drop the
    // frames between it and the tick before show, nor the fall's last before it. Eased as a step, that
    // held the drawn eye, and the gun with it, up to 14 cm over the session's muzzle (the tracer's
    // start, the flash, the brass, the cues) for a tenth of a second after every jump. One rig, kept as
    // the game keeps it, draws each frame at the clock's alpha, the ticks run as Session.advance runs
    // them; the session's muzzle for a frame is between the last two ticks' as the foot is. From the
    // first frame after the landing tick through 0.5 s, the gun is drawn there, to a millimetre (a
    // tick's turn of the gun on landing, interpolated, bows a few tenths of one off the straight line).
    const fall = (h: number) => {
      const s = standing();
      s.teleport([3.2, 2.0 + h, 3.2], 0, 0);
      return s;
    };
    const cases: string[] = [];
    let most = 0;
    for (const hz of [120, 60, 144, 240, 30]) {
      for (const [how, jump] of [['a jump', true], ['a fall of 1.5 m', false]] as const) {
        const s = jump ? standing() : fall(1.5);
        const rig = new CameraRig(rigTunables(tun));
        let [was, now] = [s.muzzle(), s.muzzle()];
        let leapt = !jump;
        let landed = -1;
        let impact = 0;
        let gap = 0;
        let at = -1;
        for (let f = 0; landed < 0 ? f < 2 * hz : f - landed <= 0.5 * hz; f++) {
          const ticks = s.clock.advance(1 / hz);
          for (let i = 0; i < ticks; i++) {
            // Standing a few frames, then the jump.
            s.intent = { ...idleIntent(), jump: !leapt && f >= 4 };
            leapt ||= s.intent.jump === true;
            const inAir = !s.player.onGround;
            s.tick();
            [was, now] = [now, s.muzzle()];
            if (landed < 0 && inAir && s.player.onGround) [landed, impact] = [f, s.player.landingImpact];
          }
          const drawn = through(rig.rifle(s, rig.pose(s, 1 / hz)).toWorld, s.arm.spec.muzzle);
          const a = s.clock.alpha;
          const off = Math.hypot(...[0, 1, 2].map((k) => drawn[k] - (was[k] + (now[k] - was[k]) * a)));
          if (landed >= 0 && off > gap) [gap, at] = [off, f - landed];
        }
        const label = `${how} at ${hz} Hz`;
        // It came down, hard enough to matter: the jump at about 4.3 m/s, the fall at about 6.8.
        expect(landed, label).toBeGreaterThan(0);
        expect(impact, label).toBeGreaterThan(jump ? 4 : 6);
        cases.push(`${label}: ${(gap * 1000).toFixed(3)} mm (frame +${at})`);
        most = Math.max(most, gap);
      }
    }
    expect(most, cases.join('; ')).toBeLessThan(1e-3);
  });

  it("a takeoff is not a step either: one rig, drawing every frame through a jump from a standstill and then a running one, keeps the muzzle on the session's from each takeoff through its landing and 0.5 s on, at 120 Hz and at 30 to 240", () => {
    // The takeoff tick sets the body rising at the jump's speed, and the frames run a tick behind: the
    // first frame after it still shows the tick before, the body standing. Explained by the velocity
    // after it over the frame's whole time, that frame's motion fell short of it, and the rest, eased as
    // a step, held the drawn eye, and the gun with it, up to 66 mm over the session's muzzle (the
    // tracer's start, the flash, the brass, the cues) for a tenth of a second after every jump. One rig,
    // kept as the game keeps it, draws each frame at the clock's alpha through both jumps in turn, the
    // ticks run as Session.advance runs them; the session's muzzle for a frame is between the last two
    // ticks' as the foot is. Zeroed: the camera's own stride (the eye's bob and lean, the gun's run dip),
    // which the session's muzzle leaves out, and the sprint's turn of the gun, whose few degrees a tick,
    // drawn between ticks, bow the muzzle up to 1.6 mm off the straight line between two ticks' muzzles.
    // What is left is the eye's own.
    const raw = tun.raw();
    (raw.camera as Record<string, unknown>).head_bob_amplitude = 0;
    (raw.viewmodel as Record<string, unknown>).run_dip_m = 0;
    Object.assign(raw.handling as Record<string, unknown>, { sprint_pitch_deg: 0, sprint_yaw_deg: 0, sprint_roll_deg: 0 });
    const t = new Tunables(raw);
    const cases: string[] = [];
    let most = 0;
    for (const hz of [120, 60, 144, 240, 30]) {
      // A long flat field, faced down (+z).
      const map = new BrickMap({ x: 256, y: 64, z: 512 });
      map.fillBox(0, 0, 0, 256, 4, 512, P.SOD);
      const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 2] } }, t, 7, 0);
      for (let k = 0; k < 10; k++) s.tick();
      const rig = new CameraRig(rigTunables(t));
      let [was, now] = [s.muzzle(), s.muzzle()];
      let f = 0;
      for (const [how, running] of [['a jump from a standstill', false], ['a running jump', true]] as const) {
        // Standing a tenth of a second, or running a second (the sprint's pose all in), then a tap of jump.
        const tapAt = f + Math.round((running ? 1 : 0.1) * hz);
        let leapt = false;
        let [takeoff, landed, speed, impact, gap, at] = [-1, -1, 0, 0, 0, -1];
        for (; landed < 0 ? f < tapAt + 2 * hz : f - landed <= 0.5 * hz; f++) {
          const ticks = s.clock.advance(1 / hz);
          for (let i = 0; i < ticks; i++) {
            s.intent = { ...idleIntent(), forward: running ? 1 : 0, sprint: running, jump: !leapt && f >= tapAt };
            leapt ||= s.intent.jump;
            const grounded = s.player.onGround;
            s.tick();
            [was, now] = [now, s.muzzle()];
            if (takeoff < 0 && grounded && !s.player.onGround && s.player.velocity.y > 0) [takeoff, speed] = [f, s.player.velocity.horizontalLength];
            else if (takeoff >= 0 && landed < 0 && !grounded && s.player.onGround) [landed, impact] = [f, s.player.landingImpact];
          }
          const drawn = through(rig.rifle(s, rig.pose(s, 1 / hz)).toWorld, s.arm.spec.muzzle);
          const a = s.clock.alpha;
          const off = Math.hypot(...[0, 1, 2].map((k) => drawn[k] - (was[k] + (now[k] - was[k]) * a)));
          if (takeoff >= 0 && off > gap) [gap, at] = [off, f - takeoff];
        }
        const label = `${how} at ${hz} Hz`;
        // It left the ground, standing still or at a sprint (a walk is 4.1 m/s), and came down.
        expect(takeoff, label).toBeGreaterThanOrEqual(0);
        if (running) expect(speed, label).toBeGreaterThan(6);
        else expect(speed, label).toBeLessThan(0.01);
        expect(landed, label).toBeGreaterThan(takeoff);
        expect(impact, label).toBeGreaterThan(4);
        cases.push(`${label}: ${(gap * 1000).toFixed(3)} mm (frame +${at})`);
        most = Math.max(most, gap);
      }
    }
    expect(most, cases.join('; ')).toBeLessThan(1e-3);
  });

  it('turns with the view, its axes square', () => {
    const s = standing();
    s.player.yaw = 90;
    const rig = new CameraRig(rigTunables(tun));
    const m = rig.rifle(s, rig.pose(s, 1 / 60)).toWorld;
    // The model's forward is the view's (+x at yaw 90), and its axes are unit and square.
    expect(m[6]).toBeCloseTo(1, 6);
    const axis = (c: number) => [m[c * 3], m[c * 3 + 1], m[c * 3 + 2]];
    for (const c of [0, 1, 2]) expect(Math.hypot(...axis(c))).toBeCloseTo(1, 6);
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(axis(0), axis(1))).toBeCloseTo(0, 6);
    expect(dot(axis(1), axis(2))).toBeCloseTo(0, 6);
  });

  it("its previous transform is the last frame's", () => {
    const s = standing();
    const rig = new CameraRig(rigTunables(tun));
    const first = rig.rifle(s, rig.pose(s, 1 / 60));
    s.player.yaw += 10;
    s.tick();
    const second = rig.rifle(s, rig.pose(s, 1 / 60));
    expect(Array.from(second.prevToWorld)).toEqual(Array.from(first.toWorld));
    expect(Array.from(second.toWorld)).not.toEqual(Array.from(first.toWorld));
  });

  const TICK = 1 / 60;
  const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  /** Where the rig draws the gun's model origin, in the view `pose` shows: right, up and forward of the eye (metres). */
  function drawnAt(rig: CameraRig, s: Session, pose: CameraPose): { right: number; up: number } {
    const m = rig.rifle(s, pose).toWorld;
    const basis = cameraBasis(pose.yaw, pose.pitch, pose.roll ?? 0);
    const at = [m[9] - pose.position[0], m[10] - pose.position[1], m[11] - pose.position[2]];
    return { right: dot(at, basis.right), up: dot(at, basis.up) };
  }

  it("at a walk it swings across by the hands' figure eight alone: either side of centre by turns, within 0.006 m by the run's share", () => {
    // The gun's stride motion is the hands' (handling.ts), not the eye's sway, which is the eye's own
    // lean. Each stride swings it the other way; it still drops a little at speed (run_dip_m).
    const map = new BrickMap({ x: 256, y: 64, z: 512 });
    map.fillBox(0, 0, 0, 256, 4, 512, P.SOD);
    const s = Session.create({ map, plan: null, spawn: { position: [12.8, 0.4, 2] } }, tun, 7, 0);
    for (let k = 0; k < 10; k++) s.tick();
    const rig = new CameraRig(rigTunables(tun));
    const vt = viewmodelTunables(tun);
    const ht = handlingTunables(tun);
    s.intent = { ...idleIntent(), forward: 1 };
    const strides: number[][] = [[]];
    let last = s.player.bobPhase;
    let ratio = 0;
    let lean = 0;
    for (let k = 0; k < 270; k++) {
      // Drawn at alpha 0 (no frame between ticks here), the gun is as the last tick but one left the
      // hands, so its stride is the body's before this tick.
      const phase = s.player.bobPhase;
      if (phase < last - Math.PI) strides.push([]);
      last = phase;
      s.tick();
      const pose = rig.pose(s, TICK);
      const drawn = drawnAt(rig, s, pose);
      const hands = s.handling.at(0);
      const share = Math.min(1, s.player.velocity.horizontalLength / ht.runMps);
      // Across, the hands' alone; up, the hands' and the run's dip.
      const across = drawn.right - vt.restRightM;
      expect(across, `tick ${k}`).toBeCloseTo(hands.offset[0], 5);
      expect(drawn.up - vt.restUpM, `tick ${k}`).toBeCloseTo(hands.offset[1] - share * vt.runDipM, 5);
      strides[strides.length - 1].push(across);
      ratio = share;
      // The eye's own lean along its right (facing +z, its right is +x), which stays.
      lean = Math.max(lean, pose.position[0] - s.footAt().x);
    }
    // The walk's first stride (getting up to speed) and its last (cut short) aside, at least four whole ones.
    const whole = strides.slice(1, -1);
    expect(whole.length).toBeGreaterThanOrEqual(4);
    const most = 0.006 * ratio + 0.0015;
    const swings = whole.map((st) => st.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0));
    for (let j = 0; j < whole.length; j++) {
      for (const x of whole[j]) expect(Math.abs(x), `stride ${j}`).toBeLessThanOrEqual(most);
      expect(Math.abs(swings[j]), `stride ${j}`).toBeGreaterThan(0.8 * 0.006 * ratio);
      if (j > 0) expect(Math.sign(swings[j]), `stride ${j}`).toBe(-Math.sign(swings[j - 1]));
    }
    expect(ratio).toBeGreaterThan(0.7);
    expect(lean).toBeGreaterThan(0.004);
  });

  it("the rig's share of a run is the body's speed over [handling] run_mps: the eye's bob and the gun's dip follow it", () => {
    for (const runMps of [5, 8]) {
      const raw = tun.raw();
      (raw.handling as Record<string, unknown>).run_mps = runMps;
      const t = new Tunables(raw);
      const s = standing(t);
      s.handsStill = true;
      const rig = new CameraRig(rigTunables(t));
      s.player.velocity = new Vec3(0, 0, 4);
      s.player.bobPhase = Math.PI / 2;
      const share = 4 / runMps;
      const pose = rig.pose(s, TICK);
      // The eye: up by the head bob's amplitude at the stride's top, by the share.
      expect(pose.position[1] - 3.62, `run_mps ${runMps}`).toBeCloseTo(t.f('camera.head_bob_amplitude') * share, 9);
      // The gun: dropped by run_dip_m, by the share.
      expect(drawnAt(rig, s, pose).up - t.f('viewmodel.rest_up_m'), `run_mps ${runMps}`).toBeCloseTo(-t.f('viewmodel.run_dip_m') * share, 5);
    }
  });
});
