// Shots' flashes (frame.flashes): point lights that live a frame or two. They light what they
// reach as the lanterns would with nothing in the way — a flash sits a metre in front of the eye,
// so what the eye sees it mostly lights — and are added where a surface is shaded, never through
// the light buffer, ReSTIR or the denoiser, whose history would show a two-frame light at a
// thirtieth of its strength and keep it half a second (effects.ts).
#include "light.wgsl"

fn flashLight(p: vec3f, n: vec3f) -> vec3f {
  var sum = vec3f(0.0);
  for (var i = 0u; i < min(frame.flashCount, 4u); i++) {
    let f = frame.flashes[i];
    sum += unshadowed(Light(f.pos, f.radius, f.colour, f.intensity), p, n);
  }
  return sum;
}
