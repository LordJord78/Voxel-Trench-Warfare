/**
 * Each map's shell field (shelling.ts ShellField), pinned: the room cannot generate a world, so it
 * shells over these. tests/world/generation/world.test.ts and corridor.test.ts hold each to
 * world/generation/shell-field.ts over the generated map, as the worlds' fingerprints are held:
 * a change to a map's lines or starts fails there, printing the field to paste here.
 */

import type { ShellField } from './shelling';

export const SHELL_FIELDS: Record<string, ShellField> = {
  ravine: {
    size: [256, 256],
    lines: [
      { z: 106, x0: 6, x1: 250 },
      { z: 84, x0: 6, x1: 250 },
      { z: 158, x0: 6, x1: 250 },
      { z: 180, x0: 6, x1: 250 },
    ],
    nml: [114, 150],
    spawns: [[115.25, 106.95], [133.75, 110.45], [105.95, 107.45], [143.15, 112.25], [132.45, 163.55], [123.45, 162.75], [141.75, 157.55], [114.95, 166.75]],
  },
  corridor: {
    size: [256, 256],
    lines: [
      { z: 34, x0: 30, x1: 226 },
      { z: 16, x0: 50, x1: 206 },
      { z: 219.5, x0: 30, x1: 226 },
      { z: 237.5, x0: 50, x1: 206 },
    ],
    nml: [42, 211.5],
    spawns: [[115.65, 42.35], [107.55, 39.15], [141.75, 30.05], [99.05, 43.25], [140.45, 213.65], [114.35, 225.95], [148.55, 216.85], [105.95, 222.15]],
  },
};
