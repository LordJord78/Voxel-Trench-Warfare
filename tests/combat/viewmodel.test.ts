import { describe, expect, it } from 'vitest';
import { ZERO_HANDS, type HandsDelta } from '../../src/combat/handling';
import { rifleModel } from '../../src/combat/rifle-model';
import { heldPose, modelToView, RIFLE_HOLDING, viewBasis, viewmodelPose, viewmodelTunables, type Holding, type ViewmodelPose } from '../../src/combat/viewmodel';
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

  it('on the firing step the rifle is raised over the crest, eased up and down', () => {
    // A standing eye is 0.12 m over its crest, and the rest pose holds the bore 0.205 m under the eye.
    const on = (floor: number) => {
      const map = new BrickMap({ x: 64, y: 64, z: 64 });
      map.fillBox(0, 0, 0, 64, 4, 64, floor);
      const s = Session.create({ map, plan: null, spawn: { position: [3.2, 0.4, 3.2] } }, tun, 7, 0);
      return s;
    };
    const height = (s: Session) => s.muzzle()[1] - (s.player.position.y + s.controller.eyeHeight(s.player));
    const ground = on(P.SOD);
    const step = on(P.BENCH);
    for (let k = 0; k < 6; k++) {
      ground.tick();
      step.tick();
    }
    const eased = height(step) - height(ground);
    expect(eased).toBeGreaterThan(0.01);
    expect(eased).toBeLessThan(t.stepRaiseM - 0.01);
    for (let k = 0; k < 60; k++) {
      ground.tick();
      step.tick();
    }
    expect(height(step) - height(ground)).toBeCloseTo(t.stepRaiseM, 3);
    // Over a crest 0.12 m under the eye.
    expect(height(step)).toBeGreaterThan(-0.12);
  });

  // A kick part-way home, a pistol (the M17's irons) and the shovel, for the held poses below.
  const kicked = { back: 0.031, up: 0.007, side: -0.0015, pitch: 1.3, yaw: -0.2, roll: 0.45 };
  const PISTOL: Holding = { kind: 'pistol', sight: { y: 0.0525, z: 0.36 } };
  const SHOVEL: Holding = { kind: 'shovel', sight: { y: 0, z: 0 } };

  it("heldPose with ZERO_HANDS is today's pose exactly", () => {
    // Today's poses, taken from heldPose before the hands were added to it, to the last bit: rifle.spec's
    // and loadout.spec's model traces stand on them. At the hip; raised on the firing step; aimed;
    // kicked, walking, half raised and part aimed; a pistol kicked and mostly aimed; the shovel
    // mid-stroke as it comes up; and a kicked rifle dipped as it is put away.
    const cases: [Parameters<typeof heldPose>, ViewmodelPose][] = [
      [[t, RIFLE_HOLDING, still, 0, 0, 0], { offset: [0.175, -0.205, 0.44], pitch: 0, yaw: 0, roll: 0 }],
      [[t, RIFLE_HOLDING, still, 0, 0, 1], { offset: [0.175, -0.06499999999999997, 0.44], pitch: 0, yaw: 0, roll: 0 }],
      [[t, RIFLE_HOLDING, still, 0, 0, 1, 1], { offset: [0, -0.0675, 0.10000000000000003], pitch: 0, yaw: 0, roll: 0 }],
      [
        [t, RIFLE_HOLDING, kicked, 0.004, 0.6, 0.5, 0.4],
        { offset: [0.11345999999999998, -0.1098912, 0.2915024], pitch: 1.0712, yaw: -0.1648, roll: 0.33912 },
      ],
      [
        [t, PISTOL, kicked, 0, 0, 0, 0.7],
        { offset: [0.02716800000000001, -0.0773952, 0.3425008], pitch: 0.7904000000000001, yaw: -0.12160000000000001, roll: 0.20304000000000003 },
      ],
      [
        [t, SHOVEL, still, -0.003, 0.5, 0, 0, 0.6, 0.4],
        { offset: [0.16906000000000002, -0.2758400000000001, 0.40128], pitch: -41.29600000000003, yaw: -18, roll: 18.800000000000004 },
      ],
      [
        [t, RIFLE_HOLDING, kicked, 0, 0, 0, 0, 0.3],
        { offset: [0.19701999999999997, -0.39399999999999996, 0.3698], pitch: -30.059999999999995, yaw: -0.2, roll: 20.049999999999997 },
      ],
    ];
    for (const [args, today] of cases) {
      const [tt, holding, kick, sway, speedRatio, raised, aimed = 0, ready = 1, stroke = null] = args;
      expect(heldPose(tt, holding, kick, sway, speedRatio, raised, aimed, ready, stroke, ZERO_HANDS)).toEqual(today);
      expect(heldPose(...args)).toEqual(today);
    }
  });

  it("the hands' delta is summed onto the pose after the aim's blend, with the ready dip", () => {
    // Aimed fully, the delta still moves the gun: it is added after the blend to the sight, not blended away.
    const hands: HandsDelta = { offset: [0.011, -0.023, 0.031], pitch: 2.5, yaw: -3.5, roll: 4.5 };
    for (const holding of [RIFLE_HOLDING, PISTOL, SHOVEL]) {
      const stroke = holding.kind === 'shovel' ? 0.3 : null;
      for (const aimed of [0, 0.5, 1]) {
        for (const ready of [1, 0.4]) {
          const bare = heldPose(t, holding, kicked, 0.002, 0.3, 0.5, aimed, ready, stroke);
          const held = heldPose(t, holding, kicked, 0.002, 0.3, 0.5, aimed, ready, stroke, hands);
          for (let k = 0; k < 3; k++) expect(held.offset[k] - bare.offset[k]).toBeCloseTo(hands.offset[k], 12);
          expect(held.pitch - bare.pitch).toBeCloseTo(hands.pitch, 12);
          expect(held.yaw - bare.yaw).toBeCloseTo(hands.yaw, 12);
          expect(held.roll - bare.roll).toBeCloseTo(hands.roll, 12);
        }
      }
    }
  });

  it("the session's muzzle and port follow the view: turned 90°, they are turned 90°", () => {
    const map = new BrickMap({ x: 64, y: 64, z: 64 });
    map.fillBox(0, 0, 0, 64, 4, 64, P.SOD);
    const s = Session.create({ map, plan: null, spawn: { position: [3.2, 0.4, 3.2] } }, tun, 7, 0);
    for (let k = 0; k < 20; k++) s.tick();
    // Settling from the spawn is itself a small landing, which dips the eye and so the muzzle (the
    // camera's landing dip); this test wants none.
    s.player.landingImpact = 0;
    const m = rifleModel();
    const { muzzle, port: portAt } = s.arm.spec;
    // Where the session holds a model point: the held pose at rest (no kick, raise, aim or dip) with
    // the hands' delta, from the eye along the view as the last tick left it, to the last bit.
    const held = (point: readonly number[], hands: HandsDelta) => {
      const p = s.player;
      expect(s.viewAt(1)).toEqual({ yaw: 0, pitch: 0, roll: 0, fov: 0, shake: [0, 0, 0] });
      const { forward, right, up } = viewBasis(p.yaw, p.pitch);
      const v = modelToView(heldPose(t, s.holding(), still, 0, 0, 0, 0, 1, null, hands), point);
      const eye = [p.position.x, p.position.y + s.controller.eyeHeight(p), p.position.z];
      return [0, 1, 2].map((k) => eye[k] + right[k] * v[0] + up[k] * v[1] + forward[k] * v[2]);
    };
    // A still gun breathes: the muzzle is today's pose with the hands' delta, exactly.
    expect(s.handling.delta).not.toEqual(ZERO_HANDS);
    expect(s.muzzle()).toEqual(held(muzzle, s.handling.delta));
    expect(s.port()).toEqual(held(portAt, s.handling.delta));
    // Held still, it is today's pose: 0.175 m right, 0.205 m down, and out along the view.
    const p = s.player.position;
    const eye = [p.x, p.y + s.controller.eyeHeight(s.player), p.z];
    const out = 0.44 + m.muzzle[2];
    s.handsStill = true;
    const ahead = s.muzzle();
    expect(ahead).toEqual(held(muzzle, ZERO_HANDS));
    expect(ahead[0] - eye[0]).toBeCloseTo(0.175, 9);
    expect(ahead[1] - eye[1]).toBeCloseTo(-0.205, 9);
    expect(ahead[2] - eye[2]).toBeCloseTo(out, 9);
    s.handsStill = false;
    // Turned 90° in a tick: the gun trails the turn (to its left), and the muzzle and port are the
    // pose with that delta, turned with the view.
    s.player.yaw = 90;
    s.tick();
    expect(s.handling.delta.offset[0]).toBeLessThan(-0.001);
    expect(s.muzzle()).toEqual(held(muzzle, s.handling.delta));
    expect(s.port()).toEqual(held(portAt, s.handling.delta));
    s.handsStill = true;
    const turned = s.muzzle();
    expect(turned[0] - eye[0]).toBeCloseTo(out, 9);
    expect(turned[2] - eye[2]).toBeCloseTo(-0.175, 9);
    const port = s.port();
    expect(port[0] - eye[0]).toBeCloseTo(0.44 + m.port[2], 9);
    expect(port[2] - eye[2]).toBeCloseTo(-(0.175 + m.port[0]), 9);
  });
});
