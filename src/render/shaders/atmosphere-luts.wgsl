// Building the atmosphere's three LUTs (Hillaire 2020), one entry point each:
//   transmittanceLut — light lost from a height along a direction to the top;
//   scatteringLut    — Ψms, every order of scattering past the first, by his
//                      isotropic approximation: one workgroup per texel, one
//                      ring of directions per invocation;
//   skyViewLut       — the sky's radiance from the viewer's height, by the
//                      angle from the sun's azimuth and the zenith angle.
// Each pipeline takes its own (automatic) layout, so no texture is written and
// read in one dispatch. Radiance is per unit sun illuminance.
#include "atmosphere-model.wgsl"

@group(0) @binding(0) var<uniform> atm: Atmosphere;
@group(0) @binding(1) var transmittanceIn: texture_2d<f32>;
@group(0) @binding(2) var scatteringIn: texture_2d<f32>;
@group(0) @binding(3) var lutSampler: sampler;
@group(0) @binding(4) var transmittanceOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var scatteringOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(6) var skyViewOut: texture_storage_2d<rgba16float, write>;

fn unitOf(g: vec2u, size: vec2f) -> vec2f {
  let uv = (vec2f(g) + 0.5) / size;
  return vec2f(unitFromUv(uv.x, size.x), unitFromUv(uv.y, size.y));
}

// ∫ T(s) σ ds across a step where the transmittance falls by `fall`: exact for constant media.
fn stepIntegral(throughput: vec3f, source: vec3f, extinction: vec3f, fall: vec3f, dt: f32) -> vec3f {
  return select(throughput * source * dt, throughput * source * (1.0 - fall) / extinction, extinction > vec3f(0.0));
}

// Sunlight on the ground where it faces `up`, times its albedo: the light it scatters is this over π.
fn groundLight(a: Atmosphere, up: vec3f, sun: vec3f) -> vec3f {
  // Lifted a metre, clear of the ground's own shadow test.
  let h = 1e-3;
  let r = a.bottom + h;
  let lit = sunlight(transmittanceIn, lutSampler, a, r, heightC(a, h), r * dot(up, sun));
  return lit * max(dot(up, sun), 0.0) * a.albedo;
}

@compute @workgroup_size(8, 8)
fn transmittanceLut(@builtin(global_invocation_id) g: vec3u) {
  if (any(vec2f(g.xy) >= TRANSMITTANCE_SIZE)) {
    return;
  }
  let rm = transmittanceParams(atm, unitOf(g.xy, TRANSMITTANCE_SIZE));
  // The texel's radius came from rho, so its c is rho², exactly.
  let c = rm.x * rm.x - atm.bottom * atm.bottom;
  let b = rm.x * rm.y;
  let steps = 40.0;
  let dt = topHit(atm, b, c) / steps;
  var depth = vec3f(0.0);
  for (var i = 0.0; i < steps; i += 1.0) {
    depth += media(atm, alongRay(atm, b, c, (i + 0.5) * dt).h).extinction * dt;
  }
  textureStore(transmittanceOut, g.xy, vec4f(exp(-depth), 1.0));
}

// The sphere of directions Ψms gathers from: RINGS rings at cos θ = u³ for u evenly spaced in
// (-1, 1), which crowds them toward the horizon (twilight's light arrives along it), each with
// RING_AZIMUTHS directions over the half-circle φ in (0, π). The sun lies in the plane φ = 0, so
// the other half mirrors this one.
const RINGS: u32 = 64u;
const RING_AZIMUTHS: f32 = 8.0;
const SCATTERING_STEPS: f32 = 40.0;

var<workgroup> gathered: array<vec4f, RINGS>;
var<workgroup> scattered: array<vec4f, RINGS>;

@compute @workgroup_size(RINGS)
fn scatteringLut(@builtin(workgroup_id) texel: vec3u, @builtin(local_invocation_index) ring: u32) {
  let unit = unitOf(texel.xy, SCATTERING_SIZE);
  let muS = scatteringMu(unit.x);
  let h = (atm.top - atm.bottom) * unit.y * unit.y;
  let r = atm.bottom + h;
  let c = heightC(atm, h);
  let sun = vec3f(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0);
  let u = -1.0 + 2.0 * (f32(ring) + 0.5) / f32(RINGS);
  let cosT = u * u * u;
  let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  // Each direction's share of the sphere: d(cos θ)/du = 3u², over the sphere's span of 2 in cos θ,
  // shared by the half-circle's azimuths.
  let w = 3.0 * u * u * (2.0 / f32(RINGS)) / 2.0 / RING_AZIMUTHS;
  var lum = vec3f(0.0);
  var f = vec3f(0.0);
  for (var b = 0.0; b < RING_AZIMUTHS; b += 1.0) {
    let phi = PI_ATM * (b + 0.5) / RING_AZIMUTHS;
    let d = vec3f(sinT * cos(phi), cosT, sinT * sin(phi));
    let b = r * cosT;
    let bSun = r * muS;
    let cosSun = dot(d, sun);
    let ground = groundHit(b, c);
    let tMax = select(topHit(atm, b, c), ground, ground >= 0.0);
    let dt = tMax / SCATTERING_STEPS;
    var throughput = vec3f(1.0);
    for (var i = 0.0; i < SCATTERING_STEPS; i += 1.0) {
      let t = (i + 0.5) * dt;
      let p = alongRay(atm, b, c, t);
      let m = media(atm, p.h);
      let fall = exp(-m.extinction * dt);
      let integral = stepIntegral(throughput, m.rayleigh + vec3f(m.mie), m.extinction, fall, dt);
      lum += integral * sunlight(transmittanceIn, lutSampler, atm, p.r, p.c, bSun + t * cosSun) * (w / (4.0 * PI_ATM));
      f += integral * w;
      throughput *= fall;
    }
    if (ground >= 0.0) {
      lum += throughput * groundLight(atm, normalize(vec3f(0.0, r, 0.0) + d * ground), sun) * (w / PI_ATM);
    }
  }
  gathered[ring] = vec4f(lum, 0.0);
  scattered[ring] = vec4f(f, 0.0);
  workgroupBarrier();
  for (var half = RINGS / 2u; half > 0u; half >>= 1u) {
    if (ring < half) {
      gathered[ring] += gathered[ring + half];
      scattered[ring] += scattered[ring + half];
    }
    workgroupBarrier();
  }
  if (ring == 0u) {
    let psi = gathered[0].rgb / (vec3f(1.0) - scattered[0].rgb);
    textureStore(scatteringOut, texel.xy, vec4f(log(max(psi, vec3f(1e-30))), 0.0));
  }
}

@compute @workgroup_size(8, 8)
fn skyViewLut(@builtin(global_invocation_id) g: vec3u) {
  if (any(vec2f(g.xy) >= SKY_VIEW_SIZE)) {
    return;
  }
  let h = max(atm.viewHeight, 0.0);
  let r = atm.bottom + h;
  let c = heightC(atm, h);
  let angles = skyViewParams(atm, h, unitOf(g.xy, SKY_VIEW_SIZE));
  let sinZ = sqrt(max(0.0, 1.0 - angles.y * angles.y));
  let sinA = sqrt(max(0.0, 1.0 - angles.x * angles.x));
  let view = vec3f(sinZ * angles.x, angles.y, sinZ * sinA);
  // In this frame the sun stands at azimuth 0, at its elevation as seen.
  let sun = vec3f(sqrt(max(0.0, 1.0 - atm.sunDir.y * atm.sunDir.y)), atm.sunDir.y, 0.0);
  let b = r * view.y;
  let bSun = r * sun.y;
  let ground = groundHit(b, c);
  let tMax = select(topHit(atm, b, c), ground, ground >= 0.0);
  let cosT = dot(view, sun);
  let pr = rayleighPhase(cosT);
  let pm = miePhase(atm.mieG, cosT);
  var radiance = vec3f(0.0);
  var throughput = vec3f(1.0);
  // Segments growing with the square of their index, short near the eye where the air is densest,
  // each sampled at its middle (where an exponential's mean sits as a segment shrinks).
  let steps = 40.0;
  for (var i = 0.0; i < steps; i += 1.0) {
    let t0 = tMax * (i / steps) * (i / steps);
    let t1 = tMax * ((i + 1.0) / steps) * ((i + 1.0) / steps);
    let dt = t1 - t0;
    let t = t0 + 0.5 * dt;
    let p = alongRay(atm, b, c, t);
    let m = media(atm, p.h);
    let lit = sunlight(transmittanceIn, lutSampler, atm, p.r, p.c, bSun + t * cosT);
    let ms = sampleScattering(scatteringIn, atm, p.r, (bSun + t * cosT) / p.r);
    let source = lit * (m.rayleigh * pr + m.mie * pm) + (m.rayleigh + vec3f(m.mie)) * ms;
    let fall = exp(-m.extinction * dt);
    radiance += stepIntegral(throughput, source, m.extinction, fall, dt);
    throughput *= fall;
  }
  if (ground >= 0.0) {
    radiance += throughput * groundLight(atm, normalize(vec3f(0.0, r, 0.0) + view * ground), sun) / PI_ATM;
  }
  textureStore(skyViewOut, g.xy, vec4f(radiance * LUT_SCALE, 1.0));
}
