// The present pass's tone curve (present.wgsl): the ACES fit, channel by channel, and its inverse, so
// the effects can light the tracers to show at the hue they are given (effects.wgsl keepHue).

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

// The input the fit shows as `d` (0 to 1), channel by channel: the positive root of
// (2.51 - 2.43 d) x^2 + (0.03 - 0.59 d) x - 0.14 d = 0. At 1 it is the fit's top, some 7.24.
fn acesInverse(d: vec3f) -> vec3f {
  let a = 2.51 - 2.43 * d;
  let b = 0.03 - 0.59 * d;
  return (-b + sqrt(b * b + 0.56 * d * a)) / (2.0 * a);
}
