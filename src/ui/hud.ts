/**
 * The HUD (the spec's §5; the reference's ui/hud.py): DOM over the canvas, in
 * the loading screen's and pause menu's type and colours. Bottom left, the
 * player's own reckoning: their stance, how exposed they stand, the rounds in
 * the magazine or a reload, and the digging when F is held; in the middle, the
 * reference's four ticks round a gap, which read against mud without hiding
 * the target. Its copy is a pure function of the state, as the F3 overlay's
 * is, so it can be tested without a page.
 *
 * With the loadout: the gun in the hands and how it fires, the kit's line
 * (tracers, the light), the ticks spread as wide as the cone, and, aimed, the
 * sight's own reticle: a red dot, a holographic ring, or the scope's circle
 * with the world dark round it. Over the top a compass; over teammates' heads
 * a mark, so a friend is not shot for a foe; and H's card of the keys.
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
  /** The gun in the hands (or the shovel), how it fires, and the kit's line. */
  weapon?: string;
  mode?: string;
  kit?: string;
}

/** What is over the middle of the view: the ticks from the hip, a sight's reticle aimed, or none (iron sights, the shovel). */
export type Reticle = 'cross' | 'dot' | 'holo' | 'scope' | 'none';

/** A teammate's mark: where on the page (CSS pixels), their name and team, how far (m). */
export interface HudTag {
  x: number;
  y: number;
  name: string;
  team: 'red' | 'blue';
  distanceM: number;
}

/** Compass points every 45°, clockwise from the map's north (+z). */
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** The compass's pixels a degree. */
const COMPASS_PX = 3;

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
  private readonly roomEl: HTMLElement | null;
  private readonly weaponEl: HTMLElement | null;
  private readonly kitEl: HTMLElement | null;
  private readonly reticleEl: HTMLElement | null;
  private readonly scopeEl: HTMLElement | null;
  private readonly stripEl: HTMLElement | null;
  private readonly tagsEl: HTMLElement | null;
  private readonly helpEl: HTMLElement | null;
  private last = '';
  private lastKit = '';
  private lastSight = '';
  private lastBearing = Number.NaN;

  constructor(doc: Document) {
    this.root = doc.getElementById('hud')!;
    const part = (selector: string) => this.root.querySelector<HTMLElement>(selector)!;
    const maybe = (selector: string) => this.root.querySelector<HTMLElement>(selector);
    this.crosshairEl = part('.crosshair');
    this.stanceEl = part('.stance');
    this.exposureEl = part('.exposure');
    this.rifleEl = part('.rifle');
    this.digEl = part('.dig');
    this.roomEl = maybe('.roomline');
    this.weaponEl = maybe('.weapon');
    this.kitEl = maybe('.kit');
    this.reticleEl = maybe('.reticle');
    this.scopeEl = doc.getElementById('scope');
    this.stripEl = maybe('.compass .strip');
    this.tagsEl = maybe('.tags');
    this.helpEl = maybe('.help');
    // The compass's strip: a tick every 15°, a point every 45°, from a turn before north to a turn after.
    if (this.stripEl) {
      for (let deg = -360; deg <= 720; deg += 15) {
        const mark = doc.createElement('span');
        const point = ((deg % 360) + 360) % 360;
        mark.className = point % 45 === 0 ? 'point' : 'tick';
        mark.style.left = `${(deg + 360) * COMPASS_PX}px`;
        if (point % 45 === 0) mark.textContent = POINTS[point / 45];
        this.stripEl.append(mark);
      }
    }
  }

  /** In a game with friends: its code and how many a side, over the middle of the view; null hides it. */
  room(line: { room: string; red: number; blue: number } | null): void {
    const el = this.roomEl;
    if (!el) return;
    el.hidden = line === null;
    if (!line) return;
    const key = `${line.room}:${line.red}:${line.blue}`;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    const doc = el.ownerDocument;
    const side = (cls: string, text: string) => {
      const span = doc.createElement('span');
      span.className = cls;
      span.textContent = text;
      return span;
    };
    el.replaceChildren(side('red', `RED ${line.red}`), doc.createTextNode(` · Game ${line.room} · `), side('blue', `BLUE ${line.blue}`));
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
    const kit = JSON.stringify([s.weapon, s.mode, s.kit]);
    if (kit !== this.lastKit) {
      this.lastKit = kit;
      if (this.weaponEl) {
        this.weaponEl.textContent = [s.weapon, s.mode].filter(Boolean).join(' · ');
        this.weaponEl.hidden = !s.weapon;
      }
      if (this.kitEl) {
        this.kitEl.textContent = s.kit ?? '';
        this.kitEl.hidden = !s.kit;
      }
    }
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

  /**
   * Every frame: the sight. From the hip the ticks stand `gapVh` from the middle (the cone's
   * width); aimed past halfway, the sight's reticle instead, the scope's once it is all but up.
   */
  sight(reticle: Reticle, aimed: number, gapVh: number): void {
    const key = `${reticle}:${aimed >= 0.5 ? 1 : 0}:${aimed >= 0.85 ? 1 : 0}:${gapVh.toFixed(2)}`;
    if (key === this.lastSight) return;
    this.lastSight = key;
    this.crosshairEl.style.setProperty('--gap', `${gapVh.toFixed(2)}vh`);
    if (aimed >= 0.5) this.crosshairEl.hidden = true;
    if (this.reticleEl) {
      this.reticleEl.hidden = !(aimed >= 0.5 && (reticle === 'dot' || reticle === 'holo'));
      this.reticleEl.className = `reticle ${reticle}`;
    }
    if (this.scopeEl) this.scopeEl.hidden = !(reticle === 'scope' && aimed >= 0.85);
  }

  /** The compass, turned to `yaw` (degrees clockwise from north, +z). */
  compass(yaw: number): void {
    if (!this.stripEl) return;
    const bearing = Math.round((((yaw % 360) + 360) % 360) * 4) / 4;
    if (bearing === this.lastBearing) return;
    this.lastBearing = bearing;
    // The strip's 0° is a turn in; the window's middle is under the needle.
    this.stripEl.style.transform = `translateX(${-(bearing + 360) * COMPASS_PX}px)`;
  }

  /** Teammates' marks, where they stand on the page. */
  tags(list: readonly HudTag[]): void {
    const el = this.tagsEl;
    if (!el) return;
    const doc = el.ownerDocument;
    while (el.children.length < list.length) {
      const tag = doc.createElement('div');
      tag.className = 'tag';
      tag.append(doc.createElement('i'), doc.createElement('span'));
      el.append(tag);
    }
    [...el.children].forEach((node, i) => {
      const tag = node as HTMLElement;
      const t = list[i];
      tag.hidden = !t;
      if (!t) return;
      tag.className = `tag ${t.team}`;
      tag.style.transform = `translate(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px)`;
      const label = tag.querySelector('span')!;
      const text = t.distanceM < 40 ? t.name : `${t.name} ${Math.round(t.distanceM)} m`;
      if (label.textContent !== text) label.textContent = text;
    });
  }

  /** H's card of the keys: shown or not; whether it now is. */
  toggleHelp(open?: boolean): boolean {
    if (!this.helpEl) return false;
    this.helpEl.hidden = open === undefined ? !this.helpEl.hidden : !open;
    return !this.helpEl.hidden;
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
