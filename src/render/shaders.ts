/** Shader modules as the GPU gets them: the generated uniform structs, then the composed WGSL. */

import { FRAME } from './frame-uniforms';
import { structWgsl } from './layout';

export function moduleSource(composed: string): string {
  return `${structWgsl(FRAME)}\n\n${composed}`;
}
