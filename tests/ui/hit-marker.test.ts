import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { HitMarker, markerTunables } from '../../src/ui/hit-marker';

// The hit marker (the shots spec's §4): four ticks at the crosshair, white for a hit, gold and larger
// for a headshot, red, larger still and ringed for a kill; each pops in and fades, a kill over a
// headshot over a hit. Under it HEADSHOT or KILL, a match's kill with the victim's name; over the
// view, the red flash of being hit. Its animations run on the frame's clock (tick), so a frozen,
// stepped page shows each frame what that frame's time says.
const tun = loadTunables();
const t = markerTunables(tun);

/** An animation as the page's Web Animations make it: its keyframes and timing, held and set by hand. */
class FakeAnimation {
  currentTime: number | null = null;
  paused = false;
  cancelled = false;
  constructor(
    readonly keyframes: Keyframe[],
    readonly options: KeyframeAnimationOptions,
  ) {}
  pause(): void {
    this.paused = true;
  }
  cancel(): void {
    this.cancelled = true;
  }
}

/** An element as the marker writes it. */
class FakeElement {
  hidden = true;
  className = '';
  textContent: string | null = '';
  readonly animations: FakeAnimation[] = [];
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): FakeAnimation {
    const a = new FakeAnimation(keyframes, options);
    this.animations.push(a);
    return a;
  }
  get animation(): FakeAnimation {
    return this.animations.at(-1)!;
  }
}

function page() {
  const els = { marker: new FakeElement(), pop: new FakeElement(), word: new FakeElement(), name: new FakeElement(), flash: new FakeElement() };
  const at: Record<string, FakeElement> = {
    '#hud .marker': els.marker,
    '#hud .hit-pop': els.pop,
    '#hud .hit-pop .word': els.word,
    '#hud .hit-pop .name': els.name,
    '#hurt-flash': els.flash,
  };
  const doc = { querySelector: (selector: string) => at[selector] ?? null };
  return { els, marker: new HitMarker(doc as unknown as Document, t) };
}

describe('the hit marker', () => {
  it("reads [hits]: each kind's hold, the pop and the fade, the text's time, the flash's fade", () => {
    expect(t).toEqual({ holdS: { hit: 0.22, head: 0.32, kill: 0.6 }, popS: 0.09, popScale: 1.6, fadeS: 0.12, textS: 0.9, textScale: 1.3, flashS: 0.35 });
  });

  it("a hit's marker pops in from 1.6× over 90 ms, is held 220 ms and fades over 120 ms, on the frame's clock; a new hit starts it again", () => {
    const { els, marker } = page();
    expect(marker.state()).toEqual({ marker: null, pop: null });
    marker.show('hit', 1000);
    expect([els.marker.hidden, els.marker.className]).toEqual([false, 'marker hit']);
    expect(marker.state()).toEqual({ marker: 'hit', pop: null });
    const a = els.marker.animation;
    expect(a.options).toMatchObject({ duration: 340, fill: 'both' });
    expect(a.keyframes.map((k) => [k.transform, k.opacity])).toEqual([
      ['scale(1.6)', 1],
      ['scale(1)', 1],
      ['scale(1)', 1],
      ['scale(1)', 0],
    ]);
    expect(a.keyframes.map((k) => k.offset)).toEqual([0, 90 / 340, 220 / 340, 1]);
    // Held, and set to the frame's time since it was shown.
    expect([a.paused, a.currentTime]).toEqual([true, 0]);
    marker.tick(1100);
    expect(a.currentTime).toBe(100);
    marker.tick(1339);
    expect([marker.state().marker, els.marker.hidden]).toEqual(['hit', false]);
    marker.tick(1340);
    expect([marker.state().marker, els.marker.hidden, a.cancelled]).toEqual([null, true, true]);
    // Shown again, and again before it is done: each starts it afresh.
    marker.show('hit', 2000);
    const first = els.marker.animation;
    marker.tick(2200);
    marker.show('hit', 2200);
    expect(first.cancelled).toBe(true);
    expect(els.marker.animation).not.toBe(first);
    expect(els.marker.animation.currentTime).toBe(0);
    marker.tick(2539);
    expect(marker.state().marker).toBe('hit');
  });

  it('a kill replaces a hit still showing, and nothing less replaces a kill until it is done; a headshot is gold, a kill red and ringed, by class', () => {
    const { els, marker } = page();
    marker.show('hit', 0);
    marker.show('kill', 150);
    expect([marker.state().marker, els.marker.className]).toEqual(['kill', 'marker kill']);
    expect(els.marker.animation.options.duration).toBe(720);
    marker.show('head', 300);
    marker.show('hit', 400);
    expect([marker.state().marker, els.marker.className, els.marker.animations.length]).toEqual(['kill', 'marker kill', 2]);
    marker.tick(869);
    expect(marker.state().marker).toBe('kill');
    marker.tick(870);
    expect(marker.state().marker).toBeNull();
    // Done, a hit shows; a headshot over it.
    marker.show('hit', 900);
    marker.show('head', 950);
    expect([marker.state().marker, els.marker.className]).toEqual(['head', 'marker head']);
    expect(els.marker.animation.options.duration).toBe(440);
  });

  it("the pop: HEADSHOT, or KILL with a match's victim named in their team's colour, for 0.9 s", () => {
    const { els, marker } = page();
    marker.pop('HEADSHOT', null, 0);
    expect([els.pop.hidden, els.pop.className, els.word.textContent, els.name.textContent]).toEqual([false, 'hit-pop head', 'HEADSHOT', '']);
    expect(marker.state()).toEqual({ marker: null, pop: 'HEADSHOT' });
    const a = els.pop.animation;
    expect(a.options).toMatchObject({ duration: 900, fill: 'both' });
    expect(a.keyframes.map((k) => [k.transform, k.opacity])).toEqual([
      ['scale(1.3)', 1],
      ['scale(1)', 1],
      ['scale(1)', 1],
      ['scale(1)', 0],
    ]);
    expect(a.keyframes.map((k) => k.offset)).toEqual([0, 90 / 900, 780 / 900, 1]);
    marker.tick(899);
    expect(marker.state().pop).toBe('HEADSHOT');
    marker.tick(900);
    expect([marker.state().pop, els.pop.hidden]).toEqual([null, true]);
    marker.pop('KILL', { name: 'Ann', team: 'blue' }, 1000);
    expect([els.pop.className, els.word.textContent, els.name.textContent, els.name.className]).toEqual(['hit-pop kill', 'KILL', 'Ann', 'name blue']);
    expect(marker.state().pop).toBe('KILL Ann');
  });

  it('the red flash: at its strength, gone over 0.35 s; clear takes everything down at once', () => {
    const { els, marker } = page();
    marker.flash(0.58, 0);
    expect(els.flash.hidden).toBe(false);
    expect(els.flash.animation.keyframes.map((k) => k.opacity)).toEqual([0.58, 0]);
    expect(els.flash.animation.options).toMatchObject({ duration: 350, fill: 'both' });
    marker.tick(349);
    expect(els.flash.hidden).toBe(false);
    marker.tick(350);
    expect(els.flash.hidden).toBe(true);
    marker.show('kill', 1000);
    marker.pop('KILL', null, 1000);
    marker.flash(1, 1000);
    marker.clear();
    expect([els.marker.hidden, els.pop.hidden, els.flash.hidden]).toEqual([true, true, true]);
    expect(marker.state()).toEqual({ marker: null, pop: null });
  });

  it('a page without its elements keeps the state and throws nothing', () => {
    const marker = new HitMarker({ querySelector: () => null } as unknown as Document, t);
    marker.show('head', 0);
    marker.pop('HEADSHOT', null, 0);
    marker.flash(0.3, 0);
    expect(marker.state()).toEqual({ marker: 'head', pop: 'HEADSHOT' });
    marker.tick(5000);
    expect(marker.state()).toEqual({ marker: null, pop: null });
    marker.clear();
  });
});
