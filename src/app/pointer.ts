/**
 * The pointer lock's changes, as the game takes them. Play that loses the lock pauses (Esc, or the
 * browser took it). A lock the browser gives once play has stopped is let go at once, so the menus
 * have the cursor: one asked for by Play or Resume and granted only after Esc had paused (fullscreen
 * in Chrome and Edge, where Esc is the page's, a short press no longer frees the pointer itself),
 * or after the match ended or the game stopped.
 */
export function pointerLockAction(playing: boolean, locked: boolean): 'pause' | 'release' | null {
  if (playing) return locked ? null : 'pause';
  return locked ? 'release' : null;
}
