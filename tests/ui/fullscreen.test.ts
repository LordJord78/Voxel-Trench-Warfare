import { describe, expect, it } from 'vitest';
import { Fullscreen, fullscreenButtons, type KeyboardLock } from '../../src/ui/fullscreen';

type Listener = () => void;

/**
 * A page as the browser keeps it for fullscreen. A request (the root's) or an exit changes the
 * fullscreen element and settles at once; its change event fires at the browser's next frame
 * (`frame`), as the spec runs them. `legacy`: older Safari, with only the webkit-prefixed API, whose
 * calls return nothing and change the page at the next frame. `refuse`: the browser says no (no
 * click to allow it, a page not allowed it).
 */
class FakePage {
  /** The elements each request was made on. */
  readonly requests: unknown[] = [];
  exits = 0;
  readonly documentElement: { requestFullscreen?: () => Promise<void>; webkitRequestFullscreen?: () => void };
  fullscreenElement?: object | null;
  webkitFullscreenElement?: object | null;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void;
  private readonly listeners = new Map<string, Listener[]>();
  private pending: Listener[] = [];

  constructor(options: { legacy?: boolean; refuse?: boolean } = {}) {
    const page = this;
    if (options.legacy) {
      this.webkitFullscreenElement = null;
      this.documentElement = {
        webkitRequestFullscreen() {
          page.requests.push(this);
          page.later(() => {
            if (options.refuse) return page.dispatch('webkitfullscreenerror');
            page.webkitFullscreenElement = page.documentElement;
            page.dispatch('webkitfullscreenchange');
          });
        },
      };
      this.webkitExitFullscreen = () => {
        page.exits++;
        page.later(() => {
          page.webkitFullscreenElement = null;
          page.dispatch('webkitfullscreenchange');
        });
      };
    } else {
      this.fullscreenElement = null;
      this.documentElement = {
        requestFullscreen() {
          page.requests.push(this);
          if (options.refuse) {
            page.later(() => page.dispatch('fullscreenerror'));
            return Promise.reject(new TypeError('Permissions check failed'));
          }
          page.fullscreenElement = page.documentElement;
          page.later(() => page.dispatch('fullscreenchange'));
          return Promise.resolve();
        },
      };
      this.exitFullscreen = () => {
        page.exits++;
        // As browsers do: an exit with nothing fullscreen is refused.
        if (!page.fullscreenElement) return Promise.reject(new TypeError('Document not active'));
        page.fullscreenElement = null;
        page.later(() => page.dispatch('fullscreenchange'));
        return Promise.resolve();
      };
    }
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** The browser's next frame: what it had pending happens. */
  frame(): void {
    const now = this.pending;
    this.pending = [];
    for (const f of now) f();
  }

  /** The user leaves fullscreen the browser's own way (Esc held down, F11). */
  userLeaves(): void {
    const legacy = this.fullscreenElement === undefined;
    if (legacy) this.webkitFullscreenElement = null;
    else this.fullscreenElement = null;
    this.later(() => this.dispatch(legacy ? 'webkitfullscreenchange' : 'fullscreenchange'));
  }

  dispatch(type: string): void {
    for (const l of this.listeners.get(type) ?? []) l();
  }

  private later(f: Listener): void {
    this.pending.push(f);
  }
}

/** A keyboard that can be locked (Chrome's and Edge's): the keys each lock asked for, and the unlocks. */
function lockingKeyboard() {
  const keyboard = {
    locks: [] as string[][],
    unlocks: 0,
    lock(keys?: string[]) {
      keyboard.locks.push(keys ?? []);
      return Promise.resolve();
    },
    unlock() {
      keyboard.unlocks++;
    },
  };
  return keyboard;
}

/** Until the promises a click or a call set going have settled. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('fullscreen', () => {
  it('takes the whole page fullscreen (not the canvas, so the HUD and menus stay), and says so when the browser does', async () => {
    const page = new FakePage();
    const fs = new Fullscreen(page);
    const told: boolean[] = [];
    fs.onChange((on) => told.push(on));
    expect(fs.active).toBe(false);
    expect(await fs.enter()).toBe(true);
    expect(page.requests).toEqual([page.documentElement]);
    expect(fs.active).toBe(true);
    page.frame();
    expect(told).toEqual([true]);
    // Already fullscreen: nothing more is asked of the browser.
    expect(await fs.enter()).toBe(true);
    expect(page.requests).toHaveLength(1);
  });

  it('leaves fullscreen, and toggles in and out', async () => {
    const page = new FakePage();
    const fs = new Fullscreen(page);
    const told: boolean[] = [];
    fs.onChange((on) => told.push(on));
    await fs.enter();
    page.frame();
    await fs.exit();
    page.frame();
    expect(fs.active).toBe(false);
    expect(page.exits).toBe(1);
    expect(told).toEqual([true, false]);
    // Not fullscreen, an exit asks nothing of the browser (which would refuse it).
    await fs.exit();
    expect(page.exits).toBe(1);
    expect(await fs.toggle()).toBe(true);
    expect(fs.active).toBe(true);
    page.frame();
    expect(await fs.toggle()).toBe(true);
    expect(fs.active).toBe(false);
    page.frame();
    expect([page.requests.length, page.exits]).toEqual([2, 2]);
    expect(told).toEqual([true, false, true, false]);
  });

  it("falls back to older Safari's webkit-prefixed API where the unprefixed one is missing", async () => {
    const page = new FakePage({ legacy: true });
    const fs = new Fullscreen(page);
    const told: boolean[] = [];
    fs.onChange((on) => told.push(on));
    expect(fs.active).toBe(false);
    expect(await fs.enter()).toBe(true);
    expect(page.requests).toEqual([page.documentElement]);
    page.frame();
    expect(fs.active).toBe(true);
    expect(told).toEqual([true]);
    expect(await fs.toggle()).toBe(true);
    page.frame();
    expect(page.exits).toBe(1);
    expect(fs.active).toBe(false);
    expect(told).toEqual([true, false]);
  });

  it('holds Esc for the page while fullscreen where the keyboard can be locked, and lets it go however the page leaves', async () => {
    const page = new FakePage();
    const keyboard = lockingKeyboard();
    const fs = new Fullscreen(page, { keyboard });
    await fs.enter();
    page.frame();
    expect(keyboard.locks).toEqual([['Escape']]);
    expect(keyboard.unlocks).toBe(0);
    await fs.exit();
    page.frame();
    expect(keyboard.unlocks).toBe(1);
    // In again, and out the browser's own way (Esc held down, F11): let go all the same.
    await fs.enter();
    page.frame();
    page.userLeaves();
    page.frame();
    expect(keyboard.locks).toEqual([['Escape'], ['Escape']]);
    expect(keyboard.unlocks).toBe(2);
  });

  it('goes fullscreen all the same where the keyboard lock is refused, throws, or is missing (Safari, Firefox)', async () => {
    const keyboards: (KeyboardLock | undefined)[] = [
      { lock: () => Promise.reject(new DOMException('Keyboard lock is not allowed here', 'NotAllowedError')), unlock() {} },
      {
        lock: () => {
          throw new TypeError('not a top-level page');
        },
      },
      {},
      undefined,
    ];
    for (const keyboard of keyboards) {
      const page = new FakePage();
      const fs = new Fullscreen(page, { keyboard });
      expect(await fs.enter()).toBe(true);
      page.frame();
      expect(fs.active).toBe(true);
      await fs.exit();
      page.frame();
      expect(fs.active).toBe(false);
    }
    // And without the navigator at all. A refused lock left unhandled would fail the run here.
    expect(await new Fullscreen(new FakePage()).enter()).toBe(true);
    await settled();
  });

  it('says false, and never throws, where the browser refuses or there is no fullscreen', async () => {
    const page = new FakePage({ refuse: true });
    const keyboard = lockingKeyboard();
    const fs = new Fullscreen(page, { keyboard });
    const told: boolean[] = [];
    fs.onChange((on) => told.push(on));
    expect(await fs.enter()).toBe(false);
    expect(await fs.toggle()).toBe(false);
    page.frame();
    expect(fs.active).toBe(false);
    expect(told).toEqual([]);
    // No lock without fullscreen.
    expect(keyboard.locks).toEqual([]);
    // A request that throws at once, and a page without the API at all.
    const throwing = new FakePage();
    throwing.documentElement.requestFullscreen = () => {
      throw new TypeError('Illegal invocation');
    };
    expect(await new Fullscreen(throwing).enter()).toBe(false);
    const none = new FakePage();
    delete none.documentElement.requestFullscreen;
    expect(await new Fullscreen(none).enter()).toBe(false);
    expect(await new Fullscreen(none).toggle()).toBe(false);
    // An exit the browser refuses (the user left at the same moment) is no error either.
    const leaving = new FakePage();
    const out = new Fullscreen(leaving);
    await out.enter();
    leaving.exitFullscreen = () => Promise.reject(new TypeError('Document not active'));
    await expect(out.exit()).resolves.toBeUndefined();
  });

  it("takes older Safari's request as made, since it says nothing at once, and asks no lock while the page is not fullscreen", async () => {
    // Its refusal comes later, as a webkitfullscreenerror, and the page never goes fullscreen.
    const page = new FakePage({ legacy: true, refuse: true });
    const keyboard = lockingKeyboard();
    const fs = new Fullscreen(page, { keyboard });
    const told: boolean[] = [];
    fs.onChange((on) => told.push(on));
    expect(await fs.enter()).toBe(true);
    page.frame();
    expect(fs.active).toBe(false);
    expect(told).toEqual([]);
    expect(keyboard.locks).toEqual([]);
  });

  it('tells its listeners the page has left even where letting go of the keyboard throws', async () => {
    // A keyboard of the page's own that throws must not leave the buttons saying "Leave fullscreen".
    const page = new FakePage();
    const keyboard: KeyboardLock = {
      lock: () => Promise.resolve(),
      unlock() {
        throw new TypeError('not locked');
      },
    };
    const fs = new Fullscreen(page, { keyboard });
    const told: boolean[] = [];
    fs.onChange((on) => told.push(on));
    await fs.enter();
    page.frame();
    await fs.exit();
    page.frame();
    expect(fs.active).toBe(false);
    expect(told).toEqual([true, false]);
  });

  it('tells its listeners of each change once, on whichever event the browser fires', () => {
    const page = new FakePage();
    const fs = new Fullscreen(page);
    const told: boolean[] = [];
    fs.onChange((on) => told.push(on));
    page.fullscreenElement = page.documentElement;
    page.dispatch('fullscreenchange');
    // A browser that fires the prefixed event too, for the same change.
    page.dispatch('webkitfullscreenchange');
    expect(told).toEqual([true]);
    page.fullscreenElement = null;
    page.dispatch('webkitfullscreenchange');
    expect(told).toEqual([true, false]);
    // Older Safari: only the prefixed element and event.
    const legacy = new FakePage({ legacy: true });
    const old = new Fullscreen(legacy);
    const oldTold: boolean[] = [];
    old.onChange((on) => oldTold.push(on));
    legacy.webkitFullscreenElement = legacy.documentElement;
    legacy.dispatch('webkitfullscreenchange');
    expect(oldTold).toEqual([true]);
  });
});

describe('the fullscreen buttons', () => {
  /** A button as the page has it: its words, its click, and a press of the mouse on it. */
  const button = () => {
    type Handler = (e: { preventDefault(): void }) => void;
    const listeners: Record<'click' | 'mousedown', Handler[]> = { click: [], mousedown: [] };
    return {
      textContent: '' as string | null,
      addEventListener(type: 'click' | 'mousedown', listener: Handler) {
        listeners[type].push(listener);
      },
      click: () => listeners.click.forEach((l) => l({ preventDefault() {} })),
      /** The mouse pressed on the button: whether the page would move the focus to it, as Chrome and Edge do. */
      press(): boolean {
        let prevented = false;
        for (const l of listeners.mousedown) l({ preventDefault: () => (prevented = true) });
        return !prevented;
      },
    };
  };

  it('each says where a click takes the page, and its key, and stays right however the page goes in or out', async () => {
    const page = new FakePage();
    const fs = new Fullscreen(page);
    const buttons = [button(), button()];
    fullscreenButtons(buttons, fs, 'Alt+Enter', () => void fs.toggle());
    const words = () => buttons.map((b) => b.textContent);
    expect(words()).toEqual(['Fullscreen · Alt+Enter', 'Fullscreen · Alt+Enter']);
    buttons[1].click();
    await settled();
    page.frame();
    expect(fs.active).toBe(true);
    expect(words()).toEqual(['Leave fullscreen · Alt+Enter', 'Leave fullscreen · Alt+Enter']);
    // Out the browser's own way (Esc held down, F11): the buttons follow.
    page.userLeaves();
    page.frame();
    expect(words()).toEqual(['Fullscreen · Alt+Enter', 'Fullscreen · Alt+Enter']);
    // In and out by the other button.
    buttons[0].click();
    await settled();
    page.frame();
    buttons[0].click();
    await settled();
    page.frame();
    expect(fs.active).toBe(false);
    expect(words()).toEqual(['Fullscreen · Alt+Enter', 'Fullscreen · Alt+Enter']);
    expect(page.requests).toHaveLength(2);
  });

  it('leave the focus where it was when clicked (Play, Resume, Go), so Enter or Space still does what it did', async () => {
    const page = new FakePage();
    const fs = new Fullscreen(page);
    const b = button();
    fullscreenButtons([b], fs, 'Alt+Enter', () => void fs.toggle());
    expect(b.press()).toBe(false);
    // The click still takes the page fullscreen.
    b.click();
    await settled();
    page.frame();
    expect(fs.active).toBe(true);
  });

  it("name the key as the player's keyboard does, and start right on a page already fullscreen", async () => {
    const page = new FakePage();
    const fs = new Fullscreen(page);
    await fs.enter();
    page.frame();
    const b = button();
    fullscreenButtons([b], fs, 'Option+Return', () => void fs.toggle());
    expect(b.textContent).toBe('Leave fullscreen · Option+Return');
  });
});
