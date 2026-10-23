/**
 * Materials and the voxel palette.
 *
 * A voxel is one byte: an index into a 256-entry palette. Each entry belongs to
 * a material *kind*, and the kind carries the rules the Python game's
 * `world/voxel.py` defined (solid, granular, what a carve leaves behind). The
 * entries within a kind are shades the generator picks on purpose — wet mud by
 * water, darker sandbag seams, dead grass — which is how the world gets its
 * texture at 10 cm.
 */

import { pow } from '../core/dmath';

export const K = {
  AIR: 0, SOD: 1, MUD: 2, CLAY: 3, SUBSOIL: 4, SPOIL: 5, SANDBAG: 6, DUCKBOARD: 7, TIMBER: 8,
  CORRUGATE: 9, CONCRETE: 10, BRICK: 11, TRUNK: 12, BRANCH: 13, WATER: 14, RUBBLE: 15, WIRE: 16,
  HULL: 17, MORTAR: 18, PICKET: 19, CLOTH: 20,
} as const;

export const KIND_COUNT = 21;

// solid, opaque, blocks sight, granular, loose, hardness, becomes when carved.
// Kinds 0-17 are Python's tables verbatim; MORTAR, PICKET and CLOTH are new.
type KindRule = readonly [number, number, number, number, number, number, number];
const KIND_RULES: readonly KindRule[] = [
  [0, 0, 0, 0, 0, 0.0, K.AIR], // AIR
  [1, 1, 1, 1, 0, 1.0, K.SPOIL], // SOD
  [1, 1, 1, 1, 0, 1.0, K.SPOIL], // MUD
  [1, 1, 1, 1, 0, 1.1, K.SPOIL], // CLAY
  [1, 1, 1, 1, 0, 1.2, K.SPOIL], // SUBSOIL
  [1, 1, 1, 1, 1, 0.8, K.SPOIL], // SPOIL
  [1, 1, 1, 1, 1, 1.4, K.SPOIL], // SANDBAG
  [1, 1, 1, 0, 0, 0.9, K.RUBBLE], // DUCKBOARD
  [1, 1, 1, 0, 0, 1.0, K.RUBBLE], // TIMBER
  [1, 1, 1, 0, 0, 1.3, K.RUBBLE], // CORRUGATE
  [1, 1, 1, 0, 0, 4.0, K.RUBBLE], // CONCRETE
  [1, 1, 1, 0, 0, 2.6, K.RUBBLE], // BRICK
  [1, 1, 1, 0, 0, 1.6, K.BRANCH], // TRUNK
  [1, 1, 1, 0, 0, 0.7, K.AIR], // BRANCH
  [0, 0, 0, 0, 0, 0.0, K.WATER], // WATER: a fill result, never carved
  [1, 1, 1, 1, 1, 1.2, K.RUBBLE], // RUBBLE
  [0, 0, 0, 0, 0, 0.5, K.AIR], // WIRE: a solid strand would be a wall
  [1, 1, 1, 0, 0, 3.4, K.RUBBLE], // HULL
  [1, 1, 1, 0, 0, 2.6, K.RUBBLE], // MORTAR
  [1, 1, 1, 0, 0, 3.0, K.RUBBLE], // PICKET: steel screw pickets
  [0, 1, 1, 0, 0, 0.3, K.AIR], // CLOTH: a gas curtain hides you, it does not stop you
];

function column(i: number): Uint8Array {
  return Uint8Array.from(KIND_RULES, (rule) => rule[i]);
}

export const KIND_SOLID = column(0);
export const KIND_OPAQUE = column(1);
export const KIND_BLOCKS_SIGHT = column(2);
export const KIND_GRANULAR = column(3);
export const KIND_LOOSE = column(4);
export const KIND_HARDNESS = Float32Array.from(KIND_RULES, (rule) => rule[5]);
export const KIND_SPOIL = column(6);

export interface PaletteEntry {
  name: string;
  kind: number;
  srgb: readonly [number, number, number];
  roughness: number;
  emission: number;
}

const ROUGH_DEFAULT = 0.85;
const ROUGHNESS: Partial<Record<number, number>> = {
  [K.SOD]: 0.95, [K.MUD]: 0.95, [K.CLAY]: 0.95, [K.SUBSOIL]: 0.95, [K.SPOIL]: 0.95,
  [K.SANDBAG]: 0.95, [K.CLOTH]: 0.95, [K.TIMBER]: 0.95, [K.DUCKBOARD]: 0.95,
  [K.TRUNK]: 0.95, [K.BRANCH]: 0.95,
  [K.CORRUGATE]: 0.6, [K.HULL]: 0.6, [K.WIRE]: 0.6, [K.PICKET]: 0.6,
  [K.WATER]: 0.3,
};

type Def = readonly [string, number, number, number, number, number?, number?];
const DEFS: readonly Def[] = [
  ['AIR', K.AIR, 0, 0, 0, 1],
  ['SOD', K.SOD, 104, 102, 72], ['SOD_DRY', K.SOD, 122, 114, 78], ['SOD_TUFT', K.SOD, 92, 96, 62],
  ['MUD', K.MUD, 112, 90, 68], ['MUD_WET', K.MUD, 86, 70, 56], ['MUD_DARK', K.MUD, 96, 76, 58],
  ['MUD_TURNED', K.MUD, 100, 80, 60],
  ['CLAY', K.CLAY, 142, 122, 96], ['CLAY_WET', K.CLAY, 122, 104, 84],
  ['SUBSOIL', K.SUBSOIL, 118, 104, 88],
  ['SPOIL', K.SPOIL, 92, 72, 54], ['SPOIL_DRY', K.SPOIL, 106, 86, 64],
  ['SANDBAG', K.SANDBAG, 152, 144, 114], ['SANDBAG_SEAM', K.SANDBAG, 124, 116, 92],
  ['SANDBAG_WORN', K.SANDBAG, 138, 128, 100], ['SANDBAG_DARK', K.SANDBAG, 110, 104, 82],
  ['DUCKBOARD', K.DUCKBOARD, 130, 108, 76], ['DUCKBOARD_WORN', K.DUCKBOARD, 112, 94, 68],
  ['TIMBER', K.TIMBER, 106, 86, 64], ['TIMBER_WEATHERED', K.TIMBER, 128, 116, 96],
  ['TIMBER_DARK', K.TIMBER, 84, 68, 52],
  ['CORRUGATE', K.CORRUGATE, 132, 132, 126], ['CORRUGATE_RUST', K.CORRUGATE, 128, 92, 64],
  ['CONCRETE', K.CONCRETE, 160, 158, 150], ['CONCRETE_STAINED', K.CONCRETE, 134, 132, 124],
  ['BRICK', K.BRICK, 140, 92, 74], ['BRICK_DARK', K.BRICK, 118, 74, 60], ['BRICK_BURNT', K.BRICK, 82, 60, 52],
  ['MORTAR', K.MORTAR, 170, 164, 150],
  ['TRUNK', K.TRUNK, 68, 56, 46], ['TRUNK_BARK', K.TRUNK, 84, 70, 56], ['TRUNK_SPLINTER', K.TRUNK, 150, 130, 100],
  ['BRANCH', K.BRANCH, 86, 74, 58],
  ['WATER', K.WATER, 92, 106, 104],
  ['RUBBLE', K.RUBBLE, 118, 112, 98], ['RUBBLE_BRICK', K.RUBBLE, 130, 90, 72],
  ['WIRE', K.WIRE, 100, 98, 90], ['WIRE_RUST', K.WIRE, 110, 80, 60],
  ['HULL', K.HULL, 54, 50, 48], ['HULL_RUST', K.HULL, 90, 62, 46],
  ['PICKET', K.PICKET, 88, 84, 78], ['PICKET_RUST', K.PICKET, 112, 78, 56],
  ['CLOTH', K.CLOTH, 120, 112, 90], ['CLOTH_DARK', K.CLOTH, 80, 74, 60],
  ['LANTERN_GLOW', K.PICKET, 255, 190, 110, 0.3, 6],
  ['EMBER', K.RUBBLE, 200, 80, 30, 1, 2],
  // The rifle's (combat/rifle-model.ts): never placed in the world.
  ['RIFLE_STEEL', K.PICKET, 46, 46, 50, 0.45], ['RIFLE_STEEL_WORN', K.PICKET, 70, 69, 68, 0.4],
  ['RIFLE_FURNITURE', K.TIMBER, 92, 54, 40, 0.6], ['RIFLE_MAG', K.TIMBER, 132, 64, 34, 0.5],
  ['RIFLE_GRIP', K.TIMBER, 38, 32, 30, 0.65],
];

/** Palette ids by name. Kept explicit so ids are stable and greppable; checked against DEFS below. */
export const P = {
  AIR: 0, SOD: 1, SOD_DRY: 2, SOD_TUFT: 3, MUD: 4, MUD_WET: 5, MUD_DARK: 6, MUD_TURNED: 7,
  CLAY: 8, CLAY_WET: 9, SUBSOIL: 10, SPOIL: 11, SPOIL_DRY: 12, SANDBAG: 13, SANDBAG_SEAM: 14,
  SANDBAG_WORN: 15, SANDBAG_DARK: 16, DUCKBOARD: 17, DUCKBOARD_WORN: 18, TIMBER: 19,
  TIMBER_WEATHERED: 20, TIMBER_DARK: 21, CORRUGATE: 22, CORRUGATE_RUST: 23, CONCRETE: 24,
  CONCRETE_STAINED: 25, BRICK: 26, BRICK_DARK: 27, BRICK_BURNT: 28, MORTAR: 29, TRUNK: 30,
  TRUNK_BARK: 31, TRUNK_SPLINTER: 32, BRANCH: 33, WATER: 34, RUBBLE: 35, RUBBLE_BRICK: 36,
  WIRE: 37, WIRE_RUST: 38, HULL: 39, HULL_RUST: 40, PICKET: 41, PICKET_RUST: 42, CLOTH: 43,
  CLOTH_DARK: 44, LANTERN_GLOW: 45, EMBER: 46, RIFLE_STEEL: 47, RIFLE_STEEL_WORN: 48,
  RIFLE_FURNITURE: 49, RIFLE_MAG: 50, RIFLE_GRIP: 51,
} as const;

export const PALETTE: readonly PaletteEntry[] = DEFS.map(([name, kind, r, g, b, roughness, emission]) => ({
  name,
  kind,
  srgb: [r, g, b] as const,
  roughness: roughness ?? ROUGHNESS[kind] ?? ROUGH_DEFAULT,
  emission: emission ?? 0,
}));

for (const [name, id] of Object.entries(P)) {
  if (PALETTE[id]?.name !== name) throw new Error(`palette id ${id} is ${PALETTE[id]?.name}, not ${name}`);
}
if (PALETTE.length !== Object.keys(P).length || PALETTE.length > 256) {
  throw new Error(`palette has ${PALETTE.length} entries but P names ${Object.keys(P).length}`);
}

export const PALETTE_KIND = new Uint8Array(256);
PALETTE.forEach((entry, id) => (PALETTE_KIND[id] = entry.kind));

const BASE = new Uint8Array(KIND_COUNT);
for (let id = PALETTE.length - 1; id >= 0; id--) BASE[PALETTE[id].kind] = id;

export function kindOf(p: number): number {
  return PALETTE_KIND[p];
}

/** The first palette entry of a kind: its plain, unshaded look. */
export function baseOf(kind: number): number {
  return BASE[kind];
}

export function isSolid(p: number): boolean {
  return KIND_SOLID[PALETTE_KIND[p]] === 1;
}

export function isOpaque(p: number): boolean {
  return KIND_OPAQUE[PALETTE_KIND[p]] === 1;
}

export function blocksSight(p: number): boolean {
  return KIND_BLOCKS_SIGHT[PALETTE_KIND[p]] === 1;
}

export function isGranular(p: number): boolean {
  return KIND_GRANULAR[PALETTE_KIND[p]] === 1;
}

export function isLoose(p: number): boolean {
  return KIND_LOOSE[PALETTE_KIND[p]] === 1;
}

export function hardness(p: number): number {
  return KIND_HARDNESS[PALETTE_KIND[p]];
}

/** What a carve that does not remove a voxel leaves in its place. */
export function spoilOf(p: number): number {
  return BASE[KIND_SPOIL[PALETTE_KIND[p]]];
}

/** 256 entries of [r, g, b (linear), roughness, emission r, g, b, kind] for the GPU. */
export function paletteData(): Float32Array {
  const out = new Float32Array(256 * 8);
  PALETTE.forEach((entry, id) => {
    const o = id * 8;
    for (let c = 0; c < 3; c++) {
      const linear = pow(entry.srgb[c] / 255, 2.2);
      out[o + c] = linear;
      out[o + 4 + c] = linear * entry.emission;
    }
    out[o + 3] = entry.roughness;
    out[o + 7] = entry.kind;
  });
  return out;
}
