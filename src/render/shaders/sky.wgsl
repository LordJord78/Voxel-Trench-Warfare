// The sky, from the atmosphere (see atmosphere.ts): the sun's light and the moon's, each scattered
// by the air into its own sky-view layer, and the light that sky puts on faces. Linear RGB, in the
// renderer's units: the layers are per unit of each light above the air (frame.sunLight and
// frame.moonLight).
#include "scene.wgsl"
#include "atmosphere-model.wgsl"

fn skyColour(rd: vec3f) -> vec3f {
  let a = frame.atmosphere;
  return frame.sunLight * skyViewSample(skyViewLut, lutSampler, a, rd, frame.sunDir, 0) + frame.moonLight * skyViewSample(skyViewLut, lutSampler, a, rd, frame.moonDir, 1);
}

// Half a degree over the horizon, where the fog's colour is read.
const FOG_HORIZON_COS: f32 = 0.99996;
const FOG_HORIZON_SIN: f32 = 0.0087;

// The direction just over the horizon that makes the same angle with `light` as rd does: there the
// air scatters the light toward the eye as the fog along rd does.
fn horizonAt(rd: vec3f, light: vec3f) -> vec3f {
  let flat = vec2f(light.x, light.z);
  let lf = length(flat);
  let along = select(vec2f(0.0, 1.0), flat / lf, lf > 1e-4);
  let c = clamp((dot(rd, light) - FOG_HORIZON_SIN * light.y) / (FOG_HORIZON_COS * max(lf, 1e-4)), -1.0, 1.0);
  let s = sqrt(max(0.0, 1.0 - c * c));
  let h = c * along + s * vec2f(-along.y, along.x);
  return vec3f(h.x * FOG_HORIZON_COS, FOG_HORIZON_SIN, h.y * FOG_HORIZON_COS);
}

// The colour height fog takes looking along rd: each light's sky just over the horizon at the
// angle rd makes with that light, where the air's own haze is deepest. So fog glows round a low sun
// only where the view is near it, and distant fog meets the horizon in the sky's own colour.
fn fogColour(rd: vec3f) -> vec3f {
  let a = frame.atmosphere;
  let sun = skyViewSample(skyViewLut, lutSampler, a, horizonAt(rd, frame.sunDir), frame.sunDir, 0);
  let moon = skyViewSample(skyViewLut, lutSampler, a, horizonAt(rd, frame.moonDir), frame.moonDir, 1);
  return frame.sunLight * sun + frame.moonLight * moon;
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
