// The exposure reckoned from the light (the base the adaptation starts from, see auto-exposure.ts):
// what makes the light the frame is lit by show as dusk's did at exposure 1, so the frame keeps its
// brightness as the light changes through the day. That light is the key's and the sky's on a face
// of each of the six orientations, averaged; never less than frame.exposureFloor, a moonless
// night's. The hour's bias and the correction for the frame are applied after it is metered.
#include "scene.wgsl"

// The adaptation's state: the base goes first.
@group(1) @binding(0) var<storage, read_write> state: array<f32, 8>;

fn lum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@compute @workgroup_size(1)
fn main() {
  // The key lights three of the six faces, each by the cosine of its angle to the key.
  let k = abs(frame.keyDir);
  var light = lum(frame.keyColour) * (k.x + k.y + k.z) / 6.0;
  for (var f = 0u; f < 6u; f++) {
    light += lum(frame.sunLight * skyLight[f].rgb + frame.moonLight * skyLight[f + 6u].rgb) / 6.0;
  }
  state[0] = frame.exposureLight / max(light, frame.exposureFloor);
}
