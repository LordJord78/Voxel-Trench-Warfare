/**
 * Deterministic transcendental maths.
 *
 * `Math.sin` and friends are implementation-defined: V8, JavaScriptCore and
 * SpiderMonkey may disagree in the last bit, and one bit is enough for two
 * browsers to generate different worlds from the same seed. These are ports of
 * fdlibm built only from IEEE-754 basic operations (+ − × ÷, `Math.sqrt`,
 * `floor`) and bit views, which every engine rounds identically.
 *
 * Simulation code (`core`, `world`, `physics`, `sim`) uses these instead of
 * `Math`; tests/architecture.test.ts enforces it.
 */

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const HI = LITTLE ? 1 : 0;
const LO = LITTLE ? 0 : 1;

/** High word of a double, as a signed 32-bit integer (the fdlibm `__HI`). */
function highWord(x: number): number {
  f64[0] = x;
  return u32[HI] | 0;
}

function lowWord(x: number): number {
  f64[0] = x;
  return u32[LO];
}

function withHighWord(x: number, hi: number): number {
  f64[0] = x;
  u32[HI] = hi >>> 0;
  return f64[0];
}

function fromWords(hi: number, lo: number): number {
  u32[HI] = hi >>> 0;
  u32[LO] = lo >>> 0;
  return f64[0];
}

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
const DEG = PI / 180;
const RAD = 180 / PI;

export function radians(deg: number): number {
  return deg * DEG;
}

export function degrees(rad: number): number {
  return rad * RAD;
}

export function copysign(mag: number, sign: number): number {
  const m = Math.abs(mag);
  return sign < 0 || Object.is(sign, -0) ? -m : m;
}

export function hypot(x: number, y: number, z?: number): number {
  if (z === undefined) return Math.sqrt(x * x + y * y);
  return Math.sqrt(x * x + y * y + z * z);
}

// --- sin / cos ------------------------------------------------------------------

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

/** fdlibm __kernel_sin on [-π/4, π/4]; `y` is the tail of x, `iy` says whether it is non-zero. */
function kernelSin(x: number, y: number, iy: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix < 0x3e400000 && Math.trunc(x) === 0) return x;
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

/** fdlibm __kernel_cos on [-π/4, π/4]. */
function kernelCos(x: number, y: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix < 0x3e400000 && Math.trunc(x) === 0) return 1;
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y));
  const qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0);
  const hz = 0.5 * z - qx;
  const a = 1 - qx;
  return a - (hz - (z * r - x * y));
}

const INV_PIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417e0;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21;
const PIO2_3T = 8.47842766036889956997e-32;

/** Reduced argument (head, tail) from the last `remPio2` call. */
let remY0 = 0;
let remY1 = 0;

// Multiples of π/2 whose high word marks where the medium-range reduction can
// cancel: fdlibm's npio2_hw, recomputed from π in integer arithmetic.
const NPIO2_HW = [
  0x3ff921fb, 0x400921fb, 0x4012d97c, 0x401921fb, 0x401f6a7a, 0x4022d97c, 0x4025fdbb, 0x402921fb,
  0x402c463a, 0x402f6a7a, 0x4031475c, 0x4032d97c, 0x40346b9c, 0x4035fdbb, 0x40378fdb, 0x403921fb,
  0x403ab41b, 0x403c463a, 0x403dd85a, 0x403f6a7a, 0x40407e4c, 0x4041475c, 0x4042106c, 0x4042d97c,
  0x4043a28c, 0x40446b9c, 0x404534ac, 0x4045fdbb, 0x4046c6cb, 0x40478fdb, 0x404858eb, 0x404921fb,
];

/**
 * fdlibm __ieee754_rem_pio2: x = n·π/2 + (remY0 + remY1), returning n.
 * Medium arguments take Cody–Waite with fdlibm's quick path; anything past
 * 2^19·π/2 goes through `kernelRemPio2` (Payne–Hanek), so every finite angle
 * reduces exactly as fdlibm reduces it.
 */
function remPio2(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    remY0 = x;
    remY1 = 0;
    return 0;
  }
  if (ix < 0x4002d97c) {
    if (hx > 0) {
      let z = x - PIO2_1;
      if (ix !== 0x3ff921fb) {
        remY0 = z - PIO2_1T;
        remY1 = (z - remY0) - PIO2_1T;
      } else {
        z -= PIO2_2;
        remY0 = z - PIO2_2T;
        remY1 = (z - remY0) - PIO2_2T;
      }
      return 1;
    }
    let z = x + PIO2_1;
    if (ix !== 0x3ff921fb) {
      remY0 = z + PIO2_1T;
      remY1 = (z - remY0) + PIO2_1T;
    } else {
      z += PIO2_2;
      remY0 = z + PIO2_2T;
      remY1 = (z - remY0) + PIO2_2T;
    }
    return -1;
  }
  if (ix > 0x413921fb) {
    if (ix >= 0x7ff00000) {
      remY0 = remY1 = x - x;
      return 0;
    }
    // z = |x| scaled to [2^23, 2^24), split into three 24-bit pieces.
    const e0 = (ix >> 20) - 1046;
    let z = fromWords(ix - (e0 << 20), lowWord(x));
    const tx = [0, 0, 0];
    for (let k = 0; k < 2; k++) {
      tx[k] = Math.trunc(z);
      z = (z - tx[k]) * TWO24;
    }
    tx[2] = z;
    let nx = 3;
    while (tx[nx - 1] === 0) nx--;
    const n = kernelRemPio2(tx, e0, nx);
    if (hx < 0) {
      remY0 = -remY0;
      remY1 = -remY1;
      return -n;
    }
    return n;
  }
  const t0 = Math.abs(x);
  const n = Math.trunc(t0 * INV_PIO2 + 0.5);
  const fn = n;
  let r = t0 - fn * PIO2_1;
  let w = fn * PIO2_1T;
  const j = ix >> 20;
  remY0 = r - w;
  let i = j - ((highWord(remY0) >> 20) & 0x7ff);
  if ((n >= 32 || ix === NPIO2_HW[n - 1]) && i > 16) {
    let t = r;
    w = fn * PIO2_2;
    r = t - w;
    w = fn * PIO2_2T - ((t - r) - w);
    remY0 = r - w;
    i = j - ((highWord(remY0) >> 20) & 0x7ff);
    if (i > 49) {
      t = r;
      w = fn * PIO2_3;
      r = t - w;
      w = fn * PIO2_3T - ((t - r) - w);
      remY0 = r - w;
    }
  }
  remY1 = (r - remY0) - w;
  if (hx < 0) {
    remY0 = -remY0;
    remY1 = -remY1;
    return -n;
  }
  return n;
}

const TWO24 = 16777216;
const TWON24 = 5.9604644775390625e-8;

// 2/π in 24-bit pieces (fdlibm's two_over_pi), recomputed from π in integer arithmetic.
const IPIO2 = [
  0xa2f983, 0x6e4e44, 0x1529fc, 0x2757d1, 0xf534dd, 0xc0db62, 0x95993c, 0x439041, 0xfe5163, 0xabdebb, 0xc561b7,
  0x246e3a, 0x424dd2, 0xe00649, 0x2eea09, 0xd1921c, 0xfe1deb, 0x1cb129, 0xa73ee8, 0x8235f5, 0x2ebb44, 0x84e99c,
  0x7026b4, 0x5f7e41, 0x3991d6, 0x398353, 0x39f49c, 0x845f8b, 0xbdf928, 0x3b1ff8, 0x97ffde, 0x05980f, 0xef2f11,
  0x8b5a0a, 0x6d1f6d, 0x367ecf, 0x27cb09, 0xb74f46, 0x3f669e, 0x5fea2d, 0x7527ba, 0xc7ebe5, 0xf17b3d, 0x0739f7,
  0x8a5292, 0xea6bfb, 0x5fb11f, 0x8d5d08, 0x560330, 0x46fc7b, 0x6babf0, 0xcfbc20, 0x9af436, 0x1da9e3, 0x91615e,
  0xe61b08, 0x659985, 0x5f14a0, 0x68408d, 0xffd880, 0x4d7327, 0x310606, 0x1556ca, 0x73a8c9, 0x60e27b, 0xc08c6b,
];

// π/2 in doubles of 24 significant bits each (fdlibm's PIo2).
const PIO2_PIECES = [
  1.570796251296997, 7.549789415861596e-8, 5.390302529957765e-15, 3.282003415807913e-22,
  1.270655753080676e-29, 1.2293330898111133e-36, 2.7337005381646456e-44, 2.1674168387780482e-51,
];

/** x·2^n, exactly, by building the power of two in the exponent bits. */
function scalbn(x: number, n: number): number {
  while (n > 1023) {
    x *= 8.98846567431158e307;
    n -= 1023;
  }
  while (n < -1022) {
    x *= 2.2250738585072014e-308;
    n += 1022;
  }
  return x * fromWords((n + 1023) << 20, 0);
}

/** fdlibm __kernel_rem_pio2 at double precision (prec 2): Payne–Hanek reduction. */
function kernelRemPio2(x: number[], e0: number, nx: number): number {
  const jk = 4;
  const jp = 4;
  const jx = nx - 1;
  const jv = Math.max(0, Math.trunc((e0 - 3) / 24));
  let q0 = e0 - 24 * (jv + 1);
  const f = new Float64Array(20);
  const q = new Float64Array(20);
  const fq = new Float64Array(20);
  const iq = new Int32Array(20);

  for (let i = 0, j = jv - jx; i <= jx + jk; i++, j++) f[i] = j < 0 ? 0 : IPIO2[j];
  for (let i = 0; i <= jk; i++) {
    let fw = 0;
    for (let j = 0; j <= jx; j++) fw += x[j] * f[jx + i - j];
    q[i] = fw;
  }

  let jz = jk;
  let z = 0;
  let n = 0;
  let ih = 0;
  for (;;) {
    z = q[jz];
    for (let i = 0, j = jz; j > 0; i++, j--) {
      const fw = Math.trunc(TWON24 * z);
      iq[i] = Math.trunc(z - TWO24 * fw);
      z = q[j - 1] + fw;
    }
    z = scalbn(z, q0);
    z -= 8 * Math.floor(z * 0.125);
    n = Math.trunc(z);
    z -= n;
    ih = 0;
    if (q0 > 0) {
      const i = iq[jz - 1] >> (24 - q0);
      n += i;
      iq[jz - 1] -= i << (24 - q0);
      ih = iq[jz - 1] >> (23 - q0);
    } else if (q0 === 0) {
      ih = iq[jz - 1] >> 23;
    } else if (z >= 0.5) {
      ih = 2;
    }
    if (ih > 0) {
      n += 1;
      let carry = 0;
      for (let i = 0; i < jz; i++) {
        const v = iq[i];
        if (carry === 0) {
          if (v !== 0) {
            carry = 1;
            iq[i] = 0x1000000 - v;
          }
        } else {
          iq[i] = 0xffffff - v;
        }
      }
      if (q0 === 1) iq[jz - 1] &= 0x7fffff;
      else if (q0 === 2) iq[jz - 1] &= 0x3fffff;
      if (ih === 2) {
        z = 1 - z;
        if (carry !== 0) z -= scalbn(1, q0);
      }
    }
    if (z === 0) {
      let j = 0;
      for (let i = jz - 1; i >= jk; i--) j |= iq[i];
      if (j === 0) {
        let k = 1;
        while (iq[jk - k] === 0) k++;
        for (let i = jz + 1; i <= jz + k; i++) {
          f[jx + i] = IPIO2[jv + i];
          let fw = 0;
          for (let jj = 0; jj <= jx; jj++) fw += x[jj] * f[jx + i - jj];
          q[i] = fw;
        }
        jz += k;
        continue;
      }
    }
    break;
  }

  if (z === 0) {
    jz -= 1;
    q0 -= 24;
    while (iq[jz] === 0) {
      jz--;
      q0 -= 24;
    }
  } else {
    z = scalbn(z, -q0);
    if (z >= TWO24) {
      const fw = Math.trunc(TWON24 * z);
      iq[jz] = Math.trunc(z - TWO24 * fw);
      jz += 1;
      q0 += 24;
      iq[jz] = fw;
    } else {
      iq[jz] = Math.trunc(z);
    }
  }

  let fw = scalbn(1, q0);
  for (let i = jz; i >= 0; i--) {
    q[i] = fw * iq[i];
    fw *= TWON24;
  }
  for (let i = jz; i >= 0; i--) {
    let sum = 0;
    for (let k = 0; k <= jp && k <= jz - i; k++) sum += PIO2_PIECES[k] * q[i + k];
    fq[jz - i] = sum;
  }
  let head = 0;
  for (let i = jz; i >= 0; i--) head += fq[i];
  remY0 = ih === 0 ? head : -head;
  let tail = fq[0] - head;
  for (let i = 1; i <= jz; i++) tail += fq[i];
  remY1 = ih === 0 ? tail : -tail;
  return n & 7;
}

export function sin(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelSin(x, 0, 0);
  if (ix >= 0x7ff00000) return x - x;
  const n = remPio2(x);
  switch (n & 3) {
    case 0:
      return kernelSin(remY0, remY1, 1);
    case 1:
      return kernelCos(remY0, remY1);
    case 2:
      return -kernelSin(remY0, remY1, 1);
    default:
      return -kernelCos(remY0, remY1);
  }
}

export function cos(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelCos(x, 0);
  if (ix >= 0x7ff00000) return x - x;
  const n = remPio2(x);
  switch (n & 3) {
    case 0:
      return kernelCos(remY0, remY1);
    case 1:
      return -kernelSin(remY0, remY1, 1);
    case 2:
      return -kernelCos(remY0, remY1);
    default:
      return kernelSin(remY0, remY1, 1);
  }
}

export function tan(x: number): number {
  return sin(x) / cos(x);
}

// --- exp ------------------------------------------------------------------------

const O_THRESHOLD = 7.09782712893383973096e2;
const U_THRESHOLD = -7.45133219101941108420e2;
const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700e0;
const TWOM1000 = 9.33263618503218878990e-302;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.65339022054652515390e-6;
const P5 = 4.13813679705723846039e-8;

/** fdlibm __ieee754_exp. */
export function exp(x: number): number {
  let hx = highWord(x);
  const xsb = (hx >>> 31) & 1;
  hx &= 0x7fffffff;

  if (hx >= 0x40862e42) {
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | lowWord(x)) !== 0) return x + x;
      return xsb === 0 ? x : 0;
    }
    if (x > O_THRESHOLD) return Infinity;
    if (x < U_THRESHOLD) return 0;
  }

  let hi = 0;
  let lo = 0;
  let k = 0;
  if (hx > 0x3fd62e42) {
    if (hx < 0x3ff0a2b2) {
      hi = xsb === 0 ? x - LN2_HI : x + LN2_HI;
      lo = xsb === 0 ? LN2_LO : -LN2_LO;
      k = 1 - xsb - xsb;
    } else {
      k = Math.trunc(INV_LN2 * x + (xsb === 0 ? 0.5 : -0.5));
      const t = k;
      hi = x - t * LN2_HI;
      lo = t * LN2_LO;
    }
    x = hi - lo;
  } else if (hx < 0x3e300000) {
    return 1 + x;
  } else {
    k = 0;
  }

  const t = x * x;
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2) - x);
  const y = 1 - ((lo - (x * c) / (2 - c)) - hi);
  if (k >= -1021) return withHighWord(y, highWord(y) + (k << 20));
  return withHighWord(y, highWord(y) + ((k + 1000) << 20)) * TWOM1000;
}

// --- log ------------------------------------------------------------------------

const TWO54 = 1.80143985094819840000e16;
const LG1 = 6.666666666666735130e-1;
const LG2 = 3.999999999940941908e-1;
const LG3 = 2.857142874366239149e-1;
const LG4 = 2.222219843214978396e-1;
const LG5 = 1.818357216161805012e-1;
const LG6 = 1.531383769920937332e-1;
const LG7 = 1.479819860511658591e-1;

/** fdlibm __ieee754_log. */
export function log(x: number): number {
  let hx = highWord(x);
  const lx = lowWord(x);
  let k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= TWO54;
    hx = highWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i0 = (hx + 0x95f64) & 0x100000;
  x = withHighWord(x, hx | (i0 ^ 0x3ff00000));
  k += i0 >> 20;
  const f = x - 1;
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) {
      if (k === 0) return 0;
      return k * LN2_HI + k * LN2_LO;
    }
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    if (k === 0) return f - R;
    return k * LN2_HI - ((R - k * LN2_LO) - f);
  }
  const s = f / (2 + f);
  const dk = k;
  const z = s * s;
  let i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + R));
    return dk * LN2_HI - ((hfsq - (s * (hfsq + R) + dk * LN2_LO)) - f);
  }
  if (k === 0) return f - s * (f - R);
  return dk * LN2_HI - ((s * (f - R) - dk * LN2_LO) - f);
}

function isOddInteger(y: number): boolean {
  return Number.isInteger(y) && Math.abs(y % 2) === 1;
}

/** x^n for integer n by repeated squaring: multiplications only, exact when the result is representable. */
function integerPow(x: number, y: number): number {
  let n = Math.abs(y);
  let base = x;
  let result = 1;
  while (n > 0) {
    if (n % 2 === 1) result *= base;
    n = Math.floor(n / 2);
    if (n > 0) base *= base;
  }
  return y < 0 ? 1 / result : result;
}

/**
 * x^y with JavaScript's special values (ECMA-262 Number::exponentiate).
 * Integer powers are repeated squaring, so 2^3 is 8 and 10^2 is 100; y = 0.5 is
 * a square root; everything else is exp(y·log x) from the deterministic exp
 * and log above.
 */
export function pow(x: number, y: number): number {
  if (y !== y) return NaN;
  if (y === 0) return 1;
  if (x !== x) return NaN;
  if (x === Infinity) return y > 0 ? Infinity : 0;
  if (x === -Infinity) {
    if (y > 0) return isOddInteger(y) ? -Infinity : Infinity;
    return isOddInteger(y) ? -0 : 0;
  }
  if (x === 0) {
    const negative = Object.is(x, -0) && isOddInteger(y);
    if (y > 0) return negative ? -0 : 0;
    return negative ? -Infinity : Infinity;
  }
  if (y === Infinity || y === -Infinity) {
    const a = Math.abs(x);
    if (a === 1) return NaN;
    return (a > 1) === (y > 0) ? Infinity : 0;
  }
  if (Number.isInteger(y)) return integerPow(x, y);
  if (x < 0) return NaN;
  if (y === 0.5) return Math.sqrt(x);
  return exp(y * log(x));
}

// --- atan / atan2 -----------------------------------------------------------------

const ATAN_HI = [
  4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1,
  1.57079632679489655800e0,
];
const ATAN_LO = [
  2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17,
  6.12323399573676603587e-17,
];
const AT = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1,
  -1.11111104054623557880e-1, 9.09088713343650656196e-2, -7.69187620504482999495e-2,
  6.66107313738753120669e-2, -5.83357013379057348645e-2, 4.97687799461593236017e-2,
  -3.65315727442169155270e-2, 1.62858201153657823623e-2,
];

/** fdlibm s_atan. */
export function atan(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  let id: number;
  if (ix >= 0x44100000) {
    if (x !== x) return x + x;
    return hx > 0 ? ATAN_HI[3] + ATAN_LO[3] : -ATAN_HI[3] - ATAN_LO[3];
  }
  if (ix < 0x3fdc0000) {
    if (ix < 0x3e200000) return x;
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) {
        id = 0;
        x = (2 * x - 1) / (2 + x);
      } else {
        id = 1;
        x = (x - 1) / (x + 1);
      }
    } else if (ix < 0x40038000) {
      id = 2;
      x = (x - 1.5) / (1 + 1.5 * x);
    } else {
      id = 3;
      x = -1 / x;
    }
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATAN_HI[id] - ((x * (s1 + s2) - ATAN_LO[id]) - x);
  return hx < 0 ? -r : r;
}

const PI_O_4 = 7.8539816339744827900e-1;
const PI_O_2 = 1.5707963267948965580e0;
const PI_LO = 1.2246467991473531772e-16;

/** fdlibm __ieee754_atan2. */
export function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return NaN;
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  const lx = lowWord(x);
  const hy = highWord(y);
  const iy = hy & 0x7fffffff;
  const ly = lowWord(y);
  if (x === 1) return atan(y);
  const m = ((hy >>> 31) & 1) | ((hx >>> 30) & 2);

  if ((iy | ly) === 0) {
    if (m < 2) return y;
    return m === 2 ? PI : -PI;
  }
  if ((ix | lx) === 0) return hy < 0 ? -PI_O_2 : PI_O_2;

  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) {
      switch (m) {
        case 0: return PI_O_4;
        case 1: return -PI_O_4;
        case 2: return 3 * PI_O_4;
        default: return -3 * PI_O_4;
      }
    }
    switch (m) {
      case 0: return 0;
      case 1: return -0;
      case 2: return PI;
      default: return -PI;
    }
  }
  if (iy === 0x7ff00000) return hy < 0 ? -PI_O_2 : PI_O_2;

  const k = (iy - ix) >> 20;
  let z: number;
  if (k > 60) z = PI_O_2 + 0.5 * PI_LO;
  else if (hx < 0 && k < -60) z = 0;
  else z = atan(Math.abs(y / x));
  switch (m) {
    case 0: return z;
    case 1: return -z;
    case 2: return PI - (z - PI_LO);
    default: return (z - PI_LO) - PI;
  }
}
