// The height fog and the smoke over the lines, analytically: what the haze hides between the eye
// and a point along a ray, and the colour it glows (sky.wgsl's fogColour). Shading sees what lies
// past the froxels through it, and the froxels take their haze's depth from it (froxels.wgsl).
#include "sky.wgsl"

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

// The optical depth of the haze, the ground fog and the smoke over it, between the eye and a point
// `metres` along rd.
fn hazeDepth(eyeY: f32, rd: vec3f, metres: f32) -> f32 {
  return max(fogDepth(frame.fogDensity, frame.fogHeight, eyeY, rd, metres) + fogDepth(frame.smokeDensity, frame.smokeHeight, eyeY, rd, metres), 0.0);
}

// The haze between the eye and a point `metres` along rd: the colour it glows, and transmittance.
fn fog(eyeY: f32, rd: vec3f, metres: f32) -> vec4f {
  return vec4f(fogColour(rd), exp(-hazeDepth(eyeY, rd, metres)));
}
