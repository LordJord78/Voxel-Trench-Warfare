// The atmosphere, after Hillaire (2020): Rayleigh, Mie and ozone over a
// spherical earth, in kilometres. These are the pure parts shared by the LUT
// builds (atmosphere-luts.wgsl) and by shading: the media, where a ray meets
// the ground and the top, the phase functions, and how each LUT's texels map
// to what they hold. The Atmosphere struct is generated from frame-uniforms.ts
// and prepended to each module.

const PI_ATM: f32 = 3.14159265;

// The sky view holds radiance this many times over, which keeps twilight's out of half floats'
// denormals; sampling divides it out.
const LUT_SCALE: f32 = 16384.0;

struct Media {
  rayleigh: vec3f,
  mie: f32,
  extinction: vec3f,
}

fn media(a: Atmosphere, h: f32) -> Media {
  let dr = exp(-h / a.rayleighHeight);
  let dm = exp(-h / a.mieHeight);
  let dozone = max(0.0, 1.0 - abs(h - a.ozoneCentre) / a.ozoneHalfWidth);
  return Media(a.rayleigh * dr, a.mieScattering * dm, a.rayleigh * dr + a.mieExtinction * dm + a.ozone * dozone);
}

// The sphere tests take a point as r, its distance from the earth's centre, and c = r² - bottom²,
// and a direction from it as b = r cos(its angle from the zenith). Callers form c from heights, as
// h (2 bottom + h) (heightC), and carry it along a ray as c + t (2b + t): near the ground a
// difference of squares in f32 would lose it to rounding (±4 km² against the 25 km² of a point 2 m
// up), misplacing the ground and shadowing points beside it.
fn heightC(a: Atmosphere, h: f32) -> f32 {
  return h * (2.0 * a.bottom + h);
}

// The distance to the ground, or -1 if the ray misses it. A point on (or, by rounding, just inside)
// the ground that looks down meets it at once, never through the planet.
fn groundHit(b: f32, c: f32) -> f32 {
  if (c <= 0.0) {
    return select(-1.0, 0.0, b < 0.0);
  }
  let disc = b * b - c;
  if (disc < 0.0 || b >= 0.0) {
    return -1.0;
  }
  // The near root, without the cancellation of -b - sqrt(disc).
  return c / (-b + sqrt(disc));
}

// From inside the atmosphere, the distance to its top: 0 from the top looking out.
fn topHit(a: Atmosphere, b: f32, c: f32) -> f32 {
  let ct = c - (a.top * a.top - a.bottom * a.bottom);
  return max(0.0, -b + sqrt(max(0.0, b * b - ct)));
}

// A point t along a ray from (r, b, c): its distance from the centre, its height, and its c.
struct AirPoint {
  r: f32,
  h: f32,
  c: f32,
}

fn alongRay(a: Atmosphere, b: f32, c: f32, t: f32) -> AirPoint {
  let ct = c + t * (2.0 * b + t);
  let r = sqrt(a.bottom * a.bottom + ct);
  return AirPoint(r, ct / (r + a.bottom), ct);
}

fn rayleighPhase(cosT: f32) -> f32 {
  return 3.0 / (16.0 * PI_ATM) * (1.0 + cosT * cosT);
}

// Cornette-Shanks, as Hillaire uses.
fn miePhase(g: f32, cosT: f32) -> f32 {
  let k = 3.0 / (8.0 * PI_ATM) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + cosT * cosT) / pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-4), 1.5);
}

// Texel centres span [0, 1] exactly: a LUT of n texels holds unit 0 at its first centre and 1 at its last.
fn unitFromUv(u: f32, n: f32) -> f32 {
  return (u - 0.5 / n) * n / (n - 1.0);
}

fn uvFromUnit(u: f32, n: f32) -> f32 {
  return u * (n - 1.0) / n + 0.5 / n;
}

const TRANSMITTANCE_SIZE: vec2f = vec2f(256.0, 64.0);
// The sun's cosine across, height up.
const SCATTERING_SIZE: vec2f = vec2f(64.0, 32.0);
const SKY_VIEW_SIZE: vec2f = vec2f(192.0, 108.0);

// Bruneton's parametrisation of the transmittance LUT: (distance to the top along the ray, height),
// for a point (r, c) looking along cosine mu from its zenith.
fn transmittanceUnit(a: Atmosphere, r: f32, c: f32, mu: f32) -> vec2f {
  let big = sqrt(a.top * a.top - a.bottom * a.bottom);
  let rho = sqrt(max(c, 0.0));
  // -r mu + sqrt(r² (mu² - 1) + top²), with r² - top² as c - big².
  let d = max(0.0, -r * mu + sqrt(max(r * r * mu * mu - (c - big * big), 0.0)));
  let dMin = a.top - r;
  let dMax = rho + big;
  return vec2f((d - dMin) / (dMax - dMin), rho / big);
}

// The (radius, cosine of zenith) a transmittance texel holds.
fn transmittanceParams(a: Atmosphere, unit: vec2f) -> vec2f {
  let big = sqrt(a.top * a.top - a.bottom * a.bottom);
  let rho = big * unit.y;
  let r = sqrt(rho * rho + a.bottom * a.bottom);
  let dMin = a.top - r;
  let dMax = rho + big;
  let d = dMin + unit.x * (dMax - dMin);
  let mu = select((big * big - rho * rho - d * d) / (2.0 * r * d), 1.0, d == 0.0);
  return vec2f(r, clamp(mu, -1.0, 1.0));
}

fn sampleTransmittance(lut: texture_2d<f32>, s: sampler, a: Atmosphere, r: f32, c: f32, mu: f32) -> vec3f {
  let unit = clamp(transmittanceUnit(a, r, c, mu), vec2f(0.0), vec2f(1.0));
  let uv = vec2f(uvFromUnit(unit.x, TRANSMITTANCE_SIZE.x), uvFromUnit(unit.y, TRANSMITTANCE_SIZE.y));
  return textureSampleLevel(lut, s, uv, 0.0).rgb;
}

// Sunlight arriving at a point (r, c), with the sun at b = r cos(its zenith angle): its
// transmittance from the top, or none behind the earth.
fn sunlight(lut: texture_2d<f32>, s: sampler, a: Atmosphere, r: f32, c: f32, b: f32) -> vec3f {
  if (groundHit(b, c) >= 0.0) {
    return vec3f(0.0);
  }
  return sampleTransmittance(lut, s, a, r, c, b / r);
}

// The multiple-scattering LUT's sun axis: MU_CENTRE ± a sinh(k t)/sinh(k) for t = 2 unit - 1, from
// MU_LOW (deep night, where Ψms is negligible) to 1, crowded round the horizon where Ψms bends from
// daylight's slow change to twilight's exponential fall. Its height axis is h = (top - bottom) y².
const MU_CENTRE: f32 = -0.02;
const MU_LOW: f32 = -0.5;
const MU_K: f32 = 3.0;

fn scatteringMu(unit: f32) -> f32 {
  let t = 2.0 * unit - 1.0;
  let a = select(1.0 - MU_CENTRE, MU_CENTRE - MU_LOW, t < 0.0);
  return MU_CENTRE + a * sinh(MU_K * t) / sinh(MU_K);
}

fn scatteringUnit(muS: f32) -> f32 {
  let a = select(1.0 - MU_CENTRE, MU_CENTRE - MU_LOW, muS < MU_CENTRE);
  let t = asinh((muS - MU_CENTRE) * sinh(MU_K) / a) / MU_K;
  return clamp(t, -1.0, 1.0) * 0.5 + 0.5;
}

// Ψms, light scattered more than once, at radius r with the sun at cosine muS from the zenith. The
// LUT holds its log, in full floats, read bilinearly by hand: below the horizon Ψms falls by orders
// of magnitude, nearly exponentially, which the log follows.
fn sampleScattering(lut: texture_2d<f32>, a: Atmosphere, r: f32, muS: f32) -> vec3f {
  let h = clamp((r - a.bottom) / (a.top - a.bottom), 0.0, 1.0);
  let texel = vec2f(scatteringUnit(muS), sqrt(h)) * (SCATTERING_SIZE - 1.0);
  let base = min(vec2u(texel), vec2u(SCATTERING_SIZE) - 2u);
  let f = texel - vec2f(base);
  let l00 = textureLoad(lut, base, 0).rgb;
  let l10 = textureLoad(lut, base + vec2u(1u, 0u), 0).rgb;
  let l01 = textureLoad(lut, base + vec2u(0u, 1u), 0).rgb;
  let l11 = textureLoad(lut, base + vec2u(1u, 1u), 0).rgb;
  return exp(mix(mix(l00, l10, f.x), mix(l01, l11, f.x), f.y));
}

// The angle below the horizontal at which a viewer at height h sees the horizon.
fn horizonDip(a: Atmosphere, h: f32) -> f32 {
  return acos(clamp(sqrt(heightC(a, h)) / (a.bottom + h), -1.0, 1.0));
}

// Hillaire's sky-view mapping, for a viewer whose horizon dips `beta` below the horizontal (so it
// stands at zenith angle pi - beta): the zenith angle a unit row holds, with the horizon given half
// the rows, and the angle from the light's azimuth a unit column holds, crowded toward the light.
fn zenithOf(beta: f32, v: f32) -> f32 {
  let zenithHorizon = PI_ATM - beta;
  if (v < 0.5) {
    let c = 1.0 - 2.0 * v;
    return zenithHorizon * (1.0 - c * c);
  }
  let c = 2.0 * v - 1.0;
  return zenithHorizon + beta * c * c;
}

fn azimuthOf(u: f32) -> f32 {
  return acos(clamp(1.0 - 2.0 * u * u, -1.0, 1.0));
}

// (cosine of the angle from the light's azimuth, cosine of the zenith angle) for a unit position.
fn skyViewParams(a: Atmosphere, h: f32, unit: vec2f) -> vec2f {
  return vec2f(cos(azimuthOf(unit.x)), cos(zenithOf(horizonDip(a, h), unit.y)));
}

fn skyViewUnit(a: Atmosphere, h: f32, cosAzimuth: f32, cosZenith: f32) -> vec2f {
  let beta = horizonDip(a, h);
  let zenithHorizon = PI_ATM - beta;
  let zenith = acos(clamp(cosZenith, -1.0, 1.0));
  var v: f32;
  if (zenith < zenithHorizon) {
    let c = sqrt(max(1.0 - zenith / zenithHorizon, 0.0));
    v = (1.0 - c) * 0.5;
  } else {
    let c = sqrt(max((zenith - zenithHorizon) / beta, 0.0));
    v = c * 0.5 + 0.5;
  }
  let u = sqrt(clamp(-cosAzimuth * 0.5 + 0.5, 0.0, 1.0));
  return vec2f(u, v);
}

// The sky's radiance along unit rd (y up), per unit of the light's illuminance, from the sky-view
// layer built for this viewer's height and lit from `light`.
fn skyViewSample(lut: texture_2d_array<f32>, s: sampler, a: Atmosphere, rd: vec3f, light: vec3f, layer: i32) -> vec3f {
  let flatView = vec2f(rd.x, rd.z);
  let flatLight = vec2f(light.x, light.z);
  let lv = length(flatView);
  let ll = length(flatLight);
  let cosAzimuth = select(1.0, dot(flatView, flatLight) / (lv * ll), lv > 1e-6 && ll > 1e-6);
  let unit = skyViewUnit(a, max(a.viewHeight, 0.0), cosAzimuth, rd.y);
  let uv = vec2f(uvFromUnit(unit.x, SKY_VIEW_SIZE.x), uvFromUnit(unit.y, SKY_VIEW_SIZE.y));
  return textureSampleLevel(lut, s, uv, layer, 0.0).rgb / LUT_SCALE;
}
