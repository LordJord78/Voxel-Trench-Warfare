import { describe, expect, it } from 'vitest';
import { farHeightM, type FarField } from '../../../src/world/generation/farfield';

// Where a far shell stands: the far field's height under a point, in metres.
describe('the far field under a point', () => {
  it('reads the cell under a point in metres, and the edge beyond the grid', () => {
    // Four cells of 20 voxels (2 m at 0.1 m), from (-40, -40) voxels; rows along z.
    const height = new Float32Array(16).map((_, i) => 100 + i);
    height[1 * 4 + 2] = -Infinity;
    const ff: FarField = { size: 4, cell: 20, originX: -40, originZ: -40, height, material: new Uint8Array(16) };
    // Cell (x 1, z 2): x from -20 to 0 voxels, z from 0 to 20.
    expect(farHeightM(ff, -1.0, 1.0, 0.1)).toBeCloseTo((100 + 2 * 4 + 1) * 0.1, 6);
    // Beyond the grid: its edge's cell.
    expect(farHeightM(ff, -100, 1.0, 0.1)).toBeCloseTo((100 + 2 * 4 + 0) * 0.1, 6);
    expect(farHeightM(ff, 100, 100, 0.1)).toBeCloseTo((100 + 3 * 4 + 3) * 0.1, 6);
    // Inside the playable map.
    expect(farHeightM(ff, 1.0, -1.0, 0.1)).toBe(-Infinity);
  });
});
