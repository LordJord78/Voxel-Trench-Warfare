/**
 * Bands into one world. Each band arrives compacted, with its dense bricks'
 * bytes in table order; assembly copies them into place without marking
 * anything dirty, since a band is exactly what the world holds there.
 */

import { BrickMap, UNIFORM } from '../bricks';
import { BAND, type BandResult } from './fill';
import type { WorldPlan } from './plan';

export function assemble(plan: WorldPlan, bands: BandResult[]): BrickMap {
  const map = new BrickMap(plan.params.dims);
  const bx = BAND / 8;
  const by = map.bricks.y;
  for (const band of bands) {
    let dense = 0;
    for (let bi = 0; bi < band.table.length; bi++) {
      const e = band.table[bi];
      if (e === 0) continue;
      const lx = bi % bx;
      const rest = (bi - lx) / bx;
      const ly = rest % by;
      const lz = (rest - ly) / by;
      const target = map.brickIndex(band.band * bx + lx, ly, lz);
      if (e & UNIFORM) {
        map.loadBrick(target, e);
      } else {
        if (band.denseBricks[dense] !== bi) throw new Error(`band ${band.band}: dense brick ${bi} is out of order`);
        map.loadBrick(target, 0, band.dense.subarray(dense * 512, dense * 512 + 512));
        dense++;
      }
    }
  }
  return map;
}
