import { describe, expect, it } from 'vitest';
import { HORIZON_FLASHES } from '../../src/battle/barrages';
import { battleDarkness, Director, type BattleEvents, type BattleInputs, type DistantShell } from '../../src/battle/director';
import { tracerAt, tracerTunables } from '../../src/battle/tracers';
import { flareTunables } from '../../src/battle/flares';
import { loadTunables, Tunables } from '../../src/core/tunables';
import { sceneLights } from '../../src/render/lights';
import { genParams } from '../../src/world/generation/params';
import { planWorld } from '../../src/world/generation/plan';

// The director's flares (the battle spec's §1–§2): fired from posts on both front lines' parapets out
// over no man's land, a quarter from near the player, about six alight at the front's light
// intensity, two and a half times that heavy, one a minute off, and none while the sky is light;
// on the lights' clock, deterministic, and sought by stepping from its start.
const tun = loadTunables();
const p = genParams(tun);
const plan = planWorld(p, 7);
const v = p.voxel;
const ft = flareTunables(tun);
const front = plan.lines.find((l) => l.spec.side === 0 && l.spec.firingSteps)!;
const bay = front.bays[Math.floor(front.bays.length / 2)];
/** The player on the friendly front line's middle bay. */
const player: [number, number, number] = bay.longAxis === 0 ? [((bay.a0 + bay.a1) / 2) * v, bay.crestY * v, ((bay.b0 + bay.b1) / 2) * v] : [((bay.b0 + bay.b1) / 2) * v, bay.crestY * v, ((bay.a0 + bay.a1) / 2) * v];
const dark = (intensity: BattleInputs['intensity']): BattleInputs => ({ intensity, darkness: 1, player });

/** Run `minutes` from the start at 60 Hz: the mean count burning, sampled each second, and every launch. */
function run(inputs: BattleInputs, minutes: number, seed = 7) {
  const d = new Director(plan, tun, seed);
  let burning = 0;
  let samples = 0;
  const launches = [];
  for (let k = 0; k < minutes * 3600; k++) {
    launches.push(...d.tick(1 / 60, inputs).launches);
    if (k % 60 === 0) {
      burning += d.flares().filter((f) => f.stage === 'burning').length;
      samples++;
    }
  }
  return { d, mean: burning / samples, launches };
}

describe('the director', () => {
  it('about six burn at once at light, two and a half times that heavy, one a minute off', () => {
    const light = run(dark('light'), 30).mean;
    expect(light).toBeGreaterThan(ft.meanLight * 0.8);
    expect(light).toBeLessThan(ft.meanLight * 1.2);
    const heavy = run(dark('heavy'), 30).mean;
    expect(heavy / light).toBeGreaterThan(ft.heavyScale * 0.8);
    expect(heavy / light).toBeLessThan(ft.heavyScale * 1.2);
    const off = run(dark('off'), 30).launches.length;
    expect(off).toBeGreaterThan(30 * ft.offPerMin * 0.6);
    expect(off).toBeLessThan(30 * ft.offPerMin * 1.4);
  });

  it("no flare is fired while the sky's flares key is 0.1 or less; one alight burns out", () => {
    expect(run({ ...dark('heavy'), darkness: ft.darkAbove }, 10).launches).toEqual([]);
    // Dark for a minute, then light: none fired after, and those alight burn on until out.
    const d = new Director(plan, tun, 7);
    for (let k = 0; k < 3600; k++) d.tick(1 / 60, dark('heavy'));
    const alight = d.flares().filter((f) => f.stage === 'burning').length;
    expect(alight).toBeGreaterThan(0);
    let fired = 0;
    for (let k = 0; k < 60; k++) fired += d.tick(1 / 60, { ...dark('heavy'), darkness: 0 }).launches.length;
    expect(fired).toBe(0);
    expect(d.flares().filter((f) => f.stage === 'burning').length).toBeGreaterThan(0);
    for (let k = 0; k < 60 * 60; k++) d.tick(1 / 60, { ...dark('heavy'), darkness: 0 });
    expect(d.flares()).toEqual([]);
  });

  it("flares come from posts on both lines' parapets, a quarter within 60 m of the player along the lines, fired over no man's land", () => {
    const { launches } = run(dark('heavy'), 30);
    expect(launches.length).toBeGreaterThan(200);
    const lines = plan.lines.filter((l) => l.spec.firingSteps);
    const sideOf = (post: readonly number[]) => {
      for (const l of lines) for (const b of l.bays) {
        const along = b.longAxis === 0 ? post[0] / v : post[2] / v;
        const across = b.longAxis === 0 ? post[2] / v : post[0] / v;
        if (along >= b.a0 && along <= b.a1 && Math.abs(across - (b.facing > 0 ? b.b1 : b.b0)) < 1e-6) return { side: l.spec.side, b };
      }
      return null;
    };
    let near = 0;
    const sides = [0, 0];
    for (const l of launches) {
      const at = sideOf(l.post)!;
      expect(at, JSON.stringify(l.post)).not.toBeNull();
      sides[at.side]++;
      // Over no man's land: the bearing within spread_deg of straight across, toward the enemy.
      const ahead = at.b.longAxis === 0 ? [0, at.b.facing] : [at.b.facing, 0];
      const cosine = Math.sin(l.bearing) * ahead[0] + Math.cos(l.bearing) * ahead[1];
      expect(cosine).toBeGreaterThanOrEqual(Math.cos(((ft.spreadDeg + 1e-6) * Math.PI) / 180));
      const along = at.b.longAxis === 0 ? Math.abs(l.post[0] - player[0]) : Math.abs(l.post[2] - player[2]);
      if (along <= ft.nearM) near++;
    }
    expect(Math.min(...sides) / launches.length).toBeGreaterThan(0.3);
    expect(near / launches.length).toBeGreaterThan(ft.nearShare * 0.8);
  });

  it("at light, the flares light no man's land about as the approved six did", () => {
    // light.wgsl's unshadowed point light on the ground (normal up): ndl · win² / (m² + 1), win = 1 − (d/r)⁴;
    // averaged over no man's land's ground and twenty minutes at light, against the six planned flares.
    const enemy = plan.lines.find((l) => l.spec.side === 1 && l.spec.firingSteps)!;
    const z0 = Math.max(...front.bays.map((b) => b.b1)) * v;
    const z1 = Math.min(...enemy.bays.map((b) => b.b0)) * v;
    const ground: number[][] = [];
    for (let x = 10; x <= 246; x += 8) for (let z = z0 + 2; z <= z1 - 2; z += 6) ground.push([x, 16, z]);
    const lightOn = (flares: { at: readonly number[]; glow: number }[]) => {
      let sum = 0;
      for (const q of ground) {
        for (const f of flares) {
          const d = Math.hypot(q[0] - f.at[0], q[1] - f.at[1], q[2] - f.at[2]);
          if (d >= ft.radiusM) continue;
          const x = d / ft.radiusM;
          const win = 1 - x * x * x * x;
          sum += (f.glow * Math.max(0, (f.at[1] - q[1]) / d) * win * win) / (d * d + 1);
        }
      }
      return sum / ground.length;
    };
    const approved = lightOn(sceneLights(plan, tun).filter((l) => l.kind === 'flare').map((l) => ({ at: l.position, glow: 1 })));
    const d = new Director(plan, tun, 7);
    let lit = 0;
    let samples = 0;
    for (let k = 0; k < 21 * 3600; k++) {
      d.tick(1 / 60, dark('light'));
      if (k >= 3600 && k % 60 === 0) {
        lit += lightOn(d.flares().filter((f) => f.stage === 'burning').map((f) => ({ at: f.position, glow: f.glow })));
        samples++;
      }
    }
    expect(lit / samples / approved).toBeGreaterThan(0.7);
  });

  it('never more than max_alight alight, even heavy', () => {
    const d = new Director(plan, tun, 7);
    let most = 0;
    for (let k = 0; k < 30 * 3600; k++) {
      d.tick(1 / 60, dark('heavy'));
      if (k % 30 === 0) most = Math.max(most, d.flares().length);
    }
    expect(ft.maxAlight).toBe(16);
    expect(most).toBe(ft.maxAlight);
  });

  it("the battle's dark is the sky's flares key while the sun is down, and none once it is up", () => {
    expect(ft.sunBelowDeg).toBe(0);
    expect(battleDarkness(-3, 0.2, ft)).toBe(0.2);
    expect(battleDarkness(-0.5, 1, ft)).toBe(1);
    expect(battleDarkness(0.5, 0.2, ft)).toBe(0);
    expect(battleDarkness(20, 0.15, ft)).toBe(0);
  });

  it('the same seed, inputs and steps fire the same flares; seeking to t is stepping to t, at any frame rate', () => {
    const a = run(dark('light'), 3, 11);
    const b = run(dark('light'), 3, 11);
    expect(b.launches).toEqual(a.launches);
    expect(run(dark('light'), 3, 12).launches).not.toEqual(a.launches);
    const sought = Director.at(150, plan, tun, 11, dark('light'));
    const stepped = new Director(plan, tun, 11);
    for (let k = 0; k < 150 * 30; k++) stepped.tick(1 / 30, dark('light'));
    expect(sought.seconds).toBeCloseTo(150, 6);
    expect(stepped.flares()).toEqual(sought.flares());
  });
});

// The distant fire (the battle spec's §3): barrages beyond the map and shells into the far field, by the
// front's intensity and not the dark; the sky sent the newest sixteen flashes; seeking still stepping.
describe('the distant fire', () => {
  const minutes = (d: Director, inputs: BattleInputs, n: number, each?: (k: number) => void) => {
    const distant: DistantShell[] = [];
    for (let k = 0; k < n * 3600; k++) {
      distant.push(...d.tick(1 / 60, inputs).distant);
      each?.(k);
    }
    return distant;
  };

  it('at light a barrage every two or three minutes, at heavy one or two in progress, none off', () => {
    const light = new Director(plan, tun, 7);
    minutes(light, dark('light'), 60);
    expect(light.barrages.started).toBeGreaterThanOrEqual(12);
    expect(light.barrages.started).toBeLessThanOrEqual(40);
    const heavy = new Director(plan, tun, 7);
    let running = 0;
    minutes(heavy, dark('heavy'), 30, (k) => {
      if (k % 60 === 0) running += heavy.barrages.running;
    });
    expect(running / (30 * 60)).toBeGreaterThanOrEqual(1.0);
    expect(running / (30 * 60)).toBeLessThanOrEqual(2.6);
    expect(minutes(new Director(plan, tun, 7), dark('off'), 10)).toEqual([]);
  });

  it('far shells: about two a minute at light, twelve at heavy, none off', () => {
    const far = (intensity: BattleInputs['intensity']) => minutes(new Director(plan, tun, 7), dark(intensity), 30).filter((s) => s.far).length;
    const light = far('light');
    expect(light).toBeGreaterThanOrEqual(60 * 0.7);
    expect(light).toBeLessThanOrEqual(60 * 1.3);
    const heavy = far('heavy');
    expect(heavy).toBeGreaterThanOrEqual(360 * 0.7);
    expect(heavy).toBeLessThanOrEqual(360 * 1.3);
    expect(far('off')).toBe(0);
  });

  it('the distant fire does not wait for the dark', () => {
    const d = new Director(plan, tun, 7);
    let launches = 0;
    const distant: DistantShell[] = [];
    for (let k = 0; k < 5 * 3600; k++) {
      const e = d.tick(1 / 60, { ...dark('heavy'), darkness: 0 });
      launches += e.launches.length;
      distant.push(...e.distant);
    }
    expect(launches).toBe(0);
    expect(distant.filter((s) => s.far).length).toBeGreaterThan(0);
    expect(distant.filter((s) => !s.far).length).toBeGreaterThan(0);
  });

  it('turned off, a barrage in progress stops', () => {
    const d = new Director(plan, tun, 7);
    let landed = false;
    for (let k = 0; k < 30 * 3600 && !(landed && d.barrages.running > 0); k++) landed ||= d.tick(1 / 60, dark('heavy')).distant.some((s) => !s.far);
    expect(d.barrages.running).toBeGreaterThan(0);
    expect(minutes(d, dark('off'), 2)).toEqual([]);
    expect(d.barrages.running).toBe(0);
  });

  it('the sky is sent the newest sixteen, none older than the window', () => {
    // A minute's window, so more than sixteen are within it at heavy.
    const raw = tun.raw() as { battle: { flashes: Record<string, unknown> } };
    raw.battle.flashes.window_s = 60;
    const long = new Tunables(raw as Record<string, unknown>);
    const d = new Director(plan, long, 7);
    let most = 0;
    minutes(d, dark('heavy'), 10, (k) => {
      if (k % 60 !== 0) return;
      const f = d.flashes();
      most = Math.max(most, f.length);
      expect(f.length).toBeLessThanOrEqual(HORIZON_FLASHES);
      for (let i = 0; i < f.length; i++) {
        expect(d.seconds - f[i].t).toBeGreaterThanOrEqual(0);
        expect(d.seconds - f[i].t).toBeLessThanOrEqual(60);
        if (i > 0) expect(f[i].t).toBeLessThanOrEqual(f[i - 1].t);
      }
    });
    expect(most).toBe(HORIZON_FLASHES);
    // And at the window's own second, none older than it.
    const short = new Director(plan, tun, 7);
    minutes(short, dark('heavy'), 5, (k) => {
      if (k % 60 === 0) for (const f of short.flashes()) expect(short.seconds - f.t).toBeLessThanOrEqual(1);
    });
  });

  it('a far shell stands on the far field', () => {
    const ground = (x: number, z: number) => x / 100 + z / 1000;
    const far = minutes(new Director(plan, tun, 7, ground), dark('heavy'), 5).filter((s) => s.far);
    expect(far.length).toBeGreaterThan(0);
    for (const s of far) expect(s.position[1]).toBe(ground(s.position[0], s.position[2]));
  });

  it('seeking is stepping, for the distant fire too', () => {
    const sought = Director.at(150, plan, tun, 11, dark('heavy'));
    const stepped = new Director(plan, tun, 11);
    for (let k = 0; k < 150 * 30; k++) stepped.tick(1 / 30, dark('heavy'));
    expect(stepped.smoke().length).toBeGreaterThan(0);
    expect(stepped.smoke()).toEqual(sought.smoke());
    expect(stepped.flashes()).toEqual(sought.flashes());
  });
});

// The machine guns (the battle spec's §4): bursts from guns on both lines beyond the player's stretch,
// at night, their tracers streaming over the field; none passing near the player; seeking stepping.
describe('the machine guns', () => {
  const tt = tracerTunables(tun);
  /** `seconds` at `inputs`, each step's events to `each`. */
  const runFor = (d: Director, inputs: BattleInputs, seconds: number, each?: (e: BattleEvents, k: number) => void) => {
    for (let k = 0; k < seconds * 60; k++) {
      const e = d.tick(1 / 60, inputs);
      each?.(e, k);
    }
  };
  const meanInFlight = (intensity: BattleInputs['intensity']) => {
    const d = new Director(plan, tun, 7);
    let sum = 0;
    let samples = 0;
    runFor(d, dark(intensity), 600, (_, k) => {
      if (k % 60 === 0 && k >= 600) {
        sum += d.tracers().length;
        samples++;
      }
    });
    return sum / samples;
  };

  it('at light at least 20 tracers are in flight on average, two and a half times that heavy, none off', () => {
    const light = meanInFlight('light');
    expect(light).toBeGreaterThanOrEqual(20);
    const heavy = meanInFlight('heavy');
    expect(heavy / light).toBeGreaterThan(tt.heavyScale * 0.8);
    expect(heavy / light).toBeLessThan(tt.heavyScale * 1.2);
    expect(meanInFlight('off')).toBe(0);
  });

  it('tracers are fired only in the dark: when it lifts, those in flight finish', () => {
    const lit = new Director(plan, tun, 7);
    let bursts = 0;
    runFor(lit, { ...dark('heavy'), darkness: 0 }, 60, (e) => (bursts += e.bursts.length));
    expect(bursts).toBe(0);
    const d = new Director(plan, tun, 7);
    runFor(d, dark('heavy'), 60);
    expect(d.tracers().length).toBeGreaterThan(0);
    let after = 0;
    runFor(d, { ...dark('heavy'), darkness: 0 }, 0.2, (e) => (after += e.bursts.length));
    expect(after).toBe(0);
    // A burst begun before it lifted finishes its rounds, each burning burn_s.
    runFor(d, { ...dark('heavy'), darkness: 0 }, tt.burnS + ((tt.rounds[1] - 1) * 60) / tt.rpm + 0.1);
    expect(d.tracers()).toEqual([]);
  });

  it('none passes within 30 m of the player, wherever they stand along the front', () => {
    for (const k of [1, 6, 13, 19, 24]) {
      const b = front.bays[k];
      const at: [number, number, number] = [((b.a0 + b.a1) / 2) * v, b.crestY * v, ((b.b0 + b.b1) / 2) * v];
      const d = new Director(plan, tun, 7);
      let legs = 0;
      runFor(d, { intensity: 'heavy', darkness: 1, player: at }, 120, (_, step) => {
        if (step % 30 !== 0) return;
        for (const shot of d.shots()) {
          for (const leg of shot.legs) {
            const end = tracerAt({ id: 0, legs: [leg] }, leg.t1, tt)!.position;
            // The leg's line across the ground, and the player's nearest point on it.
            const dx = end[0] - leg.from[0];
            const dz = end[2] - leg.from[2];
            const s = Math.max(0, Math.min(1, ((at[0] - leg.from[0]) * dx + (at[2] - leg.from[2]) * dz) / Math.max(dx * dx + dz * dz, 1e-9)));
            expect(Math.hypot(leg.from[0] + dx * s - at[0], leg.from[2] + dz * s - at[2]), `bay ${k}`).toBeGreaterThanOrEqual(tt.missM);
            legs++;
          }
        }
      });
      expect(legs, `bay ${k}`).toBeGreaterThan(0);
    }
  });

  it("from guns on both lines, none within clear_m of the player's stretch", () => {
    const d = new Director(plan, tun, 7);
    const zs = new Set<number>();
    let bursts = 0;
    runFor(d, dark('heavy'), 300, (e) => {
      for (const b of e.bursts) {
        bursts++;
        expect(Math.abs(b.gun[0] - player[0])).toBeGreaterThan(tt.clearM);
        zs.add(b.gun[2] > 135 ? 1 : 0);
        expect(b.rounds).toBeGreaterThanOrEqual(tt.rounds[0]);
        expect(b.rounds).toBeLessThanOrEqual(tt.rounds[1]);
      }
    });
    expect(bursts).toBeGreaterThan(100);
    expect(zs.size).toBe(2);
  });

  it('seeking is stepping, for the guns too', () => {
    const sought = Director.at(150, plan, tun, 11, dark('light'));
    const stepped = new Director(plan, tun, 11);
    for (let k = 0; k < 150 * 30; k++) stepped.tick(1 / 30, dark('light'));
    expect(stepped.tracers().length).toBeGreaterThan(0);
    expect(stepped.tracers()).toEqual(sought.tracers());
  });
});
