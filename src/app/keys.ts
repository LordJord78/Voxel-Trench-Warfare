/**
 * What the keys do until milestone 5's controls: views, time of day,
 * quality and the overlay. (Flying is held keys, read by the fly camera.)
 * And fullscreen's key, Alt+Enter, which works anywhere in the game.
 */

import { CLOCK_KEYS } from '../core/sky-clock';
import { VIEW_NAMES, type ViewName } from './views';

export type KeyAction =
  | { kind: 'view'; name: ViewName }
  | { kind: 'time-next' }
  | { kind: 'time-step'; by: 1 | -1 }
  | { kind: 'preset' }
  | { kind: 'dynres' }
  | { kind: 'overlay' };

/** The clock's keys in the day's order. */
const TIME_KEYS = [CLOCK_KEYS.dawn, CLOCK_KEYS.noon, CLOCK_KEYS.dusk, CLOCK_KEYS.night];
/** [ and ] move the clock a quarter of an hour. */
const TIME_STEP = 0.25;

export function actionFor(code: string): KeyAction | null {
  const digit = /^Digit([1-9])$/.exec(code);
  if (digit) {
    const name = VIEW_NAMES[Number(digit[1]) - 1];
    return name ? { kind: 'view', name } : null;
  }
  switch (code) {
    case 'KeyT':
      return { kind: 'time-next' };
    case 'BracketLeft':
      return { kind: 'time-step', by: -1 };
    case 'BracketRight':
      return { kind: 'time-step', by: 1 };
    case 'KeyP':
      return { kind: 'preset' };
    case 'KeyY':
      return { kind: 'dynres' };
    case 'F3':
      return { kind: 'overlay' };
    default:
      return null;
  }
}

/**
 * Alt+Enter (on a Mac the same keys, Option+Return): fullscreen on and off. Shift may be held (a
 * sprint); Ctrl and Cmd may not (AltGr is Ctrl+Alt on Windows). A plain Enter is not it.
 */
export function isFullscreenKey(e: Pick<KeyboardEvent, 'code' | 'altKey' | 'ctrlKey' | 'metaKey'>): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'Enter' || e.code === 'NumpadEnter');
}

/** Fullscreen's key as the player's keyboard names it: Option+Return on a Mac, Alt+Enter elsewhere. */
export function fullscreenKeyName(userAgent: string): string {
  return /Mac/.test(userAgent) ? 'Option+Return' : 'Alt+Enter';
}

/** The clock's next key after `hours`, round the day: dusk, night, dawn, noon, dusk. */
export function nextTimeKey(hours: number): number {
  return TIME_KEYS.find((k) => k > hours + 1e-9) ?? TIME_KEYS[0];
}

/** The clock moved a quarter of an hour on (+1) or back (-1), onto the quarters, round midnight. */
export function stepTime(hours: number, by: 1 | -1): number {
  const quarter = by > 0 ? Math.floor(hours / TIME_STEP + 1e-9) + 1 : Math.ceil(hours / TIME_STEP - 1e-9) - 1;
  return (((quarter * TIME_STEP) % 24) + 24) % 24;
}
