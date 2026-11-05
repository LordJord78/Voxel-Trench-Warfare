import { describe, expect, it } from 'vitest';
import { loadTunables, Tunables } from '../../src/core/tunables';
import { CameraRig, rigTunables } from '../../src/app/camera-rig';
import { handlingTunables } from '../../src/combat/handling';
import { rifleModel } from '../../src/combat/rifle-model';
import { viewmodelTunables } from '../../src/combat/viewmodel';
import { Stance } from '../../src/physics/character';
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
  for (let t = 0; t < 10; t++) s.tick();
  // Settling from the spawn is itself a small landing; these tests want none.
  s.player.landingImpact = 0;
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
    // A body standing on the ground records a little landing each tick (0.29 m/s): as standing() does, none.
    s.player.landingImpact = 0;
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
    const s = standing();
    const rig = new CameraRig(rigTunables(tun));
    s.player.landingImpact = 8;
    expect(rig.pose(s, 1 / 60).position[1]).toBeCloseTo(3.62 - 0.11, 9);
    s.player.landingImpact = 20;
    expect(rig.pose(s, 1 / 60).position[1]).toBeCloseTo(3.62 - 0.11, 9);
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
    // No landing's dip of the eye (the camera's alone), as standing() has it.
    s.player.landingImpact = 0;
    // A frame a whisker short of the next tick: drawn as the last tick left the view.
    expect(s.clock.advance(s.clock.dt * (1 - 1e-9))).toBe(0);
    const rig = new CameraRig(rigTunables(tun));
    const drawn = through(rig.rifle(s, rig.pose(s, 1 / 60)).toWorld, rifleModel().muzzle);
    const fired = s.muzzle();
    for (let k = 0; k < 3; k++) expect(drawn[k]).toBeCloseTo(fired[k], 5);
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
