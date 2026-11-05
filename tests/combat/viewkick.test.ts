import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recoilProfile } from '../../src/combat/recoil';
import { ViewKick, viewKickProfile, type ViewKickProfile } from '../../src/combat/viewkick';
import { Rng } from '../../src/core/rng';
import { loadTunables } from '../../src/core/tunables';

// Ported from reference/python/tests/test_viewkick.py (its particle tests move to milestone 3's
// effects): the cosmetic layer, everything felt and nothing that moves the round. The shots spec's
// §3 makes it heavier (the punch, and the camera's roll and shake), and none of it moves a round.
const TICK = 1 / 60;
const tun = loadTunables();
const profile = viewKickProfile(tun, 'assault_rifle');
const rng = () => Rng.root(11).derive('viewkick');
/** The camera's own stream: the roll's side and the shake are drawn from it, and from nothing else. */
const camera = (seed = 11) => Rng.root(seed).derive('viewkick.camera');
/** The AK's kick to the aim, the table's (the shots spec's §3). */
const AK_KICK = 0.44;
const STILL = { offset: [0, 0, 0], pitch: 0, yaw: 0 };

describe('view kick', () => {
  it('no cosmetic magnitude is written in code', () => {
    const body = readFileSync('src/combat/viewkick.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '')
      .replace(/'[^']*'|`[^`]*`|"[^"]*"/g, '');
    const suspicious = (body.match(/(?<![\w.])\d+\.\d+/g) ?? []).filter((n) => !['1.0', '0.0', '2.0', '0.2'].includes(n));
    expect(suspicious).toEqual([]);
  });

  it('reads the rifle over the defaults', () => {
    expect(profile).toMatchObject({
      punchBackM: 0.0442, punchPitchDeg: 1.5625, punchRollDeg: 0.55, damping: 0.7, fovPulseDeg: -0.6, settleS: 0.22, aimPitchFollow: 0.9, jitterScale: 0.12,
      camRollDeg: 0.7, camRollSettleS: 0.12, camRollDamping: 1, camShakeM: 0.0015, camShakeDeg: 0.12, camShakeS: 0.06,
    });
  });

  it("every gun's punch is heavier, back × 1.3 and pitch × 1.25, at damping 0.7; its pulse of the field of view is unchanged", () => {
    // The shots spec's §3, from each [viewkick.*]'s numbers before it: back (m), pitch (°), and the FOV's pulse (°).
    const before: Record<string, [number, number, number]> = {
      defaults: [0.03, 1.1, -0.55],
      assault_rifle: [0.034, 1.25, -0.6],
      m4: [0.03, 1.1, -0.55],
      mp5: [0.02, 0.7, -0.3],
      svd: [0.06, 3.2, -1.1],
      m249: [0.032, 1.0, -0.55],
      m870: [0.08, 5.5, -1.4],
      m17: [0.025, 4.0, -0.55],
      pm: [0.025, 4.4, -0.55],
    };
    expect(tun.sections('viewkick')).toEqual(Object.keys(before).sort());
    for (const [table, [back, pitch, fov]] of Object.entries(before)) {
      const p = viewKickProfile(tun, table);
      expect(p.punchBackM, table).toBeCloseTo(back * 1.3, 12);
      expect(p.punchPitchDeg, table).toBeCloseTo(pitch * 1.25, 12);
      expect(p.damping, table).toBe(0.7);
      expect(p.fovPulseDeg, table).toBe(fov);
    }
  });

  it("every gun's camera: its roll (0.7° the AK, M4 and M249, 0.45° the MP5, 1.4° the SVD, 1.8° the M870, 0.9° the pistols) settles over 0.12 s, undamped past level; its shake is 0.0015 m and 0.12° for 0.06 s", () => {
    const roll: Record<string, number> = { assault_rifle: 0.7, m4: 0.7, m249: 0.7, mp5: 0.45, svd: 1.4, m870: 1.8, m17: 0.9, pm: 0.9 };
    for (const [table, deg] of Object.entries(roll)) {
      expect(viewKickProfile(tun, table), table).toMatchObject({ camRollDeg: deg, camRollSettleS: 0.12, camRollDamping: 1, camShakeM: 0.0015, camShakeDeg: 0.12, camShakeS: 0.06 });
    }
  });

  it('the viewmodel is at its peak on the shot tick', () => {
    const k = new ViewKick(profile);
    k.shot(AK_KICK, rng(), camera());
    const atShot = Math.abs(k.back);
    for (let t = 0; t < 120; t++) {
      k.tick(TICK, camera());
      expect(Math.abs(k.back)).toBeLessThanOrEqual(atShot);
    }
  });

  it('the viewmodel overshoots on the way back', () => {
    expect(profile.damping).toBeLessThan(1);
    const k = new ViewKick(profile);
    k.shot(AK_KICK, rng(), camera());
    let dipped = false;
    for (let t = 0; t < 60; t++) {
      k.tick(TICK, camera());
      if (k.back < 0) dipped = true;
    }
    expect(dipped).toBe(true);
  });

  it('both layers settle together', () => {
    expect(Math.abs(profile.settleS - recoilProfile(tun, 'assault_rifle').settleS)).toBeLessThanOrEqual(0.08);
  });

  it('the viewmodel moves further than the sight picture', () => {
    expect(profile.punchPitchDeg).toBeGreaterThan(2 * recoilProfile(tun, 'assault_rifle').kickPitchDeg);
  });

  it('the two layers are driven by one event: a bigger aim kick, more pitch', () => {
    expect(profile.aimPitchFollow).toBeGreaterThan(0);
    const small = new ViewKick(profile);
    const big = new ViewKick(profile);
    small.shot(0.1, rng(), camera());
    big.shot(1.0, rng(), camera());
    expect(big.pitch).toBeGreaterThan(small.pitch);
  });

  it('the FOV pulses in and settles', () => {
    const k = new ViewKick(profile);
    k.shot(AK_KICK, rng(), camera());
    expect(k.fovOffset).toBeCloseTo(-0.6, 12);
    for (let t = 0; t < Math.round(0.3 / TICK); t++) k.tick(TICK, camera());
    expect(Math.abs(k.fovOffset)).toBeLessThan(0.006);
  });
});

describe("the camera's roll and shake", () => {
  it('a shot rolls the camera cam_roll_deg to a side drawn for it, settling back over 0.12 s without swinging past level', () => {
    for (const table of ['assault_rifle', 'mp5', 'svd', 'm870', 'm17']) {
      const p = viewKickProfile(tun, table);
      const k = new ViewKick(p);
      expect(k.camRoll).toBe(0);
      k.shot(AK_KICK, rng(), camera());
      // At its peak on the shot's tick, the gun's whole roll.
      const peak = k.camRoll;
      expect(Math.abs(peak), table).toBe(p.camRollDeg);
      let last = Math.abs(peak);
      for (let t = 1; t <= 60; t++) {
        k.tick(TICK, camera());
        // Back toward level on its spring, never past it (critically damped), and within 2% of its
        // peak from cam_roll_settle_s on (spring.ts's settling time).
        expect(Math.sign(k.camRoll) * Math.sign(peak), `${table} tick ${t}`).toBeGreaterThanOrEqual(0);
        expect(Math.abs(k.camRoll), `${table} tick ${t}`).toBeLessThanOrEqual(last);
        if (t * TICK >= p.camRollSettleS) expect(Math.abs(k.camRoll), `${table} tick ${t}`).toBeLessThan(0.02 * Math.abs(peak));
        last = Math.abs(k.camRoll);
      }
      // Still rolling part-way through (a spring, not a step).
      const half = new ViewKick(p);
      half.shot(AK_KICK, rng(), camera());
      for (let t = 0; t < Math.floor(p.camRollSettleS / 2 / TICK); t++) half.tick(TICK, camera());
      expect(Math.abs(half.camRoll), table).toBeGreaterThan(0.1 * p.camRollDeg);
    }
  });

  it('either side: each shot rolls the camera one way or the other, drawn from the camera stream', () => {
    const k = new ViewKick(profile);
    const cam = camera(5);
    const sides = { left: 0, right: 0 };
    for (let n = 0; n < 200; n++) {
      const was = k.camRoll;
      k.shot(AK_KICK, rng(), cam);
      const step = k.camRoll - was;
      expect(Math.abs(step)).toBeCloseTo(profile.camRollDeg, 12);
      if (step > 0) sides.right++;
      else sides.left++;
      for (let t = 0; t < 30; t++) k.tick(TICK, cam);
    }
    // Two hundred fair draws: each side well over 60 (seven standard deviations under an even split).
    expect(sides.left).toBeGreaterThan(60);
    expect(sides.right).toBeGreaterThan(60);
  });

  it('the shake: the eye moved and turned by a fresh draw each tick for cam_shake_s after a shot, within cam_shake_m and cam_shake_deg, and gone 0.06 s after the last shot', () => {
    const p = profile;
    const k = new ViewKick(p);
    const cam = camera();
    expect(k.shake).toEqual(STILL);
    let widest = { m: 0, deg: 0 };
    for (let n = 0; n < 50; n++) {
      k.shot(AK_KICK, rng(), cam);
      // Shaking from the shot's own tick, for every tick under cam_shake_s since it (four, at 60 Hz).
      const seen: string[] = [];
      for (let t = 0; t < 30; t++) {
        if (t > 0) k.tick(TICK, cam);
        const s = k.shake;
        if (t * TICK < p.camShakeS) {
          for (const v of s.offset) expect(Math.abs(v)).toBeLessThanOrEqual(p.camShakeM);
          for (const v of [s.pitch, s.yaw]) expect(Math.abs(v)).toBeLessThanOrEqual(p.camShakeDeg);
          expect(s, `shot ${n}, tick ${t}`).not.toEqual(STILL);
          seen.push(JSON.stringify(s));
          widest = { m: Math.max(widest.m, ...s.offset.map(Math.abs)), deg: Math.max(widest.deg, Math.abs(s.pitch), Math.abs(s.yaw)) };
        } else {
          expect(s, `shot ${n}, tick ${t}`).toEqual(STILL);
        }
      }
      expect(seen).toHaveLength(Math.ceil(p.camShakeS / TICK));
      // Drawn afresh each tick.
      expect(new Set(seen).size).toBe(seen.length);
    }
    // Two hundred draws of each span most of the range.
    expect(widest.m).toBeGreaterThan(0.9 * p.camShakeM);
    expect(widest.deg).toBeGreaterThan(0.9 * p.camShakeDeg);
  });

  it('a shot during a shake starts it over: it lasts cam_shake_s from the last shot', () => {
    const k = new ViewKick(profile);
    const cam = camera();
    k.shot(AK_KICK, rng(), cam);
    k.tick(TICK, cam);
    k.tick(TICK, cam);
    k.shot(AK_KICK, rng(), cam);
    for (let t = 1; t < 10; t++) {
      k.tick(TICK, cam);
      if (t * TICK < profile.camShakeS) expect(k.shake, `tick ${t}`).not.toEqual(STILL);
      else expect(k.shake, `tick ${t}`).toEqual(STILL);
    }
  });

  it("the camera's draws are its own stream's: the viewmodel's channels draw six a shot as before, whatever the camera does", () => {
    // The camera's roll and shake at their values and at 0, and the camera's stream seeded two ways:
    // the six channels and the pulse are the same to the bit, and the viewmodel's stream is left
    // where six draws a shot leave it.
    const zeroed: ViewKickProfile = { ...profile, camRollDeg: 0, camShakeM: 0, camShakeDeg: 0, camShakeS: 0 };
    const runs = [
      { p: profile, cam: camera(1) },
      { p: profile, cam: camera(2) },
      { p: zeroed, cam: camera(1) },
    ].map(({ p, cam }) => {
      const k = new ViewKick(p);
      const r = rng();
      const trace: number[][] = [];
      const cameraTrace: number[][] = [];
      for (let t = 0; t < 120; t++) {
        if (t % 7 === 0) k.shot(AK_KICK, r, cam);
        else k.tick(TICK, cam);
        trace.push([k.back, k.up, k.side, k.pitch, k.yaw, k.roll, k.fovOffset]);
        cameraTrace.push([k.camRoll, ...k.shake.offset, k.shake.pitch, k.shake.yaw]);
      }
      return { trace, cameraTrace, next: r.float() };
    });
    expect(runs[1].trace).toEqual(runs[0].trace);
    expect(runs[2].trace).toEqual(runs[0].trace);
    expect(runs[1].next).toBe(runs[0].next);
    expect(runs[2].next).toBe(runs[0].next);
    // Six uniform draws a shot (a float each), for the 18 shots.
    const r = rng();
    for (let n = 0; n < 18 * 6; n++) r.float();
    expect(runs[0].next).toBe(r.float());
    // The camera's own draws differ by its stream, and at 0 there is no roll or shake at all.
    expect(runs[1].cameraTrace).not.toEqual(runs[0].cameraTrace);
    for (const c of runs[2].cameraTrace) expect(c.map(Math.abs)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
