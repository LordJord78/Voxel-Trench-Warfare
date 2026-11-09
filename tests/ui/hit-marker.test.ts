import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadTunables } from '../../src/core/tunables';
import { HitMarker, markerTunables } from '../../src/ui/hit-marker';

// The hit marker (the shots spec's §4): four ticks at the crosshair, white for a hit, gold and larger
// for a headshot, red, larger still and ringed for a kill; each pops in and fades, a kill over a
// headshot over a hit. A kill's ring expands out from the marker and fades over its hold, so it frames
// what it marks (G3 Task 6). Under it HEADSHOT or KILL, a match's kill with the victim's name; over the
// view, the red flash of being hit. Its animations run on the frame's clock (tick), so a frozen,
// stepped page shows each frame what that frame's time says.
const tun = loadTunables();
const t = markerTunables(tun);
/** [hits] kill_ring_to: the ring's size at the end of its hold, times the marker's reach. */
const RING_TO = tun.f('hits.kill_ring_to');

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
  const els = { marker: new FakeElement(), ring: new FakeElement(), pop: new FakeElement(), word: new FakeElement(), name: new FakeElement(), flash: new FakeElement() };
  const at: Record<string, FakeElement> = {
    '#hud .marker': els.marker,
    '#hud .kill-ring': els.ring,
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
    expect(t).toEqual({ holdS: { hit: 0.22, head: 0.32, kill: 0.6 }, popS: 0.09, popScale: 1.6, fadeS: 0.12, textS: 0.9, textScale: 1.3, flashS: 0.35, ring: { from: 1.6, to: RING_TO, ease: 3 } });
  });

  /** The ring's scale and opacity at `ms` into its animation, as the page interpolates its keyframes (linearly between them). */
  const ringAt = (a: FakeAnimation, ms: number) => {
    const u = ms / Number(a.options.duration);
    const k = a.keyframes;
    const scale = (f: Keyframe) => Number(/^scale\(([\d.]+)\)$/.exec(String(f.transform))![1]);
    for (let i = 1; i < k.length; i++) {
      const [lo, hi] = [Number(k[i - 1].offset), Number(k[i].offset)];
      if (u <= hi) {
        const w = (u - lo) / (hi - lo);
        return { scale: scale(k[i - 1]) + (scale(k[i]) - scale(k[i - 1])) * w, opacity: Number(k[i - 1].opacity) + (Number(k[i].opacity) - Number(k[i - 1].opacity)) * w };
      }
    }
    return { scale: scale(k.at(-1)!), opacity: Number(k.at(-1)!.opacity) };
  };

  it("a kill's ring expands out from the marker as it pops (1.6× the marker's reach) to kill_ring_to over its 600 ms hold, easing out, and fades out as it goes, so it frames what it marks; the ticks keep their pop", () => {
    const { els, marker } = page();
    expect(els.ring.hidden).toBe(true);
    marker.show('kill', 1000);
    expect([els.ring.hidden, els.ring.className]).toEqual([false, 'kill-ring']);
    const a = els.ring.animation;
    expect(a.options).toMatchObject({ duration: 600, fill: 'both' });
    expect([a.paused, a.currentTime]).toEqual([true, 0]);
    // Its keyframes every 50 ms: the scale 1.6 + (to − 1.6)(1 − (1 − u)³), the opacity 1 − u.
    expect(a.keyframes).toHaveLength(13);
    const ease = (u: number) => 1.6 + (RING_TO - 1.6) * (1 - (1 - u) ** 3);
    a.keyframes.forEach((k, i) => {
      expect(k.offset).toBeCloseTo(i / 12, 12);
      expect(Number(/^scale\(([\d.]+)\)$/.exec(String(k.transform))![1])).toBeCloseTo(ease(i / 12), 4);
      expect(k.opacity).toBeCloseTo(1 - i / 12, 12);
    });
    // Growing all its hold, quickest at first: by 100 ms (six frames) past 42% of the way out.
    let was = 0;
    for (let ms = 0; ms <= 600; ms += 10) {
      const now = ringAt(a, ms);
      expect(now.scale).toBeGreaterThan(was);
      was = now.scale;
    }
    expect(ringAt(a, 0)).toEqual({ scale: 1.6, opacity: 1 });
    expect(ringAt(a, 100).scale).toBeGreaterThan(1.6 + 0.42 * (RING_TO - 1.6));
    expect(ringAt(a, 100).opacity).toBeCloseTo(5 / 6, 9);
    expect(ringAt(a, 600)).toEqual({ scale: RING_TO, opacity: 0 });
    // On the frame's clock, and gone at the end of its hold while the ticks fade on.
    marker.tick(1100);
    expect(a.currentTime).toBe(100);
    marker.tick(1599);
    expect(els.ring.hidden).toBe(false);
    marker.tick(1600);
    expect([els.ring.hidden, a.cancelled, marker.state().marker, els.marker.hidden]).toEqual([true, true, 'kill', false]);
    // The ticks' own pop, as before: 1.6× to 1× over 90 ms, held, faded.
    expect(els.marker.animation.keyframes.map((k) => k.transform)).toEqual(['scale(1.6)', 'scale(1)', 'scale(1)', 'scale(1)']);
  });

  it('no ring for a hit or a headshot; a kill over a kill starts its ring again; clear takes it down', () => {
    const { els, marker } = page();
    marker.show('hit', 0);
    marker.show('head', 50);
    expect([els.ring.hidden, els.ring.animations.length]).toEqual([true, 0]);
    marker.show('kill', 100);
    const first = els.ring.animation;
    marker.tick(300);
    marker.show('kill', 300);
    expect(first.cancelled).toBe(true);
    expect([els.ring.animations.length, els.ring.animation.currentTime, els.ring.hidden]).toEqual([2, 0, false]);
    marker.tick(899);
    expect(els.ring.hidden).toBe(false);
    marker.clear();
    expect([els.ring.hidden, els.ring.animation.cancelled]).toEqual([true, true]);
    // After a kill's ring is done, a hit shows no ring.
    marker.show('kill', 2000);
    marker.tick(2720);
    marker.show('hit', 2800);
    expect(els.ring.hidden).toBe(true);
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

  it('a kill replaces a hit still showing, and nothing less replaces a kill until it is done; a headshot is gold, a kill red and ringed, by class; show says whether it showed', () => {
    const { els, marker } = page();
    expect(marker.show('hit', 0)).toBe(true);
    expect(marker.show('kill', 150)).toBe(true);
    expect([marker.state().marker, els.marker.className]).toEqual(['kill', 'marker kill']);
    expect(els.marker.animation.options.duration).toBe(720);
    expect(marker.show('head', 300)).toBe(false);
    expect(marker.show('hit', 400)).toBe(false);
    expect([marker.state().marker, els.marker.className, els.marker.animations.length]).toEqual(['kill', 'marker kill', 2]);
    marker.tick(869);
    expect(marker.state().marker).toBe('kill');
    marker.tick(870);
    expect(marker.state().marker).toBeNull();
    // Done, a hit shows; a headshot over it.
    expect(marker.show('hit', 900)).toBe(true);
    expect(marker.show('head', 950)).toBe(true);
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

  it("a match's headshot kill pops HEADSHOT once: the room's word, while the round's HEADSHOT still shows, names the victim without starting it again", () => {
    const { els, marker } = page();
    marker.pop('HEADSHOT', null, 0);
    const a = els.pop.animation;
    marker.tick(100);
    expect(a.currentTime).toBe(100);
    // The room's death, a round trip on: the name added, the same animation going on from where it was.
    marker.pop('HEADSHOT', { name: 'Ann', team: 'blue' }, 100);
    expect(els.pop.animations).toHaveLength(1);
    expect([a.cancelled, a.currentTime]).toEqual([false, 100]);
    expect([els.pop.hidden, els.pop.className, els.word.textContent, els.name.textContent, els.name.className]).toEqual([false, 'hit-pop head', 'HEADSHOT', 'Ann', 'name blue']);
    expect(marker.state().pop).toBe('HEADSHOT Ann');
    marker.tick(150);
    expect(a.currentTime).toBe(150);
    // Gone when the round's pop is done, 0.9 s from the round.
    marker.tick(899);
    expect(marker.state().pop).toBe('HEADSHOT Ann');
    marker.tick(900);
    expect([marker.state().pop, els.pop.hidden]).toEqual([null, true]);
    // A new word, a new headshot, or another kill's name starts it again.
    marker.pop('HEADSHOT', null, 1000);
    marker.pop('KILL', { name: 'Ann', team: 'blue' }, 1050);
    expect(els.pop.animations).toHaveLength(3);
    marker.pop('KILL', { name: 'Bob', team: 'red' }, 1100);
    marker.pop('KILL', null, 1150);
    expect(els.pop.animations).toHaveLength(5);
    expect(els.pop.animations.slice(0, 4).every((x) => x.cancelled)).toBe(true);
    expect([marker.state().pop, els.name.textContent]).toEqual(['KILL', '']);
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

  it("a weaker flash over a stronger one still fading goes on from what shows: an M870's blast split over two ticks (1, then 0.25 50 ms on) starts the second at about 0.86, not 0.25; a stronger one starts at its own", () => {
    const { els, marker } = page();
    marker.flash(1, 1000);
    marker.tick(1050);
    marker.flash(0.25, 1050);
    const shown = 1 * (1 - 50 / 350);
    const [from, to] = els.flash.animation.keyframes.map((k) => Number(k.opacity));
    expect(from).toBeCloseTo(shown, 9);
    expect(from).toBeCloseTo(0.86, 2);
    expect(to).toBe(0);
    expect(els.flash.animation.options).toMatchObject({ duration: 350 });
    // Fading from there over hurt_flash_s.
    marker.tick(1399);
    expect(els.flash.hidden).toBe(false);
    marker.tick(1400);
    expect(els.flash.hidden).toBe(true);
    // A stronger one over a weaker: its own strength.
    marker.flash(0.3, 2000);
    marker.flash(0.9, 2100);
    expect(els.flash.animation.keyframes.map((k) => k.opacity)).toEqual([0.9, 0]);
    // Once one is done, the next starts at its own, however weak.
    marker.flash(1, 3000);
    marker.tick(3350);
    marker.flash(0.25, 3400);
    expect(els.flash.animation.keyframes.map((k) => k.opacity)).toEqual([0.25, 0]);
  });

  it("the red flash lies over the scope's mask, under the marker, its ring and the words (index.html): a scoped player sees being hit", () => {
    const html = readFileSync('index.html', 'utf8');
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      expect(i, needle).toBeGreaterThan(0);
      return i;
    };
    const flash = at('<div id="hurt-flash"');
    expect(flash).toBeGreaterThan(at('<div id="scope"'));
    for (const over of ['<div class="marker"', '<b class="kill-ring"', '<p class="hit-pop"']) expect(flash, over).toBeLessThan(at(over));
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
