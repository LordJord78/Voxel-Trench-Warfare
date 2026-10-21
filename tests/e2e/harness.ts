/**
 * Browser side of the GPU harness: every case module's functions, callable
 * from Playwright as window.harness[name](args). A case returns plain data.
 */
import { cases as device } from './cases/device';

const registry: Record<string, (args?: never) => Promise<unknown>> = { ...device };
(window as unknown as { harness: typeof registry }).harness = registry;
