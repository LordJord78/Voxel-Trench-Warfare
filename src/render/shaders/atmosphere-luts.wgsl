// Building the atmosphere's three LUTs (Hillaire 2020), one entry point each:
//   transmittanceLut — light lost from a height along a direction to the top;
//   scatteringLut    — Ψms, every order of scattering past the first, by his
//                      isotropic approximation: one workgroup per texel, one
//                      ring of directions per invocation;
//   skyViewLut       — the sky's radiance from the viewer's height, by the
//                      angle from the light's azimuth and the zenith angle:
//                      layer 0 lit by the sun, layer 1 by the moon;
//   irradianceLut    — the light each layer's sky puts on the six face
//                      directions: a workgroup per chunk of the layer's
//                      texels, all six faces at once, then irradianceSum
//                      adds the chunks.
// Each pipeline takes its own (automatic) layout, so no texture is written and
// read in one dispatch. Radiance is per unit sun illuminance.
#include "atmosphere-model.wgsl"

@group(0) @binding(0) var<uniform> atm: Atmosphere;
@group(0) @binding(1) var transmittanceIn: texture_2d<f32>;
@group(0) @binding(2) var scatteringIn: texture_2d<f32>;
@group(0) @binding(3) var lutSampler: sampler;
@group(0) @binding(4) var transmittanceOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var scatteringOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(6) var skyViewOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(7) var skyViewIn: texture_2d_array<f32>;
@group(0) @binding(8) var<storage, read_write> irradianceOut: array<vec4f, 12>;
// Each chunk's six faces, per layer: IRRADIANCE_CHUNKS × 6 vec4s a layer.
@group(0) @binding(9) var<storage, read_write> irradianceParts: array<vec4f, 192>;

// The light a sky-view layer is lit by.
fn layerLight(layer: u32) -> vec3f {
  return select(atm.sunDir, atm.moonDir, layer == 1u);
}

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
  let size = vec2f(textureDimensions(skyViewOut).xy);
  if (any(vec2f(g.xy) >= size)) {
    return;
  }
  let h = max(atm.viewHeight, 0.0);
  let r = atm.bottom + h;
  let c = heightC(atm, h);
  let angles = skyViewParams(atm, h, unitOf(g.xy, size));
  let sinZ = sqrt(max(0.0, 1.0 - angles.y * angles.y));
  let sinA = sqrt(max(0.0, 1.0 - angles.x * angles.x));
  let view = vec3f(sinZ * angles.x, angles.y, sinZ * sinA);
  // In this frame the light stands at azimuth 0, at its elevation as seen.
  let light = layerLight(g.z);
  let sun = vec3f(sqrt(max(0.0, 1.0 - light.y * light.y)), light.y, 0.0);
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
  textureStore(skyViewOut, g.xy, g.z, vec4f(radiance * LUT_SCALE, 1.0));
}

// The faces' irradiance from one layer's sky, summed over the layer's texels: each stands for a
// band of sky (and its mirror image across the light's vertical plane) whose solid angle comes from
// the mapping, and counts by its radiance and the cosine to each face's normal. Exact for what the
// layer holds, so its sharpest band, the glow over the horizon toward a low sun, counts in full.
// Below the horizon the layer holds the lit ground, so a downward face gets the ground's light.
// Each workgroup takes one of IRRADIANCE_CHUNKS chunks of the texels, every face at once.
const IRRADIANCE_CHUNKS: u32 = 16u;

var<workgroup> faceSums: array<array<vec4f, 64>, 6>;

@compute @workgroup_size(64)
fn irradianceLut(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) lane: u32) {
  let chunk = wg.x;
  let layer = wg.y;
  // The light's way across the ground, and square to it: the layer's azimuths turn from the first.
  let light = layerLight(layer);
  let flat = vec2f(light.x, light.z);
  let lf = length(flat);
  let along = select(vec2f(1.0, 0.0), flat / lf, lf > 1e-6);
  let across = vec2f(-along.y, along.x);
  let beta = horizonDip(atm, max(atm.viewHeight, 0.0));
  let size = textureDimensions(skyViewIn).xy;
  let sizeF = vec2f(size);
  let texels = size.x * size.y;
  let per = (texels + IRRADIANCE_CHUNKS - 1u) / IRRADIANCE_CHUNKS;
  // Half a texel, in unit coordinates (whose texel centres run 0 to 1).
  let half = 0.5 / (sizeF - 1.0);
  var sums: array<vec3f, 6>;
  for (var k = chunk * per + lane; k < min((chunk + 1u) * per, texels); k += 64u) {
    let t = vec2u(k % size.x, k / size.x);
    let unit = vec2f(t) / (sizeF - 1.0);
    let lo = max(unit - half, vec2f(0.0));
    let hi = min(unit + half, vec2f(1.0));
    let solid = (cos(zenithOf(beta, lo.y)) - cos(zenithOf(beta, hi.y))) * (azimuthOf(hi.x) - azimuthOf(lo.x));
    let zenith = zenithOf(beta, unit.y);
    let azimuth = azimuthOf(unit.x);
    let radiance = textureLoad(skyViewIn, t, i32(layer), 0).rgb * (solid / LUT_SCALE);
    for (var side = -1.0; side <= 1.0; side += 2.0) {
      let h = sin(zenith) * (cos(azimuth) * along + side * sin(azimuth) * across);
      let d = vec3f(h.x, cos(zenith), h.y);
      // faceNormal's order: -x, +x, -y, +y, -z, +z.
      sums[0] += radiance * max(-d.x, 0.0);
      sums[1] += radiance * max(d.x, 0.0);
      sums[2] += radiance * max(-d.y, 0.0);
      sums[3] += radiance * max(d.y, 0.0);
      sums[4] += radiance * max(-d.z, 0.0);
      sums[5] += radiance * max(d.z, 0.0);
    }
  }
  for (var f = 0u; f < 6u; f++) {
    faceSums[f][lane] = vec4f(sums[f], 0.0);
  }
  workgroupBarrier();
  for (var half = 32u; half > 0u; half >>= 1u) {
    if (lane < half) {
      for (var f = 0u; f < 6u; f++) {
        faceSums[f][lane] += faceSums[f][lane + half];
      }
    }
    workgroupBarrier();
  }
  if (lane < 6u) {
    irradianceParts[(layer * IRRADIANCE_CHUNKS + chunk) * 6u + lane] = faceSums[lane][0];
  }
}

// The chunks added: one invocation per face, a workgroup per layer.
@compute @workgroup_size(6)
fn irradianceSum(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) face: u32) {
  let layer = wg.x;
  var sum = vec4f(0.0);
  for (var chunk = 0u; chunk < IRRADIANCE_CHUNKS; chunk++) {
    sum += irradianceParts[(layer * IRRADIANCE_CHUNKS + chunk) * 6u + face];
  }
  irradianceOut[layer * 6u + face] = vec4f(sum.rgb, 0.0);
}
