import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { lightMotion, lightsAt } from '../../src/render/light-motion';
import type { SceneLight } from '../../src/render/lights';

const tun = loadTunables();
const motion = lightMotion(tun);
const lantern: SceneLight = { position: [10, 2, 10], radius: 7, colour: [1, 0.6, 0.3], intensity: 2.5, kind: 'lantern', phase: 0.3 };
const flare: SceneLight = { position: [50, 40, 80], radius: 60, colour: [1, 0.9, 0.8], intensity: 400, kind: 'flare', phase: 0.7 };

describe('the lights in motion', () => {
  it('flickers a lantern within a tenth of its light, smoothly from frame to frame, and leaves it where it hangs', () => {
    let last = lightsAt([lantern], 0, motion)[0];
    let lo = Infinity;
    let hi = -Infinity;
    for (let f = 1; f < 60 * 120; f++) {
      const now = lightsAt([lantern], f / 60, motion)[0];
      expect(Math.abs(now.intensity / lantern.intensity - 1)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(now.intensity - last.intensity) / lantern.intensity).toBeLessThan(0.02);
      expect(now.position).toEqual(lantern.position);
      lo = Math.min(lo, now.intensity);
      hi = Math.max(hi, now.intensity);
      last = now;
    }
    // It does flicker.
    expect(hi - lo).toBeGreaterThan(0.05 * lantern.intensity);
  });

  it("sinks a flare a test gives under its parachute as it burns, and gutters it out, as sub-project 2's did (the scene's own come from the battle's director)", () => {
    // Its phase sets how far through its burn it is: 0.7 of 40 s at the clock's start.
    const burnt = (seconds: number) => ((seconds / motion.flareBurn + flare.phase) % 1) * motion.flareBurn;
    for (const seconds of [0, 1, 6, 11.5]) {
      const now = lightsAt([flare], seconds, motion)[0];
      expect(now.position[1]).toBeCloseTo(flare.position[1] - motion.flareSink * burnt(seconds), 6);
      expect([now.position[0], now.position[2]]).toEqual([flare.position[0], flare.position[2]]);
    }
    // Lit again where it began once out: dark at the end of its burn, whole in the middle of it.
    expect(lightsAt([flare], 12, motion)[0].intensity).toBeLessThan(0.01 * flare.intensity);
    expect(lightsAt([flare], 32, motion)[0].intensity).toBeCloseTo(flare.intensity, 6);
    expect(motion.flareBurn).toBe(40);
    expect(motion.flareSink).toBe(0.3);
  });

  it('gives the same lights for the same moment', () => {
    expect(lightsAt([lantern, flare], 123.45, motion)).toEqual(lightsAt([lantern, flare], 123.45, motion));
  });
});
