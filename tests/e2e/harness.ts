/**
 * Browser side of the GPU harness: every case module's functions, callable
 * from Playwright as window.harness[name](args). A case returns plain data.
 */
import { cases as denoise } from './cases/denoise';
import { cases as device } from './cases/device';
import { cases as farfield } from './cases/farfield';
import { cases as lighting } from './cases/lighting';
import { cases as primary } from './cases/primary';
import { cases as scale } from './cases/scale';
import { cases as shade } from './cases/shade';
import { cases as taa } from './cases/taa';
import { cases as traverse } from './cases/traverse';
import { cases as world } from './cases/world';

const registry: Record<string, (args: never) => Promise<unknown>> = { ...device, ...world, ...traverse, ...primary, ...farfield, ...lighting, ...denoise, ...shade, ...taa, ...scale };
(window as unknown as { harness: typeof registry }).harness = registry;
