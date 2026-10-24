import { describe, expect, it } from 'vitest';
import { horizonGlowRecord, horizonTerms } from '../../src/render/frame-uniforms';
import { loadTunables } from '../../src/core/tunables';

// A barrage's flash as the sky's glow takes it, worked out once a frame for the eye (sky.wgsl's
// horizonGlow then does a dot, a subtraction and an exp per flash): its bearing from the eye, its own
// elevation from it, its weight, and its glow's width and height above and under it.
const terms = horizonTerms(loadTunables());
const rad = Math.PI / 180;

describe("a flash's glow, for the frame", () => {
  it('is its bearing and elevation from the eye, its weight by its power and the air, and its widths', () => {
    const eye = [0, 2, 0];
    const at = (bearing: number, metres: number): [number, number, number] => [Math.sin(bearing * rad) * metres, 0, Math.cos(bearing * rad) * metres];
    const r = horizonGlowRecord({ position: at(40, 2000), power: 0.8, glow: true }, eye, terms, 0.4);
    expect(r[0]).toBeCloseTo(Math.sin(40 * rad), 6);
    expect(r[1]).toBeCloseTo(Math.cos(40 * rad), 6);
    expect(r[2]).toBeCloseTo(Math.atan2(-2, 2000), 9);
    expect(r[3]).toBeCloseTo(0.4 * 0.8 * Math.exp(-2000 / terms.reachM), 9);
    const w = Math.atan((0.5 * terms.spreadM[0]) / 2000);
    const h = Math.max(Math.atan(terms.spreadM[1] / 2000), terms.minDeg * rad);
    expect(r[4]).toBeCloseTo(1 / (w * w), 4);
    expect(r[5]).toBeCloseTo(1 / (h * h), 4);
    expect(r[6]).toBeCloseTo(100 / (h * h), 2);
    // Far off, its glow no lower than min_deg.
    const far = horizonGlowRecord({ position: at(40, 8000), power: 1, glow: true }, eye, terms, 0.4);
    expect(far[5]).toBeCloseTo(1 / (terms.minDeg * rad) ** 2, 3);
  });
});
