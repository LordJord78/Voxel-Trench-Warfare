import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { CameraRig, rigTunables } from '../../src/app/camera-rig';
import { Stance } from '../../src/physics/character';
import { Vec3 } from '../../src/physics/vec';
import { Session } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

const tun = loadTunables();
function standing(): Session {
  const map = new BrickMap({ x: 64, y: 64, z: 64 });
  map.fillBox(0, 0, 0, 64, 20, 64, P.SOD);
  const s = Session.create({ map, plan: null, spawn: { position: [3.2, 2.0, 3.2] } }, tun, 7);
  for (let t = 0; t < 10; t++) s.tick();
  // Settling from the spawn is itself a small landing; these tests want none.
  s.player.landingImpact = 0;
  return s;
}

describe('the camera rig', () => {
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
  /** Move the player's foot straight to y (as a tick that snapped it would), and draw one frame. */
  function snapTo(s: Session, rig: CameraRig, y: number, vy = 0) {
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

  it('snaps to a teleport', () => {
    const s = standing();
    const rig = new CameraRig(rigTunables(tun));
    snapTo(s, rig, 2.0);
    expect(Math.abs(snapTo(s, rig, 9.0) - (9.0 + 1.62))).toBeLessThan(0.01);
  });
});
