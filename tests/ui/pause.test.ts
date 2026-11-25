import { describe, expect, it } from 'vitest';
import { PauseMenu, type PauseHandlers } from '../../src/ui/pause';

// Solo's pause has a way back (the G6 self-playtest's P3): a room's pause has "Leave the game", and
// solo's "Back to the start screen", so a player who wants to host or join need not reload the page
// by hand. Each is offered where it belongs, never both.

/** An element as the pause menu uses it: shown or hidden, its classes, and its click. */
class FakeElement {
  hidden = false;
  value = '';
  private readonly listeners = new Map<string, (() => void)[]>();
  private readonly classes = new Set<string>();
  readonly classList = {
    toggle: (c: string, on: boolean) => void (on ? this.classes.add(c) : this.classes.delete(c)),
    contains: (c: string) => this.classes.has(c),
  };

  constructor(readonly ownerDocument: FakePage) {}

  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
}

/** The page as the pause menu uses it: its elements by id, each made as first asked for. */
class FakePage {
  private readonly byId = new Map<string, FakeElement>();
  getElementById(id: string): FakeElement {
    let e = this.byId.get(id);
    if (!e) this.byId.set(id, (e = new FakeElement(this)));
    return e;
  }
}

describe("the pause menu's way out", () => {
  function menu() {
    const page = new FakePage();
    const called: string[] = [];
    const handlers: PauseHandlers = {
      resume: () => void called.push('resume'),
      change() {},
      time() {},
      lapse() {},
      leave: () => void called.push('leave'),
      endMatch: () => void called.push('end'),
      toStart: () => void called.push('start screen'),
    };
    const pause = new PauseMenu(page as unknown as Document, handlers);
    return { page, called, pause };
  }

  it('offers solo "Back to the start screen", and a room "Leave the game" in its place', () => {
    const { page, pause } = menu();
    const [solo, room, end] = [page.getElementById('pause-solo'), page.getElementById('pause-match'), page.getElementById('end-match')];
    pause.together(false, false);
    expect([solo.hidden, room.hidden, end.hidden]).toEqual([false, true, true]);
    pause.together(true, false);
    expect([solo.hidden, room.hidden, end.hidden]).toEqual([true, false, true]);
    pause.together(true, true);
    expect([solo.hidden, room.hidden, end.hidden]).toEqual([true, false, false]);
    pause.together(false, true);
    expect([solo.hidden, room.hidden, end.hidden]).toEqual([false, true, true]);
  });

  it('goes back to the start screen from solo, as a room’s Leave goes', () => {
    const { page, called } = menu();
    page.getElementById('to-start').click();
    expect(called).toEqual(['start screen']);
    page.getElementById('leave-match').click();
    expect(called).toEqual(['start screen', 'leave']);
  });
});
