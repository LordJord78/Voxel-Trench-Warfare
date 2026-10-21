/**
 * What the keys do until milestone 5's controls: views, time of day,
 * quality and the overlay. (Flying is held keys, read by the fly camera.)
 */

import { VIEW_NAMES, type ViewName } from './views';

export type KeyAction =
  | { kind: 'view'; name: ViewName }
  | { kind: 'time-next' }
  | { kind: 'time-step'; by: 1 | -1 }
  | { kind: 'preset' }
  | { kind: 'dynres' }
  | { kind: 'overlay' };

/** Dusk, twilight and night: the time-of-day keys. */
const TIME_KEYS = [0, 0.5, 1];
const TIME_STEP = 0.05;

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
    case 'KeyR':
      return { kind: 'dynres' };
    case 'F3':
      return { kind: 'overlay' };
    default:
      return null;
  }
}

/** The next time-of-day key after t, from night back to dusk. */
export function nextTimeKey(t: number): number {
  return TIME_KEYS.find((k) => k > t + 1e-9) ?? TIME_KEYS[0];
}

/** t moved a step of 0.05 toward night (+1) or dusk (-1), on the steps' grid and within dusk and night. */
export function stepTime(t: number, by: 1 | -1): number {
  const steps = Math.round(t / TIME_STEP) + by;
  return Math.min(1, Math.max(0, Math.round(steps * TIME_STEP * 100) / 100));
}
