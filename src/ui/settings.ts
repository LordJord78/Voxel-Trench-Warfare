/**
 * The pause menu's preferences, kept between visits in local storage where
 * the browser allows it. Anything missing, unreadable or out of range falls
 * back to its default, so a stale or hand-edited value cannot break the game.
 * The time of day is not kept: every visit starts at dusk.
 */

import type { Intensity } from '../combat/front';
import type { Tunables } from '../core/tunables';
import type { Preset } from '../render/quality';

export interface Settings {
  preset: Preset;
  /** Whether the preset is the visitor's own, picked in the pause menu: kept, and never moved for them (app/tiers.ts). */
  presetChosen: boolean;
  /** Degrees of turn per pixel of mouse movement. */
  sensitivity: number;
  /** Horizontal field of view, degrees. */
  fov: number;
  /** The front's incoming fire: light by default, so a visitor hears the front without being pinned. */
  intensity: Intensity;
}

export const SETTING_RANGES = { sensitivity: [0.02, 0.6], fov: [60, 110] } as const;

const KEY = 'trenchline.settings';

export function defaultSettings(tun: Tunables): Settings {
  return { preset: 'high', presetChosen: false, sensitivity: tun.f('player.mouse_sensitivity'), fov: tun.f('camera.fov'), intensity: 'light' };
}

export function loadSettings(storage: Pick<Storage, 'getItem'> | null, defaults: Settings): Settings {
  let raw: unknown = null;
  try {
    raw = JSON.parse(storage?.getItem(KEY) ?? 'null');
  } catch {
    raw = null;
  }
  if (raw === null || typeof raw !== 'object') return { ...defaults };
  const r = raw as Record<string, unknown>;
  const number = (key: keyof typeof SETTING_RANGES): number => {
    const v = r[key];
    const [lo, hi] = SETTING_RANGES[key];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : defaults[key];
  };
  return {
    preset: r.preset === 'high' || r.preset === 'low' ? r.preset : defaults.preset,
    // Settings kept before the choice was: not the visitor's own.
    presetChosen: r.presetChosen === true,
    sensitivity: number('sensitivity'),
    fov: number('fov'),
    intensity: r.intensity === 'off' || r.intensity === 'light' || r.intensity === 'heavy' ? r.intensity : defaults.intensity,
  };
}

export function saveSettings(storage: Pick<Storage, 'setItem'> | null, s: Settings): void {
  try {
    storage?.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private browsing or a full quota: the settings last this visit.
  }
}
