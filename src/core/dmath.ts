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

/**
 * fdlibm __ieee754_rem_pio2: x = n·π/2 + (remY0 + remY1), returning n.
 * Arguments past 2^19·π/2 take the same three-step Cody–Waite reduction rather
 * than Payne–Hanek; that is still deterministic, merely less accurate at angles
 * the game never produces.
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
  const t0 = Math.abs(x);
  const n = Math.trunc(t0 * INV_PIO2 + 0.5);
  const fn = n;
  let r = t0 - fn * PIO2_1;
  let w = fn * PIO2_1T;
  const j = ix >> 20;
  remY0 = r - w;
  let i = j - ((highWord(remY0) >> 20) & 0x7ff);
  if (i > 16) {
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

/**
 * x^y as exp(y·log x). Not fdlibm's e_pow, so a few ulps looser, but built from
 * the deterministic exp and log above, which is the property that matters here.
 */
export function pow(x: number, y: number): number {
  if (y === 0) return 1;
  if (x !== x || y !== y) return NaN;
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x > 0) return exp(y * log(x));
  if (Math.floor(y) !== y || !Number.isFinite(y)) return NaN;
  const magnitude = exp(y * log(-x));
  return Math.abs(y % 2) === 1 ? -magnitude : magnitude;
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
