/**
 * The hit marker (the shots spec's §4): what the player's rounds did, at the crosshair. Four ticks,
 * white for a hit, gold and larger for a headshot, red, larger still and ringed for a kill (their
 * looks are index.html's `#hud .marker`). Each pops in from [hits] marker_pop_scale to 1×, is held
 * its kind's while and fades; a kill shows over a headshot over a hit, and another of the same, or a
 * greater, starts it again. A kill's ring (`#hud .kill-ring`) is its own: it leaves the ticks' tips
 * as they pop (kill_ring_from times their reach) and expands out to kill_ring_to over the kill's
 * hold, easing out, fading as it goes, so it frames the body it marks rather than covering it (G3
 * Task 4's captures: a ring the marker's size covered the 25 m dummy its first frames). Under it
 * "HEADSHOT" in gold or "KILL" in red, a match's kill with the
 * victim's name in their team's colour (`.hit-pop`): the room's word naming the victim of a round
 * whose word still shows (a match's headshot, popped as it struck) adds the name to it and goes on
 * with it, so it pops once. Over the whole view, being hit, a red flash at its strength fading out
 * (`#hurt-flash`).
 *
 * Each is a Web Animation on scale and opacity, held and set each frame to the frame's own clock
 * (tick), so a page frozen and stepped shows each frame what its time says.
 */

import type { Tunables } from '../core/tunables';
import type { Team } from '../net/protocol';

export type MarkerKind = 'hit' | 'head' | 'kill';
export type PopText = 'HEADSHOT' | 'KILL';

/**
 * [hits]: each kind's marker held (s), its pop in and its fade; the words' time and pop; the flash's
 * fade; and a kill's ring, from and to (times the ticks' reach) and how it eases out: its scale
 * from + (to − from)(1 − (1 − u)^ease) at u of the kill's hold.
 */
export interface MarkerTunables {
  holdS: Record<MarkerKind, number>;
  popS: number;
  popScale: number;
  fadeS: number;
  textS: number;
  textScale: number;
  flashS: number;
  ring: { from: number; to: number; ease: number };
}

export function markerTunables(tun: Tunables): MarkerTunables {
  const f = (k: string) => tun.f(`hits.${k}`);
  return {
    holdS: { hit: f('marker_hit_s'), head: f('marker_head_s'), kill: f('marker_kill_s') },
    popS: f('marker_pop_s'),
    popScale: f('marker_pop_scale'),
    fadeS: f('marker_fade_s'),
    textS: f('pop_s'),
    textScale: f('pop_scale'),
    flashS: f('hurt_flash_s'),
    ring: { from: f('kill_ring_from'), to: f('kill_ring_to'), ease: f('kill_ring_ease') },
  };
}

/** A kill's ring's keyframes over its hold: this many steps, each linear between (50 ms at a 600 ms hold). */
const RING_STEPS = 12;

/** Which marker shows over which. */
const RANK: Record<MarkerKind, number> = { hit: 0, head: 1, kill: 2 };

/** The words under the marker: HEADSHOT or KILL, and the victim's name (none: the round's own, or the range's). */
interface Popped {
  word: PopText;
  name: string | null;
}

/** Something shown: what, from when to when (ms, the frame's clock), and its animation. */
interface Showing<T> {
  what: T;
  at: number;
  until: number;
  animation: Animation | null;
}

const ms = (s: number) => Math.round(s * 1000);

export class HitMarker {
  private readonly markerEl: HTMLElement | null;
  private readonly ringEl: HTMLElement | null;
  private readonly popEl: HTMLElement | null;
  private readonly wordEl: HTMLElement | null;
  private readonly nameEl: HTMLElement | null;
  private readonly flashEl: HTMLElement | null;
  private marker: Showing<MarkerKind> | null = null;
  private ring: Showing<null> | null = null;
  private popped: Showing<Popped> | null = null;
  private flashed: Showing<number> | null = null;

  constructor(
    doc: Document,
    private readonly t: MarkerTunables,
  ) {
    this.markerEl = doc.querySelector<HTMLElement>('#hud .marker');
    this.ringEl = doc.querySelector<HTMLElement>('#hud .kill-ring');
    this.popEl = doc.querySelector<HTMLElement>('#hud .hit-pop');
    this.wordEl = doc.querySelector<HTMLElement>('#hud .hit-pop .word');
    this.nameEl = doc.querySelector<HTMLElement>('#hud .hit-pop .name');
    this.flashEl = doc.querySelector<HTMLElement>('#hurt-flash');
  }

  /** The marker of `kind` at `now` (ms): unless a greater one still shows, from its start. Whether it shows. */
  show(kind: MarkerKind, now: number): boolean {
    const was = this.marker;
    if (was && now < was.until && RANK[kind] < RANK[was.what]) return false;
    const held = ms(this.t.holdS[kind]);
    const total = held + ms(this.t.fadeS);
    const el = this.markerEl;
    if (el) {
      el.className = `marker ${kind}`;
      el.hidden = false;
    }
    this.marker = this.start(was, el, kind, now, total, this.popIn(this.t.popScale, total, held));
    if (kind === 'kill') {
      if (this.ringEl) {
        this.ringEl.className = 'kill-ring';
        this.ringEl.hidden = false;
      }
      this.ring = this.start(this.ring, this.ringEl, null, now, held, this.expanding());
    }
    return true;
  }

  /**
   * "HEADSHOT" or "KILL" under the crosshair at `now` (ms), a match's victim named after it in their
   * team's colour. The same word still showing unnamed (the round's, as it struck) takes the name and
   * goes on as it was, its pop and its time; anything else starts afresh.
   */
  pop(text: PopText, name: { name: string; team: Team } | null, now: number): void {
    const was = this.popped;
    const naming = name !== null && was !== null && now < was.until && was.what.word === text && was.what.name === null;
    if (this.nameEl) {
      this.nameEl.textContent = name?.name ?? '';
      this.nameEl.className = name ? `name ${name.team}` : 'name';
    }
    if (naming) {
      was.what = { word: text, name: name.name };
      return;
    }
    const total = ms(this.t.textS);
    const el = this.popEl;
    if (el) {
      el.className = `hit-pop ${text === 'HEADSHOT' ? 'head' : 'kill'}`;
      el.hidden = false;
    }
    if (this.wordEl) this.wordEl.textContent = text;
    this.popped = this.start(was, el, { word: text, name: name?.name ?? null }, now, total, this.popIn(this.t.textScale, total, total - ms(this.t.fadeS)));
  }

  /**
   * Being hit, at `now` (ms): the red flash over the view at `strength` (0 to 1), fading out; or on
   * from what still shows of one fading, if that is more (an M870's blast split over two ticks, a
   * shell after a round: the red would drop from near full to a quarter in a frame).
   */
  flash(strength: number, now: number): void {
    const total = ms(this.t.flashS);
    const was = this.flashed;
    const shown = was && now < was.until ? was.what * (1 - (now - was.at) / (was.until - was.at)) : 0;
    const from = Math.max(strength, shown);
    if (this.flashEl) this.flashEl.hidden = false;
    this.flashed = this.start(was, this.flashEl, from, now, total, [{ opacity: from }, { opacity: 0 }]);
  }

  /** Every frame, at `now` (ms): each shown as its time since says, and gone once done. */
  tick(now: number): void {
    this.marker = this.step(this.marker, this.markerEl, now);
    this.ring = this.step(this.ring, this.ringEl, now);
    this.popped = this.step(this.popped, this.popEl, now);
    this.flashed = this.step(this.flashed, this.flashEl, now);
  }

  /** Everything gone at once. */
  clear(): void {
    this.marker = this.end(this.marker, this.markerEl);
    this.ring = this.end(this.ring, this.ringEl);
    this.popped = this.end(this.popped, this.popEl);
    this.flashed = this.end(this.flashed, this.flashEl);
  }

  /** The marker showing, and the words. */
  state(): { marker: MarkerKind | null; pop: string | null } {
    const p = this.popped?.what;
    return { marker: this.marker?.what ?? null, pop: p ? (p.name === null ? p.word : `${p.word} ${p.name}`) : null };
  }

  /** Popping in from `scale` over the pop, held until `held` (ms), and faded by `total`. */
  private popIn(scale: number, total: number, held: number): Keyframe[] {
    return [
      { transform: `scale(${scale})`, opacity: 1, offset: 0 },
      { transform: 'scale(1)', opacity: 1, offset: ms(this.t.popS) / total },
      { transform: 'scale(1)', opacity: 1, offset: held / total },
      { transform: 'scale(1)', opacity: 0, offset: 1 },
    ];
  }

  /** A kill's ring over its hold: from the ticks' tips as they pop out to kill_ring_to, easing out, fading as it goes. */
  private expanding(): Keyframe[] {
    const { from, to, ease } = this.t.ring;
    return Array.from({ length: RING_STEPS + 1 }, (_, i) => {
      const u = i / RING_STEPS;
      const scale = from + (to - from) * (1 - (1 - u) ** ease);
      return { transform: `scale(${Number(scale.toFixed(5))})`, opacity: 1 - u, offset: u };
    });
  }

  /** `what` shown on `el` from `now` for `total` ms by `keyframes`, in place of what `was`: its animation held at its start. */
  private start<T>(was: Showing<T> | null, el: HTMLElement | null, what: T, now: number, total: number, keyframes: Keyframe[]): Showing<T> {
    was?.animation?.cancel();
    const animation = el?.animate ? el.animate(keyframes, { duration: total, fill: 'both' }) : null;
    animation?.pause();
    if (animation) animation.currentTime = 0;
    return { what, at: now, until: now + total, animation };
  }

  private step<T>(s: Showing<T> | null, el: HTMLElement | null, now: number): Showing<T> | null {
    if (!s) return null;
    if (now >= s.until) return this.end(s, el);
    if (s.animation) s.animation.currentTime = Math.max(0, now - s.at);
    return s;
  }

  private end<T>(s: Showing<T> | null, el: HTMLElement | null): null {
    s?.animation?.cancel();
    if (el) el.hidden = true;
    return null;
  }
}
