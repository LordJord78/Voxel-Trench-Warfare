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
    const rig = new CameraRig(rigTunables(tun));
    expect(rig.pose(s, 1 / 60).position[1]).toBeCloseTo(2.0 + 1.62, 9);
    s.player.stance = Stance.CROUCHED;
    s.player.height = 1.25;
    expect(rig.pose(s, 1 / 60).position[1]).toBeCloseTo(2.0 + 1.1, 9);
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
