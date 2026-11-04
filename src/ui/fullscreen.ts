/**
 * Fullscreen, for the whole page: the HUD, the menus and the lobby are HTML over the canvas, so the
 * page goes fullscreen, not the canvas. Its buttons and Alt+Enter go in and out, and the browser's
 * own ways out (Esc, F11) are followed, so every button says the right thing. Where the keyboard can
 * be locked (Chrome and Edge), Esc is held for the page while it is fullscreen: a press pauses the
 * game as it does anywhere, and holding it down leaves (the browser's rule). Elsewhere (Safari,
 * Firefox) Esc is the browser's, as ever. Older Safari's webkit-prefixed API stands in for the
 * unprefixed one. Nothing here throws: a refusal (no click to allow it, a page not allowed it) is
 * false.
 */

/** The keyboard lock (the Keyboard API: Chrome's and Edge's): keys held for the page while it is fullscreen. */
export interface KeyboardLock {
  lock?(keyCodes?: string[]): Promise<void>;
  unlock?(): void;
}

declare global {
  interface Navigator {
    /** Where there is one (Chromium's); TypeScript's DOM types have none. */
    readonly keyboard?: KeyboardLock;
  }
}

/** What fullscreen asks of the page's root element: the request, unprefixed or older Safari's. */
export interface FullscreenRoot {
  requestFullscreen?(): Promise<void>;
  /** Older Safari's: no promise, and no word of a refusal. */
  webkitRequestFullscreen?(): void;
}

/** What fullscreen asks of the document: the element fullscreen, the way out, and word of a change. */
export interface FullscreenDocument {
  readonly documentElement: FullscreenRoot;
  readonly fullscreenElement?: object | null;
  readonly webkitFullscreenElement?: object | null;
  exitFullscreen?(): Promise<void>;
  webkitExitFullscreen?(): void;
  addEventListener(type: 'fullscreenchange' | 'webkitfullscreenchange', listener: () => void): void;
}

export class Fullscreen {
  private readonly keyboard: KeyboardLock | undefined;
  private readonly listeners: ((active: boolean) => void)[] = [];
  /** Fullscreen as the listeners were last told. */
  private told: boolean;

  constructor(
    private readonly doc: FullscreenDocument,
    nav?: Pick<Navigator, 'keyboard'>,
  ) {
    this.keyboard = nav?.keyboard;
    this.told = this.active;
    // Each change once, whichever event the browser fires for it (a browser may fire both).
    const changed = () => {
      const on = this.active;
      if (on === this.told) return;
      this.told = on;
      // However the page left (a button, Alt+Enter, Esc held down, F11), Esc is the browser's again.
      if (!on) this.unlockEsc();
      for (const listener of this.listeners) listener(on);
    };
    doc.addEventListener('fullscreenchange', changed);
    doc.addEventListener('webkitfullscreenchange', changed);
  }

  /** Whether the page is fullscreen now. */
  get active(): boolean {
    return Boolean(this.doc.fullscreenElement ?? this.doc.webkitFullscreenElement);
  }

  /**
   * The whole page fullscreen, Esc held for it where the keyboard can be locked. False where the
   * browser refuses or has no fullscreen; older Safari says nothing either way, so its request is
   * taken as made.
   */
  async enter(): Promise<boolean> {
    if (this.active) return true;
    const root = this.doc.documentElement;
    try {
      if (root.requestFullscreen) await root.requestFullscreen();
      else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
      else return false;
    } catch {
      return false;
    }
    if (this.active) this.lockEsc();
    return true;
  }

  /** Out of fullscreen (Esc's lock let go as the browser says the page has left). */
  async exit(): Promise<void> {
    if (!this.active) return;
    try {
      if (this.doc.exitFullscreen) await this.doc.exitFullscreen();
      else this.doc.webkitExitFullscreen?.();
    } catch {
      // Already out (the user left at the same moment): nothing to undo.
    }
  }

  /** Fullscreen on or off: false only where going fullscreen was refused or cannot be done here. */
  async toggle(): Promise<boolean> {
    if (!this.active) return this.enter();
    await this.exit();
    return true;
  }

  /** Told whenever the page goes fullscreen or leaves it, however it does. */
  onChange(listener: (active: boolean) => void): void {
    this.listeners.push(listener);
  }

  private lockEsc(): void {
    try {
      // A refusal (a page not allowed it) leaves Esc the browser's: it leaves fullscreen as ever.
      void Promise.resolve(this.keyboard?.lock?.(['Escape'])).catch(() => {});
    } catch {
      // Refused at once: the same.
    }
  }

  private unlockEsc(): void {
    try {
      this.keyboard?.unlock?.();
    } catch {
      // Letting go of nothing is no error, but this runs as the page leaves, before the listeners
      // are told: a keyboard that throws here must not leave the buttons saying "Leave fullscreen".
    }
  }
}

/** A fullscreen button as the page has it: its words, its click, and the press of the mouse that comes first. */
export interface FullscreenButton {
  textContent: string | null;
  addEventListener(type: 'click' | 'mousedown', listener: (e: { preventDefault(): void }) => void): void;
}

/**
 * The page's fullscreen buttons (the start screen's, the lobby's, the pause menu's): a click is
 * `toggle`, and each says where a click takes the page and the key that does the same, kept right
 * however the page goes in or out. A click leaves the focus where it was (Chrome and Edge would
 * move it to the button), so Enter or Space still plays, resumes or goes in; tabbed to, a button
 * is still the keys'.
 */
export function fullscreenButtons(buttons: Iterable<FullscreenButton>, fs: Fullscreen, key: string, toggle: () => void): void {
  const all = [...buttons];
  const label = (on: boolean) => {
    for (const b of all) b.textContent = `${on ? 'Leave fullscreen' : 'Fullscreen'} · ${key}`;
  };
  for (const b of all) {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', toggle);
  }
  label(fs.active);
  fs.onChange(label);
}
