import { describe, expect, it } from 'vitest';
import { rifleModel } from '../../src/combat/rifle-model';
import { modelToView, viewBasis, viewmodelPose, viewmodelTunables } from '../../src/combat/viewmodel';
import { loadTunables } from '../../src/core/tunables';
import { cameraBasis } from '../../src/render/camera';
import { Session } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// Where the rifle is held: the reference's rest pose (0.175 m right, 0.205 m down, 0.44 m out),
// moved by the view kick's six channels, the walk's sway and a run's dip (viewmodel.py update).
const tun = loadTunables();
const t = viewmodelTunables(tun);
const still = { back: 0, up: 0, side: 0, pitch: 0, yaw: 0, roll: 0 };
const RAD = Math.PI / 180;

describe('the viewmodel', () => {
  it("at rest the model's origin sits at the rest offset, the rifle along the view", () => {
    const pose = viewmodelPose(t, still, 0, 0);
    expect(modelToView(pose, [0, 0, 0])).toEqual([0.175, -0.205, 0.44]);
    const ahead = modelToView(pose, [0, 0, 1]);
    expect(ahead[0]).toBeCloseTo(0.175, 12);
    expect(ahead[1]).toBeCloseTo(-0.205, 12);
    expect(ahead[2]).toBeCloseTo(1.44, 12);
  });

  it('a pitch kick raises the muzzle, a yaw kick turns it right, a roll turns its right side up', () => {
    const pitched = modelToView(viewmodelPose(t, { ...still, pitch: 10 }, 0, 0), [0, 0, 1]);
    expect(pitched[1]).toBeCloseTo(-0.205 + Math.sin(10 * RAD), 9);
    const yawed = modelToView(viewmodelPose(t, { ...still, yaw: 10 }, 0, 0), [0, 0, 1]);
    expect(yawed[0]).toBeCloseTo(0.175 + Math.sin(10 * RAD), 9);
    const rolled = modelToView(viewmodelPose(t, { ...still, roll: 10 }, 0, 0), [1, 0, 0]);
    expect(rolled[1]).toBeCloseTo(-0.205 + Math.sin(10 * RAD), 9);
    // The kick's offsets: back toward the eye, up and aside; the walk's sway and a run's dip.
    const kicked = viewmodelPose(t, { ...still, back: 0.03, up: 0.01, side: 0.002 }, 0.02, 1);
    expect(kicked.offset[0]).toBeCloseTo(0.175 + 0.002 + 0.02 * t.swayFollow, 12);
    expect(kicked.offset[1]).toBeCloseTo(-0.205 + 0.01 - t.runDipM, 12);
    expect(kicked.offset[2]).toBeCloseTo(0.44 - 0.03, 12);
  });

  it("the simulation's view basis is the camera's", () => {
    for (const [y, p, r] of [[0, 0, 0], [37, -12, 0.5], [200, 60, -3], [-90, 88, 0.85]]) {
      const a = viewBasis(y, p, r);
      const b = cameraBasis(y, p, r);
      for (const k of ['forward', 'right', 'up'] as const) for (let i = 0; i < 3; i++) expect(a[k][i]).toBeCloseTo(b[k][i], 12);
    }
  });

  it("the session's muzzle and port follow the view: turned 90°, they are turned 90°", () => {
    const map = new BrickMap({ x: 64, y: 64, z: 64 });
    map.fillBox(0, 0, 0, 64, 4, 64, P.SOD);
    const s = Session.create({ map, plan: null, spawn: { position: [3.2, 0.4, 3.2] } }, tun, 7, 0);
    for (let k = 0; k < 20; k++) s.tick();
    const p = s.player.position;
    const eye = [p.x, p.y + s.controller.eyeHeight(s.player), p.z];
    const m = rifleModel();
    const out = 0.44 + m.muzzle[2];
    const ahead = s.muzzle();
    expect(ahead[0] - eye[0]).toBeCloseTo(0.175, 9);
    expect(ahead[1] - eye[1]).toBeCloseTo(-0.205, 9);
    expect(ahead[2] - eye[2]).toBeCloseTo(out, 9);
    s.player.yaw = 90;
    s.tick();
    const turned = s.muzzle();
    expect(turned[0] - eye[0]).toBeCloseTo(out, 9);
    expect(turned[2] - eye[2]).toBeCloseTo(-0.175, 9);
    const port = s.port();
    expect(port[0] - eye[0]).toBeCloseTo(0.44 + m.port[2], 9);
    expect(port[2] - eye[2]).toBeCloseTo(-(0.175 + m.port[0]), 9);
  });
});
