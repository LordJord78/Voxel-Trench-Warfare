/**
 * Seeded randomness.
 *
 * One root stream per run, passed in, never reached for globally. Sub-streams
 * are derived by *label*, not by draw order, so adding a generation step does
 * not shift the numbers every other system receives: the same rule as the Python
 * game's `GameRandom`, on a generator that runs identically in every browser
 * (xoshiro128**, seeded through FNV-1a and SplitMix64).
 */

import { log, pow } from './dmath';
import { fnv1a64, splitmix64 } from './hash';

const M32 = 0xffffffffn;
const TWO_32 = 4294967296;

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export class Rng {
  readonly label: string;
  readonly key: bigint;
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  private constructor(key: bigint, label: string) {
    this.key = key;
    this.label = label;
    const a = splitmix64(key);
    const b = splitmix64(a);
    this.s0 = Number(a >> 32n);
    this.s1 = Number(a & M32);
    this.s2 = Number(b >> 32n);
    this.s3 = Number(b & M32);
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  static root(seed: number): Rng {
    return new Rng(splitmix64(BigInt.asUintN(64, BigInt(seed))), 'root');
  }

  /** A child stream that is independent of how much this one has drawn. */
  derive(label: string): Rng {
    return new Rng(splitmix64(this.key ^ fnv1a64(label)), `${this.label}.${label}`);
  }

  nextU32(): number {
    const s1 = this.s1;
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ s1) >>> 0;
    this.s1 = (s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform in [0, 1) with 53 bits of resolution. */
  float(): number {
    const a = this.nextU32() >>> 5;
    const b = this.nextU32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  uniform(lo = 0, hi = 1): number {
    return lo + (hi - lo) * this.float();
  }

  /** Inclusive of `lo`, exclusive of `hi`, without modulo bias. */
  randint(lo: number, hi: number): number {
    const n = hi - lo;
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || !(n >= 1) || n > TWO_32) {
      throw new RangeError(`randint(${lo}, ${hi}): need integers with lo < hi`);
    }
    const limit = Math.floor(TWO_32 / n) * n;
    let u = this.nextU32();
    while (u >= limit) u = this.nextU32();
    return lo + (u % n);
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  choice<T>(xs: readonly T[]): T {
    return xs[this.randint(0, xs.length)];
  }

  shuffled<T>(xs: readonly T[]): T[] {
    const out = xs.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.randint(0, i + 1);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  /** Symmetric noise in [-m, +m). */
  jitter(m: number): number {
    return this.uniform(-m, m);
  }

  /** Marsaglia's polar method; the second value of each pair is discarded. */
  normal(mean = 0, sigma = 1): number {
    let u: number;
    let s: number;
    do {
      u = 2 * this.float() - 1;
      const v = 2 * this.float() - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    return mean + sigma * u * Math.sqrt((-2 * log(s)) / s);
  }

  /** Marsaglia–Tsang. */
  gamma(shape: number, scale = 1): number {
    if (!(shape > 0)) throw new RangeError(`gamma shape must be positive, got ${shape}`);
    if (shape < 1) return this.gamma(shape + 1, scale) * pow(this.float(), 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.float();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
      if (log(u) < 0.5 * x * x + d * (1 - v + log(v))) return d * v * scale;
    }
  }

  beta(a: number, b: number): number {
    const x = this.gamma(a);
    const y = this.gamma(b);
    return x / (x + y);
  }

  /**
   * Exact position in the stream. A system that draws one extra value moves
   * this even when what it produced happens to look the same, which is the
   * drift that otherwise stays invisible until a replay diverges.
   */
  stateString(): string {
    return JSON.stringify({ label: this.label, s: [this.s0, this.s1, this.s2, this.s3] });
  }
}
