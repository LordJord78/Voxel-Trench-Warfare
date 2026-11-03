/**
 * The loadout's guns and the shovel as voxel models at the rifle's 1.5 cm (rifle-model.ts), made
 * in code from parts: boxes and rods along the bore, some with a test that shapes them (a curved
 * magazine, a raked grip), painted in order, a part of nothing cutting a hole. A gun's own parts
 * come first, then what its fit puts at its mounts (arsenal.ts): the optic on the rail, a muzzle
 * device at the barrel's end, a grip under the handguard, a light or a laser on its left. The grid
 * is the parts' bounds, on a lattice whose middle column runs down the bore: x and y at the
 * voxels' middles on multiples of 1.5 cm, z at their faces.
 *
 * Each model is a pure function of its gun and fit, so it is made once and kept.
 */

import { P } from '../world/materials';
import type { Fit, GunKey, Muzzle, Optic, Side, Under } from '../net/gear';
import { GUN_DEFS, muzzleOf, type Mounts } from './arsenal';
import type { RifleModel } from './rifle-model';

type V3 = [number, number, number];

const V = 0.015;
/** No model is larger than this, in voxels: the renderers size their buffers by it. */
export const MODEL_VOXELS_MAX = 32768;

interface Part {
  lo: V3;
  hi: V3;
  /** Palette id; 0 cuts. */
  pal: number;
  test?: (x: number, y: number, z: number) => boolean;
}

const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, pal: number, test?: Part['test']): Part => ({ lo: [x0, y0, z0], hi: [x1, y1, z1], pal, test });
/** Symmetric about the bore: |x| up to `hx`. */
const sym = (hx: number, y0: number, y1: number, z0: number, z1: number, pal: number, test?: Part['test']): Part => box(-hx, hx, y0, y1, z0, z1, pal, test);
/** A rod along z, of radius `r` about (cx, cy): on this lattice a cross, a square or a rounded one. */
const rod = (cx: number, cy: number, r: number, z0: number, z1: number, pal: number): Part =>
  box(cx - r, cx + r, cy - r, cy + r, z0, z1, pal, (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r + 1e-9);
/** The voxel's row along z, for patterns: rails' notches, vents, a belt's rounds. */
const row = (z: number) => Math.floor(z / V + 1e-6);
const every = (z: number, n: number, at = 0) => ((row(z) % n) + n) % n === at;

const STEEL = P.RIFLE_STEEL;
const WORN = P.RIFLE_STEEL_WORN;
const BLACK = P.GUN_BLACK;
const POLY = P.GUN_POLYMER;

/** A rail's notches: its outer columns cut every other voxel along it. */
const notches = (y0: number, y1: number, z0: number, z1: number): Part => sym(0.0225, y0, y1, z0, z1, 0, (x, _y, z) => Math.abs(x) > 0.0075 && every(z, 2));

/** A magazine of `hx` hanging from `top` to `bottom`, `z0` to `z1` long at the top, curving forward by `curve` at the bottom. */
const magazine = (hx: number, top: number, bottom: number, z0: number, z1: number, curve: number, pal: number): Part =>
  sym(hx, bottom, top, z0, z1 + curve, pal, (_x, y, z) => {
    const hang = (top - y) / (top - bottom);
    const c = curve * hang * hang;
    return z >= z0 + c && z < z1 + c;
  });

/** A pistol grip from the frame at `top` down `depth`, its front at `front` and `width` deep, raked back by `rake` a metre down. */
const grip = (top: number, depth: number, front: number, width: number, rake: number, pal: number): Part =>
  sym(0.0225, top - depth, top, front - width - rake * depth, front, pal, (_x, y, z) => {
    const d = top - y;
    return z >= front - width - rake * d && z < front - rake * d;
  });

/** A trigger guard: its bar along the bottom and its front post, `drop` below `top`. */
const guard = (top: number, drop: number, z0: number, z1: number): Part[] => [
  sym(0.0075, top - drop, top, z0, z1, STEEL, (_x, y, z) => y < top - drop + 0.015 || z > z1 - 0.015),
  sym(0.0075, top - drop + 0.015, top, z0 + (z1 - z0) / 3, z0 + (z1 - z0) / 3 + 0.015, WORN),
];

const BODIES: Record<GunKey, (fit: Fit) => Part[]> = {
  // The AK-74 as rifle-model.ts has it, part for part, and a side mount for an optic.
  ak74: (fit) => [
    sym(0.0225, -0.1, 0.015, -0.26, 0, P.RIFLE_FURNITURE, (_x, y, z) => y >= -0.03 - 0.07 * (-z / 0.26)),
    sym(0.0225, -0.1, 0.015, -0.26, -0.245, STEEL),
    sym(0.0225, -0.03, 0.03, 0, 0.34, STEEL),
    sym(0.015, 0.0375, 0.045, 0.02, 0.32, STEEL),
    sym(0.0075, 0.0375, 0.06, 0.3, 0.34, STEEL),
    sym(0.0225, -0.13, -0.0375, -0.015, 0.06, P.RIFLE_GRIP, (_x, y, z) => z >= 0.02 - 0.35 * (-0.03 - y) && z < 0.06 - 0.35 * (-0.03 - y)),
    sym(0.0075, -0.06, -0.0375, 0.06, 0.1, STEEL, (_x, y, z) => (y < -0.045 && z >= 0.06 && z < 0.1) || (y < -0.03 && z >= 0.09 && z < 0.1)),
    sym(0.0225, -0.21, -0.0375, 0.1, 0.26, P.RIFLE_MAG, (_x, y, z) => {
      const hang = (-0.03 - y) / 0.18;
      const curve = 0.07 * hang * hang;
      return z >= 0.1 + curve && z < 0.19 + curve;
    }),
    sym(0.0075, -0.0075, 0.0075, 0.34, 0.66, STEEL),
    sym(0.0075, 0.0075, 0.03, 0.34, 0.52, STEEL),
    sym(0.0225, -0.03, 0.0075, 0.34, 0.52, P.RIFLE_FURNITURE),
    sym(0.0225, 0.0075, 0.0375, 0.36, 0.5, P.RIFLE_FURNITURE),
    sym(0.015, -0.015, 0.015, 0.6, 0.63, WORN),
    sym(0.0075, 0.0225, 0.06, 0.6, 0.63, WORN),
    ...(fit.muzzle === 'none' ? [sym(0.015, -0.015, 0.015, 0.66, 0.72, WORN)] : []),
    ...(fit.optic !== 'iron' ? [sym(0.0225, 0.0375, 0.0525, 0.135, 0.255, BLACK), box(-0.0375, -0.0225, -0.015, 0.0525, 0.165, 0.225, BLACK)] : []),
  ],

  // The carbine: a stock on its buffer tube, flat-top receivers, a free-float handguard railed
  // along its top, the PMAG in tan; flip-up sights, folded away when an optic is on.
  m4: (fit) => [
    rod(0, 0, 0.016, -0.12, 0, BLACK),
    sym(0.0225, -0.0825, 0.0225, -0.27, -0.12, POLY, (_x, y, z) => y >= -0.0375 - 0.045 * ((-0.12 - z) / 0.15)),
    sym(0.0225, -0.0825, 0.0225, -0.27, -0.255, BLACK),
    sym(0.0225, -0.0375, 0.0375, 0, 0.21, BLACK),
    sym(0.0225, -0.0525, -0.0375, 0.075, 0.15, BLACK),
    sym(0.0225, 0.0375, 0.0525, 0, 0.45, BLACK),
    notches(0.0375, 0.0525, 0, 0.45),
    grip(-0.0375, 0.105, 0.075, 0.045, 0.33, POLY),
    ...guard(-0.0375, 0.03, 0.075, 0.12),
    magazine(0.0225, -0.0525, -0.2025, 0.0825, 0.1425, 0.035, P.GUN_TAN),
    sym(0.0225, -0.2025, -0.1875, 0.105, 0.18, POLY),
    sym(0.0225, -0.0375, 0.0375, 0.21, 0.465, BLACK),
    sym(0.0225, -0.0225, -0.0075, 0.225, 0.45, 0, (x, _y, z) => Math.abs(x) > 0.0075 && every(z, 3)),
    rod(0, 0, 0.0075, 0.465, 0.615, STEEL),
    sym(0.0075, 0.0075, 0.0225, 0.465, 0.495, STEEL),
    ...(fit.muzzle === 'none' ? [rod(0, 0, 0.016, 0.615, 0.66, WORN)] : []),
    ...(fit.optic === 'iron'
      ? [
          // A ghost ring at the rail's rear; the front post between its wings.
          sym(0.0375, 0.0525, 0.1125, 0, 0.03, BLACK),
          sym(0.0225, 0.0675, 0.0975, 0, 0.03, 0),
          sym(0.0375, 0.0525, 0.0675, 0.42, 0.45, BLACK),
          box(-0.0375, -0.0225, 0.0675, 0.0975, 0.42, 0.45, BLACK),
          box(0.0225, 0.0375, 0.0675, 0.0975, 0.42, 0.45, BLACK),
          sym(0.0075, 0.0675, 0.0825, 0.42, 0.45, WORN),
        ]
      : []),
  ],

  // The submachine gun: a retracting stock's struts, the round receiver and the cocking tube over
  // the barrel, a magazine curving hard forward, the drum sight and the hooded post.
  mp5: (fit) => [
    rod(-0.015, 0, 0.0075, -0.21, 0, STEEL),
    rod(0.015, 0, 0.0075, -0.21, 0, STEEL),
    sym(0.0225, -0.0675, 0.0375, -0.225, -0.195, POLY),
    sym(0.0225, -0.0225, 0.0375, 0, 0.3, BLACK),
    sym(0.0075, 0.0225, 0.0375, 0.3, 0.39, BLACK),
    sym(0.015, 0.0375, 0.0825, 0.015, 0.045, BLACK),
    sym(0.0075, 0.0525, 0.0675, 0.015, 0.045, 0),
    sym(0.0225, -0.0375, -0.0225, 0.06, 0.165, POLY),
    grip(-0.0375, 0.09, 0.12, 0.045, 0.3, POLY),
    ...guard(-0.0375, 0.03, 0.12, 0.165),
    magazine(0.0225, -0.0375, -0.1875, 0.165, 0.21, 0.05, STEEL),
    sym(0.0225, -0.0525, 0.0225, 0.21, 0.36, POLY),
    rod(0, 0, 0.0075, 0.36, 0.405, STEEL),
    rod(0, 0, fit.muzzle === 'none' ? 0.016 : 0.0075, 0.405, 0.45, WORN),
    sym(0.015, 0.0375, 0.0825, 0.36, 0.39, BLACK),
    sym(0.0075, 0.0525, 0.0825, 0.36, 0.39, 0),
    ...(fit.optic !== 'iron' ? [sym(0.0225, 0.0375, 0.0525, 0.075, 0.195, BLACK)] : []),
  ],

  // The marksman's rifle: the skeleton stock in wood with its cheek rest and thumbhole, a short
  // magazine, the vented handguard, the long barrel and its slotted flash hider; a side mount.
  svd: (fit) => [
    sym(0.0225, -0.0225, 0.0225, -0.39, 0, P.GUN_WOOD),
    sym(0.0225, 0.0225, 0.0375, -0.3, -0.12, P.GUN_WOOD),
    sym(0.0225, -0.135, 0.0225, -0.405, -0.36, P.GUN_WOOD),
    sym(0.0225, -0.135, 0.0225, -0.405, -0.39, WORN),
    sym(0.0225, -0.1425, -0.075, -0.36, -0.06, P.GUN_WOOD, (_x, y, z) => {
      const b = -0.1425 + 0.03 * ((z + 0.36) / 0.3);
      return y >= b && y < b + 0.03;
    }),
    sym(0.0225, -0.135, -0.0225, -0.075, 0, P.GUN_WOOD),
    sym(0.0225, -0.0375, 0.0375, 0, 0.24, STEEL),
    sym(0.015, 0.0375, 0.0525, 0.015, 0.225, STEEL),
    magazine(0.0225, -0.0375, -0.1425, 0.12, 0.18, 0.015, STEEL),
    ...guard(-0.0375, 0.03, 0.015, 0.09),
    sym(0.0225, -0.0375, 0.0375, 0.24, 0.555, P.GUN_WOOD),
    sym(0.0225, -0.0075, 0.0075, 0.27, 0.54, P.RIFLE_GRIP, (x, _y, z) => Math.abs(x) > 0.0075 && every(z, 3)),
    rod(0, 0, 0.0075, 0.555, 0.84, STEEL),
    sym(0.0075, 0.0075, 0.0375, 0.555, 0.585, STEEL),
    sym(0.0075, 0.0075, 0.0675, 0.78, 0.81, WORN),
    sym(0.0075, 0.0375, 0.0675, 0.225, 0.255, STEEL),
    ...(fit.muzzle === 'none' ? [rod(0, 0, 0.016, 0.84, 0.915, WORN)] : []),
    ...(fit.optic !== 'iron' ? [sym(0.0225, 0.0525, 0.0675, 0.06, 0.21, BLACK), box(-0.0375, -0.0225, -0.0225, 0.0675, 0.09, 0.18, BLACK)] : []),
  ],

  // The light machine gun: a broad receiver under its feed cover, the belt's box and its rounds
  // going in on the left, the heat shield, the carry handle, the heavy barrel and folded bipod.
  m249: (fit) => [
    sym(0.0225, -0.1125, 0.0225, -0.36, 0, POLY, (_x, y, z) => y >= -0.0525 - 0.06 * (-z / 0.36)),
    sym(0.0225, -0.1125, 0.0225, -0.36, -0.345, BLACK),
    sym(0.0375, -0.0525, 0.0375, 0, 0.3, BLACK),
    sym(0.0375, 0.0375, 0.0675, 0.045, 0.255, BLACK),
    ...(fit.optic === 'iron' ? [sym(0.0225, 0.0675, 0.0975, 0.045, 0.075, BLACK), sym(0.0075, 0.0825, 0.0975, 0.045, 0.075, 0)] : []),
    grip(-0.0525, 0.105, 0.105, 0.045, 0.3, POLY),
    ...guard(-0.0525, 0.03, 0.105, 0.15),
    box(-0.0525, 0.0225, -0.1875, -0.0525, 0.15, 0.27, P.GUN_OD),
    box(-0.0525, -0.0375, -0.0375, 0.0075, 0.165, 0.225, P.GUN_BRASS, (_x, _y, z) => every(z, 2)),
    sym(0.0225, -0.0525, 0.0225, 0.3, 0.48, POLY),
    sym(0.015, 0.0225, 0.0375, 0.3, 0.48, STEEL),
    rod(0, 0, 0.016, 0.48, 0.81, STEEL),
    sym(0.0075, 0.0375, 0.0825, 0.33, 0.345, POLY),
    sym(0.0075, 0.0375, 0.0825, 0.435, 0.45, POLY),
    sym(0.0075, 0.0675, 0.0825, 0.33, 0.45, POLY),
    sym(0.015, -0.0375, 0.0075, 0.6, 0.645, STEEL),
    rod(-0.015, -0.03, 0.0075, 0.48, 0.63, STEEL),
    rod(0.015, -0.03, 0.0075, 0.48, 0.63, STEEL),
    sym(0.0075, 0.0075, 0.0825, 0.765, 0.795, WORN),
    ...(fit.muzzle === 'none' ? [rod(0, 0, 0.016, 0.81, 0.855, WORN)] : []),
  ],

  // The pump gun: a straight stock, the receiver, the barrel over its magazine tube, the ribbed
  // pump and the bead at the muzzle; a rail on the receiver for a sight.
  m870: (fit) => [
    sym(0.0225, -0.1125, 0.0225, -0.33, 0, POLY, (_x, y, z) => y >= -0.0375 - 0.075 * (-z / 0.33) && y <= 0.0225 - 0.015 * (-z / 0.33)),
    sym(0.0225, -0.1125, 0.0225, -0.33, -0.315, BLACK),
    sym(0.0225, -0.0375, 0.0375, 0, 0.18, BLACK),
    ...guard(-0.0375, 0.03, 0.03, 0.12),
    ...(fit.optic !== 'iron' ? [sym(0.0225, 0.0375, 0.0525, 0.015, 0.165, BLACK)] : []),
    rod(0, 0, 0.016, 0.18, 0.69, STEEL),
    rod(0, -0.045, 0.016, 0.18, 0.555, BLACK),
    sym(0.0075, 0.0225, 0.0375, 0.645, 0.675, WORN),
    sym(0.0375, -0.0825, -0.0075, 0.24, 0.42, POLY),
    sym(0.0375, -0.0825, -0.0075, 0.24, 0.42, 0, (x, _y, z) => Math.abs(x) > 0.0225 && every(z, 3, 1)),
  ],

  // The service pistol: its slide over the tan frame, the raked grip, a notch and a post.
  m17: (fit) => [
    sym(0.0225, -0.0075, 0.0375, 0, 0.18, BLACK),
    sym(0.0225, -0.0375, -0.0075, 0, 0.18, P.GUN_TAN),
    grip(-0.0375, 0.0975, 0.06, 0.06, 0.32, P.GUN_TAN),
    ...guard(-0.0375, 0.03, 0.06, 0.12),
    ...(fit.optic === 'iron' ? [sym(0.0225, 0.0375, 0.0525, 0, 0.015, BLACK), sym(0.0075, 0.0375, 0.0525, 0, 0.015, 0)] : []),
    sym(0.0075, 0.0375, 0.0525, 0.165, 0.18, BLACK),
  ],

  // The Makarov: small and blued, its grip in brown.
  pm: () => [
    sym(0.0225, -0.0075, 0.0225, 0, 0.15, STEEL),
    sym(0.0225, -0.0375, -0.0075, 0, 0.15, STEEL),
    grip(-0.0375, 0.075, 0.0525, 0.0525, 0.25, P.RIFLE_FURNITURE),
    ...guard(-0.0375, 0.03, 0.045, 0.105),
    sym(0.0225, 0.0225, 0.0375, 0, 0.015, STEEL),
    sym(0.0075, 0.0225, 0.0375, 0, 0.015, 0),
    sym(0.0075, 0.0225, 0.0375, 0.135, 0.15, STEEL),
  ],
};

/** An optic on the rail at `railY`, its middle at `opticZ`: its window's middle (the sight's line) at railY + 5.25 cm. */
function optic(m: Mounts, kind: Optic, pistol: boolean): Part[] {
  const y0 = m.railY;
  const zc = m.opticZ;
  switch (kind) {
    case 'reddot': {
      // A tube, square on this lattice, open through its middle three by three; its knobs.
      const [z0, z1] = pistol ? [zc - 0.015, zc + 0.015] : [zc - 0.045, zc + 0.03];
      return [
        sym(0.0225, y0, y0 + 0.015, zc - 0.03, zc + 0.03, BLACK),
        sym(0.0375, y0 + 0.015, y0 + 0.09, z0, z1, BLACK),
        sym(0.0225, y0 + 0.03, y0 + 0.075, z0, z1, 0),
        ...(pistol ? [] : [sym(0.0075, y0 + 0.09, y0 + 0.105, zc - 0.015, zc + 0.015, BLACK), box(0.0375, 0.0525, y0 + 0.045, y0 + 0.06, zc - 0.015, zc + 0.015, BLACK)]),
      ];
    }
    case 'holo':
      // A long base, its battery at the back, and the hood round a square window.
      return [
        sym(0.0375, y0, y0 + 0.015, zc - 0.06, zc + 0.045, BLACK),
        sym(0.0375, y0 + 0.015, y0 + 0.0375, zc - 0.06, zc - 0.015, BLACK),
        sym(0.0375, y0 + 0.015, y0 + 0.09, zc - 0.015, zc + 0.045, BLACK),
        sym(0.0225, y0 + 0.03, y0 + 0.075, zc - 0.015, zc + 0.045, 0),
      ];
    case 'scope': {
      // Two rings, the tube, the objective's bell and the eyepiece, each lens dark glass; turrets.
      const cy = y0 + 0.0525;
      return [
        sym(0.0225, y0, cy, zc - 0.075, zc - 0.045, BLACK),
        sym(0.0225, y0, cy, zc + 0.045, zc + 0.075, BLACK),
        rod(0, cy, 0.023, zc - 0.12, zc + 0.105, BLACK),
        rod(0, cy, 0.034, zc + 0.105, zc + 0.18, BLACK),
        rod(0, cy, 0.024, zc + 0.165, zc + 0.18, P.OPTIC_GLASS),
        rod(0, cy, 0.031, zc - 0.18, zc - 0.12, BLACK),
        rod(0, cy, 0.024, zc - 0.18, zc - 0.165, P.OPTIC_GLASS),
        sym(0.0075, cy + 0.0075, cy + 0.0525, zc - 0.015, zc + 0.015, BLACK),
        box(0.0225, 0.0525, cy - 0.0075, cy + 0.0075, zc - 0.015, zc + 0.015, BLACK),
      ];
    }
    case 'iron':
      return [];
  }
}

/** What goes on the barrel's end: a can (its mouth dark), or a ported brake. */
function muzzleDevice(m: Mounts, kind: Muzzle, pistol: boolean): Part[] {
  const z0 = m.muzzleZ;
  if (kind === 'suppressor') {
    const len = pistol ? 0.12 : 0.165;
    return [rod(0, 0, 0.031, z0, z0 + len, BLACK), rod(0, 0, 0.031, z0, z0 + 0.03, STEEL), rod(0, 0, 0.0075, z0 + len - 0.015, z0 + len, P.RIFLE_GRIP)];
  }
  if (kind === 'compensator') return [rod(0, 0, 0.016, z0, z0 + 0.06, WORN), sym(0.0075, 0.0075, 0.0225, z0 + 0.015, z0 + 0.045, P.RIFLE_GRIP, (_x, _y, z) => every(z, 2))];
  return [];
}

/** A grip under the handguard, on its clamp: upright, or a ramp for the palm. */
function underDevice(m: Mounts, kind: Under): Part[] {
  const y0 = m.underY;
  const z0 = m.underZ;
  if (kind === 'none') return [];
  const clamp = sym(0.0225, y0 - 0.015, y0, z0 - 0.045, z0 + 0.03, BLACK);
  if (kind === 'vertical') return [clamp, sym(0.0225, y0 - 0.105, y0 - 0.015, z0 - 0.015, z0 + 0.015, POLY)];
  return [clamp, sym(0.0225, y0 - 0.06, y0 - 0.015, z0 - 0.06, z0 + 0.03, POLY, (_x, y, z) => y >= y0 - 0.03 - 0.03 * ((z - (z0 - 0.06)) / 0.09))];
}

/** A light (its lens bright) or a laser's box (its emitter red) on the left, or hung under a pistol. */
function sideDevice(m: Mounts, kind: Side): Part[] {
  const s = m.side;
  if (kind === 'none') return [];
  if (s.below) {
    const cy = s.y - 0.0225;
    if (kind === 'flashlight') return [sym(0.0225, s.y - 0.045, s.y, s.z, s.z + 0.06, BLACK), rod(0, cy, 0.016, s.z + 0.06, s.z + 0.075, P.LIGHT_LENS)];
    return [sym(0.0225, s.y - 0.045, s.y, s.z, s.z + 0.06, P.GUN_TAN), box(-0.0075, 0.0075, cy - 0.0075, cy + 0.0075, s.z + 0.045, s.z + 0.06, P.OPTIC_DOT)];
  }
  const cx = s.x - 0.0225;
  if (kind === 'flashlight') return [rod(cx, s.y, 0.016, s.z, s.z + 0.09, BLACK), rod(cx, s.y, 0.023, s.z + 0.09, s.z + 0.12, BLACK), rod(cx, s.y, 0.016, s.z + 0.105, s.z + 0.12, P.LIGHT_LENS)];
  return [box(cx - 0.0225, cx + 0.0225, s.y - 0.0225, s.y + 0.0225, s.z, s.z + 0.075, P.GUN_TAN), box(cx - 0.0075, cx + 0.0075, s.y - 0.0075, s.y + 0.0075, s.z + 0.06, s.z + 0.075, P.OPTIC_DOT)];
}

/** The parts as a grid on the lattice, over their bounds (cuts aside). */
function build(parts: readonly Part[], muzzle: V3, port: V3): RifleModel {
  let hx = 0;
  let y0 = Infinity;
  let y1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of parts) {
    if (p.pal === 0) continue;
    hx = Math.max(hx, Math.abs(p.lo[0]), Math.abs(p.hi[0]));
    y0 = Math.min(y0, p.lo[1]);
    y1 = Math.max(y1, p.hi[1]);
    z0 = Math.min(z0, p.lo[2]);
    z1 = Math.max(z1, p.hi[2]);
  }
  const eps = 1e-6;
  // Columns either side of the bore's; rows from the lowest to the highest middle inside the bounds.
  const m = Math.max(0, Math.ceil(hx / V - 0.5 - eps));
  const jmin = Math.ceil(y0 / V - eps);
  const jmax = Math.floor(y1 / V + eps);
  const kmin = Math.ceil(z0 / V - 0.5 - eps);
  const kmax = Math.floor(z1 / V - 0.5 + eps);
  const dims: V3 = [2 * m + 1, jmax - jmin + 1, kmax - kmin + 1];
  const voxels = new Uint8Array(dims[0] * dims[1] * dims[2]);
  if (voxels.length > MODEL_VOXELS_MAX) throw new RangeError(`a gun of ${dims.join(' x ')} voxels is over the ${MODEL_VOXELS_MAX} the renderers hold`);
  for (const p of parts) {
    const i0 = Math.max(0, Math.ceil(p.lo[0] / V - eps) + m);
    const i1 = Math.min(dims[0] - 1, Math.floor(p.hi[0] / V + eps) + m);
    const j0 = Math.max(0, Math.ceil(p.lo[1] / V - eps) - jmin);
    const j1 = Math.min(dims[1] - 1, Math.floor(p.hi[1] / V + eps) - jmin);
    const k0 = Math.max(0, Math.ceil(p.lo[2] / V - 0.5 - eps) - kmin);
    const k1 = Math.min(dims[2] - 1, Math.floor(p.hi[2] / V - 0.5 + eps) - kmin);
    for (let k = k0; k <= k1; k++) {
      const z = (k + kmin + 0.5) * V;
      for (let j = j0; j <= j1; j++) {
        const y = (j + jmin) * V;
        for (let i = i0; i <= i1; i++) {
          const x = (i - m) * V;
          if (!p.test || p.test(x, y, z)) voxels[i + dims[0] * (j + dims[1] * k)] = p.pal;
        }
      }
    }
  }
  return { dims, voxelM: V, origin: [m + 0.5, 0.5 - jmin, -kmin], voxels, muzzle, port };
}

const made = new Map<string, RifleModel>();

/** The model of `gun` with `fit`: made once, then kept. */
export function gunModel(gun: GunKey, fit: Fit): RifleModel {
  const key = `${gun}:${fit.optic}:${fit.muzzle}:${fit.under}:${fit.side}`;
  const kept = made.get(key);
  if (kept) return kept;
  const def = GUN_DEFS[gun];
  const pistol = def.slot === 'secondary';
  const m = def.mounts;
  const parts = [...BODIES[gun](fit), ...optic(m, fit.optic, pistol), ...muzzleDevice(m, fit.muzzle, pistol), ...underDevice(m, fit.under), ...sideDevice(m, fit.side)];
  const model = build(parts, muzzleOf(gun, fit), m.port);
  made.set(key, model);
  return model;
}

/** Where the blade is wide, along it: square to 0.51 m, then to its point at 0.6 m. */
const bladeHalf = (z: number) => (z < 0.51 ? 0.0675 : 0.0675 - (z - 0.51) * (0.06 / 0.09));

let shovel: RifleModel | null = null;

/**
 * The entrenching tool, along z as a gun is: its handle and the D of its grip at the back, the
 * socket, and the blade, dished up at its sides, its point and edges worn bright. Held, it is
 * turned blade-down (viewmodel.ts); its "muzzle" is the blade's point.
 */
export function shovelModel(): RifleModel {
  if (shovel) return shovel;
  const parts: Part[] = [
    sym(0.0075, -0.0225, 0.0075, -0.165, 0.36, P.SHOVEL_HANDLE),
    sym(0.0075, -0.0675, 0.0525, -0.24, -0.165, P.SHOVEL_HANDLE, (_x, y, z) => z < -0.225 || z > -0.18 || y < -0.0525 || y > 0.0375),
    rod(0, -0.0075, 0.02, 0.33, 0.39, P.SHOVEL_BLADE),
    sym(0.0675, -0.0225, -0.0075, 0.39, 0.6, P.SHOVEL_BLADE, (x, _y, z) => Math.abs(x) <= bladeHalf(z)),
    sym(0.0675, -0.0075, 0.0075, 0.39, 0.555, P.SHOVEL_BLADE, (x, _y, z) => Math.abs(x) > 0.05 && Math.abs(x) <= bladeHalf(z)),
    sym(0.0675, -0.0225, -0.0075, 0.39, 0.6, P.SHOVEL_EDGE, (x, _y, z) => Math.abs(x) <= bladeHalf(z) && (z > 0.57 || Math.abs(x) > bladeHalf(z) - 0.016)),
  ];
  shovel = build(parts, [0, -0.015, 0.6], [0, 0, 0]);
  return shovel;
}
