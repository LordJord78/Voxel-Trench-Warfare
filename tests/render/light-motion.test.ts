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

  it('lets a flare sink no faster than half a metre a second, fade at the end of its burn, and light again above', () => {
    expect(motion.flareSink).toBeLessThanOrEqual(0.5);
    const burn = motion.flareBurn;
    let last = lightsAt([flare], 0, motion)[0];
    let relit = 0;
    let brightest = 0;
    for (let f = 1; f < 60 * burn * 3; f++) {
      const now = lightsAt([flare], f / 60, motion)[0];
      const fell = last.position[1] - now.position[1];
      if (fell < 0) {
        // Lit again, from dark, back up at its height (less what it has sunk since, within the frame).
        relit++;
        expect(flare.position[1] - now.position[1]).toBeGreaterThanOrEqual(0);
        expect(flare.position[1] - now.position[1]).toBeLessThanOrEqual(motion.flareSink / 60 + 1e-9);
        expect(last.intensity).toBeLessThan(0.05 * flare.intensity);
      } else {
        expect(fell).toBeLessThanOrEqual(motion.flareSink / 60 + 1e-9);
      }
      expect(now.position[0]).toBe(flare.position[0]);
      expect(now.position[2]).toBe(flare.position[2]);
      expect(now.intensity).toBeLessThanOrEqual(flare.intensity);
      brightest = Math.max(brightest, now.intensity);
      last = now;
    }
    expect(relit).toBeGreaterThanOrEqual(2);
    // Between catching and guttering out, it burns at its full strength.
    expect(brightest).toBeCloseTo(flare.intensity, 6);
  });

  it('gives the same lights for the same moment', () => {
    expect(lightsAt([lantern, flare], 123.45, motion)).toEqual(lightsAt([lantern, flare], 123.45, motion));
  });
});
