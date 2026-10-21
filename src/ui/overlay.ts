/**
 * The F3 overlay: what the frame costs, what it renders at, what the world
 * holds in memory, and where the camera is. Its text is a pure function of
 * the numbers, so it can be tested without a page.
 */

import type { GpuWorldStats } from '../render/gpu-world';
import type { Preset } from '../render/quality';
import { bayIndex, type BayLookup, type WorldPlan } from '../world/generation/plan';

export interface OverlayInfo {
  gpuMs: number | null;
  passes: Record<string, number>;
  fps: number;
  res: [number, number];
  alloc: [number, number];
  scale: number;
  preset: Preset;
  dynres: boolean;
  world: GpuWorldStats;
  /** Metres and degrees. */
  position: [number, number, number];
  yaw: number;
  pitch: number;
  timeOfDay: number;
  place: string;
}

const MB = 1024 * 1024;

export function overlayText(i: OverlayInfo): string {
  const lines = [`${i.gpuMs === null ? 'GPU not timed' : `GPU ${i.gpuMs.toFixed(2)} ms`}  ${Math.round(i.fps)} fps`];
  for (const [name, ms] of Object.entries(i.passes)) lines.push(`  ${name.padEnd(9)} ${ms.toFixed(2)}`);
  lines.push(
    `internal ${i.res[0]}×${i.res[1]} of ${i.alloc[0]}×${i.alloc[1]} (${Math.round(i.scale * 100)}%)  preset ${i.preset}, ${i.dynres ? 'dynamic' : 'fixed'}`,
  );
  const w = i.world;
  lines.push(
    `world ${w.denseBricks.toLocaleString('en-US')} dense bricks  heap ${(w.heapUsedBytes / MB).toFixed(1)} / ${(w.heapCapacityBytes / MB).toFixed(1)} MB  ` +
      `table ${(w.tableBytes / MB).toFixed(1)} MB  ${w.pending} upload${w.pending === 1 ? '' : 's'} pending`,
  );
  lines.push(`at ${i.position.map((v) => v.toFixed(1)).join(', ')} m  yaw ${Math.round(i.yaw)}° pitch ${Math.round(i.pitch)}°  time ${i.timeOfDay.toFixed(2)}`);
  lines.push(i.place);
  return lines.join('\n');
}

const lookups = new WeakMap<WorldPlan, BayLookup>();

/** The trench bay under a point (metres), by its line and number, e.g. "front bay 12". */
export function placeName(plan: WorldPlan, x: number, z: number): string {
  let lookup = lookups.get(plan);
  if (!lookup) {
    lookup = bayIndex(plan);
    lookups.set(plan, lookup);
  }
  const v = plan.params.voxel;
  const at = lookup.at(Math.floor(x / v), Math.floor(z / v));
  return at ? `${plan.lines[at.line].spec.name.replace(/_/g, ' ')} bay ${at.bay}` : 'open ground';
}

/** The overlay's element: hidden until toggled, and only written while shown. */
export class Overlay {
  visible = false;
  private readonly el: HTMLPreElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('pre');
    this.el.id = 'overlay';
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.hidden = !this.visible;
  }

  show(info: OverlayInfo): void {
    if (this.visible) this.el.textContent = overlayText(info);
  }
}
