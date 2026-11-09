// G3's proof's measures (tools/hit-captures.mjs, npm run hit-captures; the shots spec's §4): what it
// photographs (the shots and their frames), the backstops it builds behind the dummy for the spatter
// to land on, the blood voxels counted on it and off it, and the zoomed strips of each shot's frames.
// And its gates (G3 Task 6): the burst seen (the pixels it changes against the same frame without it),
// the kill's ring clear of the dummy, the spatter's marks a splat (a cluster), the zone by the readout.

import { basis, dot, project, RAD, sub } from './camera.mjs';

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

/**
 * The nearer backstop (G3 Task 6): a trench's back wall is usually within about a metre of a head
 * over its parapet, so the spatter is shot onto one 0.9 m past the feet as well.
 */
export const NEAR_BACKSTOP = { ...BACKSTOP, behindM: 0.9 };

/**
 * The burst seen: at `frame` after the hit, the pixels of the zoom about the crosshair that it changes
 * (some channel by `threshold` of 255 or more) against the same frame drawn again without the blood,
 * counted where its blood is drawn (each billboard's disc, and `margin` pixels round it: the rest of
 * the frame's changes between two drawings are the TAA's and the denoiser's, not the blood's), at
 * least `px` of a torso hit's and a headshot's.
 */
export const BURST = { frame: 2, threshold: 16, margin: 1.5, px: { torso: 40, head: 80 } };

/** The kill's ring clear of the dummy's box on the screen by `ringFrame` after the kill; and the spatter on each backstop at least one cluster of `cluster` voxels, joined face to face (clusters). */
export const GATES = { ringFrame: 6, cluster: 6 };

/** The dummy as it stands, for its box on the screen: `halfWidthM` either side of its feet, `heightM` tall (its 1.8 m, its helmet, its rifle at rest). */
export const DUMMY = { halfWidthM: 0.4, heightM: 1.9 };

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

/** How many pixels of `box` ([x0, y0, w, h], cut to the frame) differ between `a` and `b` (same size) by `threshold` or more in some channel of red, green and blue; only those `mask` (discMask's) holds, if given. */
export function changedPixels(a, b, box, threshold, mask) {
  if (a.w !== b.w || a.h !== b.h) throw new Error(`changedPixels: frames of a different size (${a.w} × ${a.h}, ${b.w} × ${b.h})`);
  const x0 = Math.max(0, box[0]);
  const y0 = Math.max(0, box[1]);
  const x1 = Math.min(a.w, box[0] + box[2]);
  const y1 = Math.min(a.h, box[1] + box[3]);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (mask && !mask.data[y * a.w + x]) continue;
      const o = (y * a.w + x) * 4;
      if (Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]), Math.abs(a.data[o + 2] - b.data[o + 2])) >= threshold) n++;
    }
  }
  return n;
}

/** The six steps to a voxel that shares a face. */
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * The voxels ([x, y, z, ...] each) in clusters, those sharing a face joined (6-connected): each
 * cluster's size, the largest first. Voxels meeting only at an edge are not joined: on a wall's face
 * those are dots touching at their corners, a scatter, not a splat (G3 Task 6's fix round 1: the old
 * spatter's dots passed an 18-connected gate).
 */
export function clusters(voxels) {
  const key = (x, y, z) => `${x},${y},${z}`;
  const left = new Set(voxels.map((v) => key(v[0], v[1], v[2])));
  const sizes = [];
  for (const [x0, y0, z0] of voxels) {
    if (!left.delete(key(x0, y0, z0))) continue;
    const stack = [[x0, y0, z0]];
    let size = 0;
    while (stack.length) {
      const [x, y, z] = stack.pop();
      size++;
      for (const [dx, dy, dz] of FACES) {
        if (left.delete(key(x + dx, y + dy, z + dz))) stack.push([x + dx, y + dy, z + dz]);
      }
    }
    sizes.push(size);
  }
  return sizes.sort((p, q) => q - p);
}

/** Whether the ring (its middle and inner edge's radius, pixels) has `box` ({x0, y0, x1, y1}) inside its inner edge: the farthest corner from its middle, and by how much it is inside (under 0: not). */
export function ringClear(ring, box) {
  const far = Math.max(...[[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]].map(([x, y]) => Math.hypot(x - ring.cx, y - ring.cy)));
  return { clear: far < ring.inner, far, margin: ring.inner - far };
}

/** The eight corners (metres) of the box `dummy` ({halfWidthM, heightM}) stands in, its feet at `feet`. */
export function dummyCorners(feet, dummy) {
  const out = [];
  for (const dx of [-1, 1]) for (const dz of [-1, 1]) for (const y of [0, dummy.heightM]) out.push([feet[0] + dx * dummy.halfWidthM, feet[1] + y, feet[2] + dz * dummy.halfWidthM]);
  return out;
}

/** The bounds ({x0, y0, x1, y1}) of points on the screen (null: behind the camera, left out); null if none is in front. */
export function screenBox(points) {
  const seen = points.filter((p) => p !== null);
  if (seen.length === 0) return null;
  return { x0: Math.min(...seen.map((p) => p[0])), y0: Math.min(...seen.map((p) => p[1])), x1: Math.max(...seen.map((p) => p[0])), y1: Math.max(...seen.map((p) => p[1])) };
}

/** The zone the range's readout names first (TORSO, HEAD, LIMB), lower case; null if it names none. */
export function zoneOf(readout) {
  const word = /^(TORSO|HEAD|LIMB)\b/.exec(readout ?? '');
  return word ? word[1].toLowerCase() : null;
}

/**
 * A blood billboard ({at, half}, metres) on a `res` frame drawn from `pose` (its fov 90 unless given):
 * its disc's middle and radius in pixels, at least half a pixel and BURST's margin round it; null
 * behind the camera.
 */
export function bloodDisc(pose, res, billboard) {
  const centre = project(pose, res, billboard.at);
  if (!centre) return null;
  const depth = dot(sub(billboard.at, pose.position), basis(pose).forward);
  const t = pose.fov === undefined || pose.fov === 90 ? 1 : Math.tan((pose.fov * RAD) / 2);
  const half = (billboard.half * res[0]) / 2 / (depth * t);
  return { cx: centre[0], cy: centre[1], r: Math.max(half, 0.5) + BURST.margin };
}

/** The pixels of a `w` × `h` frame whose middles lie within any of `discs` ({cx, cy, r}): one byte each, and how many. */
export function discMask(discs, w, h) {
  const data = new Uint8Array(w * h);
  let count = 0;
  for (const d of discs) {
    const x0 = Math.max(0, Math.floor(d.cx - d.r - 0.5));
    const x1 = Math.min(w - 1, Math.ceil(d.cx + d.r - 0.5));
    const y0 = Math.max(0, Math.floor(d.cy - d.r - 0.5));
    const y1 = Math.min(h - 1, Math.ceil(d.cy + d.r - 0.5));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (data[y * w + x] || Math.hypot(x + 0.5 - d.cx, y + 0.5 - d.cy) > d.r) continue;
        data[y * w + x] = 1;
        count++;
      }
    }
  }
  return { data, count };
}
