/**
 * The lobby (the multiplayer spec's §2): the game's code and the link to send friends, the
 * player's name, the two teams and who is ready, and the owner's settings and Start. Everyone
 * sees the settings; only the owner can change them. When the match starts the sheet becomes its
 * way in: the countdown, then Go, the click that lets the game take the mouse.
 */

import type { RoomConfig, Seat, Team } from '../net/protocol';

export interface LobbyHandlers {
  name(name: string): void;
  team(team: Team): void;
  ready(ready: boolean): void;
  configure(config: Partial<RoomConfig>): void;
  start(): void;
  leave(): void;
  go(): void;
}

export interface LobbyView {
  room: string;
  invite: string;
  you: number;
  owner: number;
  seats: readonly Seat[];
  config: RoomConfig;
}

export class Lobby {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly invite: HTMLInputElement;
  private readonly name: HTMLInputElement;
  private readonly lists: Record<Team, HTMLElement>;
  private readonly settings: HTMLFormElement;
  private readonly statusLine: HTMLElement;
  private readonly readyButton: HTMLButtonElement;
  private readonly startButton: HTMLButtonElement;
  private readonly deployLine: HTMLElement;
  private readonly goButton: HTMLButtonElement;
  private ready = false;
  private shownName = '';

  constructor(
    private readonly doc: Document,
    handlers: LobbyHandlers,
  ) {
    const el = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T;
    this.root = el('lobby');
    this.title = el('lobby-title');
    this.invite = el<HTMLInputElement>('invite');
    this.name = el<HTMLInputElement>('name');
    this.lists = { red: el('red-list'), blue: el('blue-list') };
    this.settings = el<HTMLFormElement>('match-settings');
    this.statusLine = el('lobby-status');
    this.readyButton = el<HTMLButtonElement>('ready');
    this.startButton = el<HTMLButtonElement>('start');
    this.deployLine = el('deploy-line');
    this.goButton = el<HTMLButtonElement>('go');

    el<HTMLButtonElement>('copy').addEventListener('click', () => {
      this.invite.select();
      void navigator.clipboard?.writeText(this.invite.value).then(
        () => this.status('The link is copied: paste it to your friends.'),
        () => this.status('Select the link and copy it to your friends.'),
      );
    });
    this.name.addEventListener('change', () => handlers.name(this.name.value));
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('button[data-team]')) b.addEventListener('click', () => handlers.team(b.dataset.team as Team));
    this.readyButton.addEventListener('click', () => handlers.ready(!this.ready));
    this.startButton.addEventListener('click', () => handlers.start());
    el<HTMLButtonElement>('leave').addEventListener('click', () => handlers.leave());
    this.goButton.addEventListener('click', () => handlers.go());
    this.settings.addEventListener('submit', (e) => e.preventDefault());
    this.settings.addEventListener('change', () => {
      const f = new FormData(this.settings);
      handlers.configure({
        map: String(f.get('map')),
        killTarget: Number(f.get('killTarget')),
        timeOfDay: Number(f.get('timeOfDay')),
        intensity: String(f.get('intensity')) as RoomConfig['intensity'],
      });
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** The lobby as the room last told it. */
  show(view: LobbyView): void {
    this.root.hidden = false;
    this.title.textContent = `Game ${view.room}`;
    this.invite.value = view.invite;
    const you = view.seats.find((s) => s.id === view.you);
    // The name field is the player's own: not overwritten while they type in it.
    if (you && this.doc.activeElement !== this.name && you.name !== this.shownName) {
      this.name.value = you.name;
      this.shownName = you.name;
    }
    for (const team of ['red', 'blue'] as const) {
      const list = this.lists[team];
      list.replaceChildren(
        ...view.seats
          .filter((s) => s.team === team)
          .map((s) => {
            const li = this.doc.createElement('li');
            if (s.id === view.you) li.className = 'you';
            const who = this.doc.createElement('span');
            who.textContent = s.name;
            const tags = this.doc.createElement('span');
            tags.className = 'tags';
            tags.textContent = [s.id === view.owner ? 'host' : '', s.ready ? 'ready' : ''].filter(Boolean).join(', ');
            li.append(who, tags);
            return li;
          }),
      );
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('button[data-team]')) b.disabled = you?.team === b.dataset.team;
    this.ready = you?.ready ?? false;
    this.readyButton.textContent = this.ready ? 'Not ready' : 'Ready';
    const owner = view.you === view.owner;
    // The owner is ready when they start: their Start is their Ready.
    this.startButton.hidden = !owner;
    this.readyButton.hidden = owner;
    for (const field of this.settings.elements) (field as HTMLInputElement).disabled = !owner;
    const set = (name: string, value: string) => {
      const field = this.settings.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
      if (field && this.doc.activeElement !== field) field.value = value;
    };
    set('map', view.config.map);
    set('killTarget', String(view.config.killTarget));
    set('timeOfDay', String(view.config.timeOfDay));
    set('intensity', view.config.intensity);
    const waiting = view.seats.filter((s) => !s.ready && s.id !== view.owner).length;
    if (!this.root.classList.contains('deploying')) {
      this.status(owner ? (view.seats.length < 2 ? 'Send the link to your friends: they join here.' : waiting > 0 ? `${waiting} not ready yet. Start whenever you like.` : 'Everyone is ready.') : 'Waiting for the host to start the match.');
    }
  }

  status(text: string): void {
    this.statusLine.textContent = text;
  }

  /** The match is starting or on: the way in, `line` saying how it stands. */
  deploy(line: string, canGo: boolean): void {
    this.root.hidden = false;
    this.root.classList.add('deploying');
    this.deployLine.textContent = line;
    this.goButton.hidden = !canGo;
    if (canGo && this.doc.activeElement !== this.goButton) this.goButton.focus();
  }

  /** Back to gathering, after a match. */
  gather(): void {
    this.root.classList.remove('deploying');
  }

  hide(): void {
    this.root.hidden = true;
  }
}
