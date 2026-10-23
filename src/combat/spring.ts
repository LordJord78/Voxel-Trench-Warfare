/**
 * An exact step of a damped spring, x″ = −ω²x − 2ζωx′, over `dt`: the
 * reference's `advance_spring`. Not Euler: at the rifle's settle times ω·dt is
 * about 0.5 at 60 Hz, and an explicit step loses most of a kick and stretches
 * its settling past what the tuning file says. The closed form has no
 * stability limit, so the same recoil comes out at any tick rate.
 */

import { cos, exp, sin } from '../core/dmath';

/**
 * ω × a settling time, for a displacement released into a critically damped
 * spring to fall to 2% of its peak: the root of (1 + u)e^−u = 0.02. A
 * derivation, not a feel value.
 */
export const SETTLE_CONSTANT = 5.83;

/** (x, x′) after `dt`, from (x, v), for natural frequency `omega` and damping ratio `zeta`; unchanged if ω ≤ 0. */
export function advanceSpring(x: number, v: number, omega: number, zeta: number, dt: number): [number, number] {
  if (omega <= 0) return [x, v];
  if (zeta < 1 - 1e-6) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const decay = exp(-zeta * omega * dt);
    const c = cos(wd * dt);
    const s = sin(wd * dt);
    return [decay * (x * c + ((v + zeta * omega * x) / wd) * s), decay * (v * c - ((omega * omega * x + zeta * omega * v) / wd) * s)];
  }
  if (zeta > 1 + 1e-6) {
    const rate = omega * Math.sqrt(zeta * zeta - 1);
    const a = -zeta * omega + rate;
    const b = -zeta * omega - rate;
    const c2 = (v - a * x) / (b - a);
    const c1 = x - c2;
    const ea = exp(a * dt);
    const eb = exp(b * dt);
    return [c1 * ea + c2 * eb, c1 * a * ea + c2 * b * eb];
  }
  // Critically damped: x = (A + Bt) e^−ωt.
  const decay = exp(-omega * dt);
  const b = v + omega * x;
  return [(x + b * dt) * decay, (b - omega * (x + b * dt)) * decay];
}
