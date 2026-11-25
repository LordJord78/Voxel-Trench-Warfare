import { describe, expect, it } from 'vitest';
import { GUN_DEFS, sightOf } from '../../src/combat/arsenal';
import { gunModel, sightMarks } from '../../src/combat/gun-models';
import { ZERO_HANDS } from '../../src/combat/handling';
import { traceRifle } from '../../src/combat/rifle-model';
import { heldPose, modelToView, viewmodelTunables, type Holding, type ViewmodelKick } from '../../src/combat/viewmodel';
import { loadTunables } from '../../src/core/tunables';
import { BARE, GUNS, type Fit, type GunKey } from '../../src/net/gear';

// The sight picture (G4 Task 4). Aimed, the point of aim is the screen's middle: rounds leave from the
// eye along the view. So the sight's aiming point, as the gun's own voxels have it (the front post's
// tip, a dot's window or the scope's reticle centre), must lie on the eye's line of sight; and an iron
// sight's rear notch (or aperture) must frame the post on that same line, so the post is seen, not
// hidden behind the rear sight or anything else of the gun.

const tun = loadTunables();
const t = viewmodelTunables(tun);
const still: ViewmodelKick = { back: 0, up: 0, side: 0, pitch: 0, yaw: 0, roll: 0 };
const DEG = 180 / Math.PI;
/** Within this of the line of sight (degrees): under a pixel at 1600 x 1000 (0.06 degrees is one). */
const ON_AXIS_DEG = 0.05;
/** A ray this far over or under the line of sight (degrees): a pixel or two at 1600 x 1000. */
const NUDGE_DEG = 0.1;

const holdingOf = (gun: GunKey, fit: Fit): Holding => ({ kind: GUN_DEFS[gun].slot === 'secondary' ? 'pistol' : 'rifle', sight: sightOf(gun, fit) });
/** How far a view-space point lies off the view's axis, degrees. */
const offAxis = (p: readonly number[]) => Math.atan2(Math.hypot(p[0], p[1]), p[2]) * DEG;

/** Every gun with every optic its fits allow (the rest bare). */
const SIGHTED: [GunKey, Fit][] = GUNS.flatMap((gun) => GUN_DEFS[gun].fits.optic.map((optic): [GunKey, Fit] => [gun, { ...BARE, optic }]));

/**
 * Aimed at rest (no kick, no hands), the eye in the model's own metres and a ray from it down the line
 * of sight, `deg` degrees over it (under, negative): what of the gun it meets first, and where along
 * the gun (model z), or null.
 */
function lookAlong(gun: GunKey, fit: Fit, deg: number): { t: number; z: number; palette: number } | null {
  const pose = heldPose(t, holdingOf(gun, fit), still, 0, 0, 0, 1, 1, null, ZERO_HANDS);
  // Aimed at rest the pose has no turn: the eye at view (0, 0, 0) is at minus its offset in the model.
  expect([pose.pitch, pose.yaw, pose.roll]).toEqual([0, 0, 0]);
  const eye = [-pose.offset[0], -pose.offset[1], -pose.offset[2]];
  const a = deg / DEG;
  const dir = [0, Math.sin(a), Math.cos(a)];
  const hit = traceRifle(gunModel(gun, fit), eye, dir);
  return hit ? { t: hit.t, z: eye[2] + dir[2] * hit.t, palette: hit.palette } : null;
}

describe('the sight picture', () => {
  for (const [gun, fit] of SIGHTED) {
    it(`${gun} with ${fit.optic}: aimed at rest, the sight's aiming point lies on the eye's line of sight`, () => {
      const marks = sightMarks(gun, fit);
      for (const raised of [0, 1]) {
        const pose = heldPose(t, holdingOf(gun, fit), still, 0, 0, raised, 1, 1, null, ZERO_HANDS);
        const at = modelToView(pose, [0, marks.aim.y, marks.aim.z]);
        expect(at[2], `${gun} ${fit.optic}`).toBeGreaterThan(0.05);
        expect(offAxis(at), `${gun} ${fit.optic}: ${JSON.stringify({ marks, at })}`).toBeLessThan(ON_AXIS_DEG);
      }
      // Seen along the line: a dot's window is open down it, the scope shows its eyepiece; over a post
      // the line meets nothing of the gun, and just under it, the post's tip first.
      if (fit.optic === 'iron') {
        const over = lookAlong(gun, fit, NUDGE_DEG);
        expect(over, `${gun}: over the post, ${JSON.stringify(over)}`).toBeNull();
        const under = lookAlong(gun, fit, -NUDGE_DEG);
        expect(under, `${gun}: under the line`).not.toBeNull();
        expect(Math.abs(under!.z - marks.aim.z), `${gun}: under the line it meets the post (z ${marks.aim.z}), not ${JSON.stringify(under)}`).toBeLessThanOrEqual(0.0225);
      } else if (fit.optic === 'scope') {
        const on = lookAlong(gun, fit, 0);
        expect(on, `${gun}: the scope's eyepiece`).not.toBeNull();
        expect(Math.abs(on!.z - marks.aim.z), `${gun}: down the line, the eyepiece first: ${JSON.stringify(on)}`).toBeLessThanOrEqual(0.0225);
      } else {
        for (const deg of [-NUDGE_DEG, 0, NUDGE_DEG]) expect(lookAlong(gun, fit, deg), `${gun} ${fit.optic}: the window open at ${deg} degrees`).toBeNull();
      }
    });
  }

  for (const gun of GUNS.filter((g) => GUN_DEFS[g].fits.optic.includes('iron'))) {
    it(`${gun}: the iron sights' rear notch and front post line up on the same axis`, () => {
      const fit = { ...BARE, optic: 'iron' as const };
      const marks = sightMarks(gun, fit);
      const pose = heldPose(t, holdingOf(gun, fit), still, 0, 0, 0, 1, 1, null, ZERO_HANDS);
      // Both on the line: the post's tip, and the rear's (a notch's shoulders, an aperture's middle).
      // The shotgun has a bead and no rear sight: its receiver lies under the line (the bead seen over it, above).
      expect(offAxis(modelToView(pose, [0, marks.aim.y, marks.aim.z]))).toBeLessThan(ON_AXIS_DEG);
      if (gun === 'm870') {
        expect(marks.rear).toBeNull();
        return;
      }
      expect(marks.rear, gun).not.toBeNull();
      const rear = marks.rear!;
      expect(rear.z, gun).toBeLessThan(marks.aim.z);
      expect(offAxis(modelToView(pose, [0, rear.y, rear.z])), `${gun}: ${JSON.stringify(marks)}`).toBeLessThan(ON_AXIS_DEG);
      expect(rear.y).toBeCloseTo(marks.aim.y, 9);
    });
  }

  it("each gun's sight height is its model's own: the post's tip, or the optic's window centre", () => {
    for (const [gun, fit] of SIGHTED) expect(sightOf(gun, fit).y, `${gun} ${fit.optic}`).toBeCloseTo(sightMarks(gun, fit).aim.y, 12);
    // What the voxels give: the AK's post tip at 0.0675 m over the bore (its irons, as before), a dot on
    // its rail (0.0525) its window's middle 0.0525 over that.
    expect(sightMarks('ak74', BARE).aim.y).toBeCloseTo(0.0675, 12);
    expect(sightMarks('ak74', { ...BARE, optic: 'reddot' }).aim.y).toBeCloseTo(0.105, 12);
    expect(sightMarks('svd', { ...BARE, optic: 'scope' }).aim.y).toBeCloseTo(0.12, 12);
  });

  it('aimed, a kick moves the gun back toward the eye and rolls it, but its aiming point stays on the line of sight', () => {
    const kicked: ViewmodelKick = { back: 0.044, up: 0.009, side: -0.002, pitch: 2.4, yaw: -0.3, roll: 0.7 };
    for (const [gun, fit] of SIGHTED) {
      const marks = sightMarks(gun, fit);
      const pose = heldPose(t, holdingOf(gun, fit), kicked, 0, 0, 0, 1, 1, null, ZERO_HANDS);
      const at = modelToView(pose, [0, marks.aim.y, marks.aim.z]);
      expect(offAxis(at), `${gun} ${fit.optic}: ${JSON.stringify(at)}`).toBeLessThan(1e-9);
      // Still kicked: back toward the eye, and rolled.
      const rest = heldPose(t, holdingOf(gun, fit), still, 0, 0, 0, 1, 1, null, ZERO_HANDS);
      expect(pose.offset[2]).toBeLessThan(rest.offset[2] - 0.03);
      expect(pose.roll).toBeGreaterThan(0.1);
    }
    // From the hip the kick is as it was: lifted, pitched and turned.
    const hip = heldPose(t, holdingOf('ak74', BARE), kicked, 0, 0, 0, 0, 1, null, ZERO_HANDS);
    expect([hip.pitch, hip.yaw, hip.roll]).toEqual([2.4, -0.3, 0.7]);
  });
});
