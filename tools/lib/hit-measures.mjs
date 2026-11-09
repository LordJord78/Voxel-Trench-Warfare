// G3's proof's measures (tools/hit-captures.mjs, npm run hit-captures; the shots spec's §4): what it
// photographs (the shots and their frames), the backstop it builds behind the dummy for the spatter to
// land on, the blood voxels counted on it and off it, and the zoomed strips of each shot's frames.

/**
 * The shots, one after the other on the same dummy: a torso hit from an M4 (55 of its 100: a hit, not a
 * kill), photographed on frames 0, 2 and 6 after the frame its marker comes; then a headshot (a kill),
 * on 0, 2, 6 and 20 (its fall, 0.45 s, is 27 frames). Each aimed from the eye at `aimM` over the feet.
 */
export const SHOTS = [
  { name: 'torso', gun: 'm4', aimM: 1.2, zone: 'torso', frames: [0, 2, 6], kills: false },
  { name: 'head', gun: 'm4', aimM: 1.62, zone: 'head', frames: [0, 2, 6, 20], kills: true },
];

/**
 * The backstop built behind the dummy for the spatter to land on: sandbags, its near face 2 m past the
 * feet (the cone along the round reaches 2.5 m from the head; the body, falling 1.8 m long toward it,
 * lies short of it), 0.4 m deep, 1.5 m either side, from 0.6 m under the feet to 2.4 m over them.
 */
export const BACKSTOP = { behindM: 2, halfWidthM: 1.5, aboveM: 2.4, belowM: 0.6, thickM: 0.4 };

/** Each frame's zoom: `w` × `h` CSS pixels about the crosshair, `below` more of it under the middle than over it (the words 6vh under it, the readout under them), magnified `scale` times. */
export const ZOOM = { w: 360, h: 280, below: 70, scale: 2 };

/** The back of a strip, and of what a crop takes from outside the frame. */
const BACK = [24, 24, 24];

/**
 * The backstop behind the dummy whose feet are at `feet`, fired at from `eye` (metres): a wall square to
 * the line of fire across whichever of x and z is nearer square to it, its near face `behindM` past the
 * feet along it and `thickM` deep, `halfWidthM` either side of the feet, from `belowM` under them to
 * `aboveM` over them. Its voxel box [x0, y0, z0, x1, y1, z1) (out to whole voxels of `voxel` metres).
 */
export function wallBox(eye, feet, wall, voxel) {
  const d = [feet[0] - eye[0], feet[2] - eye[2]];
  const thin = Math.abs(d[0]) > Math.abs(d[1]) ? 0 : 2;
  const wide = thin === 0 ? 2 : 0;
  const sign = Math.sign(thin === 0 ? d[0] : d[1]) || 1;
  const near = feet[thin] + sign * wall.behindM;
  const far = near + sign * wall.thickM;
  const lo = [0, feet[1] - wall.belowM, 0];
  const hi = [0, feet[1] + wall.aboveM, 0];
  lo[thin] = Math.min(near, far);
  hi[thin] = Math.max(near, far);
  lo[wide] = feet[wide] - wall.halfWidthM;
  hi[wide] = feet[wide] + wall.halfWidthM;
  return [...lo.map((m) => Math.floor(m / voxel)), ...hi.map((m) => Math.ceil(m / voxel))];
}

/** Blood voxels found ([x, y, z, shade] each): how many lie in the backstop's `box`, how many off it (the ground, mostly), and how many of each shade. */
export function bloodVoxels(found, box) {
  const inBox = ([x, y, z]) => x >= box[0] && y >= box[1] && z >= box[2] && x < box[3] && y < box[4] && z < box[5];
  const byShade = {};
  let wall = 0;
  for (const v of found) {
    if (inBox(v)) wall++;
    byShade[v[3]] = (byShade[v[3]] ?? 0) + 1;
  }
  return { wall, ground: found.length - wall, byShade };
}

/** `w` × `h` of `img` from (x0, y0): its RGBA copied, the back where it lies outside the frame. */
export function crop(img, x0, y0, w, h) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x0 + x;
      const sy = y0 + y;
      const o = (y * w + x) * 4;
      if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) data.set([...BACK, 255], o);
      else data.set(img.data.subarray((sy * img.w + sx) * 4, (sy * img.w + sx) * 4 + 4), o);
    }
  }
  return { data, w, h };
}

/** `img` magnified `k` times, each pixel a k × k block. */
export function magnify(img, k) {
  const w = img.w * k;
  const h = img.h * k;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = ((Math.floor(y / k) * img.w + Math.floor(x / k)) * 4);
      data.set(img.data.subarray(o, o + 4), (y * w + x) * 4);
    }
  }
  return { data, w, h };
}

/** `imgs` left to right, `gap` pixels apart and from the edges, on the back. */
export function strip(imgs, gap = 12) {
  const w = gap + imgs.reduce((s, i) => s + i.w + gap, 0);
  const h = 2 * gap + Math.max(...imgs.map((i) => i.h));
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...BACK, 255], i * 4);
  let left = gap;
  for (const img of imgs) {
    for (let y = 0; y < img.h; y++) data.set(img.data.subarray(y * img.w * 4, (y + 1) * img.w * 4), ((gap + y) * w + left) * 4);
    left += img.w + gap;
  }
  return { data, w, h };
}
