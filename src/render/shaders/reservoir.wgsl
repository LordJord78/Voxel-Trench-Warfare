// A lighting pixel's reservoir (see restir.wgsl): the light it chose (NO_LIGHT for none), that
// light's contribution weight W, the candidates it stands for (M), and the light's target where it
// was chosen (its unshadowed luminance, `luma`: `target` is a word WGSL keeps for itself). Reservoirs lie in rows of the lighting grid as allocated, so dynamic resolution, which
// renders part of it, moves none of them.

struct Reservoir {
  light: u32,
  weight: f32,
  count: f32,
  luma: f32,
}

const NO_LIGHT: u32 = 0xffffffffu;

fn reservoirAt(q: vec2u) -> u32 {
  return q.y * ((frame.alloc.x + frame.lightScale - 1u) / frame.lightScale) + q.x;
}
