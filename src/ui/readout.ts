/**
 * The range's readout (the shots spec's §5): under the hit marker, what the player's last hit on the
 * range did, for [range] readout_s. A hit says its zone, its damage and how far the round flew
 * (`TORSO 58 · 47 m`); a plate, how far (`PLATE · 55 m`); a kill, the shots it took and how far
 * (`DOWN IN 3 · 47 m`), under its pull's own line (`HEAD 190 · 25 m`), so a kill says its zone and
 * damage too. A hit is a pull of the trigger's (app/range.ts after): a shotgun's pellets into one
 * dummy are one line, their damage summed (`LIMB 52 · 25 m`). Zones in capitals, distances to the
 * metre. Its copy is a pure function of the event, as the HUD's is, so it can be tested without a page.
 */

import type { RangeEvent } from '../combat/range';

/** What the readout says of `e`: its own line. */
export function readoutText(e: RangeEvent): string {
  const far = `${Math.round(e.distanceM)} m`;
  if (e.kind === 'plate') return `PLATE · ${far}`;
  if (e.kind === 'kill') return `DOWN IN ${e.shots} · ${far}`;
  return `${e.zone.toUpperCase()} ${e.damage} · ${far}`;
}

/** The lines the readout shows for `e`: a kill's pull (its zone, damage and distance) over the kill's own line; anything else, its own. */
export function readoutLines(e: RangeEvent): string[] {
  if (e.kind !== 'kill') return [readoutText(e)];
  return [readoutText({ kind: 'hit', id: e.id, zone: e.zone, damage: e.damage, distanceM: e.distanceM }), readoutText(e)];
}

/** The part of the readout's element (`#hud .readout` in index.html) it writes; `hidden` as the DOM types it. */
export interface ReadoutElement {
  textContent: string | null;
  hidden: boolean | string;
}

/** The readout: an event shown for `holdS` seconds, then hidden. */
export class Readout {
  private shown: string | null = null;
  private until = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly el: ReadoutElement | null,
    private readonly holdS: number,
  ) {}

  /** The words shown, a line to an event's line (readoutLines), or null when nothing is. */
  get text(): string | null {
    return this.shown;
  }

  /** A frame's events at `nowS` (seconds): its kill shown if it has one, else its last; none, nothing changes. */
  show(events: readonly RangeEvent[], nowS: number): void {
    let e = events.at(-1);
    for (const x of events) if (x.kind === 'kill') e = x;
    if (!e) return;
    this.shown = readoutLines(e).join('\n');
    this.until = nowS + this.holdS;
    if (this.el) {
      this.el.textContent = this.shown;
      this.el.hidden = false;
    }
  }

  /** Every frame: hidden once its time is up. */
  tick(nowS: number): void {
    if (this.shown !== null && nowS >= this.until) this.clear();
  }

  /** Hidden at once (the range taken down). */
  clear(): void {
    this.shown = null;
    this.until = Number.NEGATIVE_INFINITY;
    if (this.el) this.el.hidden = true;
  }
}
