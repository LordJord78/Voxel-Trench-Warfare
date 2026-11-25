import { describe, expect, it } from 'vitest';
import { wgslFn } from '../support/wgsl-fn';

// The test helper that runs a shader's small arithmetic function on the CPU (tests/support/wgsl-fn.ts).
const SOURCE = `
// Not this one.
fn other(x: f32) -> f32 {
  return x;
}

// Its comments are dropped, its lets and vars typed or not, its braces matched.
fn sized(a: f32, b: f32, share: f32) -> vec2f {
  let least = min(a, 2.0 * b); // { a brace in a comment }
  var kept: f32 = clamp(least, 0.0, 1.0f);
  if (kept > 0.5) {
    kept = max(kept, abs(-0.75));
  }
  return vec2f(kept, kept * share);
}

fn reads(x: f32) -> f32 {
  return x * draw.casingMaxPx;
}
`;

describe('a WGSL function run on the CPU', () => {
  it('computes as the shader does, its vectors as arrays', () => {
    const f = wgslFn(SOURCE, 'sized');
    expect(f(0.3, 1, 0.5)).toEqual([0.3, 0.15]);
    expect(f(5, 0.2, 2)).toEqual([0.4, 0.8]);
    expect(f(0.6, 1, 1)).toEqual([0.75, 0.75]);
    expect(f(5, 5, 1)).toEqual([1, 1]);
    expect(wgslFn(SOURCE, 'other')(7)).toBe(7);
  });

  it("reads past comments before it matches braces or finds the function: a brace alone in a comment, a block comment, and a commented-out copy of its head", () => {
    const tricky = `
// fn sized(a: f32) -> f32 { return 99.0; }
/* fn sized(a: f32) -> f32 {
   return 98.0; } /* nested } */ { */
fn sized(a: f32, b: f32) -> f32 {
  // the far side }
  var x = a; /* { */
  if (x > b) { x = b; } // }}
  return x * 2.0;
}
`;
    const f = wgslFn(tricky, 'sized');
    expect(f(1, 5)).toBe(2);
    expect(f(7, 3)).toBe(6);
  });

  it('throws for a function it lacks, and where one reads what it is not handed (a uniform)', () => {
    expect(() => wgslFn(SOURCE, 'missing')).toThrow(/no fn missing/);
    expect(() => wgslFn(SOURCE, 'reads')(1)).toThrow(/draw is not defined/);
  });
});
