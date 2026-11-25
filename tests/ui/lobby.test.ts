import { describe, expect, it } from 'vitest';
import { CLOCK_KEYS } from '../../src/core/clock-keys';
import { defaultConfig, type Seat } from '../../src/net/protocol';
import { Lobby, type LobbyHandlers } from '../../src/ui/lobby';

/** An element as the lobby uses it: shown or hidden, its words, its classes, and the focus. */
class FakeElement {
  hidden = false;
  textContent = '';
  value = '';
  disabled = false;
  className = '';
  children: FakeElement[] = [];
  /** A form's fields by name (the settings' select for the time of day). */
  readonly fields = new Map<string, FakeElement>();
  private readonly classes = new Set<string>();
  readonly classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };

  constructor(
    private readonly page: FakePage,
    readonly id: string,
  ) {}

  addEventListener(): void {}

  get elements(): FakeElement[] & { namedItem(name: string): FakeElement | null } {
    return Object.assign([...this.fields.values()], { namedItem: (name: string) => this.fields.get(name) ?? null });
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  querySelectorAll(): FakeElement[] {
    return [];
  }

  focus(): void {
    this.page.activeElement = this;
  }
}

/** The page as the lobby uses it: its elements by id, each made as first asked for, and the one with the focus. */
class FakePage {
  activeElement: FakeElement | null = null;
  private readonly elements = new Map<string, FakeElement>();

  getElementById(id: string): FakeElement {
    let e = this.elements.get(id);
    if (!e) this.elements.set(id, (e = new FakeElement(this, id)));
    return e;
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
}

const handlers: LobbyHandlers = { name() {}, team() {}, ready() {}, configure() {}, start() {}, leave() {}, go() {} };

function lobbyOn(): { page: FakePage; lobby: Lobby; go: FakeElement } {
  const page = new FakePage();
  const lobby = new Lobby(page as unknown as Document, handlers);
  return { page, lobby, go: page.getElementById('go') };
}

describe("the lobby's way in", () => {
  it('gives Go the focus as it appears, so Enter or Space goes in; not again each frame, so the keys reach the other buttons', () => {
    const { page, lobby, go } = lobbyOn();
    lobby.deploy('You fight for Red. The match starts in 3…', false);
    expect(go.hidden).toBe(true);
    expect(page.activeElement).not.toBe(go);
    lobby.deploy('The match is on. You fight for Red.', true);
    expect(go.hidden).toBe(false);
    expect(page.activeElement).toBe(go);
    // Tabbed to fullscreen (or the loadout): the next frames leave it there.
    const fullscreen = page.getElementById('lobby-fullscreen');
    fullscreen.focus();
    lobby.deploy('The match is on. You fight for Red.', true);
    lobby.deploy('The match is on. You fight for Red.', true);
    expect(page.activeElement).toBe(fullscreen);
  });

  it('gives Go the focus once the loadout closes, if Go appeared while the loadout covered the way in', () => {
    const { page, lobby, go } = lobbyOn();
    const focus = go.focus.bind(go);
    // Under the open loadout the way in is visibility:hidden, and a focus there does nothing.
    go.focus = () => {};
    lobby.deploy('The match is on. You fight for Red.', true);
    lobby.deploy('The match is on. You fight for Red.', true);
    expect(page.activeElement).not.toBe(go);
    // The loadout closed: the next frame gives Go the focus.
    go.focus = focus;
    lobby.deploy('The match is on. You fight for Red.', true);
    expect(page.activeElement).toBe(go);
  });

  it('gives Go the focus at once to a player joining a match already on, and again at each match after', () => {
    const { page, lobby, go } = lobbyOn();
    lobby.deploy('The match is on. You fight for Blue.', true);
    expect(page.activeElement).toBe(go);
    // In, and the match ends: back to gathering, then the next match's way in.
    lobby.hide();
    page.activeElement = null;
    lobby.deploy('You fight for Blue. The match starts in 3…', false);
    lobby.deploy('The match is on. You fight for Blue.', true);
    expect(page.activeElement).toBe(go);
    page.getElementById('ready').focus();
    lobby.gather();
    lobby.deploy('The match is on. You fight for Blue.', true);
    expect(page.activeElement).toBe(go);
    // Go taken away (a countdown begun again) and offered once more: it has the focus again.
    page.getElementById('deploy-loadout').focus();
    lobby.deploy('You fight for Blue. The match starts in 3…', false);
    lobby.deploy('The match is on. You fight for Blue.', true);
    expect(page.activeElement).toBe(go);
  });
});

describe('the lobby while the page catches up on the battle', () => {
  it('offers neither Ready nor Start until the page can play, so the host sees who is not ready', () => {
    const { page, lobby } = lobbyOn();
    const [ready, start] = [page.getElementById('ready'), page.getElementById('start')];
    lobby.playable(false);
    expect([ready.disabled, start.disabled]).toEqual([true, true]);
    lobby.playable(true);
    expect([ready.disabled, start.disabled]).toEqual([false, false]);
  });
});

describe("the lobby's time of day", () => {
  /** A lobby whose settings hold the select for the time of day. */
  function withHours(): { lobby: Lobby; hours: FakeElement } {
    const page = new FakePage();
    const hours = page.createElement('select');
    page.getElementById('match-settings').fields.set('timeOfDay', hours);
    return { lobby: new Lobby(page as unknown as Document, handlers), hours };
  }
  const seats: Seat[] = [{ id: 0, name: 'Jord', team: 'red', ready: false, away: false }];
  const view = (timeOfDay: number) => ({ room: 'ABCDE', invite: 'http://x/?room=ABCDE', you: 0, owner: 0, seats, config: { ...defaultConfig(), timeOfDay } });

  it("offers the game clock's four named hours, each at its time (the G6 playtest's P1: the lobby's Dusk was 19:30)", () => {
    const { hours } = withHours();
    expect(hours.children.map((o) => [o.value, o.textContent])).toEqual([
      [String(CLOCK_KEYS.dawn), 'Dawn \u00b7 06:50'],
      [String(CLOCK_KEYS.noon), 'Noon \u00b7 12:00'],
      [String(CLOCK_KEYS.dusk), 'Dusk \u00b7 17:35'],
      [String(CLOCK_KEYS.night), 'Night \u00b7 21:00'],
    ]);
    // What a choice sends (lobby.ts reads the form's value as a number) is the key's hour exactly.
    for (const o of hours.children) expect(Object.values(CLOCK_KEYS)).toContain(Number(o.value));
  });

  it("shows the room's default as Dusk, and an hour of no key (an older page's room) as the key nearest it", () => {
    const { lobby, hours } = withHours();
    lobby.show(view(defaultConfig().timeOfDay));
    expect(hours.value).toBe(String(CLOCK_KEYS.dusk));
    for (const [hour, key] of [[19.5, CLOCK_KEYS.night], [5.5, CLOCK_KEYS.dawn], [22, CLOCK_KEYS.night], [12, CLOCK_KEYS.noon], [13.9, CLOCK_KEYS.noon]] as const) {
      lobby.show(view(hour));
      expect(hours.value, `${hour} h`).toBe(String(key));
    }
  });
});
