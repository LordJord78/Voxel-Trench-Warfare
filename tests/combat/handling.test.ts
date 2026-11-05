import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Handling, ZERO_HANDS, gunClass, handlingTunables, type GunClass, type HandlingCue, type HandlingInput, type HandsDelta } from '../../src/combat/handling';
import { weaponSpec } from '../../src/combat/weapon';
import { TAU } from '../../src/core/dmath';
import { loadTunables } from '../../src/core/tunables';
import { GUNS } from '../../src/net/gear';

// The gun in the hands (the shots spec's §2): the stride's bob, the look's sway, breathing, the
// sprint, a landing, the reloads and the pump, as a pose delta heldPose adds to the held gun.
// Pure: every input is the tick's, and none of it moves a round.
const TICK = 1 / 60;
const tun = loadTunables();
const t = handlingTunables(tun);

/** Still, on the ground, unaimed, long since a shot, at the session's start (breathing at its zero). */
const REST: HandlingInput = {
  dt: TICK, time: 0, yawRate: 0, pitchRate: 0, speedRatio: 0, bobPhase: 0, onGround: true, landingImpact: 0,
  sprinting: false, aimed: 0, reload: null, sinceShot: 10, gun: 'long',
};

type Ticked = ReturnType<Handling['tick']>;

/** `n` ticks of `h`, each at rest but for what `at(k)` says; every tick's result. */
function run(h: Handling, n: number, at: (k: number) => Partial<HandlingInput> = () => ({})): Ticked[] {
  const out: Ticked[] = [];
  for (let k = 0; k < n; k++) out.push(h.tick({ ...REST, ...at(k) }));
  return out;
}

function expectPose(got: HandsDelta, want: HandsDelta, digits = 12): void {
  for (let k = 0; k < 3; k++) expect(got.offset[k], `offset[${k}]`).toBeCloseTo(want.offset[k], digits);
  expect(got.pitch, 'pitch').toBeCloseTo(want.pitch, digits);
  expect(got.yaw, 'yaw').toBeCloseTo(want.yaw, digits);
  expect(got.roll, 'roll').toBeCloseTo(want.roll, digits);
}

/** A reload of `seconds` run tick by tick to its end, with the cues heard and the phase each was heard at. */
function reloadCues(gun: GunClass, seconds: number, shells = 0): { cue: HandlingCue; phase: number }[] {
  const n = Math.round(seconds / TICK);
  const h = new Handling(t);
  const ticks = run(h, n + 1, (k) => ({ gun, reload: { phase: k / n, shells } }));
  // And after it, nothing more.
  expect(run(h, 30, () => ({ gun })).flatMap((r) => r.cues)).toEqual([]);
  return ticks.flatMap((r, k) => r.cues.map((cue) => ({ cue, phase: k / n })));
}

/** Heard at the first tick at or past its mark (to rounding): the last phase under it, this one at or over it. */
function heardAt(heard: { cue: HandlingCue; phase: number }[], cue: HandlingCue, mark: number, step: number, nth = 0, of = 1): void {
  const at = heard.filter((c) => c.cue === cue);
  expect(at, cue).toHaveLength(of);
  expect(at[nth].phase, cue).toBeGreaterThanOrEqual(mark - 1e-9);
  expect(at[nth].phase - step, cue).toBeLessThan(mark + 1e-9);
}

describe('handling', () => {
  it("reads [handling] as the spec's §2 has it", () => {
    expect(t).toMatchObject({
      bobUpM: 0.008, bobSideM: 0.006, bobRollDeg: 0.8, bobAimed: 0.15, bobSprint: 1.8,
      swayMPerDps: 0.00012, swayRollDegPerDps: 0.004, swayMaxM: 0.025, swayMaxDeg: 4, swaySettleS: 0.18, swayDamping: 0.7, swayAimed: 0.25,
      breathUpM: 0.0025, breathUpHz: 0.22, breathSideM: 0.0015, breathSideHz: 0.11, breathAimed: 0.35,
      sprintOffsetM: [0.06, -0.06, -0.04], sprintPitchDeg: -18, sprintYawDeg: 32, sprintRollDeg: 18, sprintInS: 0.18, sprintOutS: 0.12, sprintBlocksFire: 0.3,
      landingDropM: 0.03, landingPitchDeg: -4, landingHardMps: 8, landingSettleS: 0.25,
      reloadTiltAt: 0.12, reloadTiltM: [-0.02, -0.04, -0.03], reloadTiltPitchDeg: 8, reloadTiltRollDeg: 28,
      reloadMagOutAt: 0.28, reloadMagOutDropM: 0.015, reloadHoldAt: 0.55,
      reloadMagInAt: 0.62, reloadMagInRiseM: 0.02, reloadMagInPitchDeg: 3,
      reloadBoltAt: 0.82, reloadBoltBackM: 0.02, reloadBoltRollDeg: 34, reloadCutS: 0.15,
      mgDepth: 1.3, mgCoverAt: 0.45,
      pistolTiltRollDeg: 18, pistolMagOutAt: 0.3, pistolMagInAt: 0.62, pistolSlideAt: 0.86,
      shellPushM: [0, 0.02, 0], shellPitchDeg: 6, shellBaseS: 0.5, shellEachS: 0.5,
      pumpAfterS: 0.12, pumpBackM: 0.035, pumpStrokeS: 0.12,
      dryReloadS: 0.25,
      // The shots spec's §3: an aim-in overshoots.
      aimOvershootDeg: 0.4, aimOvershootRiseS: 0.05, aimOvershootS: 0.15,
    });
  });

  it('no magnitude is written in code', () => {
    const body = readFileSync('src/combat/handling.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '')
      .replace(/'[^']*'|`[^`]*`|"[^"]*"/g, '');
    expect(body.match(/(?<![\w.])\d+\.\d+/g) ?? []).toEqual([]);
  });

  it("at rest, still and unaimed, at breathing's zero (time 0), the delta is zero", () => {
    // At the session's start: breathing, the one thing that moves a gun at rest, is at its zero.
    for (const gun of ['long', 'mg', 'pistol', 'pump'] as const) {
      const h = new Handling(t);
      expect(h.at(1)).toEqual(ZERO_HANDS);
      for (const r of run(h, 120, () => ({ gun }))) expect(r).toEqual({ delta: ZERO_HANDS, sprint: 0, cues: [] });
      expect(h.at(0)).toEqual(ZERO_HANDS);
      expect(h.at(0.5)).toEqual(ZERO_HANDS);
      expect(h.delta).toEqual(ZERO_HANDS);
      expect(h.sprint).toBe(0);
    }
  });

  it('walking bobs 0.008 m up and down at the stride, 0.006 m across at half its rate; aimed a sixth of it', () => {
    // Two strides at a run's share of 1, the stride's phase wrapping at a turn as the body's does
    // (physics/character.ts), so the swing across must know which of two strides it is in.
    const strides = (over: Partial<HandlingInput> = {}) =>
      run(new Handling(t), 120, (k) => ({ speedRatio: 1, bobPhase: ((k * TAU) / 60) % TAU, ...over })).map((r) => r.delta);
    const walk = strides();
    const ys = walk.map((d) => d.offset[1]);
    const xs = walk.map((d) => d.offset[0]);
    expect(Math.max(...ys)).toBeCloseTo(0.008, 12);
    expect(Math.min(...ys)).toBeCloseTo(-0.008, 12);
    expect(Math.max(...xs)).toBeCloseTo(0.006, 12);
    expect(Math.min(...xs)).toBeCloseTo(-0.006, 12);
    expect(Math.max(...walk.map((d) => d.roll))).toBeCloseTo(0.8, 12);
    // Up at a quarter stride; across at the end of the first, and the other way at the end of the second.
    expect(walk[15].offset[1]).toBeCloseTo(0.008, 12);
    expect(walk[30].offset[0]).toBeCloseTo(0.006, 12);
    expect(walk[90].offset[0]).toBeCloseTo(-0.006, 12);
    // A figure eight: the second stride rises as the first did and swings (and rolls) the other way.
    for (let k = 0; k < 60; k++) {
      expect(ys[k + 60]).toBeCloseTo(ys[k], 12);
      expect(xs[k + 60]).toBeCloseTo(-xs[k], 12);
      expect(walk[k + 60].roll).toBeCloseTo(-walk[k].roll, 12);
      // It rolls as it swings: its right side up as it swings right, as a gun hung from the hands.
      expect(walk[k].roll * xs[k]).toBeGreaterThanOrEqual(0);
    }
    for (const d of walk) {
      expect(d.offset[2]).toBe(0);
      expect(d.pitch).toBe(0);
      expect(d.yaw).toBe(0);
    }
    // × the run's share: at half of it, half the bob.
    const half = strides({ speedRatio: 0.5 });
    // Aimed, 0.15 of it; at a sprint (once the pose is in, 0.18 s), 1.8 times it, on top of the pose.
    const aimed = strides({ aimed: 1 });
    const sprint = strides({ sprinting: true });
    for (let k = 0; k < 120; k++) {
      for (let a = 0; a < 3; a++) {
        expect(half[k].offset[a]).toBeCloseTo(walk[k].offset[a] / 2, 12);
        expect(aimed[k].offset[a]).toBeCloseTo(walk[k].offset[a] * t.bobAimed, 12);
        if (k >= 11) expect(sprint[k].offset[a] - t.sprintOffsetM[a]).toBeCloseTo(walk[k].offset[a] * t.bobSprint, 12);
      }
      expect(aimed[k].roll).toBeCloseTo(walk[k].roll * t.bobAimed, 12);
      if (k >= 11) expect(sprint[k].roll - t.sprintRollDeg).toBeCloseTo(walk[k].roll * t.bobSprint, 12);
    }
  });

  it('turning at 100°/s sways the gun 0.012 m against the turn, held to 0.025 m, and it settles within 0.18 s of stopping', () => {
    const h = new Handling(t);
    const turning = run(h, 60, () => ({ yawRate: 100 }));
    // Turned right, it trails left and banks into the turn (its right side down), as a gun hung from the hands.
    expect(turning[59].delta.offset[0]).toBeCloseTo(-0.012, 9);
    expect(turning[59].delta.roll).toBeCloseTo(-0.4, 9);
    expect(turning[59].delta.offset[1]).toBe(0);
    // It trails into it on its spring, not at once.
    expect(Math.abs(turning[0].delta.offset[0])).toBeLessThan(0.012 / 2);
    // Stopped: still on its way back at 0.06 s, and within 3% of where it was from 0.18 s on (the
    // spring is under-damped, at 0.7: it swings 5% past rest and is back inside 3% by then).
    const after = run(h, 60);
    expect(Math.abs(after[Math.ceil(0.06 / TICK) - 1].delta.offset[0])).toBeGreaterThan(0.012 * 0.15);
    for (let k = Math.ceil(0.18 / TICK) - 1; k < 60; k++) {
      expect(Math.abs(after[k].delta.offset[0])).toBeLessThan(0.012 * 0.03);
      expect(Math.abs(after[k].delta.roll)).toBeLessThan(0.4 * 0.03);
    }
    // Looking up, it trails down.
    const up = run(new Handling(t), 60, () => ({ pitchRate: 100 }));
    expect(up[59].delta.offset[1]).toBeCloseTo(-0.012, 9);
    expect(up[59].delta.offset[0]).toBe(0);
    expect(up[59].delta.roll).toBe(0);
    // Held to 0.025 m and 4°, however fast the turn, even as its spring overshoots.
    const whip = run(new Handling(t), 60, () => ({ yawRate: -2000, pitchRate: 2000 }));
    for (const r of whip) {
      expect(Math.abs(r.delta.offset[0])).toBeLessThanOrEqual(0.025);
      expect(Math.abs(r.delta.offset[1])).toBeLessThanOrEqual(0.025);
      expect(Math.abs(r.delta.roll)).toBeLessThanOrEqual(4);
    }
    expect(whip[59].delta.offset[0]).toBeCloseTo(0.025, 9);
    expect(whip[59].delta.offset[1]).toBeCloseTo(-0.025, 9);
    expect(whip[59].delta.roll).toBeCloseTo(4, 9);
    // Aimed, a quarter of it.
    const aimed = run(new Handling(t), 60, () => ({ yawRate: 100, aimed: 1 }));
    expect(aimed[59].delta.offset[0]).toBeCloseTo(-0.012 * t.swayAimed, 9);
    expect(aimed[59].delta.roll).toBeCloseTo(-0.4 * t.swayAimed, 9);
  });

  it('breathing moves the gun 0.0025 m at 0.22 Hz when still; none at a run', () => {
    const breath = (time: number, over: Partial<HandlingInput> = {}) => new Handling(t).tick({ ...REST, time, ...over }).delta;
    const quarter = 1 / (4 * t.breathUpHz);
    expect(breath(quarter).offset[1]).toBeCloseTo(0.0025, 12);
    expect(breath(2 * quarter).offset[1]).toBeCloseTo(0, 12);
    expect(breath(3 * quarter).offset[1]).toBeCloseTo(-0.0025, 12);
    expect(breath(quarter + 1 / t.breathUpHz).offset[1]).toBeCloseTo(0.0025, 12);
    // Aside 0.0015 m, at half the rate.
    expect(breath(1 / (4 * t.breathSideHz)).offset[0]).toBeCloseTo(0.0015, 12);
    expect(breath(3 / (4 * t.breathSideHz)).offset[0]).toBeCloseTo(-0.0015, 12);
    // Over a minute still, only up and aside, and never further.
    const still = run(new Handling(t), 3600, (k) => ({ time: k * TICK }));
    for (const r of still) {
      expect(Math.abs(r.delta.offset[1])).toBeLessThanOrEqual(0.0025);
      expect(Math.abs(r.delta.offset[0])).toBeLessThanOrEqual(0.0015);
      expect([r.delta.offset[2], r.delta.pitch, r.delta.yaw, r.delta.roll]).toEqual([0, 0, 0, 0]);
    }
    for (const time of [0.3, quarter, 1.7, 2.9, 41.3]) {
      // None at a run (the stride at its zero, so no bob either).
      expect(breath(time, { speedRatio: 1 })).toEqual(ZERO_HANDS);
      // Aimed, 0.35 of it.
      const aimed = breath(time, { aimed: 1 });
      const plain = breath(time);
      expect(aimed.offset[0]).toBeCloseTo(plain.offset[0] * t.breathAimed, 15);
      expect(aimed.offset[1]).toBeCloseTo(plain.offset[1] * t.breathAimed, 15);
    }
  });

  it('the sprint pose comes in over 0.18 s and leaves over 0.12 s', () => {
    const pose: HandsDelta = { offset: t.sprintOffsetM, pitch: t.sprintPitchDeg, yaw: t.sprintYawDeg, roll: t.sprintRollDeg };
    expect(pose).toEqual({ offset: [0.06, -0.06, -0.04], pitch: -18, yaw: 32, roll: 18 });
    // At a run (no breathing), the stride at its zero (no bob): the pose alone. Tick k is (k + 1) ticks in.
    const h = new Handling(t);
    const going = run(h, 30, () => ({ sprinting: true, speedRatio: 1 }));
    const inAt = going.findIndex((r) => r.sprint === 1);
    expect(inAt * TICK).toBeLessThan(0.18);
    expect((inAt + 1) * TICK).toBeGreaterThanOrEqual(0.18 - 1e-12);
    // In at a steady rate, eased into the pose.
    for (let k = 0; k < inAt; k++) {
      expect(going[k].sprint).toBeCloseTo(((k + 1) * TICK) / 0.18, 12);
      expect(Math.abs(going[k].delta.yaw)).toBeLessThan(32);
      if (k > 0) expect(going[k].delta.yaw).toBeGreaterThan(going[k - 1].delta.yaw);
    }
    expect(going[29].delta).toEqual(pose);
    expect(h.sprint).toBe(1);
    // Let go: out over 0.12 s, and under the blend that stops a shot well within the 0.12 s the
    // session promises a shot out of a full sprint.
    const leaving = run(h, 20, () => ({ speedRatio: 1 }));
    const outAt = leaving.findIndex((r) => r.sprint === 0);
    expect(outAt * TICK).toBeLessThan(0.12);
    expect((outAt + 1) * TICK).toBeGreaterThanOrEqual(0.12 - 1e-12);
    for (let k = 0; k < outAt; k++) expect(leaving[k].sprint).toBeCloseTo(1 - ((k + 1) * TICK) / 0.12, 12);
    expect(leaving[outAt].delta).toEqual(ZERO_HANDS);
    expect((leaving.findIndex((r) => r.sprint < t.sprintBlocksFire) + 1) * TICK).toBeLessThanOrEqual(0.12);
  });

  it('a hard landing dips the gun 0.03 m and it is back within 0.25 s', () => {
    const h = new Handling(t);
    // In the air, nothing; landed at 9 m/s (over the 8 that dips it fully): the dip on the landing's tick.
    for (const r of run(h, 10, () => ({ onGround: false }))) expect(r.delta).toEqual(ZERO_HANDS);
    const landed = run(h, 30, () => ({ landingImpact: 9 }));
    expect(landed[0].delta.offset[1]).toBeCloseTo(-0.03, 12);
    expect(landed[0].delta.pitch).toBeCloseTo(-4, 12);
    // Settling: well down still at 0.1 s; back to within 2.5% of the dip from 0.25 s on; never past rest.
    expect(landed[Math.round(0.1 / TICK)].delta.offset[1]).toBeLessThan(-0.03 * 0.25);
    for (let k = Math.round(0.25 / TICK); k < 30; k++) {
      expect(Math.abs(landed[k].delta.offset[1])).toBeLessThan(0.03 * 0.025);
      expect(Math.abs(landed[k].delta.pitch)).toBeLessThan(4 * 0.025);
    }
    for (const r of landed) {
      expect(r.delta.offset[1]).toBeLessThanOrEqual(0);
      expect(r.delta.pitch).toBeLessThanOrEqual(0);
    }
    // A softer one dips its share: 2 m/s of the 8, a quarter.
    const soft = new Handling(t);
    run(soft, 5, () => ({ onGround: false }));
    expect(soft.tick({ ...REST, landingImpact: 2 }).delta.offset[1]).toBeCloseTo((-0.03 * 2) / 8, 12);
    // Standing, an impact the body still carries is no landing.
    for (const r of run(new Handling(t), 10, () => ({ landingImpact: 9 }))) expect(r.delta).toEqual(ZERO_HANDS);
  });

  it('an aim-in overshoots: the muzzle carried 0.4° past the aim as the sights arrive, from nothing and never a step, and back by 0.15 s', () => {
    // The shots spec's §3, carried through rather than popped: the sights arrive with no speed (the
    // aim's blend is smoothed), so the overshoot rises from nothing. Held at breathing's zero (time 0),
    // nothing else moves the gun: none of it while the sights come up (over 0.2 s); from the tick they
    // arrive (the aim's blend reaching 1), the gun's pitch alone, muzzle up.
    const up = Math.round(0.2 / TICK);
    const coming = run(new Handling(t), 40, (k) => ({ aimed: Math.min(1, (k + 1) / up) })).map((r) => r.delta);
    const arrived = up - 1;
    for (let k = 0; k < arrived; k++) expect(coming[k], `tick ${k}`).toEqual(ZERO_HANDS);
    for (let k = arrived; k < 40; k++) expect([...coming[k].offset, coming[k].yaw, coming[k].roll], `tick ${k}`).toEqual([0, 0, 0, 0, 0]);
    const pitch = coming.map((d) => d.pitch);
    // Not one tick moves it more than 0.15°, the sights' own arrival included.
    for (let k = 1; k < 40; k++) expect(Math.abs(pitch[k] - pitch[k - 1]), `tick ${k}`).toBeLessThanOrEqual(0.15);
    // Moving from the arrival's own tick, up every tick to its peak of 0.4° ± 0.02 within about
    // 0.04 s (0.4° at no more than 0.15° a tick takes three ticks: 0.05 s), then down every tick,
    // never past the aim.
    const peak = Math.max(...pitch);
    const top = pitch.indexOf(peak);
    expect(Math.abs(peak - 0.4)).toBeLessThanOrEqual(0.02);
    expect(pitch[arrived]).toBeGreaterThan(0);
    expect(top - arrived + 1).toBeLessThanOrEqual(3);
    for (let k = arrived + 1; k <= top; k++) expect(pitch[k], `tick ${k}`).toBeGreaterThan(pitch[k - 1]);
    for (let k = top + 1; pitch[k - 1] > 0; k++) {
      expect(pitch[k], `tick ${k}`).toBeLessThan(pitch[k - 1]);
      expect(pitch[k], `tick ${k}`).toBeGreaterThanOrEqual(0);
    }
    // Within 0.02° 0.15 s after the last tick the sights were short of the eye, and none at all
    // 0.15 s after the tick they arrived: the hands at rest again, exactly.
    for (let k = arrived; k < 40; k++) {
      if ((k - arrived + 1) * TICK >= t.aimOvershootS - 1e-9) expect(Math.abs(pitch[k]), `tick ${k}`).toBeLessThanOrEqual(0.02);
      if ((k - arrived) * TICK >= t.aimOvershootS) expect(coming[k], `tick ${k}`).toEqual(ZERO_HANDS);
    }
    // Only an arrival: the sights brought most of the way up (to 0.9) and down again move nothing.
    for (const r of run(new Handling(t), 61, (k) => ({ aimed: Math.max(0, 0.9 - Math.abs(k - 30) * 0.03) }))) expect(r.delta).toEqual(ZERO_HANDS);
    // Up (arriving on the first tick), held, down and up again: once each time they arrive, the same
    // each time, and not as they leave.
    const once = pitch.slice(arrived, arrived + 10);
    expect(once[once.length - 1]).toBe(0);
    const script = (k: number) => (k < 30 ? 1 : k < 42 ? 1 - (k - 29) / 12 : Math.min(1, (k - 41) / 12));
    const pitches = run(new Handling(t), 80, (k) => ({ aimed: script(k) })).map((r) => r.delta.pitch);
    expect(pitches.slice(0, once.length)).toEqual(once);
    expect(pitches.slice(53, 53 + once.length)).toEqual(once);
    pitches.forEach((p, k) => {
      if (k >= once.length && (k < 53 || k >= 53 + once.length)) expect(p, `tick ${k}`).toBe(0);
    });
  });

  it('an arrival while the overshoot is still drawn carries on from where it is: up to its peak again, never a step', () => {
    // The sights arrive, drop off the eye for a tick past the peak (to 0.95) and arrive again: the
    // muzzle rises once more from where it was to 0.4°, and settles from there as one arrival's does.
    const first = run(new Handling(t), 30, () => ({ aimed: 1 })).map((r) => r.delta.pitch);
    const again = run(new Handling(t), 30, (k) => ({ aimed: k === 3 ? 0.95 : 1 })).map((r) => r.delta.pitch);
    expect(again.slice(0, 4)).toEqual(first.slice(0, 4));
    expect(again[3]).toBeLessThan(first[2]);
    for (let k = 1; k < 30; k++) expect(Math.abs(again[k] - again[k - 1]), `tick ${k}`).toBeLessThanOrEqual(0.15);
    for (let k = 4; again[k] < 0.4 - 1e-12; k++) expect(again[k], `tick ${k}`).toBeGreaterThan(again[k - 1]);
    expect(Math.max(...again.slice(4))).toBeCloseTo(0.4, 12);
    // And from its second peak, the first's settling, tick for tick.
    const tail = again.slice(again.indexOf(Math.max(...again.slice(4)), 4));
    expect(tail.length).toBeGreaterThan(10);
    expect(tail).toEqual(first.slice(first.indexOf(Math.max(...first))).slice(0, tail.length));
  });

  it("a long gun's reload passes mag-out at 0.28, mag-in at 0.62 and bolt at 0.82, each once", () => {
    // The AK's 2.4 s reload, tick by tick.
    const heard = reloadCues('long', 2.4);
    expect(heard.map((c) => c.cue)).toEqual(['mag-out', 'mag-in', 'bolt']);
    const step = TICK / 2.4;
    heardAt(heard, 'mag-out', 0.28, step);
    heardAt(heard, 'mag-in', 0.62, step);
    heardAt(heard, 'bolt', 0.82, step);
    // Its keys: tilted at 0.12; the magazine out, a jolt down; held tilted; the magazine in, a jolt
    // up and the muzzle up; the bolt, back and turned further; at rest at the end.
    const h = new Handling(t);
    const at = (phase: number) => h.tick({ ...REST, reload: { phase, shells: 0 } }).delta;
    const tilt = { offset: [-0.02, -0.04, -0.03], pitch: 8, yaw: 0, roll: 28 } as HandsDelta;
    expectPose(at(0.12), tilt);
    expectPose(at(0.28), { ...tilt, offset: [-0.02, -0.055, -0.03] });
    expectPose(at(0.55), tilt);
    expectPose(at(0.62), { ...tilt, offset: [-0.02, -0.02, -0.03], pitch: 11 });
    expectPose(at(0.82), { ...tilt, offset: [-0.02, -0.04, -0.05], roll: 34 });
    expectPose(at(1), ZERO_HANDS);
    // Eased between keys: half-way from rest to the tilt, half the tilt.
    expectPose(new Handling(t).tick({ ...REST, reload: { phase: 0.06, shells: 0 } }).delta, { offset: [-0.01, -0.02, -0.015], pitch: 4, yaw: 0, roll: 14 });
  });

  it("the M249's adds cover at 0.45; a pistol's slide at 0.86", () => {
    // The M249's 5.8 s: the long gun's curve with the feed cover's clap, 1.3 times as deep.
    const mg = reloadCues('mg', 5.8);
    expect(mg.map((c) => c.cue)).toEqual(['mag-out', 'cover', 'mag-in', 'bolt']);
    heardAt(mg, 'cover', 0.45, TICK / 5.8);
    heardAt(mg, 'mag-out', 0.28, TICK / 5.8);
    heardAt(mg, 'bolt', 0.82, TICK / 5.8);
    const tiltOf = (gun: GunClass) => new Handling(t).tick({ ...REST, gun, reload: { phase: 0.12, shells: 0 } }).delta;
    expectPose(tiltOf('mg'), { offset: [-0.026, -0.052, -0.039], pitch: 10.4, yaw: 0, roll: 36.4 });
    // The M17's 1.6 s: tilted 18°, its magazine out at 0.3 and in at 0.62, the slide released at 0.86.
    const pistol = reloadCues('pistol', 1.6);
    expect(pistol.map((c) => c.cue)).toEqual(['mag-out', 'mag-in', 'bolt']);
    const step = TICK / 1.6;
    heardAt(pistol, 'mag-out', 0.3, step);
    heardAt(pistol, 'mag-in', 0.62, step);
    heardAt(pistol, 'bolt', 0.86, step);
    expectPose(tiltOf('pistol'), { offset: [-0.02, -0.04, -0.03], pitch: 8, yaw: 0, roll: 18 });
    // Each gun's class: the rifle, carbine, SMG and marksman are long guns.
    expect(Object.fromEntries(GUNS.map((g) => [g, gunClass(g)]))).toEqual({
      ak74: 'long', m4: 'long', mp5: 'long', svd: 'long', m249: 'mg', m870: 'pump', m17: 'pistol', pm: 'pistol',
    });
  });

  it('the shotgun pushes a shell per shell to load, evenly over its reload', () => {
    // Four shells: 0.5 s, then 0.5 s a shell, 2.5 s in all; each pushed in at the middle of its 0.5 s.
    const total = t.shellBaseS + 4 * t.shellEachS;
    const heard = reloadCues('pump', total, 4);
    expect(heard.map((c) => c.cue)).toEqual(['shell', 'shell', 'shell', 'shell']);
    [0.3, 0.5, 0.7, 0.9].forEach((mark, j) => heardAt(heard, 'shell', mark, TICK / total, j, 4));
    // Nothing through the base; each push 0.02 m and +6° at its height, at rest between.
    const h = new Handling(t);
    const at = (phase: number) => h.tick({ ...REST, gun: 'pump', reload: { phase, shells: 4 } }).delta;
    const push: HandsDelta = { offset: t.shellPushM, pitch: t.shellPitchDeg, yaw: 0, roll: 0 };
    expect(Math.hypot(...push.offset)).toBeCloseTo(0.02, 15);
    for (const phase of [0, 0.1, 0.2]) expectPose(at(phase), ZERO_HANDS);
    for (const phase of [0.3, 0.5, 0.7, 0.9]) {
      expectPose(at(phase - 0.1 + 1e-9), ZERO_HANDS, 6);
      expectPose(at(phase), push);
    }
    expectPose(at(1), ZERO_HANDS);
    // One shell: 1.0 s, pushed at 0.75 of it.
    const one = reloadCues('pump', t.shellBaseS + t.shellEachS, 1);
    expect(one.map((c) => c.cue)).toEqual(['shell']);
    heardAt(one, 'shell', 0.75, TICK / (t.shellBaseS + t.shellEachS));
  });

  it("a full tube's pushes take the shotgun's whole reload: reload_time_s is 0.5 + 0.5 × 7 = 4.0 s", () => {
    // The pushes are laid out by [weapon.m870]'s reload_base_s and reload_per_round_s. Its
    // reload_time_s (reloadS, the full figure: a reload's length until it goes shell by shell, and
    // the loadout's handling stat) is a whole tube's by the same two, as the G4 ledger rules, so
    // the hands and the weapon agree on a full reload.
    const m870 = weaponSpec(tun, 'm870');
    expect(m870.magazine).toBe(7);
    expect(t.shellBaseS + m870.magazine * t.shellEachS).toBe(4);
    expect(m870.reloadS).toBe(t.shellBaseS + m870.magazine * t.shellEachS);
  });

  it('the pump runs from 0.12 s after a shot and is home by 0.36 s', () => {
    const h = new Handling(t);
    // Long since a shot (the weapon holds its clock at its interval, 0.8 s), then a shot and its clock.
    run(h, 3, () => ({ gun: 'pump', sinceShot: 0.8 }));
    const after = run(h, 40, (k) => ({ gun: 'pump', sinceShot: k * TICK }));
    after.forEach((r, k) => {
      const s = k * TICK;
      if (s < 0.12 || s >= 0.36) expect(r.delta, `${s}`).toEqual(ZERO_HANDS);
      else {
        expect(r.delta.offset[2], `${s}`).toBeLessThan(0);
        expect(r.delta.offset[2], `${s}`).toBeGreaterThanOrEqual(-0.035);
        expect([r.delta.offset[0], r.delta.offset[1], r.delta.pitch, r.delta.yaw, r.delta.roll]).toEqual([0, 0, 0, 0, 0]);
      }
    });
    // Its chk-chk heard once, as it starts back.
    const pumped = after.flatMap((r, k) => r.cues.map((cue) => ({ cue, s: k * TICK })));
    expect(pumped.map((c) => c.cue)).toEqual(['pump']);
    expect(pumped[0].s).toBeGreaterThanOrEqual(0.12);
    expect(pumped[0].s - TICK).toBeLessThan(0.12);
    // Back 0.035 m at 0.24 s, half-way back at 0.18 s and half-way home at 0.30 s.
    const at = (sinceShot: number) => new Handling(t).tick({ ...REST, gun: 'pump', sinceShot }).delta.offset[2];
    expect(at(0.24)).toBeCloseTo(-0.035, 12);
    expect(at(0.18)).toBeCloseTo(-0.035 / 2, 12);
    expect(at(0.3)).toBeCloseTo(-0.035 / 2, 12);
    expect(at(0.36)).toBeCloseTo(0, 12);
    // No other gun pumps.
    for (const gun of ['long', 'mg', 'pistol'] as const) {
      for (const r of run(new Handling(t), 40, (k) => ({ gun, sinceShot: k * TICK }))) expect(r).toEqual({ delta: ZERO_HANDS, sprint: 0, cues: [] });
    }
  });

  it("the shotgun's marks are heard on the tick they land on, as are a long gun's: the last phase under, this one at", () => {
    // Four shells, 2.5 s, 150 ticks: the marks 0.3, 0.5, 0.7 and 0.9 fall on ticks 45, 75, 105 and 135.
    const shells = reloadCues('pump', t.shellBaseS + 4 * t.shellEachS, 4);
    expect(shells.map((c) => c.cue)).toEqual(['shell', 'shell', 'shell', 'shell']);
    [0.3, 0.5, 0.7, 0.9].forEach((mark, j) => expect(shells[j].phase).toBe(mark));
    // A long gun's 2.5 s, likewise: 0.28, 0.62 and 0.82 fall on ticks 42, 93 and 123.
    const long = reloadCues('long', 2.5);
    expect(long).toEqual([
      { cue: 'mag-out', phase: 0.28 },
      { cue: 'mag-in', phase: 0.62 },
      { cue: 'bolt', phase: 0.82 },
    ]);
  });

  it('uneven steps hear each mark once and in order, all of them in one tick if it crosses them all', () => {
    const cues = (gun: GunClass, phases: number[], shells = 0) => {
      const h = new Handling(t);
      const heard = run(h, phases.length, (k) => ({ gun, reload: { phase: phases[k], shells } })).flatMap((r) => r.cues);
      expect(run(h, 20, () => ({ gun })).flatMap((r) => r.cues)).toEqual([]);
      return heard;
    };
    expect(cues('long', [0, 0.05, 0.13, 0.279, 0.2801, 0.6, 0.6, 0.83, 0.99])).toEqual(['mag-out', 'mag-in', 'bolt']);
    expect(cues('long', [0, 0.999])).toEqual(['mag-out', 'mag-in', 'bolt']);
    expect(cues('mg', [0, 0.3, 1])).toEqual(['mag-out', 'cover', 'mag-in', 'bolt']);
    expect(cues('mg', [0, 1])).toEqual(['mag-out', 'cover', 'mag-in', 'bolt']);
    expect(cues('pistol', [0.1, 0.95])).toEqual(['mag-out', 'mag-in', 'bolt']);
    expect(cues('pump', [0, 0.31, 0.32, 0.99], 4)).toEqual(['shell', 'shell', 'shell', 'shell']);
    expect(cues('pump', [0, 0.01, 1], 7)).toEqual(Array(7).fill('shell'));
  });

  it('a phase past either end (−0.2, 1.3) is at rest, finite, and hears no mark more', () => {
    const marks: Record<GunClass, number> = { long: 3, mg: 4, pistol: 3, pump: 3 };
    for (const gun of ['long', 'mg', 'pistol', 'pump'] as const) {
      const phases = [-0.2, 0, 0.5, 1, 1.3];
      const got = run(new Handling(t), phases.length, (k) => ({ gun, reload: { phase: phases[k], shells: 3 } }));
      for (const r of got) for (const v of [...r.delta.offset, r.delta.pitch, r.delta.yaw, r.delta.roll]) expect(Number.isFinite(v), gun).toBe(true);
      expectPose(got[0].delta, ZERO_HANDS);
      expectPose(got[4].delta, ZERO_HANDS);
      expect(got[0].cues).toEqual([]);
      expect(got[4].cues).toEqual([]);
      expect(got.flatMap((r) => r.cues), gun).toHaveLength(marks[gun]);
      // Begun at either end on its own: at rest, and nothing heard before 0.
      for (const phase of [-0.2, 1.3]) {
        const one = new Handling(t).tick({ ...REST, gun, reload: { phase, shells: 3 } });
        for (const v of [...one.delta.offset, one.delta.pitch, one.delta.yaw, one.delta.roll]) expect(Number.isFinite(v)).toBe(true);
        expectPose(one.delta, ZERO_HANDS);
        if (phase < 0) expect(one.cues).toEqual([]);
      }
    }
  });

  it("the shotgun's shells are counted as its reload begins: a count changed mid-reload moves no push or mark", () => {
    const total = t.shellBaseS + 4 * t.shellEachS;
    const n = Math.round(total / TICK);
    const steady = run(new Handling(t), n + 1, (k) => ({ gun: 'pump', reload: { phase: k / n, shells: 4 } }));
    // Read as 2 a third of the way in, then 6: the pushes and their marks stay the four it began with.
    const changing = run(new Handling(t), n + 1, (k) => ({ gun: 'pump', reload: { phase: k / n, shells: k < n / 3 ? 4 : k < (2 * n) / 3 ? 2 : 6 } }));
    expect(changing).toEqual(steady);
    expect(steady.flatMap((r) => r.cues)).toHaveLength(4);
    // A reload begun afresh counts afresh.
    const h = new Handling(t);
    run(h, n + 1, (k) => ({ gun: 'pump', reload: { phase: k / n, shells: 4 } }));
    run(h, 2);
    const two = t.shellBaseS + 2 * t.shellEachS;
    const m = Math.round(two / TICK);
    expect(run(h, m + 1, (k) => ({ gun: 'pump', reload: { phase: k / m, shells: 2 } })).flatMap((r) => r.cues)).toEqual(['shell', 'shell']);
  });

  it("the run's share is held to 0–1, as the aim's is", () => {
    const strides = (speedRatio: number) =>
      run(new Handling(t), 120, (k) => ({ speedRatio, bobPhase: ((k * TAU) / 60) % TAU, time: k * TICK })).map((r) => r.delta);
    // Faster than a run (a sprint's 6.4 m/s of a run's 5) bobs as a run does, and breathes none.
    expect(strides(1.28)).toEqual(strides(1));
    // Below none (no such speed, but held all the same): no bob, the whole of breathing.
    expect(strides(-0.5)).toEqual(strides(0));
  });

  it('a reload cut short eases back to rest over 0.15 s', () => {
    // The AK's reload, put away at 0.41: tilted, the magazine out.
    const h = new Handling(t);
    const n = Math.round(2.4 / TICK);
    const going = run(h, 60, (k) => ({ reload: { phase: k / n, shells: 0 } }));
    const last = going[59].delta;
    expect(last.roll).toBeCloseTo(28, 9);
    const easing = run(h, 15);
    const channels = (d: HandsDelta) => [...d.offset, d.pitch, d.yaw, d.roll];
    // No snap: the first tick after is still most of the way where it was (and what was still, still).
    channels(easing[0].delta).forEach((v, c) => {
      const was = channels(last)[c];
      if (was === 0) expect(v).toBe(0);
      else expect(Math.abs(v)).toBeGreaterThan(Math.abs(was) * 0.9);
    });
    // Every channel eases back toward rest, never past it, half-way at about half the time...
    for (let k = 1; k < 15; k++) {
      channels(easing[k].delta).forEach((v, c) => {
        expect(Math.abs(v)).toBeLessThanOrEqual(Math.abs(channels(easing[k - 1].delta)[c]));
        expect(v * channels(last)[c]).toBeGreaterThanOrEqual(0);
      });
    }
    expect(easing[3].delta.roll).toBeGreaterThan(28 / 2);
    expect(easing[5].delta.roll).toBeLessThan(28 / 2);
    // ... and at rest by 0.15 s (tick k is (k + 1) ticks after).
    for (let k = Math.round(0.15 / TICK) - 1; k < 15; k++) expectPose(easing[k].delta, ZERO_HANDS, 9);
    expect(easing.flatMap((r) => r.cues)).toEqual([]);
    // A new reload started while it eases does not snap it either.
    const again = new Handling(t);
    run(again, 60, (k) => ({ reload: { phase: k / n, shells: 0 } }));
    const cut = run(again, 2);
    const restart = again.tick({ ...REST, reload: { phase: 0, shells: 0 } }).delta;
    expect(restart.roll).toBeGreaterThan(cut[1].delta.roll * 0.8);
  });

  it("between ticks, the delta is the last two ticks', alpha of the way", () => {
    const h = new Handling(t);
    const a = h.tick({ ...REST, yawRate: 100, sprinting: true }).delta;
    const b = h.tick({ ...REST, yawRate: 100, sprinting: true }).delta;
    expect(h.at(0)).toEqual(a);
    expectPose(h.at(1), b, 15);
    expect(h.delta).toEqual(b);
    const mid = h.at(0.25);
    for (let k = 0; k < 3; k++) expect(mid.offset[k]).toBeCloseTo(a.offset[k] + (b.offset[k] - a.offset[k]) * 0.25, 15);
    expect(mid.pitch).toBeCloseTo(a.pitch + (b.pitch - a.pitch) * 0.25, 15);
    expect(mid.yaw).toBeCloseTo(a.yaw + (b.yaw - a.yaw) * 0.25, 15);
    expect(mid.roll).toBeCloseTo(a.roll + (b.roll - a.roll) * 0.25, 15);
    // What it hands out is its own: changing it changes nothing kept.
    mid.offset[0] = 1;
    b.offset[0] = 1;
    expect(h.delta.offset[0]).not.toBe(1);
    expect(ZERO_HANDS).toEqual({ offset: [0, 0, 0], pitch: 0, yaw: 0, roll: 0 });
  });

  it('reset() leaves the hands as a fresh pair from any state: a reload under way and one easing back, the overshoot running, in the air, and the pump to come', () => {
    // A deploy starts the hands clean (the session's equip and respawn). Worked first so that every
    // field of their state differs from a fresh pair's as reset() is called: sprinting and turning
    // fast throughout, striding (in the second stride of a pair); down hard, then in the air again;
    // the sights arriving, their overshoot running; a long gun's reload part-way, let go as the
    // shotgun is taken (easing back), whose own reload is under way (a shell being pushed) and whose
    // shot was 4 ticks ago (its pump to come).
    const h = new Handling(t);
    const work = (g: number): Partial<HandlingInput> => ({
      time: g * TICK,
      sprinting: true,
      yawRate: 300,
      pitchRate: -200,
      speedRatio: 1,
      bobPhase: (g * 0.2) % TAU,
      onGround: g < 30 || (g >= 35 && g < 44),
      landingImpact: g === 35 ? 9 : 0,
      aimed: Math.min(1, Math.max(0, (g - 37) / 5)),
      gun: g < 44 ? 'long' : 'pump',
      reload: g < 10 ? null : g < 44 ? { phase: (g - 10) / 60, shells: 0 } : { phase: 0.4, shells: 3 },
      sinceShot: g < 44 ? 10 : (g - 43) * TICK,
    });
    run(h, 48, work);
    // Each of the 19 fields of the state (the tunables and what the constructor makes of them aside)
    // differs from a fresh pair's, so reset() is held to every one.
    const fresh = new Handling(t);
    const made = ['t', 'swayOmega', 'landOmega', 'curves'];
    const state = Object.keys(fresh).filter((k) => !made.includes(k));
    const field = (x: Handling, k: string) => (x as unknown as Record<string, unknown>)[k];
    expect(state).toHaveLength(19);
    for (const k of state) expect(field(h, k), k).not.toEqual(field(fresh, k));
    h.reset();
    // Every field as a fresh pair's, and drawn at rest between ticks.
    expect(h).toEqual(new Handling(t));
    expect(h.sprint).toBe(0);
    for (const alpha of [0, 0.5, 1]) expect(h.at(alpha)).toEqual(ZERO_HANDS);
    // From there it moves as a fresh pair does, tick for tick, and is one 60 ticks on. A fresh gun's
    // shot clock (long since a shot) is no pump: the last gun's shot is forgotten.
    const twin = new Handling(t);
    const script = (k: number): Partial<HandlingInput> => ({ gun: 'pump', sinceShot: 1 + k * TICK, time: k * TICK, yawRate: k < 10 ? 120 : 0, onGround: k !== 20, landingImpact: k === 21 ? 4 : 0 });
    for (let k = 0; k < 60; k++) expect(h.tick({ ...REST, ...script(k) }), `tick ${k}`).toEqual(twin.tick({ ...REST, ...script(k) }));
    expect(h).toEqual(twin);
  });

  it("the hands' state is declared once: the constructor makes a fresh pair by reset(), so the two cannot drift", () => {
    const reset = vi.spyOn(Handling.prototype, 'reset');
    try {
      const h = new Handling(t);
      expect(reset).toHaveBeenCalledTimes(1);
      expect(h.delta).toEqual(ZERO_HANDS);
      expect(h.sprint).toBe(0);
    } finally {
      reset.mockRestore();
    }
  });
});
