/**
 * Quality settings: the two presets, the dynamically scaled internal image,
 * and the renderer settings the tunables hold.
 *
 *   high — the internal image at 1.5 MP, lit at one pixel in four;
 *   low  — the same image, lit at one pixel in sixteen.
 */

import type { Tunables } from '../core/tunables';
import { atmosphereModel, type AtmosphereModel } from './atmosphere';

export type Preset = 'high' | 'low';

/** The lighting grid's block size per preset: each L × L block is lit by one of its pixels. */
export const LIGHT_SCALE: Record<Preset, number> = { high: 2, low: 4 };

/** The internal image at `scale` per axis of the size its textures hold, never below a pixel. */
export function scaledSize(alloc: readonly [number, number], scale: number): [number, number] {
  return [Math.max(1, Math.round(alloc[0] * scale)), Math.max(1, Math.round(alloc[1] * scale))];
}

export interface RenderSettings {
  /** The internal image's target size, in megapixels: 1.5 for the "high" preset. */
  megapixels: number;
  /** Bytes of world edits uploaded per frame. */
  uploadBudget: number;
  /** The GPU time dynamic resolution holds a frame under. */
  budgetMs: number;
  /** The denoiser: frames of history at most, and its filter's edge widths. */
  denoise: { historyMax: number; sigmaLuma: number; sigmaPlane: number };
  /** Sharpening after TAA, 0 to 1. */
  sharpness: number;
  /** The air the sky is made of. */
  atmosphere: AtmosphereModel;
}

export function rendererTunables(tun: Tunables): RenderSettings {
  return {
    megapixels: tun.f('render.internal_mp_high'),
    uploadBudget: tun.i('render.upload_budget_kib') * 1024,
    budgetMs: tun.f('render.gpu_budget_ms'),
    denoise: { historyMax: tun.i('render.history_max'), sigmaLuma: tun.f('render.atrous_sigma_luma'), sigmaPlane: tun.f('render.atrous_sigma_plane') },
    sharpness: tun.f('render.cas_sharpness'),
    atmosphere: atmosphereModel(tun),
  };
}
