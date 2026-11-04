import { describe, expect, it } from 'vitest';
import { Lobby, type LobbyHandlers } from '../../src/ui/lobby';

/** An element as the lobby uses it: shown or hidden, its words, its classes, and the focus. */
class FakeElement {
  hidden = false;
  textContent = '';
  value = '';
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
