import { describe, expect, it } from 'vitest';
import { Stance } from '../../src/physics/character';
import { hudLines, type HudState } from '../../src/ui/hud';

// The HUD's copy (the spec's §5, "The HUD"; the reference's ui/hud.py, in sentence case): the
// stance, how exposed, the rounds or a reload, the digging; a pure function of the state.
const base: HudState = { stance: Stance.STANDING, exposure: 1, rounds: 30, magazine: 30, reloading: false, digging: false, digFraction: 0, digInReach: false, crosshair: true };

describe('the HUD', () => {
  it('the HUD says what the state is', () => {
    expect(hudLines(base)).toEqual({ stance: 'Standing', exposure: { label: 'Exposure', filled: 10, of: 14 }, rifle: '30 / 30', dig: null });
    const names: [Stance, string][] = [
      [Stance.STANDING, 'Standing'],
      [Stance.CROUCHED, 'Crouched'],
      [Stance.PRONE, 'Prone'],
      [Stance.FIRING_STEP, 'On the firing step'],
      [Stance.PERISCOPE, 'Periscope up'],
    ];
    for (const [stance, name] of names) expect(hudLines({ ...base, stance }).stance).toBe(name);
    // A bar of 14, filled to round(exposure × 10), never past its end: prone, and the firing step's 1.35 while digging.
    expect(hudLines({ ...base, exposure: 0.28 }).exposure.filled).toBe(3);
    expect(hudLines({ ...base, exposure: 1.35 * 1.25 }).exposure.filled).toBe(14);
    expect(hudLines({ ...base, exposure: 0 }).exposure.filled).toBe(0);
    expect(hudLines({ ...base, rounds: 7 }).rifle).toBe('7 / 30');
    expect(hudLines({ ...base, rounds: 0, reloading: true }).rifle).toBe('Reloading');
    // Digging: a bar of 8 toward the next scoop; or nothing loose in reach.
    expect(hudLines({ ...base, digging: true, digInReach: true, digFraction: 0.5 }).dig).toEqual({ label: 'Digging', filled: 4, of: 8 });
    expect(hudLines({ ...base, digging: true, digInReach: true, digFraction: 0.99 }).dig).toEqual({ label: 'Digging', filled: 7, of: 8 });
    // A scoop held back (a crater's region out): the bar stands full.
    expect(hudLines({ ...base, digging: true, digInReach: true, digFraction: 1 }).dig).toEqual({ label: 'Digging', filled: 8, of: 8 });
    expect(hudLines({ ...base, digging: true, digInReach: false, digFraction: 0.3 }).dig).toEqual({ label: 'Nothing to clear', filled: 0, of: 0 });
  });
});
