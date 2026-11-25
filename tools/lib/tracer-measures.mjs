// G1's proof: the captures it takes, what each measures from the displayed pixels (sRGB-encoded 0-255,
// luminance by Rec. 709 weights), and the gates (tools/tracer-captures.mjs fires, photographs and
// writes; tests/tools/capture-measures.test.ts reads these on synthetic images). Each measure is of the
// player's own tracers, of their team's kind (red in solo; Blue's captures set Session.team):
//   - head over ring (the shot): the player's brightest drawn head within HEAD_PX of where it projects,
//     over the mean of a RING_PX annulus round it, the gun's box and anything brighter than the sky's
//     99th percentile left out: dusk's and night's at least MIN_RATIO in the head's own top channel
//     over the ring's mean in that channel (a red head read against the scene in its red: neither the
//     night's blue, which V counts whole, nor luminance, which counts red at a fifth); its V and
//     luminance ratios reported beside it. A white-hot head's top channel is its team's (red's R, blue's
//     B). By day (noon, and 17:35, solo's opening hour) the head at the display's top in its own channel
//     (no head reaches 2.2 in luminance over a sunlit ring); noon's contrast is (d)'s.
//   - (a) near width: the widest run across the player's tracer within NEAR_M of the muzzle (from
//     NEAR_FROM_M, clear of the flash's star), at half its height over each side's surroundings: the
//     line's own band, not the bloom's halo nor the parapet its shot's flash lights (the looser width,
//     every pixel LIT over them, is reported beside it); where a puff of the muzzle's smoke nearer the
//     eye, shown lit over what is round it (by the shot's flash a metre from the eye), covers the walk,
//     read as any other (a lit puff round the line is what the gate is for) and reported beside it.
//   - (b) far colour: the mean HSV saturation and hue of the player's tracers' lit pixels past FAR_M
//     of flight, against their team colour's own hue as shown (TEAM) and their kind's saturation
//     (TARGET.farSaturation), gated after dark and reported by day; and the battle's streams', gated at
//     night away from the eye (far-night, side-night, graze-night: from the eye at night they are
//     hundreds of metres off over the sky, reported).
//   - (c) path cover: in the persistence composite, the share of a round's drawn line (PATH_M of
//     flight) whose pixels are shown, over those the world does not hide (a tree in front, by the
//     G-buffer's depth); aimed, over those the gun does not cover either. From the shooter's eye a
//     line that has joined its round's path projects to a point: reported, not gated.
//   - (f) aimed (G4 Task 4, G1's aimed gate moved there): on the aimed 90 m burst, the share of the
//     round's projected path (PATH_M of flight) shown in the composite, over the samples the gun covers
//     in no frame and the world does not hide, each sample read across the line, each pixel over its own
//     background ((e)'s rule). The aimed 30 m burst is a picture: its round lands behind the post.
//   - (d) noon contrast: the brightest pixel of the player's tracer at NOON_AT_M of flight over its
//     NOON_RING_PX ring, gated at noon and reported at 17:35.
//   - (e) the stream from the hip: the followed round's drawn ribbons from STREAM_FROM_M past the muzzle
//     to within STREAM_AIM_PX of the point of aim, each sample read across the line (PATH_ACROSS_PX
//     either side, each pixel over its own background), the share shown, and how far out the shown
//     stream reaches over the muzzle's distance from the point of aim; a sample with a pixel brighter
//     than a background the lit rule cannot reach (LIT.ratio times it past 255), and none shown, left
//     out, counted (`unread`).
//   - the graze: a ricochet of the player's kind drawn in the burst (not the front's amber beside it).
//   - the wall (10 m out, at night): its rounds strike within their first tick, each drawn once, to the
//     wall: gated on (a) and (e) as a near burst is, its stream the struck rounds'; its head, drawn only
//     in the frame its round is fired, beside that shot's flash, reported.
// "Lit": LIT.ratio times the background and LIT.min over it, the background the pixel's least over
// the 8 frames in which no tracer is drawn near it (a round lights a pixel of its path in 2 of them;
// by day a tracer's light covers what is behind it, effects.wgsl tracerLight, so a frame it is drawn in
// can be darker than its background). The composite shows each pixel as its frame most unlike its
// background (image.mjs composite). "Tinted": a pixel showing its team's colour over its background
// (TINT), as a red glow covering the low sun's bright haze does while darker than it (luminance cannot
// see it). "Shown", (c)'s and (e)'s: by day (byDay) lit or tinted, after dark lit only (over the violet
// night the rule under-reads Blue); the share lit alone is reported beside it. (b) reports tinted
// beside "lit", and the front's amber is read so. A round's last streak, ending where it struck, is
// drawn and measured as any other. Every gate fails on a measure that is missing where it is gated.
import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { basis, dist, dot, lerp, project, RAD, sub, unit } from './camera.mjs';
import { at, brightest, colourOf, composite, decode, encode, hsv, hueOff, lit as litBy, litNear as litNearBy, median, percentile, ringMean, round3, topChannel } from './image.mjs';

/** The shot's flash and its light last flash_s (0.03 s): its first two frames. The head is measured clear of them, the flash not being the head's background. */
export const FLASH_FRAMES = 2;
/** The head: its brightest pixel within this many pixels of where it projects (Chebyshev). */
export const HEAD_PX = 2;
/** The background ring round it, pixels: the brief's 40 px, an annulus this wide. */
export const RING_PX = [30, 40];
/** The gun's drawn box is left out of the ring, grown by this many pixels for its flash and the sight's glow. */
const GUN_PAD_PX = 12;
/** A gun box covering more of the image than this is not a mask (aimed, it is the whole view). */
const GUN_BOX_MAX_SHARE = 0.5;
/** The sky, for the brightness a ring pixel may not pass: the image's top rows, and the percentile of them. */
const SKY_ROWS = 0.3;
const SKY_PERCENTILE = 0.99;
/** The least ring pixels left; fewer fails. */
export const RING_MIN_PIXELS = 200;
/** Head over ring in the head's own top channel (over the ring's mean in it): dusk's and night's at least. Noon's head is at the display's top in its brightest channel (against a sunlit ring no head reaches 2.2 in luminance); noon's contrast is (d)'s. */
export const MIN_RATIO = 3;
export const NOON_HEAD_MIN = 250;
/** The least GPU samples inside the burst, else the p95 is not trusted. */
export const MIN_GPU_SAMPLES = 60;
/** A ring mean under this (0-255) is read as this, so a black ring does not divide by zero. */
const RING_FLOOR = 1;
/** A pixel lit by a tracer: this many times its background in displayed luminance, and this many steps over it (night's grain is 3). */
export const LIT = { ratio: 1.5, min: 6 };
const lit = (v, bg) => litBy(v, bg, LIT);
const litNear = (img, comp, q, r, taken, out) => litNearBy(img, comp, q, r, taken, out, LIT);
/**
 * (a): the run across the tracer within NEAR_M of the muzzle, from NEAR_FROM_M: nearer, its first
 * metres lie along the flash's star on the image (its forward ray is the bore's), and a run across
 * them is the star's; from 3 m the glow's projected width is 17 px and more, so its cap is what shows.
 * Walked to WALK_PX each side; its surroundings BG_PX out.
 */
const NEAR_M = 10;
const NEAR_FROM_M = 3;
const WALK_PX = 32;
const BG_PX = [34, 48];
/**
 * The muzzle's smoke's billboard kind (particles.ts SMOKE_BILLBOARD), as the page's particleBillboards
 * gives it: the tool reads each frame's puffs (`smoke`, centre and half size, metres). (a) reports, beside
 * its width (`underSmoke`), the samples whose walk a puff nearer the eye covers where the puff shows lit
 * over what is round it (LIT: the median of PUFF_IN points across its middle over the median of PUFF_RING
 * points round its rim), with the widest run among them. They are read as any other: a run there that is
 * the puff's (the shooter's own, lit by the shot's flash a metre from the eye) is a bright ball round the
 * line leaving the gun, which the gate is for (G4 Task 3b: the player's smoke takes [effects]
 * own_smoke_flash_share of the shots' flash light, so it is not). A puff that does not show (by day, a
 * sunlit wisp of 0.18 alpha; at night, one no flash lights) is not reported.
 */
export const SMOKE_KIND = 7;
/** A puff's middle, as shares of its half size across the image: its centre and eight points at 0.4 of it. */
const PUFF_IN = [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4], [0.28, 0.28], [-0.28, 0.28], [0.28, -0.28], [-0.28, -0.28]];
/** What is round a puff: sixteen points at 1.3 of its half size. */
const PUFF_RING = Array.from({ length: 16 }, (_, k) => [1.3 * Math.cos((k * Math.PI) / 8), 1.3 * Math.sin((k * Math.PI) / 8)]);
/** A sample's centre this many steps over the brighter side's surroundings at least, or its run is not a line's (a ribbon's fading tail; a half-height on the haze's noise). */
const NEAR_CONTRAST = 40;
/** (b): past this much of its flight; pixels within FAR_RADIUS_PX of the ribbon, FAR_HEAD_PX of a head, of them the lit ((c)'s rule); fewer than FAR_LIT_MIN lit is no measure. */
export const FAR_M = 60;
const FAR_RADIUS_PX = 2;
const FAR_HEAD_PX = 3;
export const FAR_LIT_MIN = 10;
/** The battle's streams: pixels within this of each tracer's drawn streak, of them the lit. */
const BATTLE_RADIUS_PX = 1.5;
/** (e): the stream from the hip, from this far past the muzzle to within STREAM_AIM_PX of the point of aim (the view's middle). */
export const STREAM_FROM_M = 0.5;
export const STREAM_AIM_PX = 12;
/** (e): of its samples, at least this share read (not left out as past the lit rule's reach), or it is no measure. */
export const STREAM_READ_MIN = 0.5;
/** (c): a round's path, metres of its flight; its pixels read PATH_ACROSS_PX either side; under DEGENERATE_PX on the image it is seen end on. */
export const PATH_M = [20, 80];
const PATH_ACROSS_PX = 1.5;
const DEGENERATE_PX = 10;
/** Aimed, a pixel whose G-buffer depth is nearer than this is the gun (its post is half a metre out). */
const GUN_DEPTH_M = 0.9;
/** A path sample whose G-buffer depth is under this share of the path's own distance is behind the world (a tree, the parapet): left out, as the gun is. */
const HIDDEN_SHARE = 0.97;
/** (d): the point at this much flight, its ring, ring pixels within NOON_CLEAR_PX of a drawn tracer left out, and the least ring left. */
const NOON_AT_M = 40;
export const NOON_RING_PX = [16, 20];
const NOON_CLEAR_PX = 8;
const NOON_RING_MIN = 100;
/**
 * A pixel tinted by a tracer of a team (TEAM's entry): its saturation at least TINT.saturation, its chroma
 * TINT.chroma or more over its background's, its hue within TARGET.farHueDeg of its team's and at least
 * TINT.apart times as near it as any other kind's (a red glow added over the low sun's haze, orange-
 * peach at some 23 degrees, is as near amber's 42 as red's 5, and is not red's).
 */
export const TINT = { saturation: 0.5, chroma: 32, apart: 2 };
/** The tracer kinds' hues as shown (TEAM's, set below). */
let KIND_HUES = [];
export function tinted(rgb, bg, team) {
  const c = hsv(rgb);
  const b = hsv(bg);
  if (!(c.saturation >= TINT.saturation && c.chroma >= b.chroma + TINT.chroma)) return false;
  const off = hueOff(c.hue, team.hue);
  if (!(off <= TARGET.farHueDeg)) return false;
  return KIND_HUES.every((h) => h === team.hue || TINT.apart * off <= hueOff(c.hue, h));
}

/**
 * Task 5's targets, as fix round 1 ruled them: (a) to 14 page pixels at half height; (b) a far tracer at
 * its team's colour (its displayed hue within farHueDeg, its saturation at least its kind's); the
 * battle's amber at night; (c) the path shown; (d) noon's contrast; (e) the stream from the hip; and
 * (f), G4 Task 4's, the aimed 90 m path shown beside the post.
 *
 * (b)'s saturation is its kind's (the G1 final ruling): red's 0.45; Blue's 0.40, red's scaled by how
 * saturated each team's colour is as shown (TEAM): 0.45 × Blue's 0.745 / red's 0.84 = 0.399, 0.40. One
 * 0.5 for both flaked by construction (far-night read 0.498-0.504 over seven runs, side-night-blue
 * 0.485-0.528); pastel heads, the failure it is there for, read 0.35 and under.
 */
export const TARGET = { nearWidthPx: 14, farSaturation: { red: 0.45, blue: 0.4 }, farHueDeg: 20, battleSaturation: 0.4, pathCover: 0.85, noonContrast: 1.4, streamCover: 0.7, streamSpan: 0.6, aimedCover: 0.6 };

/** The tunables: the tracers' colours, and the battle's streak law. */
const TUN = parse(readFileSync(new URL('../../data/tunables.toml', import.meta.url), 'utf8'));
const FX = TUN.effects;
/** The AK's round's flight over the first frame of its flight (m): its muzzle velocity over a sixtieth of a second, the step the tool takes. */
const AK_FRAME_M = TUN.weapon.assault_rifle.muzzle_velocity / 60;
/** A colour (linear) as shown with its hue kept (effects.wgsl keepHue): its channels over its brightest, sRGB-encoded (gamma 2.2). */
const shown = (c) => c.map((v) => 255 * (v / Math.max(...c)) ** (1 / 2.2));
export const TEAM = { red: hsv(shown(FX.tracer_colour_red)), blue: hsv(shown(FX.tracer_colour_blue)), amber: hsv(shown(FX.tracer_colour)) };
KIND_HUES = [TEAM.red.hue, TEAM.blue.hue, TEAM.amber.hue];
/** The tracer kinds (net/gear.ts TRACER_KIND) and their colours (linear), by kind. */
const KIND = { amber: 1, red: 2, blue: 3 };
const COLOUR = [FX.tracer_colour, FX.tracer_colour, FX.tracer_colour_red, FX.tracer_colour_blue];

/** The kind of the player's tracers in a capture: their team's (Session.team, red in solo). */
export const kindOf = (c) => (c.team === 'blue' ? KIND.blue : KIND.red);
/** A kind's own channel (0 R, 1 G, 2 B): its colour's brightest. */
export function teamChannel(kind) {
  const c = COLOUR[kind] ?? COLOUR[KIND.amber];
  return c.indexOf(Math.max(...c));
}

/** 17:35, the clock's dusk key (core/sky-clock.ts CLOCK_KEYS.dusk): the hour solo opens at, its sun 4.5 degrees up. */
const LOW_SUN = 17 + 35 / 60;
/**
 * The wall the wall burst strikes: across the shooter's view this far out (m, under an AK round's first
 * tick, 14.7 m, so each round is drawn once, to it), this wide each side, from this far under the eye to
 * this far over it, this thick; of the game's timber (world/materials.ts P.TIMBER). What was there is put
 * back after.
 */
export const WALL = { outM: 10, halfWidthM: 3, belowM: 3, aboveM: 2, thickM: 0.4, material: 19 };
/** A burst at a man's chest or a wall: its stream from the hip to the point of aim gated. */
export const nearLike = (c) => c.burst === 'near' || c.burst === 'wall';
/**
 * The captures. Bursts (BURSTS in the tool): near, a man's chest 30 m out (pitch -0.76 degrees); far,
 * level over the enemy parapet 52 m out, so rounds fly past 90 m; graze, the parapet's crest just in
 * front; wall, a wall 10 m out (WALL). `side`: seen by a witness along the trench; `battle`: the
 * battle's amber gated; `team`: the shooter's (Session.team), red unless given; `front`: the enemy
 * line's rifle fire for the burst (light unless given; at heavy its amber is in the frame at 17:35, when
 * the battle does not fire).
 */
export const CAPTURES = [
  { name: 'noon', hours: 12, burst: 'near' },
  { name: '1735', hours: LOW_SUN, burst: 'near' },
  { name: 'dusk', hours: 19.5, burst: 'near' },
  { name: 'night', hours: 22.5, burst: 'near' },
  { name: 'dusk-aimed', hours: 19.5, burst: 'near', aimed: true },
  { name: 'far-noon', hours: 12, burst: 'far' },
  { name: 'far-1735', hours: LOW_SUN, burst: 'far' },
  { name: 'far-dusk', hours: 19.5, burst: 'far' },
  { name: 'far-night', hours: 22.5, burst: 'far', battle: true },
  { name: 'far-night-blue', hours: 22.5, burst: 'far', team: 'blue' },
  { name: 'far-dusk-aimed', hours: 19.5, burst: 'far', aimed: true },
  { name: 'side-noon', hours: 12, burst: 'far', side: true },
  { name: 'side-1735', hours: LOW_SUN, burst: 'far', side: true },
  { name: 'side-1735-blue', hours: LOW_SUN, burst: 'far', side: true, team: 'blue' },
  { name: 'side-1735-heavy', hours: LOW_SUN, burst: 'far', side: true, front: 'heavy' },
  { name: 'side-dusk', hours: 19.5, burst: 'far', side: true },
  { name: 'side-night', hours: 22.5, burst: 'far', side: true, battle: true },
  { name: 'side-night-blue', hours: 22.5, burst: 'far', side: true, team: 'blue' },
  { name: 'graze-night', hours: 22.5, burst: 'graze', battle: true },
  { name: 'wall-night', hours: 22.5, burst: 'wall' },
];
/** By day: noon, and 17:35 (the sun is down by 19:30). Gated as noon is: the head at the display's top in its own channel, (b) reported. */
export const byDay = (c) => c.hours < 19;

const own = (f, kind) => f.info.tracers.filter((t) => t.kind === kind && t.headM && t.tailM);
/** A drawn tracer's flight at its tail: its head's, less its drawn length (exact once it has joined its round's path; short of that, within the offset's change along it, a few centimetres). */
const tailFlown = (t) => t.flown - dist(t.headM, t.tailM);

/** A tracer drawn within this many pixels of a pixel in a frame: that frame is not its background (a glow is drawn 10 px across at most, a head 4.1). */
const NEAR_TRACER_PX = 8;

/** Mark (1) the pixels of `mask` (w × h) within `r` of the segment a to b. */
function markSegment(mask, w, h, a, b, r) {
  const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - r));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(a[0], b[0]) + r));
  const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - r));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(a[1], b[1]) + r));
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const s = l2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
      if (Math.hypot(px - a[0] - dx * s, py - a[1] - dy * s) <= r) mask[y * w + x] = 1;
    }
  }
}

/** Each frame's tracers on its image (the session's of every kind, and the battle's streams), NEAR_TRACER_PX about each: the pixels whose background that frame is not. */
export function tracerMasks(frames, w, h) {
  const trail = TUN.battle.tracers.trail_m;
  return frames.map((f) => {
    const mask = new Uint8Array(w * h);
    const { pose, res } = f.info;
    const k = w / res[0];
    const put = (a, b) => markSegment(mask, w, h, [a[0] * k, a[1] * k], [b[0] * k, b[1] * k], NEAR_TRACER_PX);
    for (const t of f.info.tracers) if (t.head && t.tail) put(t.tail, t.head);
    for (const b of f.battle ?? []) {
      const speed = Math.hypot(b.v[0], b.v[1], b.v[2]);
      if (!(speed > 0)) continue;
      const len = Math.min(Math.min(trail, Math.max(FX.tracer_min_m, speed * FX.tracer_streak_s)), b.flown);
      const A = project(pose, res, [0, 1, 2].map((j) => b.p[j] - (b.v[j] * len) / speed));
      const B = project(pose, res, b.p);
      if (A && B) put(A, B);
    }
    return mask;
  });
}

/** The pixels within `r` of `q` on `img` tinted by a tracer of `team` over the composite's background, each once (`taken`), pushed to `out` with their colour. */
function tintNear(img, comp, q, r, taken, out, team) {
  for (let y = Math.floor(q[1] - r); y <= Math.floor(q[1] + r); y++) {
    for (let x = Math.floor(q[0] - r); x <= Math.floor(q[0] + r); x++) {
      if (x < 0 || y < 0 || x >= img.w || y >= img.h || Math.hypot(x + 0.5 - q[0], y + 0.5 - q[1]) > r) continue;
      const k = y * img.w + x;
      if (taken.has(k)) continue;
      taken.add(k);
      const rgb = [img.data[k * 4], img.data[k * 4 + 1], img.data[k * 4 + 2]];
      if (tinted(rgb, [comp.back[k * 3], comp.back[k * 3 + 1], comp.back[k * 3 + 2]], team)) out.push({ at: [x, y], rgb });
    }
  }
}

/** The sky's 99th percentile and the gun's mask box (null when it is the whole view) of an image, for a ring. */
function ringContext(img, info) {
  const skyN = Math.floor(img.w * img.h * SKY_ROWS);
  const skyP99 = percentile(img.lum.subarray(0, skyN), SKY_PERCENTILE);
  const boxed = info.gun ? [info.gun[0] - GUN_PAD_PX, info.gun[1] - GUN_PAD_PX, info.gun[0] + info.gun[2] + GUN_PAD_PX, info.gun[1] + info.gun[3] + GUN_PAD_PX] : null;
  const gun = boxed && (boxed[2] - boxed[0]) * (boxed[3] - boxed[1]) <= GUN_BOX_MAX_SHARE * img.w * img.h ? boxed : null;
  return { skyP99, gun, inGun: (x, y) => gun !== null && x >= gun[0] && x < gun[2] && y >= gun[1] && y < gun[3] };
}

/**
 * Head over ring for each of the player's drawn heads in a frame (or, `anyKind`, every session tracer's:
 * the front's amber rounds too), and the headline (the head brightest in display).
 */
export function headRing(img, info, kind, anyKind = false) {
  if (img.w !== info.res[0] || img.h !== info.res[1]) throw new Error(`the screenshot is ${img.w}x${img.h}, the canvas ${info.res.join('x')}`);
  const { skyP99, gun, inGun } = ringContext(img, info);
  const heads = [];
  const skipped = [];
  const mine = info.tracers.filter((t) => anyKind || t.kind === kind);
  for (const t of mine) {
    if (!t.headDrawn || !t.head) continue;
    const [px, py] = t.head;
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    if (cx < 0 || cy < 0 || cx >= img.w || cy >= img.h) {
      skipped.push({ at: t.head, why: 'off the image' });
      continue;
    }
    if (inGun(cx, cy)) {
      skipped.push({ at: t.head, why: 'inside the gun box', gun });
      continue;
    }
    const head = brightest(img, cx, cy, HEAD_PX);
    // Its top channel: the highest value of any channel within HEAD_PX, and which channel it is (a
    // white-hot head's is its team's: red's R, blue's B).
    const { value: channel, channel: top } = topChannel(img, cx, cy, HEAD_PX, teamChannel(t.kind));
    const ring = ringMean(img, cx, cy, RING_PX, (x, y, v) => inGun(x, y) || v > skyP99);
    heads.push({
      at: [Math.round(px * 10) / 10, Math.round(py * 10) / 10], kind: t.kind, flownM: Math.round(t.flown * 10) / 10, struck: !!t.struck, headLum: head, headChannel: channel, headTop: 'RGB'[top], ringMean: ring.mean, ringMeanV: ring.meanV, ringMeanTop: ring.meanRGB ? ring.meanRGB[top] : null, ringPixels: ring.n, ringDropped: ring.dropped,
      ratio: ring.mean === null ? null : head / Math.max(ring.mean, RING_FLOOR),
      ratioV: ring.meanV === null ? null : channel / Math.max(ring.meanV, RING_FLOOR),
      ratioTop: ring.meanRGB === null ? null : channel / Math.max(ring.meanRGB[top], RING_FLOOR),
    });
  }
  const valid = heads.filter((x) => x.ringPixels >= RING_MIN_PIXELS).sort((a, b) => b.headLum - a.headLum);
  return { skyP99, tracersProjected: mine.length, headsDrawn: mine.filter((t) => t.headDrawn).length, headsMeasured: heads.length, headsValid: valid.length, gunMasked: gun !== null, skipped, headline: valid[0] ?? null, heads };
}

/**
 * A frame's puffs of smoke (centre and half size, m) as they show on its image: each one's depth along
 * the view (m), its centre and half size across the image (pixels), those that show lit over what is
 * round them (PUFF_IN over PUFF_RING, LIT) alone.
 */
function litPuffs(img, pose, res, puffs) {
  if (!puffs?.length) return [];
  const { forward } = basis(pose);
  const t = pose.fov === undefined || pose.fov === 90 ? 1 : Math.tan((pose.fov * RAD) / 2);
  const shown = [];
  for (const s of puffs) {
    const d = dot(sub(s.at, pose.position), forward);
    const c = d > 0 ? project(pose, res, s.at) : null;
    if (!c) continue;
    const r = (s.half / (d * t)) * (res[0] / 2);
    const lums = (points) => points.map(([x, y]) => at(img, [c[0] + x * r, c[1] + y * r])).filter((k) => k >= 0).map((k) => img.lum[k]);
    const inside = median(lums(PUFF_IN));
    const round = median(lums(PUFF_RING));
    if (inside !== null && round !== null && lit(inside, round)) shown.push({ depth: d, c, r });
  }
  return shown;
}

/** Whether a puff of `puffs` (litPuffs') nearer the eye than `p` (m) covers, on the image, any of the segment `a` to `b` (pixels). */
function smokeOver(pose, puffs, p, a, b) {
  if (!puffs.length) return false;
  const depth = dot(sub(p, pose.position), basis(pose).forward);
  for (const { depth: d, c, r } of puffs) {
    if (!(d < depth)) continue;
    // The segment's nearest point to its centre.
    const ab = [b[0] - a[0], b[1] - a[1]];
    const u = Math.max(0, Math.min(1, ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1]) / (ab[0] * ab[0] + ab[1] * ab[1] || 1)));
    if (Math.hypot(a[0] + ab[0] * u - c[0], a[1] + ab[1] * u - c[1]) < r) return true;
  }
  return false;
}

/**
 * (a): the widest run across the player's tracers, at half its height, within NEAR_M of the drawn muzzle
 * (from NEAR_FROM_M), over the window's frames, every sample read; those whose walk a puff of smoke nearer
 * the eye, shown lit, covers counted, with their widest run, beside it (`underSmoke`).
 */
export function nearWidth(imgs, frames, kind) {
  let best = null;
  let samples = 0;
  let smoked = null;
  let underSmoke = 0;
  frames.forEach((f, i) => {
    const img = imgs[i];
    const { pose, res } = f.info;
    const muzzle = f.muzzle ?? pose.position;
    const puffs = litPuffs(img, pose, res, f.smoke);
    for (const t of own(f, kind)) {
      const N = 400;
      for (let j = 0; j <= N; j++) {
        const u = j / N;
        const m = dist(lerp(t.tailM, t.headM, u), muzzle);
        if (m < NEAR_FROM_M || m > NEAR_M) continue;
        const q = project(pose, res, lerp(t.tailM, t.headM, u));
        const a = project(pose, res, lerp(t.tailM, t.headM, Math.max(0, u - 1e-3)));
        const b = project(pose, res, lerp(t.tailM, t.headM, Math.min(1, u + 1e-3)));
        if (!q || !a || !b || at(img, q) < 0) continue;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (!(len > 0)) continue;
        const n = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
        const off = (o) => at(img, [q[0] + n[0] * o, q[1] + n[1] * o]);
        // Each side's own surroundings: a tracer along the horizon has the parapet under it and the haze over it.
        const side = (sign) => {
          const v = [];
          for (let o = BG_PX[0]; o <= BG_PX[1]; o++) {
            const k = off(sign * o);
            if (k >= 0) v.push(img.lum[k]);
          }
          return median(v);
        };
        const bgs = [side(-1), side(1)];
        if (bgs[0] === null || bgs[1] === null) continue;
        const centre = img.lum[at(img, q)];
        if (!(centre >= Math.max(bgs[0], bgs[1]) + NEAR_CONTRAST)) continue;
        const under = smokeOver(pose, puffs, lerp(t.tailM, t.headM, u), [q[0] - n[0] * WALK_PX, q[1] - n[1] * WALK_PX], [q[0] + n[0] * WALK_PX, q[1] + n[1] * WALK_PX]);
        samples++;
        // The first step either side short of `within(v, bg)`, less half a step: the run's extent that way.
        const reach = (sign, bg, within) => {
          for (let o = 0.5; o <= WALK_PX; o += 0.5) {
            const k = off(sign * o);
            if (k < 0 || !within(img.lum[k], bg)) return o - 0.25;
          }
          return WALK_PX;
        };
        // Its width at half its height over each side's surroundings (the line's own band: not the bloom's
        // halo round it, nor the parapet its shot's flash lights); and, as loosely as (c)'s, all of it lit.
        const half = (v, bg) => v - bg >= 0.5 * (centre - bg);
        const width = reach(-1, bgs[0], half) + reach(1, bgs[1], half);
        if (under) {
          underSmoke++;
          if (!smoked || width > smoked.px) smoked = { px: width, frame: i, at: [Math.round(q[0]), Math.round(q[1])], fromMuzzleM: Math.round(m * 10) / 10 };
        }
        const loose = reach(-1, bgs[0], lit) + reach(1, bgs[1], lit);
        if (!best || width > best.px) best = { px: width, litPx: loose, frame: i, at: [Math.round(q[0]), Math.round(q[1])], normal: n, fromMuzzleM: Math.round(m * 10) / 10, background: bgs.map(Math.round), centre: Math.round(centre), flownM: Math.round(t.flown * 10) / 10 };
      }
    }
  });
  return { ...(best ?? { px: null }), samples, underSmoke: { samples: underSmoke, ...(smoked ?? { px: null }) } };
}

/**
 * (b): the colour of the player's tracers' lit pixels past FAR_M of flight (their ribbons and heads), over
 * the window's frames; and, reported beside it, of their pixels tinted by their team's colour (`tint`: by
 * day a red one covering the haze is darker than it, and none of its pixels is lit).
 */
export function farColour(imgs, comp, frames, kind, team) {
  const pixels = [];
  const tints = [];
  frames.forEach((f, i) => {
    const img = imgs[i];
    const { pose, res } = f.info;
    const taken = new Set();
    const tintTaken = new Set();
    for (const t of own(f, kind)) {
      if (t.flown < FAR_M) continue;
      const tail = tailFlown(t);
      const u0 = Math.max(0, Math.min(1, (FAR_M - tail) / Math.max(1e-6, t.flown - tail)));
      for (let j = 0; j <= 200; j++) {
        const q = project(pose, res, lerp(t.tailM, t.headM, u0 + ((1 - u0) * j) / 200));
        if (!q) continue;
        litNear(img, comp, q, FAR_RADIUS_PX, taken, pixels);
        tintNear(img, comp, q, FAR_RADIUS_PX, tintTaken, tints, team);
      }
      const h = t.headDrawn ? project(pose, res, t.headM) : null;
      if (h) {
        litNear(img, comp, h, FAR_HEAD_PX, taken, pixels);
        tintNear(img, comp, h, FAR_HEAD_PX, tintTaken, tints, team);
      }
    }
  });
  const c = colourOf(pixels);
  return { ...c, measured: c.n >= FAR_LIT_MIN, pixels: pixels.slice(0, 400), tint: colourOf(tints) };
}

/** The enemy line's rounds (the session's amber) as drawn over the window's frames: their pixels tinted amber over the composite's background, reported (at 17:35 the battle does not fire; the front's fire is the amber in the frame). */
export function frontColour(imgs, comp, frames) {
  const tints = [];
  let drawn = 0;
  frames.forEach((f, i) => {
    const img = imgs[i];
    const { pose, res } = f.info;
    const taken = new Set();
    for (const t of own(f, KIND.amber)) {
      const A = project(pose, res, t.tailM);
      const B = project(pose, res, t.headM);
      if (!A || !B) continue;
      drawn++;
      const n = Math.max(1, Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1])));
      for (let j = 0; j <= n; j++) tintNear(img, comp, [A[0] + ((B[0] - A[0]) * j) / n, A[1] + ((B[1] - A[1]) * j) / n], FAR_RADIUS_PX, taken, tints, TEAM.amber);
    }
  });
  return { drawn, ...colourOf(tints) };
}

/** The battle's streams' lit pixels' colour: each tracer's streak as effects-frame draws it (its speed over tracer_streak_s, within tracer_min_m and the battle's trail_m, no more than it has flown). */
export function battleColour(imgs, comp, frames) {
  const pixels = [];
  const trail = TUN.battle.tracers.trail_m;
  frames.forEach((f, i) => {
    const img = imgs[i];
    const { pose, res } = f.info;
    const taken = new Set();
    for (const b of f.battle ?? []) {
      const speed = Math.hypot(b.v[0], b.v[1], b.v[2]);
      if (!(speed > 0)) continue;
      const len = Math.min(Math.min(trail, Math.max(FX.tracer_min_m, speed * FX.tracer_streak_s)), b.flown);
      const tail = [0, 1, 2].map((k) => b.p[k] - (b.v[k] * len) / speed);
      const A = project(pose, res, tail);
      const B = project(pose, res, b.p);
      if (!A || !B) continue;
      const n = Math.max(1, Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1])));
      for (let j = 0; j <= n; j++) litNear(img, comp, [A[0] + ((B[0] - A[0]) * j) / n, A[1] + ((B[1] - A[1]) * j) / n], BATTLE_RADIUS_PX, taken, pixels);
    }
  });
  const c = colourOf(pixels);
  return { ...c, measured: c.n >= FAR_LIT_MIN };
}

/**
 * (e): the stream from the hip. The followed round's drawn ribbons, from STREAM_FROM_M past the drawn
 * muzzle to within STREAM_AIM_PX of the point of aim (the view's middle), sampled a pixel apart on each
 * frame's image and read across the line, PATH_ACROSS_PX either side, each pixel over its own
 * background (lit if any is, tinted if any is: a drawn core a pixel off the sample is read by its core,
 * and a band across the crest's edge does not read the sky's own brightness over the parapet's as a
 * line): the share of them shown in the composite ((c)'s rule: lit, or by day (`day`) lit or tinted by
 * `team`'s colour); and how far out from the point of aim the shown stream reaches, over the muzzle's
 * distance from it. Beside them (`lit`), the share lit and its reach alone.
 *
 * A sample with a pixel over a background the lit rule cannot reach (LIT.ratio times it past 255:
 * 17:35's sky, 170 and brighter, through a gap in the crest) that is brighter than that background by
 * LIT.min, and none shown, is left out of both shares and counted (`unread`), as (c) leaves out what
 * the gun and the world hide: a white core there cannot be lit, nor is white its team's colour, and it
 * is not a miss. One with no pixel brighter than its own background is (nothing is drawn there), and a
 * tinted one is shown, as before. Under STREAM_READ_MIN of the samples read, the share is no measure.
 */
export function streamCover(comp, frames, track, team = null, day = false) {
  if (!track) return { share: null, why: 'no round followed' };
  const samples = [];
  let muzzlePx = null;
  for (const { frame, t } of track.seen) {
    const f = frames[frame];
    const { pose, res } = f.info;
    const muzzle = f.muzzle;
    if (!muzzle) continue;
    const centre = [res[0] / 2, res[1] / 2];
    const m = project(pose, res, muzzle);
    if (m && muzzlePx === null) muzzlePx = Math.hypot(m[0] - centre[0], m[1] - centre[1]);
    let last = null;
    for (let j = 0; j <= 2000; j++) {
      const p = lerp(t.tailM, t.headM, j / 2000);
      if (dist(p, muzzle) < STREAM_FROM_M) continue;
      const q = project(pose, res, p);
      if (!q) continue;
      const off = Math.hypot(q[0] - centre[0], q[1] - centre[1]);
      if (off < STREAM_AIM_PX) break;
      if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < 1) continue;
      last = q;
      if (at(comp, q) < 0) continue;
      // Across the line: PATH_ACROSS_PX either side, each pixel over its own background (a line along the
      // crest's edge has the sky behind one side of its band and the parapet behind the other, and the
      // sky's own brightness is not a line over the parapet's); lit if any is, tinted if any is.
      const ahead = project(pose, res, lerp(t.tailM, t.headM, Math.min(1, j / 2000 + 1e-3)));
      const along = ahead ? Math.hypot(ahead[0] - q[0], ahead[1] - q[1]) : 0;
      const n = along > 0 ? [-(ahead[1] - q[1]) / along, (ahead[0] - q[0]) / along] : [0, 1];
      let covered = false;
      let tint = false;
      let past = false;
      // Reported: the pixel most over its own background.
      let lum = 0;
      let bg = null;
      for (let o = -PATH_ACROSS_PX; o <= PATH_ACROSS_PX + 1e-9; o += 0.5) {
        const k = at(comp, [q[0] + n[0] * o, q[1] + n[1] * o]);
        if (k < 0) continue;
        const v = comp.lum[k];
        const b = comp.least[k];
        if (lit(v, b)) covered = true;
        // Brighter than a background no reading can be lit over.
        else if (LIT.ratio * b > 255 && v >= b + LIT.min) past = true;
        if (!tint && team && tinted([comp.data[k * 4], comp.data[k * 4 + 1], comp.data[k * 4 + 2]], [comp.back[k * 3], comp.back[k * 3 + 1], comp.back[k * 3 + 2]], team)) tint = true;
        if (bg === null || v - b > lum - bg) {
          lum = v;
          bg = b;
        }
      }
      const shown = covered || (day && tint);
      // A pixel brighter than its own background past the lit rule's reach, and none shown: unread, not a miss.
      const unread = !shown && past;
      samples.push({ at: q, off, covered, tint, shown, unread, lum, bg });
    }
  }
  // Where the stream is on the image STREAM_FROM_M, a metre and three metres past the muzzle (from the first frame it is drawn in): how far from the point of aim.
  const where = (m) => {
    for (const { frame, t } of track.seen) {
      const f = frames[frame];
      if (!f.muzzle) continue;
      for (let j = 0; j <= 2000; j++) {
        const p = lerp(t.tailM, t.headM, j / 2000);
        if (dist(p, f.muzzle) < m) continue;
        const q = project(f.info.pose, f.info.res, p);
        return q ? Math.round(Math.hypot(q[0] - f.info.res[0] / 2, q[1] - f.info.res[1] / 2)) : null;
      }
    }
    return null;
  };
  const geometry = { atFromPx: where(STREAM_FROM_M), at1mPx: where(1), at3mPx: where(3) };
  const counts = day ? 'lit or tinted' : 'lit';
  if (samples.length === 0) return { share: null, counts, lit: { share: null, span: null }, muzzlePx: muzzlePx === null ? null : Math.round(muzzlePx), ...geometry, why: `nothing of the stream ${STREAM_FROM_M} m past the muzzle lies ${STREAM_AIM_PX} px or more from the point of aim` };
  const unread = samples.filter((x) => x.unread).length;
  const read = samples.length - unread;
  if (read < STREAM_READ_MIN * samples.length) return { share: null, counts, samples: samples.length, unread, lit: { share: null, span: null }, muzzlePx: muzzlePx === null ? null : Math.round(muzzlePx), ...geometry, marks: samples, why: `${unread} of ${samples.length} samples over a background that cannot be lit (${LIT.ratio} times it past 255), more than ${1 - STREAM_READ_MIN} of them` };
  /** The share of the samples read `ones` are, how far out from the point of aim they reach, and its share of the muzzle's distance. */
  const over = (ones) => {
    const reach = ones.length ? Math.max(...ones.map((x) => x.off)) : 0;
    return { share: ones.length / read, reach, span: muzzlePx ? reach / muzzlePx : null };
  };
  const shownOnes = samples.filter((x) => x.shown);
  const shown = over(shownOnes);
  const litAlone = over(samples.filter((x) => x.covered));
  // Beside the span, the shown stream's own extent: its outermost shown pixel to its innermost, over the muzzle's distance.
  const inner = shownOnes.length ? Math.min(...shownOnes.map((x) => x.off)) : 0;
  return {
    share: shown.share, counts, samples: samples.length, unread, reachPx: Math.round(shown.reach), innerPx: Math.round(inner), muzzlePx: muzzlePx === null ? null : Math.round(muzzlePx), span: shown.span, extent: muzzlePx && shownOnes.length ? (shown.reach - inner) / muzzlePx : null,
    lit: { share: litAlone.share, reachPx: Math.round(litAlone.reach), span: litAlone.span },
    ...geometry, marks: samples,
  };
}

/**
 * The round that left in the window's first frame, frame to frame by its flight (its own last step;
 * the AK's muzzle velocity over a frame, to start), and the line its tracer is drawn along, fitted to
 * its drawn segments PATH_M[0] or more out (`fit` 'drawn'): from the muzzle toward where it joins its
 * path (where the shot was aimed, `joinsM`) and along the path past it, what the image shows. A round's
 * last streak, ending where it struck (`struck`), is drawn too, and followed as any other.
 */
export function trackRound(frames, kind) {
  const start = own(frames[0], kind);
  if (start.length === 0) return null;
  let cur = start.reduce((a, b) => (b.flown < a.flown ? b : a));
  const seen = [{ frame: 0, t: cur }];
  let step = AK_FRAME_M;
  for (let i = 1; i < frames.length; i++) {
    const was = cur.flown;
    const next = own(frames[i], kind).filter((t) => t.flown > was + 0.35 * step && t.flown < was + 1.7 * step);
    if (next.length === 0) break;
    cur = next.reduce((a, b) => (Math.abs(b.flown - was - step) < Math.abs(a.flown - was - step) ? b : a));
    step = cur.flown - was;
    seen.push({ frame: i, t: cur });
  }
  const out = seen.filter((s) => tailFlown(s.t) >= PATH_M[0] - 0.5);
  const fit = out.length >= 2 ? [out[0].t.headM, out[out.length - 1].t.headM, out[0].t.flown, out[out.length - 1].t.flown] : out.length === 1 ? [out[0].t.tailM, out[0].t.headM, tailFlown(out[0].t), out[0].t.flown] : null;
  if (!fit) return { seen, path: null };
  const d = unit(sub(fit[1], fit[0]));
  const origin = [0, 1, 2].map((k) => fit[0][k] - d[k] * fit[2]);
  return { seen, path: { fit: 'drawn', origin, dir: d, lastFlownM: seen[seen.length - 1].t.flown, point: (s) => [0, 1, 2].map((k) => origin[k] + d[k] * s) } };
}

/** The G-buffer's depth (m) at a CSS pixel, from a frame's box round the middle; null outside it. */
function depthAt(f, q) {
  const d = f.depth;
  if (!d) return null;
  const x = Math.floor(q[0] * d.scale) - d.x0;
  const y = Math.floor(q[1] * d.scale) - d.y0;
  return x < 0 || y < 0 || x >= d.n || y >= d.n ? null : d.metres[y * d.n + x];
}

/**
 * The followed round's path (PATH_M of flight) on the image by the window's middle frame's camera,
 * sampled a pixel apart: each sample's point and how far its point of the path is from the camera.
 */
export function pathSamples(frames, track) {
  if (!track?.path) return null;
  const mid = frames[Math.floor(frames.length / 2)].info;
  const end = Math.min(PATH_M[1], track.path.lastFlownM);
  const P0 = track.path.point(PATH_M[0]);
  const P1 = track.path.point(end);
  const A = project(mid.pose, mid.res, P0);
  const B = project(mid.pose, mid.res, P1);
  if (!A || !B) return null;
  const lengthPx = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const n = lengthPx > 0 ? [-(B[1] - A[1]) / lengthPx, (B[0] - A[0]) / lengthPx] : [0, 1];
  const N = Math.max(1, Math.ceil(lengthPx));
  const points = [];
  const metres = [];
  const { forward } = basis(mid.pose);
  const d0 = dot(sub(P0, mid.pose.position), forward);
  const d1 = dot(sub(P1, mid.pose.position), forward);
  for (let j = 0; j <= N; j++) {
    const q = [A[0] + ((B[0] - A[0]) * j) / N, A[1] + ((B[1] - A[1]) * j) / N];
    if (q[0] < 0 || q[1] < 0 || q[0] >= mid.res[0] || q[1] >= mid.res[1]) continue;
    // The path's point on this sample's ray: a line's projection is a line, its points found by their share of it in depth.
    const u = j / N;
    const w = (u * d0) / ((1 - u) * d1 + u * d0);
    points.push(q);
    metres.push(dist(lerp(P0, P1, Number.isFinite(w) ? w : u), mid.pose.position));
  }
  return { points, metres, n, lengthPx, end };
}

/**
 * (c): the share of the round's path (PATH_M of flight) shown in the composite, sampled a pixel apart on
 * the image (by the window's middle frame's camera), over the samples the world does not hide (by
 * `pathDepth`, the G-buffer's depth along them) and, aimed, the gun covers in no frame. Shown: lit, or by
 * day (`day`) lit or tinted by its team's colour (`team`). Reported beside it, the share lit alone
 * (`litShare`), and the share tinted and the tinted samples' colour (`tint`).
 */
export function pathCover(comp, frames, track, aimed, pathDepth, team, day = false) {
  if (!track?.path) return { share: null, why: `no round followed ${PATH_M[0]} m out` };
  const ps = pathSamples(frames, track);
  if (!ps) return { share: null, why: 'the path is behind the camera or off the image' };
  const { n, lengthPx, end } = ps;
  const samples = [];
  for (let j = 0; j < ps.points.length; j++) {
    const q = ps.points[j];
    if (at(comp, q) < 0) continue;
    const gun = aimed
      ? frames.some((f) => {
          const m = depthAt(f, q);
          return m !== null && m < GUN_DEPTH_M;
        })
      : false;
    const hidden = !gun && pathDepth && pathDepth.length === ps.points.length ? pathDepth[j] < HIDDEN_SHARE * ps.metres[j] : false;
    let best = 0;
    const bgs = [];
    let tint = null;
    for (let o = -PATH_ACROSS_PX; o <= PATH_ACROSS_PX + 1e-9; o += 0.5) {
      const k = at(comp, [q[0] + n[0] * o, q[1] + n[1] * o]);
      if (k < 0) continue;
      best = Math.max(best, comp.lum[k]);
      bgs.push(comp.least[k]);
      const rgb = [comp.data[k * 4], comp.data[k * 4 + 1], comp.data[k * 4 + 2]];
      if (!tint && team && tinted(rgb, [comp.back[k * 3], comp.back[k * 3 + 1], comp.back[k * 3 + 2]], team)) tint = rgb;
    }
    const bg = median(bgs);
    const covered = bg !== null && lit(best, bg);
    samples.push({ at: q, gun, hidden, covered, tint, shown: covered || (day && tint !== null), lum: best, bg });
  }
  const counted = samples.filter((s) => !s.gun && !s.hidden);
  const shareOf = (keep) => (counted.length ? counted.filter(keep).length / counted.length : null);
  const tints = counted.filter((s) => s.tint);
  const behindGun = samples.filter((s) => s.gun).length;
  return {
    share: shareOf((s) => s.shown),
    counts: day ? 'lit or tinted' : 'lit',
    litShare: shareOf((s) => s.covered),
    tint: { share: shareOf((s) => s.tint), ...colourOf(tints.map((s) => ({ rgb: s.tint }))) },
    fit: track.path.fit, spanM: [PATH_M[0], Math.round(end * 10) / 10], lengthPx: Math.round(lengthPx * 10) / 10, endOn: lengthPx < DEGENERATE_PX, samples: samples.length, behindGun, hiddenByWorld: samples.filter((s) => s.hidden).length, depthRead: !!pathDepth, counted: counted.length, why: counted.length ? undefined : behindGun ? 'every sample is behind the gun' : 'every sample is hidden', marks: samples,
  };
}

/**
 * (f): aimed, the share of the followed round's path (PATH_M of flight) shown in the composite, sampled a
 * pixel apart on the image (by the window's middle frame's camera), over the samples the gun covers in
 * no frame (its G-buffer depth there nearer than GUN_DEPTH_M) and the world does not hide (`pathDepth`).
 * Each sample is read across the line, PATH_ACROSS_PX either side, each pixel over its own background
 * ((e)'s rule, not the band's brightest over its median, which reads a bare bright-over-dark edge as a
 * line: Task 3b's F8): lit if any is, and by day (`day`) tinted by `team`'s colour if any is. Beside it,
 * the share lit alone, and how many samples the gun covered (`behindGun`). With every sample behind the
 * gun or hidden, no measure.
 */
export function aimedCover(comp, frames, track, pathDepth, team = null, day = false) {
  if (!track?.path) return { share: null, why: `no round followed ${PATH_M[0]} m out` };
  const ps = pathSamples(frames, track);
  if (!ps) return { share: null, why: 'the path is behind the camera or off the image' };
  const { n, lengthPx, end } = ps;
  const samples = [];
  for (let j = 0; j < ps.points.length; j++) {
    const q = ps.points[j];
    if (at(comp, q) < 0) continue;
    const gun = frames.some((f) => {
      const m = depthAt(f, q);
      return m !== null && m < GUN_DEPTH_M;
    });
    const hidden = !gun && pathDepth && pathDepth.length === ps.points.length ? pathDepth[j] < HIDDEN_SHARE * ps.metres[j] : false;
    let covered = false;
    let tint = false;
    // Reported: the pixel most over its own background.
    let lum = 0;
    let bg = null;
    for (let o = -PATH_ACROSS_PX; o <= PATH_ACROSS_PX + 1e-9; o += 0.5) {
      const k = at(comp, [q[0] + n[0] * o, q[1] + n[1] * o]);
      if (k < 0) continue;
      const v = comp.lum[k];
      const b = comp.least[k];
      if (lit(v, b)) covered = true;
      if (!tint && team && tinted([comp.data[k * 4], comp.data[k * 4 + 1], comp.data[k * 4 + 2]], [comp.back[k * 3], comp.back[k * 3 + 1], comp.back[k * 3 + 2]], team)) tint = true;
      if (bg === null || v - b > lum - bg) {
        lum = v;
        bg = b;
      }
    }
    samples.push({ at: q, gun, hidden, covered, tint, shown: covered || (day && tint), lum, bg });
  }
  const counted = samples.filter((s) => !s.gun && !s.hidden);
  const shareOf = (keep) => (counted.length ? counted.filter(keep).length / counted.length : null);
  const behindGun = samples.filter((s) => s.gun).length;
  return {
    share: shareOf((s) => s.shown),
    counts: day ? 'lit or tinted' : 'lit',
    litShare: shareOf((s) => s.covered),
    spanM: [PATH_M[0], Math.round(end * 10) / 10], lengthPx: Math.round(lengthPx * 10) / 10, endOn: lengthPx < DEGENERATE_PX, samples: samples.length, behindGun, hiddenByWorld: samples.filter((s) => s.hidden).length, depthRead: !!pathDepth, counted: counted.length,
    why: counted.length ? undefined : behindGun ? 'every sample is behind the gun' : 'every sample is hidden',
    marks: samples,
  };
}

/** (d): the round's brightest pixel at NOON_AT_M of flight over its ring, in the frame whose head is nearest past that point. */
export function noonContrast(imgs, frames, track, kind) {
  if (!track?.path) return { ratio: null, why: `no round followed ${PATH_M[0]} m out` };
  const over = track.seen.filter((s) => tailFlown(s.t) <= NOON_AT_M && s.t.flown >= NOON_AT_M).sort((a, b) => a.t.flown - b.t.flown)[0];
  if (!over) return { ratio: null, why: `no frame drew the round across ${NOON_AT_M} m` };
  const f = frames[over.frame];
  const img = imgs[over.frame];
  const u = (NOON_AT_M - tailFlown(over.t)) / Math.max(1e-6, over.t.flown - tailFlown(over.t));
  const q = project(f.info.pose, f.info.res, lerp(over.t.tailM, over.t.headM, u));
  if (!q || at(img, q) < 0) return { ratio: null, why: 'the point is off the image' };
  const cx = Math.floor(q[0]);
  const cy = Math.floor(q[1]);
  const { skyP99, inGun } = ringContext(img, f.info);
  // Clear of every drawn tracer of the player's (its glow and bloom), the gun, and the sky's brightest.
  const segments = own(f, kind)
    .map((t) => [project(f.info.pose, f.info.res, t.tailM), project(f.info.pose, f.info.res, t.headM)])
    .filter(([a, b]) => a && b);
  const near = (x, y) =>
    segments.some(([a, b]) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      const s = l2 > 0 ? Math.max(0, Math.min(1, ((x + 0.5 - a[0]) * dx + (y + 0.5 - a[1]) * dy) / l2)) : 0;
      return Math.hypot(x + 0.5 - a[0] - dx * s, y + 0.5 - a[1] - dy * s) < NOON_CLEAR_PX;
    });
  const head = brightest(img, cx, cy, HEAD_PX);
  const ring = ringMean(img, cx, cy, NOON_RING_PX, (x, y, v) => inGun(x, y) || v > skyP99 || near(x, y));
  const ratio = ring.mean === null || ring.n < NOON_RING_MIN ? null : head / Math.max(ring.mean, RING_FLOOR);
  return { ratio, frame: over.frame, headFlownM: Math.round(over.t.flown * 10) / 10, at: [cx, cy], head, ringMean: ring.mean, ringPixels: ring.n, why: ratio === null ? `a ring of ${ring.n} pixels` : undefined };
}

/** A copy of the PNG with a 1 px magenta box round each measured head (the headline's larger). */
export function marked(img, m) {
  const data = Buffer.from(img.data);
  const put = (x, y, c = [255, 0, 255]) => {
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
    const i = (y * img.w + x) * 4;
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
    data[i + 3] = 255;
  };
  for (const hd of m.heads) {
    const r = hd === m.headline ? 14 : 8;
    const cx = Math.floor(hd.at[0]);
    const cy = Math.floor(hd.at[1]);
    for (let d = -r; d <= r; d++) {
      put(cx + d, cy - r);
      put(cx + d, cy + r);
      put(cx - r, cy + d);
      put(cx + r, cy + d);
    }
  }
  return encode(data, img.w, img.h);
}

/** The composite marked: (c)'s path a few pixels under it and (f)'s a few over it (green lit, blue tinted by its team's colour and not lit, red neither, grey behind the gun or hidden), (a)'s run (cyan), (b)'s pixels (yellow), (e)'s stream (cyan lit, blue tinted and not lit, grey unread: brighter than a background no reading can be lit over, orange neither), (d)'s point and ring (magenta). By day (c) and (e) count the blue as shown; after dark they do not. */
export function markedComposite(comp, m) {
  const data = Buffer.from(comp.data);
  const put = (x, y, c) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= comp.w || y >= comp.h) return;
    const i = (y * comp.w + x) * 4;
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
    data[i + 3] = 255;
  };
  if (m.pathCover?.marks) for (const s of m.pathCover.marks) for (const o of [5, 6]) put(s.at[0], s.at[1] + o, s.gun || s.hidden ? [128, 128, 128] : s.covered ? [0, 255, 0] : s.tint ? [0, 96, 255] : [255, 0, 0]);
  const a = m.nearWidth;
  if (a?.px != null) for (let o = -a.px / 2; o <= a.px / 2; o += 0.5) put(a.at[0] + a.normal[0] * o, a.at[1] + a.normal[1] * o, [0, 255, 255]);
  if (m.farColour?.pixels) {
    for (const p of m.farColour.pixels.slice(0, 60)) {
      put(p.at[0] - 3, p.at[1], [255, 255, 0]);
      put(p.at[0] + 3, p.at[1], [255, 255, 0]);
    }
  }
  if (m.aimedCover?.marks) for (const x of m.aimedCover.marks) for (const o of [-6, -5]) put(x.at[0], x.at[1] + o, x.gun || x.hidden ? [128, 128, 128] : x.covered ? [0, 255, 0] : x.tint ? [0, 96, 255] : [255, 0, 0]);
  if (m.stream?.marks) for (const x of m.stream.marks) for (const o of [5, 6]) put(x.at[0], x.at[1] + o, x.covered ? [0, 255, 255] : x.tint ? [0, 96, 255] : x.unread ? [160, 160, 160] : [255, 128, 0]);
  const d = m.noonContrast;
  if (d?.at) for (let t = 0; t < 360; t += 2) for (const r of NOON_RING_PX) put(d.at[0] + r * Math.cos(t * RAD), d.at[1] + r * Math.sin(t * RAD), [255, 0, 255]);
  return encode(data, comp.w, comp.h);
}

/** Every measure of a capture (`cap`: its window's frames, each with its PNG; the depth along the path), the images it read, the composite, and which frame is the shot. */
export function measureCapture(c, cap) {
  const kind = kindOf(c);
  const team = c.team === 'blue' ? TEAM.blue : TEAM.red;
  const imgs = cap.frames.map((f) => decode(f.png));
  const comp = composite(imgs, tracerMasks(cap.frames, imgs[0].w, imgs[0].h));
  // The shot: the first frame of the window clear of the flash with the player's head drawn (else the first with it).
  const headed = (f, i) => i >= FLASH_FRAMES && own(f, kind).some((t) => t.headDrawn);
  const clear = cap.frames.findIndex(headed);
  const shotIndex = clear >= 0 ? clear : cap.frames.findIndex((f) => own(f, kind).some((t) => t.headDrawn));
  const shot = shotIndex >= 0 ? shotIndex : 0;
  const hr = headRing(imgs[shot], cap.frames[shot].info, kind);
  // For comparison with the first proof (Task 4's headline was any session tracer's head): the best of every kind's.
  const every = headRing(imgs[shot], cap.frames[shot].info, kind, true).heads.filter((x) => x.ringPixels >= RING_MIN_PIXELS && x.ratio !== null).sort((a, b) => b.ratio - a.ratio)[0] ?? null;
  const track = trackRound(cap.frames, kind);
  const hip = !c.aimed && !c.side;
  // By day (c) and (e) count a sample shown lit or tinted by the team's colour; after dark, lit.
  const day = byDay(c);
  const m = {
    shotFrame: cap.frames[shot].k,
    ...hr,
    bestOfAnyKind: every,
    nearWidth: hip && c.burst !== 'graze' ? nearWidth(imgs, cap.frames, kind) : null,
    farColour: c.burst === 'far' && !c.aimed ? farColour(imgs, comp, cap.frames, kind, team) : null,
    battleColour: day ? null : battleColour(imgs, comp, cap.frames),
    frontColour: frontColour(imgs, comp, cap.frames),
    stream: hip && nearLike(c) ? streamCover(comp, cap.frames, track, team, day) : null,
    pathCover: c.burst === 'far' ? pathCover(comp, cap.frames, track, !!c.aimed, cap.pathDepth, team, day) : null,
    aimedCover: c.burst === 'far' && c.aimed ? aimedCover(comp, cap.frames, track, cap.pathDepth, team, day) : null,
    noonContrast: c.burst === 'far' && day ? noonContrast(imgs, cap.frames, track, kind) : null,
    followed: track ? track.seen.map((s) => Math.round(s.t.flown * 10) / 10) : null,
    // Each frame's exposure, effects and the shooter's suppression (the front fires on in the far captures; a suppressed frame greys the world, not the tracers).
    window: cap.frames.map((f) => ({ k: f.k, exposure: round3(f.exposure), suppression: round3(f.suppression), embers: f.fx.embers, ricochets: f.fx.ricochets, battleTracers: f.fx.battleTracers })),
  };
  return { m, imgs, comp, shot };
}

/** A measure that is there: a finite number (null, undefined and NaN are missing, and fail every gate). */
const num = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * The failures a capture's thresholds find in its measures (`m`) and its burst's own numbers (`burst`:
 * `most`, the most ricochets and embers drawn in a frame, of every kind and by TRACER_KIND;
 * `gpuSamples`). Which gates apply is the capture's (the G1 ledger's rulings), never whether a measure
 * came back: a measure missing where it is gated fails.
 *   - Every hip capture but the graze: (a). Near ones: a head drawn and measured, by day at the
 *     display's top in its own channel, after dark MIN_RATIO over its ring in it; near ones and the
 *     wall: (e) (the wall's head, beside its own shot's flash in every frame it is drawn, reported).
 *   - Far (from the eye or the side, not aimed): (b) after dark, against the shooter's team's hue and
 *     its kind's saturation (by day reported); (d) at noon (at 17:35 reported). Side on: (c).
 *   - Aimed, the 90 m burst: (f), at TARGET.aimedCover (G4 Task 4). The 30 m one is a picture.
 *   - (c), (e) and (f) read the share shown: by day lit or tinted, after dark lit (the measures', `counts`).
 *   - `battle`: the battle's amber. The graze: a ricochet of the player's kind. `front` (heavy): the
 *     enemy line's amber in the frame (the window is chosen at a frame it is drawn in), tinted amber.
 *     Every capture: enough GPU samples.
 */
export function gateCapture(c, m, burst) {
  const failures = [];
  const kind = kindOf(c);
  const team = c.team === 'blue' ? TEAM.blue : TEAM.red;
  const hip = !c.aimed && !c.side;
  const far = c.burst === 'far' && !c.aimed;
  const day = byDay(c);
  if (hip && c.burst === 'near') {
    const hl = m.headline;
    if (!(num(m.headsDrawn) && m.headsDrawn >= 1)) failures.push('no tracer head of the player drawn at the shot frame');
    else if (!hl) failures.push(`no head measured with a ring of ${RING_MIN_PIXELS}+ pixels (${m.headsMeasured} measured)`);
    else if (day) {
      if (!(num(hl.headChannel) && hl.headChannel >= NOON_HEAD_MIN)) failures.push(`by day: the head's brightest channel ${hl.headChannel} < ${NOON_HEAD_MIN}`);
    } else if (!(num(hl.ratioTop) && hl.ratioTop >= MIN_RATIO)) failures.push(`head over ring in its top channel (${hl.headTop}) ${hl.headChannel}/${hl.ringMeanTop?.toFixed(1)} = ${hl.ratioTop?.toFixed(2)} < ${MIN_RATIO} (V ${hl.ratioV?.toFixed(2)}, luminance ${hl.ratio?.toFixed(2)})`);
  }
  if (hip && nearLike(c)) {
    const e = m.stream;
    if (!(num(e?.share) && e.share >= TARGET.streamCover && num(e.span) && e.span >= TARGET.streamSpan)) failures.push(`(e) the stream from the hip: ${e?.counts ?? 'shown'} ${round3(e?.share)} (>= ${TARGET.streamCover}) of ${e?.samples ?? 0} samples (${e?.unread ?? 0} unread), reaching ${e?.reachPx ?? '-'} of ${e?.muzzlePx ?? '-'} px to the muzzle: ${round3(e?.span)} (>= ${TARGET.streamSpan}); lit alone ${round3(e?.lit?.share)}, span ${round3(e?.lit?.span)}${e?.why ? ` (${e.why})` : ''}`);
  }
  if (hip && c.burst !== 'graze') {
    const a = m.nearWidth;
    if (!(num(a?.px) && a.px <= TARGET.nearWidthPx)) failures.push(num(a?.px) ? `(a) near width ${a.px} px > ${TARGET.nearWidthPx}` : `(a) near width: nothing measured (${a?.samples ?? 0} samples)`);
  }
  if (far && !day) {
    const b = m.farColour;
    const saturation = TARGET.farSaturation[c.team === 'blue' ? 'blue' : 'red'];
    if (!(b?.measured === true)) failures.push(`(b) ${b?.n ?? 0} lit pixels past ${FAR_M} m`);
    else if (!(num(b.saturation) && b.saturation >= saturation && num(b.hueDeg) && hueOff(b.hueDeg, team.hue) <= TARGET.farHueDeg)) failures.push(`(b) far colour: saturation ${round3(b.saturation)} (>= ${saturation}, ${c.team ?? 'red'}'s), hue ${num(b.hueDeg) ? b.hueDeg.toFixed(1) : b.hueDeg} (${c.team ?? 'red'} ${team.hue.toFixed(1)} +/- ${TARGET.farHueDeg})`);
  }
  if (far && c.hours === 12) {
    const d = m.noonContrast;
    if (!(num(d?.ratio) && d.ratio >= TARGET.noonContrast)) failures.push(`(d) noon contrast ${round3(d?.ratio)} < ${TARGET.noonContrast}${d?.why ? ` (${d.why})` : ''}`);
  }
  if (c.side) {
    const p = m.pathCover;
    if (!(num(p?.share) && p.share >= TARGET.pathCover)) failures.push(`(c) path cover, ${p?.counts ?? 'shown'}, ${round3(p?.share)} < ${TARGET.pathCover} (lit alone ${round3(p?.litShare)})${p?.why ? ` (${p.why})` : ''}`);
  }
  if (c.aimed && c.burst === 'far') {
    const f = m.aimedCover;
    if (!(num(f?.share) && f.share >= TARGET.aimedCover)) failures.push(`(f) aimed, the path beside the post, ${f?.counts ?? 'shown'}, ${round3(f?.share)} < ${TARGET.aimedCover} (lit alone ${round3(f?.litShare)}; ${f?.counted ?? 0} of ${f?.samples ?? 0} samples counted, ${f?.behindGun ?? 0} behind the gun, ${f?.hiddenByWorld ?? 0} hidden)${f?.why ? ` (${f.why})` : ''}`);
  }
  if (c.battle) {
    const bc = m.battleColour;
    if (!(bc?.measured === true)) failures.push(`the battle's streams at night: ${bc?.n ?? 0} lit pixels, fewer than ${FAR_LIT_MIN}`);
    else if (!(num(bc.saturation) && bc.saturation >= TARGET.battleSaturation)) failures.push(`the battle's streams at night: saturation ${round3(bc.saturation)} < ${TARGET.battleSaturation} (hue ${bc.hueDeg?.toFixed(1)})`);
  }
  if (c.front) {
    const fc = m.frontColour;
    if (!(num(fc?.drawn) && fc.drawn >= 1 && num(fc.n) && fc.n >= FAR_LIT_MIN)) failures.push(`the front's amber: ${fc?.drawn ?? 0} rounds drawn, ${fc?.n ?? 0} pixels tinted amber (fewer than ${FAR_LIT_MIN})`);
  }
  if (c.burst === 'graze') {
    const mine = burst.most?.ricochetsByKind?.[kind];
    if (!(num(mine) && mine > 0)) failures.push(`graze: no ricochet of the player's drawn in the burst (${burst.most?.ricochets ?? 0} of every kind; embers ${burst.most?.embersByKind?.[kind] ?? 0} of the player's)`);
  }
  if (!(num(burst.gpuSamples) && burst.gpuSamples >= MIN_GPU_SAMPLES)) failures.push(`${burst.gpuSamples} GPU samples in the burst < ${MIN_GPU_SAMPLES}`);
  return failures;
}
