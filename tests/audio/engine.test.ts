import { describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { audioTunables } from '../../src/audio/plan';
import { loadTunables } from '../../src/core/tunables';

// Without sound the game still plays: here there is no AudioContext at all, as in a browser that
// refuses one.
describe('the sound engine without sound', () => {
  it('starts, hears and plays nothing, and never throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = new AudioEngine(audioTunables(loadTunables()), { lowHz: 120, lengthS: 0.2 });
    expect(() => engine.start()).not.toThrow();
    expect(() => engine.start()).not.toThrow();
    expect(engine.state).toBe('none');
    expect(() => engine.listen({ position: [0, 2, 0], yaw: 0, pitch: 0 })).not.toThrow();
    expect(() => engine.play([{ kind: 'report', at: [0, 2, 1], delayS: 0, gain: 1, lowpassHz: 18000 }])).not.toThrow();
    expect(() => engine.suspend()).not.toThrow();
    expect(engine.voices).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[audio] no sound'));
    warn.mockRestore();
  });
});
