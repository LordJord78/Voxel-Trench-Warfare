import { describe, expect, it } from 'vitest';
import { actionFor, fullscreenKeyName, isFullscreenKey, nextTimeKey, stepTime } from '../../src/app/keys';
import { VIEW_NAMES } from '../../src/app/views';
import { CLOCK_KEYS } from '../../src/core/sky-clock';

describe('keys', () => {
  it('1 to 6 jump to the standard views, in order', () => {
    VIEW_NAMES.forEach((name, i) => expect(actionFor(`Digit${i + 1}`)).toEqual({ kind: 'view', name }));
    expect(actionFor('Digit7')).toBeNull();
  });
  it('bind time, quality and the overlay', () => {
    expect(actionFor('KeyT')).toEqual({ kind: 'time-next' });
    expect(actionFor('BracketLeft')).toEqual({ kind: 'time-step', by: -1 });
    expect(actionFor('BracketRight')).toEqual({ kind: 'time-step', by: 1 });
    expect(actionFor('KeyP')).toEqual({ kind: 'preset' });
    // R reloads the rifle (input.ts); dynamic resolution's developer key is Y.
    expect(actionFor('KeyY')).toEqual({ kind: 'dynres' });
    expect(actionFor('KeyR')).toBeNull();
    expect(actionFor('F3')).toEqual({ kind: 'overlay' });
    expect(actionFor('KeyW')).toBeNull();
  });
  it("T walks the clock's keys in the day's order, dusk, night, dawn, noon and dusk again, from wherever the time is", () => {
    const { dawn, noon, dusk, night } = CLOCK_KEYS;
    expect(nextTimeKey(dusk)).toBe(night);
    expect(nextTimeKey(night)).toBe(dawn);
    expect(nextTimeKey(dawn)).toBe(noon);
    expect(nextTimeKey(noon)).toBe(dusk);
    expect(nextTimeKey(19)).toBe(night);
    expect(nextTimeKey(23.5)).toBe(dawn);
    expect(nextTimeKey(3)).toBe(dawn);
  });
  it('[ and ] step the clock by a quarter of an hour, on the quarters, round midnight', () => {
    expect(stepTime(12, 1)).toBe(12.25);
    expect(stepTime(12.1, 1)).toBe(12.25);
    expect(stepTime(0, -1)).toBe(23.75);
    expect(stepTime(23.75, 1)).toBe(0);
    let h = 6;
    for (let i = 0; i < 24; i++) h = stepTime(h, 1);
    expect(h).toBe(12);
  });
  it('Alt+Enter (Option+Return on a Mac) is fullscreen, Shift held or not; a plain Enter, and Enter with Ctrl or Cmd, are not', () => {
    const press = (code: string, held: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}) => ({ code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...held });
    expect(isFullscreenKey(press('Enter', { altKey: true }))).toBe(true);
    expect(isFullscreenKey(press('NumpadEnter', { altKey: true }))).toBe(true);
    // Sprinting.
    expect(isFullscreenKey(press('Enter', { altKey: true, shiftKey: true }))).toBe(true);
    expect(isFullscreenKey(press('Enter'))).toBe(false);
    expect(isFullscreenKey(press('NumpadEnter'))).toBe(false);
    // AltGr is Ctrl+Alt on Windows; Cmd+Option is the Mac's own.
    expect(isFullscreenKey(press('Enter', { altKey: true, ctrlKey: true }))).toBe(false);
    expect(isFullscreenKey(press('Enter', { altKey: true, metaKey: true }))).toBe(false);
    // F digs; Esc pauses.
    expect(isFullscreenKey(press('KeyF', { altKey: true }))).toBe(false);
    expect(isFullscreenKey(press('Escape', { altKey: true }))).toBe(false);
  });
  it("names fullscreen's key as the player's keyboard does: Option+Return on a Mac, Alt+Enter elsewhere", () => {
    expect(fullscreenKeyName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36')).toBe('Option+Return');
    expect(fullscreenKeyName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0')).toBe('Alt+Enter');
    expect(fullscreenKeyName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36')).toBe('Alt+Enter');
    expect(fullscreenKeyName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36')).toBe('Alt+Enter');
  });
});
