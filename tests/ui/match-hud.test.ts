import { describe, expect, it } from 'vitest';
import { fallenLine } from '../../src/ui/match-hud';

// The line over the count back in while dead (match-hud.ts fallen): who killed the player, or what
// of the battle did.
describe('the fallen line', () => {
  it('says how a player fell: by a name, by the shelling, shot from the line, burned', () => {
    expect(fallenLine({ name: 'Sam' }, 'round')).toBe('Killed by Sam');
    expect(fallenLine(null, 'shell')).toBe('Killed by the shelling');
    expect(fallenLine(null, 'round')).toBe('Shot from the line');
    expect(fallenLine(null, 'fire')).toBe('Burned');
    // The killer not known (nobody's word yet): only that they were killed.
    expect(fallenLine(undefined, 'shell')).toBe('Killed');
  });
});
