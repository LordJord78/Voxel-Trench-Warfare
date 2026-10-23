/**
 * The destruction worker: cuts each crater it is sent on the copy of its
 * region it came with (world/detonation.ts), and sends back the bricks that
 * changed, their bytes transferred. A job that throws is reported, not
 * dropped, so the session can cut it again in-process.
 */

import { runDetonation, type DetonationRequest } from '../../world/detonation';

self.onmessage = (event: MessageEvent<DetonationRequest>) => {
  const req = event.data;
  try {
    const result = runDetonation(req);
    const transfer = 'patches' in result ? result.patches.flatMap((p) => (p.voxels ? [p.voxels.buffer as ArrayBuffer] : [])) : [];
    (self as unknown as Worker).postMessage({ type: 'result', result }, transfer);
  } catch (e) {
    (self as unknown as Worker).postMessage({ type: 'failed', id: req.id, message: e instanceof Error ? e.message : String(e) });
  }
};
