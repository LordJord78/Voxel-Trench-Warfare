// The exposure the frame is presented at: the hour's bias (frame.exposure) over the light the frame
// is lit by, so it keeps its brightness as the light changes through the day (milestone 3 meters
// the image instead). That light is the key's and the sky's on a face of each of the six
// orientations, averaged; never less than frame.exposureFloor, a moonless night's.
#include "scene.wgsl"

@group(1) @binding(0) var<storage, read_write> present: array<f32, 8>;

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
  // The present uniform: the image, its allocation and the canvas (two floats each), then this.
  present[6] = frame.exposure * frame.exposureLight / max(light, frame.exposureFloor);
}
