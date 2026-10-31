/**
 * The match over the view (the multiplayer spec's §4), beside the HUD's own reckoning: the
 * player's health as a tally, the kill feed at the top right, a marker at the crosshair when a
 * round of theirs strikes (red when it kills), an arc toward whoever hurt them, a teammate's name
 * when they are aimed at, "Killed by" and the count back in while dead, the board on Tab, and who
 * won. Plain DOM in the HUD's type, each part shown only when it has something to say.
 */

import type { Team } from '../net/protocol';

export interface FeedEntry {
  killer: { name: string; team: Team } | null;
  victim: { name: string; team: Team };
  /** How: where the round struck, or what of the battle killed them. */
  how: string;
}

export interface BoardRow {
  name: string;
  team: Team;
  kills: number;
  deaths: number;
  you: boolean;
}

const FEED_KEEP_MS = 7000;
const FEED_MAX = 5;
const MARKER_MS = { hit: 160, kill: 420 } as const;
const HARM_MS = 900;

export class MatchHud {
  private readonly root: HTMLElement;
  private readonly healthEl: HTMLElement;
  private readonly feedEl: HTMLElement;
  private readonly markerEl: HTMLElement;
  private readonly harmEl: HTMLElement;
  private readonly aimedEl: HTMLElement;
  private readonly fallenEl: HTMLElement;
  private readonly wonEl: HTMLElement;
  private readonly boardEl: HTMLElement;
  private feedItems: { at: number; entry: FeedEntry }[] = [];
  private markerUntil = 0;
  private harmUntil = 0;
  private shownHealth = '';

  constructor(private readonly doc: Document) {
    this.root = doc.getElementById('hud')!;
    const part = (selector: string) => this.root.querySelector<HTMLElement>(selector)!;
    this.healthEl = part('.health');
    this.feedEl = part('.feed');
    this.markerEl = part('.marker');
    this.harmEl = part('.harm');
    this.aimedEl = part('.aimed');
    this.fallenEl = part('.fallen');
    this.wonEl = part('.won');
    this.boardEl = part('.board');
  }

  /** The player's health (0 to 100) as a tally of ten; null (solo play) hides it. */
  health(hp: number | null): void {
    this.healthEl.hidden = hp === null;
    if (hp === null) return;
    const filled = Math.max(0, Math.min(10, Math.ceil(hp / 10)));
    const key = String(filled);
    if (key === this.shownHealth) return;
    this.shownHealth = key;
    const label = this.doc.createElement('span');
    label.className = 'label';
    label.textContent = 'Health';
    const cells = this.doc.createElement('span');
    cells.className = 'bar';
    for (let i = 0; i < 10; i++) {
      const cell = this.doc.createElement('i');
      if (i < filled) cell.className = 'on';
      cells.append(cell);
    }
    this.healthEl.classList.toggle('low', filled <= 3);
    this.healthEl.replaceChildren(label, cells);
  }

  /** Someone died: the feed's newest line. */
  killed(entry: FeedEntry, now: number): void {
    this.feedItems.unshift({ at: now, entry });
    this.feedItems = this.feedItems.slice(0, FEED_MAX);
    this.drawFeed();
  }

  /** A round of the player's struck: the marker, red if it killed. */
  marker(kind: 'hit' | 'kill', now: number): void {
    this.markerUntil = now + MARKER_MS[kind];
    this.markerEl.classList.toggle('kill', kind === 'kill');
    this.markerEl.hidden = false;
  }

  /** The player was hurt from `bearing` degrees (clockwise from where they look); null, from no one in particular. */
  harm(bearing: number | null, now: number): void {
    this.harmUntil = now + HARM_MS;
    this.harmEl.hidden = bearing === null;
    if (bearing === null) return;
    this.harmEl.style.transform = `rotate(${bearing}deg)`;
    this.harmEl.classList.remove('fading');
    // The next frame starts the fade.
    requestAnimationFrame(() => this.harmEl.classList.add('fading'));
  }

  /** The teammate aimed at, in their colour; null, no one. */
  aimed(who: { name: string; team: Team } | null): void {
    this.aimedEl.hidden = who === null;
    if (!who) return;
    if (this.aimedEl.textContent !== who.name) this.aimedEl.textContent = who.name;
    this.aimedEl.className = `aimed ${who.team}`;
  }

  /** Dead: who killed them (null, the battle) and the seconds until they are back; null when alive. */
  fallen(by: { name: string; team: Team } | null | undefined, backIn: number | null): void {
    this.fallenEl.hidden = backIn === null;
    if (backIn === null) return;
    const byEl = this.fallenEl.querySelector<HTMLElement>('.by')!;
    const line = by ? `Killed by ${by.name}` : by === null ? 'Killed by the shelling' : 'Killed';
    if (byEl.textContent !== line) byEl.textContent = line;
    byEl.className = `by ${by?.team ?? ''}`;
    const back = backIn > 0 ? `Back in ${Math.ceil(backIn)}` : 'Back in…';
    const backEl = this.fallenEl.querySelector<HTMLElement>('.back')!;
    if (backEl.textContent !== back) backEl.textContent = back;
  }

  /** The match won: "RED WINS 30 – 21"; null hides it. */
  won(winner: Team | null, red = 0, blue = 0): void {
    this.wonEl.hidden = winner === null;
    if (!winner) return;
    this.wonEl.className = `won ${winner}`;
    this.wonEl.textContent = `${winner === 'red' ? 'RED' : 'BLUE'} WINS  ${red} – ${blue}`;
  }

  /** The board, while Tab is held: each team's players by kills, and the score. */
  board(open: boolean, rows: readonly BoardRow[], score: { red: number; blue: number }, target: number): void {
    this.boardEl.hidden = !open;
    if (!open) return;
    const title = this.doc.createElement('h3');
    title.append(this.span('red', `RED ${score.red}`), this.doc.createTextNode(`  ·  first to ${target}  ·  `), this.span('blue', `BLUE ${score.blue}`));
    const sides = this.doc.createElement('div');
    sides.className = 'sides';
    for (const team of ['red', 'blue'] as const) {
      const table = this.doc.createElement('table');
      const head = this.doc.createElement('tr');
      head.append(this.cell('th', team === 'red' ? 'Red' : 'Blue', team), this.cell('th', 'K', 'n'), this.cell('th', 'D', 'n'));
      table.append(head);
      for (const r of rows.filter((x) => x.team === team).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)) {
        const tr = this.doc.createElement('tr');
        tr.append(this.cell('td', r.name, r.you ? 'you' : ''), this.cell('td', String(r.kills), 'n'), this.cell('td', String(r.deaths), 'n'));
        table.append(tr);
      }
      sides.append(table);
    }
    this.boardEl.replaceChildren(title, sides);
  }

  /** Each frame: the marker, the arc and old feed lines go when their time is up. */
  tick(now: number): void {
    if (!this.markerEl.hidden && now >= this.markerUntil) this.markerEl.hidden = true;
    if (!this.harmEl.hidden && now >= this.harmUntil) this.harmEl.hidden = true;
    const kept = this.feedItems.filter((f) => now - f.at < FEED_KEEP_MS);
    if (kept.length !== this.feedItems.length) {
      this.feedItems = kept;
      this.drawFeed();
    }
  }

  /** Everything the match showed, gone (back to the lobby, or solo play). */
  clear(): void {
    this.feedItems = [];
    this.drawFeed();
    this.health(null);
    this.aimed(null);
    this.fallen(undefined, null);
    this.won(null);
    this.board(false, [], { red: 0, blue: 0 }, 0);
    this.markerEl.hidden = true;
    this.harmEl.hidden = true;
  }

  private drawFeed(): void {
    this.feedEl.replaceChildren(
      ...this.feedItems.map(({ entry }) => {
        const li = this.doc.createElement('li');
        if (entry.killer) li.append(this.span(entry.killer.team, entry.killer.name));
        li.append(this.span('how', entry.how), this.span(entry.victim.team, entry.victim.name));
        return li;
      }),
    );
  }

  private span(cls: string, text: string): HTMLElement {
    const s = this.doc.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  private cell(tag: 'th' | 'td', text: string, cls: string): HTMLElement {
    const c = this.doc.createElement(tag);
    c.textContent = text;
    if (cls) c.className = cls;
    return c;
  }
}
