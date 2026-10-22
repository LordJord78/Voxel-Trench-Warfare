// The image: every pixel shaded from the G-buffer and the denoised lighting.
//   - Light is upsampled from the four lighting texels around the pixel,
//     weighted bilinearly and by whether each saw the pixel's own face and
//     plane; where none did, the best same-face texel nearby, or open sky.
//   - Albedo is the palette's, varied per voxel as the probe did.
//   - Colour = albedo × (key colour × key visibility × N·L + sky and point
//     light) + emission. Water's top reflects the sky by Fresnel instead of
//     being lit like mud.
//   - The far field is lit analytically, with a coarse march toward the key
//     light over its mips for the shadows of distant hills.
//   - Everything, sky included, is seen through exponential height fog that
//     thins with altitude, glowing toward the sun.
// With FLAG_DEBUG_SHADE, a plain fixed light instead: for looking at geometry.
#include "traverse.wgsl"
#include "farfield.wgsl"
#include "camera.wgsl"
#include "sky.wgsl"
#include "palette.wgsl"
#include "lightgrid.wgsl"

const KIND_WATER: u32 = 14u;
const FAR_SKY_METRES: f32 = 2000.0;

@group(1) @binding(0) var gDepth: texture_2d<f32>;
@group(1) @binding(1) var gHit: texture_2d<u32>;
@group(1) @binding(2) var outColour: texture_storage_2d<rgba16float, write>;
@group(1) @binding(3) var light: texture_2d<f32>;
@group(1) @binding(4) var lightHit: texture_2d<u32>;

// The probe's per-voxel variation: fine grain, coarser blotches, a slight tint.
fn varied(albedo: vec3f, cell: vec3i) -> vec3f {
  let v = hash3(cell);
  let fine = 0.84 + 0.28 * f32(v & 255u) / 255.0;
  let blotch = 0.9 + 0.2 * f32(hash3(cell >> vec3u(2u)) & 255u) / 255.0;
  let tint = vec3f(1.0 + 0.05 * (f32((v >> 8u) & 255u) / 255.0 - 0.5), 1.0, 1.0 + 0.05 * (f32((v >> 16u) & 255u) / 255.0 - 0.5));
  return albedo * fine * blotch * tint;
}

// The denoised light reaching pixel p, which lies on `face` at `plane`.
fn upsampled(p: vec2u, face: u32, plane: i32, n: vec3f) -> vec4f {
  let grid = (vec2f(p) + 0.5) / f32(frame.lightScale) - 0.5;
  let base = vec2i(floor(grid));
  let f = grid - floor(grid);
  let size = vec2i(frame.lightRes);
  var sum = vec4f(0.0);
  var total = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let t = clamp(base + o, vec2i(0), size - 1);
    let h = textureLoad(lightHit, t, 0).xy;
    if (hitFace(h) != face) {
      continue;
    }
    let w = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1) * exp(-f32(abs(hitPlane(h) - plane)));
    sum += w * textureLoad(light, t, 0);
    total += w;
  }
  if (total > 1e-3) {
    return sum / total;
  }
  // No texel around saw this face: the nearest same-face texel within one more, else open sky.
  let centre = vec2i(round(grid));
  var best = -1.0;
  var pick = vec4f(skyIrradiance(n), 1.0);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let t = clamp(centre + vec2i(dx, dy), vec2i(0), size - 1);
      let h = textureLoad(lightHit, t, 0).xy;
      if (hitFace(h) != face) {
        continue;
      }
      let w = exp(-f32(abs(hitPlane(h) - plane))) / (1.0 + f32(abs(dx) + abs(dy)));
      if (w > best) {
        best = w;
        pick = textureLoad(light, t, 0);
      }
    }
  }
  return pick;
}

// The optical depth of a height fog between the eye and a point `metres` along rd: `density` per
// metre at the ground, falling off exponentially over `height` metres above it.
fn fogDepth(density: f32, height: f32, eyeY: f32, rd: vec3f, metres: f32) -> f32 {
  // The eye's height over the fog's base, and how far the ray climbs, both in fog heights.
  let a = (eyeY - frame.fogBase) / height;
  let x = rd.y * metres / height;
  // Density × length × e^-a × (1 - e^-x)/x, with the exponents combined as (e^-a - e^-(a+x))/x:
  // apart, a high eye looking far down underflows one and overflows the other (0 × ∞). Each
  // exponent is clamped only at the end, where f32 runs out.
  let eyeFog = exp(-clamp(a, -80.0, 80.0));
  if (abs(x) < 1e-3) {
    return density * metres * eyeFog * (1.0 - 0.5 * x);
  }
  return density * metres * (eyeFog - exp(-clamp(a + x, -80.0, 80.0))) / x;
}

// The haze between the eye and a point `metres` along rd, the ground fog and the smoke over it:
// transmittance, and the colour it glows.
fn fog(eyeY: f32, rd: vec3f, metres: f32) -> vec4f {
  let depth = fogDepth(frame.fogDensity, frame.fogHeight, eyeY, rd, metres) + fogDepth(frame.smokeDensity, frame.smokeHeight, eyeY, rd, metres);
  return vec4f(fogColour(rd), exp(-max(depth, 0.0)));
}

// Whether the key light reaches a far-field point, by a coarse march over mip level 2.
fn farLit(p: vec3f, n: vec3f) -> f32 {
  if (dot(n, frame.keyDir) <= 0.0 || frame.far.w < 8.0) {
    return 0.0;
  }
  let cell = frame.far.z;
  let n2 = i32(frame.far.w) >> 2u;
  for (var i = 1; i <= 24; i++) {
    let q = p + frame.keyDir * (f32(i) * cell * 4.0);
    let s = (q.xz - frame.far.xy) / cell - 0.5;
    let c = vec2i(floor(s / 4.0));
    if (any(c < vec2i(0)) || any(c >= vec2i(n2))) {
      return 1.0;
    }
    if (q.y < textureLoad(farMips, c, 2).r) {
      return 0.0;
    }
  }
  return 1.0;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= frame.res.x || g.y >= frame.res.y) {
    return;
  }
  let hit = textureLoad(gHit, vec2i(g.xy), 0).xy;
  let face = hitFace(hit);
  let rd = cameraRay(frame.cam, vec2f(g.xy) + 0.5 + frameJitter(), vec2f(frame.res));
  let eyeY = frame.cam.origin.y * frame.voxel;
  var colour: vec3f;
  var metres = FAR_SKY_METRES;
  if (face == 7u) {
    colour = skyWithBodies(rd);
  } else {
    let depth = textureLoad(gDepth, vec2i(g.xy), 0).r;
    metres = depth * frame.voxel;
    let mat = hit.y >> 16u;
    if (face == 6u) {
      let p = frame.cam.origin + rd * depth;
      let n = farNormalAt(p);
      let lit = frame.keyColour * farLit(p, n) * max(dot(n, frame.keyDir), 0.0) + skyIrradiance(n);
      colour = albedoOf(mat) * lit;
    } else {
      let cell = vec3i(i32(hit.x & 0xfffu), i32(hit.y & 0xffffu), i32((hit.x >> 12u) & 0xfffu));
      let n = faceNormal(face);
      let albedo = varied(albedoOf(mat), cell);
      if ((frame.flags & FLAG_DEBUG_SHADE) != 0u) {
        colour = albedo * (0.3 + 0.7 * max(dot(n, normalize(vec3f(0.4, 0.8, 0.45))), 0.0));
      } else {
        let l = upsampled(g.xy, face, hitPlane(hit), n);
        let lit = frame.keyColour * l.a * max(dot(n, frame.keyDir), 0.0) + l.rgb;
        colour = albedo * lit + emissionOf(mat);
        if (kindOf(mat) == KIND_WATER && face == 3u) {
          let fresnel = 0.02 + 0.98 * pow(1.0 - abs(dot(rd, n)), 5.0);
          colour = albedo * lit * 0.6 + fresnel * skyWithBodies(reflect(rd, n));
        }
      }
    }
  }
  let f = fog(eyeY, rd, metres);
  textureStore(outColour, g.xy, vec4f(colour * f.a + f.rgb * (1.0 - f.a), 1.0));
}
