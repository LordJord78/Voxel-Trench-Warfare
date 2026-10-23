/**
 * The HUD (the spec's §5; the reference's ui/hud.py): DOM over the canvas, in
 * the loading screen's and pause menu's type and colours. Bottom left, the
 * player's own reckoning: their stance, how exposed they stand, the rounds in
 * the magazine or a reload, and the digging when F is held; in the middle, the
 * reference's four ticks round a gap, which read against mud without hiding
 * the target. Its copy is a pure function of the state, as the F3 overlay's
 * is, so it can be tested without a page.
 */

import { Stance } from '../physics/character';

export interface HudState {
  stance: Stance;
  /** How exposed the player stands: the stance's, more while digging. */
  exposure: number;
  rounds: number;
  magazine: number;
  reloading: boolean;
  digging: boolean;
  /** How far through the next scoop, 0 to 1. */
  digFraction: number;
  /** Whether anything loose is in reach. */
  digInReach: boolean;
  /** The crosshair: not through the periscope. */
  crosshair: boolean;
}

/** A label with a bar of `of` cells, `filled` of them filled (none when `of` is 0). */
export interface HudBar {
  label: string;
  filled: number;
  of: number;
}

export interface HudLines {
  stance: string;
  exposure: HudBar;
  rifle: string;
  /** While digging: its bar, or that there is nothing to clear. */
  dig: HudBar | null;
}

const STANCES: Record<Stance, string> = {
  [Stance.STANDING]: 'Standing',
  [Stance.CROUCHED]: 'Crouched',
  [Stance.PRONE]: 'Prone',
  [Stance.FIRING_STEP]: 'On the firing step',
  [Stance.PERISCOPE]: 'Periscope up',
};

/** Cells in the exposure bar, each a tenth; and in the digging bar. */
const EXPOSURE_CELLS = 14;
const DIG_CELLS = 8;

export function hudLines(s: HudState): HudLines {
  return {
    stance: STANCES[s.stance],
    exposure: { label: 'Exposure', filled: Math.max(0, Math.min(EXPOSURE_CELLS, Math.round(s.exposure * 10))), of: EXPOSURE_CELLS },
    rifle: s.reloading ? 'Reloading' : `${s.rounds} / ${s.magazine}`,
    dig: !s.digging
      ? null
      : s.digInReach
        ? { label: 'Digging', filled: Math.max(0, Math.min(DIG_CELLS, Math.floor(s.digFraction * DIG_CELLS))), of: DIG_CELLS }
        : { label: 'Nothing to clear', filled: 0, of: 0 },
  };
}

/** The HUD's element (`#hud` in index.html), drawn from `hudLines`. */
export class Hud {
  private readonly root: HTMLElement;
  private readonly crosshairEl: HTMLElement;
  private readonly stanceEl: HTMLElement;
  private readonly exposureEl: HTMLElement;
  private readonly rifleEl: HTMLElement;
  private readonly digEl: HTMLElement;
  private last = '';

  constructor(doc: Document) {
    this.root = doc.getElementById('hud')!;
    const part = (selector: string) => this.root.querySelector<HTMLElement>(selector)!;
    this.crosshairEl = part('.crosshair');
    this.stanceEl = part('.stance');
    this.exposureEl = part('.exposure');
    this.rifleEl = part('.rifle');
    this.digEl = part('.dig');
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  set visible(on: boolean) {
    this.root.hidden = !on;
  }

  get crosshair(): boolean {
    return !this.crosshairEl.hidden;
  }

  /** The words shown, for tests. */
  get text(): string {
    return [this.stanceEl, this.exposureEl, this.rifleEl, this.digEl].filter((e) => !e.hidden).map((e) => e.textContent ?? '').join('\n');
  }

  update(s: HudState): void {
    this.crosshairEl.hidden = !s.crosshair;
    const lines = hudLines(s);
    const key = JSON.stringify(lines);
    if (key === this.last) return;
    this.last = key;
    this.stanceEl.textContent = lines.stance;
    this.drawBar(this.exposureEl, lines.exposure);
    this.rifleEl.textContent = lines.rifle;
    this.digEl.hidden = lines.dig === null;
    if (lines.dig) this.drawBar(this.digEl, lines.dig);
  }

  private drawBar(el: HTMLElement, bar: HudBar): void {
    const doc = el.ownerDocument;
    const label = doc.createElement('span');
    label.className = 'label';
    label.textContent = bar.label;
    const cells = doc.createElement('span');
    cells.className = 'bar';
    cells.hidden = bar.of === 0;
    for (let i = 0; i < bar.of; i++) {
      const cell = doc.createElement('i');
      if (i < bar.filled) cell.className = 'on';
      cells.append(cell);
    }
    el.replaceChildren(label, cells);
  }
}
