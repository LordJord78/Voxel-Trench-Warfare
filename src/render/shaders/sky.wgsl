// The sky, the probe's: a zenith-to-horizon gradient, a broad glow and a disc
// around the sun (even below the horizon, so dusk keeps its afterglow), and
// the ground's reflected darkness below the horizon. Linear RGB.

fn skyColour(rd: vec3f) -> vec3f {
  let up = max(rd.y, 0.0);
  var c = mix(frame.horizon, frame.zenith, pow(up, 0.45));
  let sd = max(dot(rd, frame.sunDir), 0.0);
  c += frame.keyColour * (pow(sd, 6.0) * 0.18 + pow(sd, 900.0) * 6.0) * step(0.0, frame.sunDir.y + 0.1);
  return c * select(1.0, 0.25, rd.y < -0.02);
}

// Light from the sky arriving on a face with normal n, before occlusion.
fn skyIrradiance(n: vec3f) -> vec3f {
  return mix(frame.horizon * 0.55, frame.zenith, 0.5 + 0.5 * n.y) * frame.ambient;
}
