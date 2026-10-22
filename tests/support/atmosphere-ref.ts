/**
 * A CPU reference for the sky, in f64: Hillaire's 2020 atmosphere (Rayleigh,
 * Mie and ozone over a spherical earth, multiple scattering by his Ψms
 * approximation), integrated with finer tables and many more steps than the
 * GPU's LUTs use, so a test can measure what the LUTs' resolution and step
 * counts cost. Distances are kilometres; radiance is per unit sun illuminance.
 */

import type { AtmosphereModel, Rgb } from '../../src/render/atmosphere';

export type { AtmosphereModel, Rgb };

/** Earth as Hillaire's paper gives it, with the spec's ground albedo. */
export const EARTH: AtmosphereModel = {
  bottom: 6360,
  top: 6460,
  rayleigh: [5.802e-3, 13.558e-3, 33.1e-3],
  rayleighHeight: 8,
  mieScattering: 3.996e-3,
  mieExtinction: 4.44e-3,
  mieHeight: 1.2,
  mieG: 0.8,
  ozone: [0.65e-3, 1.881e-3, 0.085e-3],
  ozoneCentre: 25,
  ozoneHalfWidth: 15,
  albedo: 0.3,
};

export type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/**
 * Along unit `d` from `o`, the distance to the ground, or -1 if the ray misses it. A point on the
 * ground (or inside it) that looks down meets it at once, never through the planet.
 */
export function groundHit(m: AtmosphereModel, o: V3, d: V3): number {
  const b = dot(o, d);
  const c = dot(o, o) - m.bottom * m.bottom;
  if (c <= 0) return b < 0 ? 0 : -1;
  const disc = b * b - c;
  if (disc < 0 || b >= 0) return -1;
  // The near root, without the cancellation of -b - sqrt(disc).
  return c / (-b + Math.sqrt(disc));
}

/** From inside the atmosphere along unit `d`, the distance to its top: 0 from the top looking out. */
export function topHit(m: AtmosphereModel, o: V3, d: V3): number {
  const b = dot(o, d);
  const c = dot(o, o) - m.top * m.top;
  return Math.max(0, -b + Math.sqrt(Math.max(0, b * b - c)));
}

/** The media at a height: Rayleigh scattering and extinction per channel, and Mie scattering. */
interface Media {
  r0: number;
  r1: number;
  r2: number;
  mie: number;
  e0: number;
  e1: number;
  e2: number;
}

const newMedia = (): Media => ({ r0: 0, r1: 0, r2: 0, mie: 0, e0: 0, e1: 0, e2: 0 });

function mediaAt(m: AtmosphereModel, h: number, out: Media): Media {
  const dr = Math.exp(-h / m.rayleighHeight);
  const dm = Math.exp(-h / m.mieHeight);
  const dz = Math.max(0, 1 - Math.abs(h - m.ozoneCentre) / m.ozoneHalfWidth);
  out.r0 = m.rayleigh[0] * dr;
  out.r1 = m.rayleigh[1] * dr;
  out.r2 = m.rayleigh[2] * dr;
  out.mie = m.mieScattering * dm;
  out.e0 = out.r0 + m.mieExtinction * dm + m.ozone[0] * dz;
  out.e1 = out.r1 + m.mieExtinction * dm + m.ozone[1] * dz;
  out.e2 = out.r2 + m.mieExtinction * dm + m.ozone[2] * dz;
  return out;
}

/** Transmittance from radius r along cosine-of-zenith mu to the top, ignoring the ground. */
export function transmittanceToTop(m: AtmosphereModel, r: number, mu: number, steps = 500): Rgb {
  const dx = Math.sqrt(Math.max(0, 1 - mu * mu));
  const tMax = topHit(m, [0, r, 0], [dx, mu, 0]);
  if (tMax <= 0) return [1, 1, 1];
  const md = newMedia();
  let d0 = 0;
  let d1 = 0;
  let d2 = 0;
  const dt = tMax / steps;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * dt;
    const x = dx * s;
    const y = r + mu * s;
    mediaAt(m, Math.sqrt(x * x + y * y) - m.bottom, md);
    d0 += md.e0 * dt;
    d1 += md.e1 * dt;
    d2 += md.e2 * dt;
  }
  return [Math.exp(-d0), Math.exp(-d1), Math.exp(-d2)];
}

/** A finer transmittance table than the GPU's, over (radius, mu) with both linear, read bilinearly. */
export class TransmittanceTable {
  private readonly data: Float64Array;
  constructor(
    private readonly m: AtmosphereModel,
    private readonly nr = 256,
    private readonly nmu = 512,
  ) {
    this.data = new Float64Array(nr * nmu * 3);
    for (let i = 0; i < nr; i++) {
      const r = m.bottom + ((m.top - m.bottom) * i) / (nr - 1);
      for (let j = 0; j < nmu; j++) this.data.set(transmittanceToTop(m, r, -1 + (2 * j) / (nmu - 1), 300), (i * nmu + j) * 3);
    }
  }
  /** The transmittance into `out`'s first three entries. */
  into(r: number, mu: number, out: number[]): number[] {
    const x = Math.min(this.nr - 1, Math.max(0, ((r - this.m.bottom) / (this.m.top - this.m.bottom)) * (this.nr - 1)));
    const y = Math.min(this.nmu - 1, Math.max(0, ((mu + 1) / 2) * (this.nmu - 1)));
    const x0 = Math.min(this.nr - 2, Math.floor(x));
    const y0 = Math.min(this.nmu - 2, Math.floor(y));
    const fx = x - x0;
    const fy = y - y0;
    const d = this.data;
    const a = (x0 * this.nmu + y0) * 3;
    const b = ((x0 + 1) * this.nmu + y0) * 3;
    for (let c = 0; c < 3; c++) out[c] = (d[a + c] * (1 - fx) + d[b + c] * fx) * (1 - fy) + (d[a + 3 + c] * (1 - fx) + d[b + 3 + c] * fx) * fy;
    return out;
  }
  at(r: number, mu: number): Rgb {
    return this.into(r, mu, [0, 0, 0]) as Rgb;
  }
}

/** Sunlight reaching point p, into `out`: its transmittance, or nothing behind the earth. */
function sunlightInto(m: AtmosphereModel, table: TransmittanceTable, p: V3, sun: V3, out: number[]): number[] {
  if (groundHit(m, p, sun) >= 0) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const r = len(p);
  return table.into(r, dot(p, sun) / r, out);
}

const rayleighPhase = (cosT: number) => (3 / (16 * Math.PI)) * (1 + cosT * cosT);
/** Cornette-Shanks, as Hillaire uses. */
function miePhase(g: number, cosT: number): number {
  const k = (3 / (8 * Math.PI)) * ((1 - g * g) / (2 + g * g));
  return (k * (1 + cosT * cosT)) / Math.pow(1 + g * g - 2 * g * cosT, 1.5);
}

export interface Direction {
  d: V3;
  /** Its share of the whole sphere. */
  w: number;
}

/**
 * Directions for the integral over the sphere behind Ψms: `elevations` rings at cos θ = u³ for u
 * evenly spaced in (-1, 1), which crowds them toward the horizon (twilight's light arrives along
 * it), each with `azimuths` directions over φ in (0, π). The sun lies in the plane φ = 0, so the
 * other half-circle mirrors this one, and its share is folded into the weights.
 */
export function sphereQuadrature(elevations: number, azimuths: number): Direction[] {
  const out: Direction[] = [];
  for (let a = 0; a < elevations; a++) {
    const u = -1 + (2 * (a + 0.5)) / elevations;
    const cosT = u * u * u;
    const sinT = Math.sqrt(1 - cosT * cosT);
    // d(cos θ)/du = 3u², over the sphere's span of 2 in cos θ, shared by the half-circle's azimuths.
    const w = (3 * u * u * (2 / elevations)) / 2 / azimuths;
    for (let b = 0; b < azimuths; b++) {
      const phi = (Math.PI * (b + 0.5)) / azimuths;
      out.push({ d: [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)], w });
    }
  }
  return out;
}

/** Uniform in cos θ and φ over the whole sphere: the slow, plain quadrature the others are checked against. */
export function uniformSphere(elevations: number, azimuths: number): Direction[] {
  const out: Direction[] = [];
  for (let a = 0; a < elevations; a++) {
    const cosT = 1 - (2 * (a + 0.5)) / elevations;
    const sinT = Math.sqrt(1 - cosT * cosT);
    for (let b = 0; b < azimuths; b++) {
      const phi = (2 * Math.PI * (b + 0.5)) / azimuths;
      out.push({ d: [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)], w: 1 / (elevations * azimuths) });
    }
  }
  return out;
}

/** 64 rings by 16 azimuths (8 mirrored): within 0.2% of a uniform 256 × 128 sphere, twilight included. */
const SPHERE = sphereQuadrature(64, 8);

/** Hillaire's Ψms at radius r with the sun at cosine muS from the zenith. */
export function multipleScattering(m: AtmosphereModel, table: TransmittanceTable, r: number, muS: number, quad: Direction[] = SPHERE, steps = 40): Rgb {
  const sun: V3 = [Math.sqrt(Math.max(0, 1 - muS * muS)), muS, 0];
  const o: V3 = [0, r, 0];
  const md = newMedia();
  const lit = [0, 0, 0];
  const p: V3 = [0, 0, 0];
  let l0 = 0;
  let l1 = 0;
  let l2 = 0;
  let f0 = 0;
  let f1 = 0;
  let f2 = 0;
  for (const { d, w } of quad) {
    const ground = groundHit(m, o, d);
    const tMax = ground >= 0 ? ground : topHit(m, o, d);
    const dt = tMax / steps;
    let t0 = 1;
    let t1 = 1;
    let t2 = 1;
    for (let i = 0; i < steps; i++) {
      const s = (i + 0.5) * dt;
      p[0] = d[0] * s;
      p[1] = r + d[1] * s;
      p[2] = d[2] * s;
      mediaAt(m, len(p) - m.bottom, md);
      sunlightInto(m, table, p, sun, lit);
      // ∫ T(s) σs ds over each step, with T falling exponentially across it.
      const g0 = Math.exp(-md.e0 * dt);
      const g1 = Math.exp(-md.e1 * dt);
      const g2 = Math.exp(-md.e2 * dt);
      const i0 = (t0 * (md.r0 + md.mie) * (1 - g0)) / md.e0;
      const i1 = (t1 * (md.r1 + md.mie) * (1 - g1)) / md.e1;
      const i2 = (t2 * (md.r2 + md.mie) * (1 - g2)) / md.e2;
      l0 += (i0 * lit[0] * w) / (4 * Math.PI);
      l1 += (i1 * lit[1] * w) / (4 * Math.PI);
      l2 += (i2 * lit[2] * w) / (4 * Math.PI);
      f0 += i0 * w;
      f1 += i1 * w;
      f2 += i2 * w;
      t0 *= g0;
      t1 *= g1;
      t2 *= g2;
    }
    if (ground >= 0) {
      const pg = add(o, d, ground);
      const up: V3 = [pg[0] / len(pg), pg[1] / len(pg), pg[2] / len(pg)];
      sunlightInto(m, table, add(pg, up, 1e-3), sun, lit);
      const k = (Math.max(0, dot(up, sun)) * m.albedo * w) / Math.PI;
      l0 += t0 * lit[0] * k;
      l1 += t1 * lit[1] * k;
      l2 += t2 * lit[2] * k;
    }
  }
  return [l0 / (1 - f0), l1 / (1 - f1), l2 / (1 - f2)];
}

// The sun's cosine for a unit coordinate: MU_CENTRE ± a sinh(k t)/sinh(k) for t = 2 unit - 1, from
// MU_LOW (deep night, where Ψms is negligible) to 1, crowded round the horizon where Ψms bends.
const MU_CENTRE = -0.02;
const MU_LOW = -0.5;
const MU_K = 3;

export function scatteringMu(unit: number): number {
  const t = 2 * unit - 1;
  const a = t < 0 ? MU_CENTRE - MU_LOW : 1 - MU_CENTRE;
  return MU_CENTRE + (a * Math.sinh(MU_K * t)) / Math.sinh(MU_K);
}

export function scatteringUnit(muS: number): number {
  const a = muS < MU_CENTRE ? MU_CENTRE - MU_LOW : 1 - MU_CENTRE;
  const t = Math.asinh(((muS - MU_CENTRE) * Math.sinh(MU_K)) / a) / MU_K;
  return (Math.min(1, Math.max(-1, t)) + 1) / 2;
}

/**
 * A Ψms table over (height, sun cosine), finer than the GPU's, holding ln Ψms and read bilinearly in
 * it: below the horizon Ψms falls by orders of magnitude, nearly exponentially, which the log
 * follows. Heights crowd toward the ground, as h = (top - bottom) y²; the sun's cosine crowds round
 * the horizon (scatteringMu).
 */
export class ScatteringTable {
  private readonly data: Float64Array;
  constructor(
    private readonly m: AtmosphereModel,
    table: TransmittanceTable,
    private readonly nh = 64,
    private readonly nmu = 128,
    quad: Direction[] = SPHERE,
    steps = 60,
  ) {
    this.data = new Float64Array(nh * nmu * 3);
    for (let i = 0; i < nh; i++) {
      const y = i / (nh - 1);
      const r = m.bottom + (m.top - m.bottom) * y * y;
      for (let j = 0; j < nmu; j++) {
        const psi = multipleScattering(m, table, r, scatteringMu(j / (nmu - 1)), quad, steps);
        this.data.set(
          psi.map((v) => Math.log(Math.max(v, 1e-300))),
          (i * nmu + j) * 3,
        );
      }
    }
  }
  at(r: number, muS: number): Rgb {
    const h = Math.max(0, (r - this.m.bottom) / (this.m.top - this.m.bottom));
    const x = Math.min(this.nh - 1, Math.sqrt(h) * (this.nh - 1));
    const y = Math.min(this.nmu - 1, Math.max(0, scatteringUnit(muS) * (this.nmu - 1)));
    const x0 = Math.min(this.nh - 2, Math.floor(x));
    const y0 = Math.min(this.nmu - 2, Math.floor(y));
    const fx = x - x0;
    const fy = y - y0;
    const d = this.data;
    const a = (x0 * this.nmu + y0) * 3;
    const b = ((x0 + 1) * this.nmu + y0) * 3;
    return [0, 1, 2].map((c) => Math.exp((d[a + c] * (1 - fx) + d[b + c] * fx) * (1 - fy) + (d[a + 3 + c] * (1 - fx) + d[b + 3 + c] * fx) * fy)) as Rgb;
  }
}

/**
 * The sky's radiance along unit `view` from `heightKm` above the ground, with the sun along unit
 * `sun` (y up at the viewer), per unit sun illuminance: single scattering by Rayleigh and Mie plus
 * Ψms, and the lit ground where the ray meets it.
 */
export function skyRadiance(m: AtmosphereModel, table: TransmittanceTable, psi: { at(r: number, muS: number): Rgb }, sun: V3, view: V3, heightKm: number, steps = 400): Rgb {
  const o: V3 = [0, m.bottom + heightKm, 0];
  const ground = groundHit(m, o, view);
  const tMax = ground >= 0 ? ground : topHit(m, o, view);
  const out: Rgb = [0, 0, 0];
  if (tMax <= 0) return out;
  const cosT = dot(view, sun);
  const pr = rayleighPhase(cosT);
  const pm = miePhase(m.mieG, cosT);
  const dt = tMax / steps;
  const throughput: Rgb = [1, 1, 1];
  const md = newMedia();
  const lit = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const p = add(o, view, (i + 0.5) * dt);
    const r = len(p);
    mediaAt(m, r - m.bottom, md);
    sunlightInto(m, table, p, sun, lit);
    const ms = psi.at(r, dot(p, sun) / r);
    const sr = [md.r0, md.r1, md.r2];
    const e = [md.e0, md.e1, md.e2];
    for (let c = 0; c < 3; c++) {
      const source = lit[c] * (sr[c] * pr + md.mie * pm) + (sr[c] + md.mie) * ms[c];
      const step = Math.exp(-e[c] * dt);
      out[c] += (throughput[c] * source * (1 - step)) / e[c];
      throughput[c] *= step;
    }
  }
  if (ground >= 0) {
    const pg = add(o, view, ground);
    const up: V3 = [pg[0] / len(pg), pg[1] / len(pg), pg[2] / len(pg)];
    sunlightInto(m, table, add(pg, up, 1e-3), sun, lit);
    const cosSun = Math.max(0, dot(up, sun));
    for (let c = 0; c < 3; c++) out[c] += throughput[c] * lit[c] * cosSun * (m.albedo / Math.PI);
  }
  return out;
}
