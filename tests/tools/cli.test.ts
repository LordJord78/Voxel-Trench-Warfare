import { describe, expect, it } from 'vitest';
import { parseOnly } from '../../tools/lib/cli.mjs';

// The tools' shared command line (tools/lib/cli.mjs): --only, as range-captures and the sounds' proof
// take it, each saying what it lists in its own noun.

describe("the tools' command line", () => {
  it('--only takes a list, as --only a,b or --only=a,b; none asked, every one (null)', () => {
    const names = ['dusk', 'corridor-night', '1735', 'noon'];
    expect(parseOnly([], names, 'capture')).toEqual({ only: null });
    expect(parseOnly(['--other'], names, 'capture')).toEqual({ only: null });
    expect(parseOnly(['--only', 'dusk,corridor-night'], names, 'capture')).toEqual({ only: ['dusk', 'corridor-night'] });
    expect(parseOnly(['--only=1735,noon'], names, 'capture')).toEqual({ only: ['1735', 'noon'] });
  });

  it('with no list, or a name that is none of them, an error in the noun asked: a capture, a render', () => {
    const names = ['hit', 'gush', 'ding-85m'];
    for (const argv of [['--only'], ['--only='], ['--only', '--other'], ['--only', '']]) {
      expect(parseOnly(argv, names, 'capture'), argv.join(' ')).toEqual({ error: '--only: no list of captures' });
      expect(parseOnly(argv, names, 'render'), argv.join(' ')).toEqual({ error: '--only: no list of renders' });
    }
    expect(parseOnly(['--only', 'hit,dawn,gush'], names, 'capture')).toEqual({ error: '--only: no capture dawn' });
    expect(parseOnly(['--only', 'hit,dawn,gush'], names, 'render')).toEqual({ error: '--only: no render dawn' });
    expect(parseOnly(['--only=gsuh'], names, 'render')).toEqual({ error: '--only: no render gsuh' });
    expect(parseOnly(['--only=gush,ding-85m'], names, 'render')).toEqual({ only: ['gush', 'ding-85m'] });
  });
});
