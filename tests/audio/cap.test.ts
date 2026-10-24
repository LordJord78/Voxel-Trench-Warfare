import { describe, expect, it } from 'vitest';
import { VoiceCap } from '../../src/audio/cap';

// The engine's voices are capped (the battle spec's §7): at most 64 sounding or waiting to, the
// farthest dropped first, so a heavy night cannot swamp the main thread.
describe('the voice cap', () => {
  it('holds 64: a farther voice is not played, a nearer one cuts the farthest', () => {
    const cap = new VoiceCap<string>(64);
    for (let i = 0; i < 64; i++) expect(cap.admit(100 + i, 10, 0, () => `v${i}`)).toEqual({ play: true });
    expect(cap.count).toBe(64);
    // Farther than all held: not played, nothing cut.
    expect(cap.admit(500, 10, 0, () => 'far')).toEqual({ play: false });
    // Nearer: played, the farthest held (163 m) cut.
    expect(cap.admit(50, 10, 0, () => 'near')).toEqual({ play: true, cut: 'v63' });
    expect(cap.count).toBe(64);
    // And the next nearer cuts the next farthest.
    expect(cap.admit(60, 10, 0, () => 'nearer')).toEqual({ play: true, cut: 'v62' });
  });

  it('a voice frees its place when it ends', () => {
    const cap = new VoiceCap<number>(2);
    cap.admit(10, 1, 0, () => 1);
    cap.admit(20, 3, 0, () => 2);
    // At 2 s the first has ended: the third is played and cuts nothing.
    expect(cap.admit(30, 4, 2, () => 3)).toEqual({ play: true });
    expect(cap.count).toBe(2);
  });

  it('makes a voice only when it is played', () => {
    const cap = new VoiceCap<number>(1);
    let made = 0;
    cap.admit(10, 5, 0, () => ++made);
    cap.admit(20, 5, 0, () => ++made);
    expect(made).toBe(1);
  });
});
