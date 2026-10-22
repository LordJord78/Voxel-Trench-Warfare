// The sky, from the atmosphere (see atmosphere.ts): the sun's light and the moon's, each scattered
// by the air into its own sky-view layer, and the light that sky puts on faces. Linear RGB, in the
// renderer's units: the layers are per unit of each light above the air (frame.sunLight and
// frame.moonLight).
#include "scene.wgsl"
#include "common.wgsl"
#include "atmosphere-model.wgsl"

fn skyColour(rd: vec3f) -> vec3f {
  let a = frame.atmosphere;
  return frame.sunLight * skyViewSample(skyViewLut, lutSampler, a, rd, frame.sunDir, 0) + frame.moonLight * skyViewSample(skyViewLut, lutSampler, a, rd, frame.moonDir, 1);
}

// The colour the haze glows looking along rd: the height fog and the smoke over the lines, far
// denser than the air. It glows with the key light it scatters back and forth (a share of it looking
// any way, more toward the key), the sky's light from above, and the front's fires and flares at
// night (frame.frontGlow). So a low sun warms it all round, as the approved fog was warm.
fn fogColour(rd: vec3f) -> vec3f {
  return hazeGlow(rd, 1.0);
}

// The approved haze's phase: a share of the light it scatters looking any way, and more as the eye
// looks along the light (c, the cosine between the eye's ray and the way to the light), by c⁴.
fn hazePhase(c: f32) -> f32 {
  let k = max(c, 0.0);
  return frame.hazeKey + frame.hazeForward * (k * k) * (k * k);
}

// fogColour where only `lit` (0 to 1) of the key light reaches the haze.
fn hazeGlow(rd: vec3f, lit: f32) -> vec3f {
  let above = frame.sunLight * skyLight[3].rgb + frame.moonLight * skyLight[9].rgb;
  return frame.keyColour * (hazePhase(dot(rd, frame.keyDir)) * lit) + frame.hazeSky / PI_ATM * above + frame.frontGlow;
}

// Light from the sky arriving on a face with normal n, before occlusion: the six faces' irradiance,
// as an ambient cube (exact for a voxel face; blended by n² for the far field's smooth normals).
fn skyIrradiance(n: vec3f) -> vec3f {
  let n2 = n * n;
  let fx = select(0u, 1u, n.x >= 0.0);
  let fy = select(2u, 3u, n.y >= 0.0);
  let fz = select(4u, 5u, n.z >= 0.0);
  let sun = skyLight[fx].rgb * n2.x + skyLight[fy].rgb * n2.y + skyLight[fz].rgb * n2.z;
  let moon = skyLight[fx + 6u].rgb * n2.x + skyLight[fy + 6u].rgb * n2.y + skyLight[fz + 6u].rgb * n2.z;
  return frame.sunLight * sun + frame.moonLight * moon;
}

// Angular radii of the sun's and moon's discs, in radians (0.267° and 0.259°).
const SUN_RADIUS: f32 = 0.004660;
const MOON_RADIUS: f32 = 0.004520;
// Limb darkening: the sun's brightness falls to 1 - u at its edge.
const SUN_LIMB: f32 = 0.6;
// The brightest a disc is drawn: within half floats, and far past white.
const DISC_MAX: f32 = 30000.0;

// What the air between the eye and the top of the atmosphere lets through along rd; nothing through
// the ground.
fn eyeToSpace(rd: vec3f) -> vec3f {
  let a = frame.atmosphere;
  let h = max(a.viewHeight, 0.0);
  let r = a.bottom + h;
  let c = heightC(a, h);
  if (groundHit(r * rd.y, c) >= 0.0) {
    return vec3f(0.0);
  }
  return sampleTransmittance(transmittanceLut, lutSampler, a, r, c, rd.y);
}

// The sun's disc: its light above the air over its solid angle, limb-darkened, through the air.
fn sunDisc(rd: vec3f) -> vec3f {
  let cosA = dot(rd, frame.sunDir);
  if (cosA < cos(SUN_RADIUS)) {
    return vec3f(0.0);
  }
  let s = sqrt(max(0.0, 1.0 - cosA * cosA)) / sin(SUN_RADIUS);
  let mu = sqrt(max(0.0, 1.0 - s * s));
  let solid = 2.0 * PI_ATM * (1.0 - cos(SUN_RADIUS));
  let centre = frame.sunLight / (solid * (1.0 - SUN_LIMB / 3.0));
  return min(centre * (1.0 - SUN_LIMB * (1.0 - mu)) * eyeToSpace(rd), vec3f(DISC_MAX));
}

// The moon's face, as it hangs in the sky: its seas (darker basalt) as soft ellipses on the bright
// highlands, a little mottling, 1 on average over the disc. `p` runs -1 to 1 across it, y up.
fn moonAlbedo(p: vec2f) -> f32 {
  var seas = 0.0;
  seas += smoothstep(0.38, 0.22, length((p - vec2f(-0.55, 0.12)) / vec2f(1.0, 1.4)));
  seas += smoothstep(0.27, 0.15, length(p - vec2f(-0.28, 0.45)));
  seas += smoothstep(0.17, 0.09, length(p - vec2f(0.18, 0.42)));
  seas += smoothstep(0.2, 0.1, length(p - vec2f(0.34, 0.12)));
  seas += smoothstep(0.11, 0.05, length(p - vec2f(0.7, 0.3)));
  seas += smoothstep(0.17, 0.08, length(p - vec2f(-0.15, -0.35)));
  seas += smoothstep(0.14, 0.07, length(p - vec2f(0.58, -0.15)));
  let mottle = f32(hash3(vec3i(vec2i(floor(p * 24.0)), 7)) & 255u) / 255.0;
  return (1.2 - 0.5 * min(seas, 1.0)) * (0.92 + 0.16 * mottle);
}

// The moon's disc: a grey sphere lit by the sun from where the sun stands (so in its phase), its
// night side faintly lit by the earth, drawn in its light at full and dimmed by the air.
fn moonDisc(rd: vec3f) -> vec3f {
  let m = frame.moonDir;
  let cosA = dot(rd, m);
  if (cosA < cos(MOON_RADIUS)) {
    return vec3f(0.0);
  }
  // Across the face, 1 at the limb; the surface's normal faces the earth at the middle.
  let across = (rd - m * cosA) / sin(MOON_RADIUS);
  let n = across - m * sqrt(max(0.0, 1.0 - dot(across, across)));
  let side = normalize(select(cross(vec3f(0.0, 1.0, 0.0), m), vec3f(1.0, 0.0, 0.0), abs(m.y) > 0.999));
  let up = cross(m, side);
  let albedo = moonAlbedo(vec2f(dot(across, side), dot(across, up)));
  let lit = max(dot(n, frame.sunDir), 0.0);
  // Earthshine: the sunlit earth seen from the moon, full when the moon is new.
  let earth = 0.002 * (1.0 + dot(frame.sunDir, m)) * 0.5;
  let solid = 2.0 * PI_ATM * (1.0 - cos(MOON_RADIUS));
  // A Lambertian sphere at full puts 2/3 of its middle's brightness over its disc on average.
  return min(frame.moonFull / (solid * 2.0 / 3.0) * albedo * (lit + earth) * eyeToSpace(rd), vec3f(DISC_MAX));
}

// The stars: fixed in the celestial sphere, whose axes the frame carries (turned by the sidereal
// clock). A cube map of STAR_CELLS² cells a face holds at most one star a cell, about 6,000 in all,
// their magnitudes counted as the sky's are (those brighter than m grow as 10^(m/2)). Each is a
// Gaussian a pixel wide at the internal image, its light a magnitude-0 star's scaled by
// 10^(-0.4 m), and it fades as the sky behind it brightens.
const STAR_CELLS: f32 = 128.0;
const STAR_CHANCE: f32 = 0.061;
// The sky luminance at which the stars are gone.
const STAR_FADE: f32 = 0.01;
// The sines of the sun's depression (6° and 12°) over which they come out.
const STAR_SUN_FROM: f32 = 0.1045;
const STAR_SUN_TO: f32 = 0.2079;
// The galactic north pole, in the celestial sphere (RA 192.86°, Dec 27.13°).
const GALACTIC_POLE: vec3f = vec3f(-0.8676, -0.1981, 0.4560);

// The cube face and the position on it, -1 to 1, of a celestial direction.
fn starFace(d: vec3f) -> vec3f {
  let a = abs(d);
  if (a.x >= a.y && a.x >= a.z) {
    return vec3f(select(0.0, 1.0, d.x < 0.0), d.y / a.x, d.z / a.x);
  }
  if (a.y >= a.z) {
    return vec3f(select(2.0, 3.0, d.y < 0.0), d.x / a.y, d.z / a.y);
  }
  return vec3f(select(4.0, 5.0, d.z < 0.0), d.x / a.z, d.y / a.z);
}

fn faceDir(face: u32, uv: vec2f) -> vec3f {
  let s = select(1.0, -1.0, (face & 1u) == 1u);
  if (face < 2u) {
    return normalize(vec3f(s, uv.x, uv.y));
  }
  if (face < 4u) {
    return normalize(vec3f(uv.x, s, uv.y));
  }
  return normalize(vec3f(uv.x, uv.y, s));
}

fn stars(rd: vec3f, behind: vec3f) -> vec3f {
  // They fade as the sky behind them brightens, and come out only as the sun sinks from 6° below the
  // horizon (civil twilight's end) to 12°: the moon's light is the approved night's, far over the
  // physical, and would otherwise let them through a twilight sky.
  let fade = clamp(1.0 - dot(behind, vec3f(0.2126, 0.7152, 0.0722)) / STAR_FADE, 0.0, 1.0) * smoothstep(STAR_SUN_FROM, STAR_SUN_TO, -frame.sunDir.y);
  if (fade <= 0.0 || frame.starBrightness <= 0.0) {
    return vec3f(0.0);
  }
  let d = vec3f(dot(rd, frame.starX), dot(rd, frame.starY), dot(rd, frame.starZ));
  let f = starFace(d);
  let face = u32(f.x);
  let grid = (f.yz * 0.5 + 0.5) * STAR_CELLS;
  // This cell and the three nearest it: a star's light reaches a little past its own.
  let base = vec2i(floor(grid - 0.5));
  // A pixel at the image's middle, in radians, sets each star's width.
  let sigma = 0.6 * 2.0 * frame.cam.tanHalf / f32(frame.res.x);
  var sum = vec3f(0.0);
  for (var k = 0; k < 4; k++) {
    let cell = clamp(base + vec2i(k & 1, k >> 1), vec2i(0), vec2i(i32(STAR_CELLS) - 1));
    let h = hash3(vec3i(cell, i32(face)));
    if (f32(h & 0xffffu) / 65535.0 >= STAR_CHANCE) {
      continue;
    }
    let h2 = hash3(vec3i(cell + vec2i(911, 577), i32(face) + 13));
    let at = (vec2f(cell) + 0.15 + 0.7 * vec2f(f32(h2 & 255u), f32((h2 >> 8u) & 255u)) / 255.0) / STAR_CELLS * 2.0 - 1.0;
    let star = faceDir(face, at);
    // Brighter than m in proportion to 10^((m - 6)/2): m = 6 + 2 log10 u for u uniform.
    let u = max(f32((h2 >> 16u) & 0xffffu) / 65535.0, 1e-4);
    let mag = max(6.0 + 2.0 * log2(u) * 0.30103, -1.5);
    let angle = acos(clamp(dot(d, star), -1.0, 1.0));
    // White to orange by its temperature.
    let warm = f32(h >> 24u) / 255.0;
    let colour = mix(vec3f(0.85, 0.95, 1.25), vec3f(1.2, 0.95, 0.7), warm * warm);
    // Low down the air makes it twinkle.
    let twinkle = select(1.0, 0.55 + 0.9 * f32(hash3(vec3i(cell, i32(frame.frame >> 2u))) & 255u) / 255.0, rd.y < 0.2588);
    let light = frame.starBrightness * exp2(-0.4 * mag * 3.321928);
    sum += colour * (light * twinkle / (2.0 * PI_ATM * sigma * sigma) * exp(-0.5 * angle * angle / (sigma * sigma)));
  }
  // A faint band along the galactic equator.
  let b = asin(clamp(dot(d, GALACTIC_POLE), -1.0, 1.0));
  let band = exp(-b * b / 0.04) * (0.7 + 0.3 * f32(hash3(vec3i(vec2i(floor(grid / 8.0)), i32(face) + 29)) & 255u) / 255.0);
  sum += vec3f(0.9, 0.95, 1.05) * (frame.starBrightness * 60.0 * band);
  return sum * fade * eyeToSpace(rd);
}

// The sky with its bodies: the sun's and moon's discs and the stars.
// The aureole: the sky's glow a few degrees round the key light (the sun's, or the moon's at night),
// as cos⁹⁰⁰ of the angle from it, some 2.7° to 1/e: the bright, near-forward scattering of the haze
// over the lines, finer than the sky-view LUT's texels (some 2°) can hold, and the approved dusk's
// glow round the sun. Through the key's light, it fades as the key does at sunset and sunrise.
const AUREOLE_POWER: f32 = 900.0;

fn aureole(rd: vec3f) -> vec3f {
  let c = dot(rd, frame.keyDir);
  if (c <= 0.0) {
    return vec3f(0.0);
  }
  return frame.keyColour * (frame.aureole * exp(AUREOLE_POWER * log(c)));
}

fn skyWithBodies(rd: vec3f) -> vec3f {
  let sky = skyColour(rd);
  return sky + aureole(rd) + sunDisc(rd) + moonDisc(rd) + stars(rd, sky);
}
