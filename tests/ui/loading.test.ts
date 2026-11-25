import { describe, expect, it } from 'vitest';
import { LoadingScreen } from '../../src/ui/loading';

// The start screen (ui/loading.ts) as a join uses it (the release audit's UX-1, ROBUST-6): it stays up,
// or comes back over the world, saying how the join stands; while one is under way, Play, Host and Join
// wait for it; after a failure, why, and the way in again.

/** An element as the loading screen uses it: shown or hidden, its words, whether it is off; its children made as first asked for. */
class FakeElement {
  hidden = false;
  disabled = false;
  textContent = '';
  value = '';
  onclick: unknown = null;
  onsubmit: unknown = null;
  onchange: unknown = null;
  readonly style: Record<string, string> = {};
  private readonly classes = new Set<string>();
  readonly classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  private readonly children = new Map<string, FakeElement>();
  constructor(private readonly page: FakePage) {}
  querySelector(selector: string): FakeElement {
    const id = /^#([\w-]+)$/.exec(selector);
    if (id) return this.page.getElementById(id[1]);
    let c = this.children.get(selector);
    if (!c) this.children.set(selector, (c = new FakeElement(this.page)));
    return c;
  }
  setAttribute(): void {}
  removeAttribute(): void {}
  focus(): void {}
}

class FakePage {
  private readonly byId = new Map<string, FakeElement>();
  getElementById(id: string): FakeElement {
    let e = this.byId.get(id);
    if (!e) this.byId.set(id, (e = new FakeElement(this)));
    return e;
  }
}

describe('the start screen, as a join uses it', () => {
  it('comes back over the world saying how a join stands: Play, Host and Join waiting while one is under way, and why it failed after', () => {
    const page = new FakePage();
    const el = (id: string) => page.getElementById(id);
    const loading = new LoadingScreen(page as unknown as Document);
    loading.ready(() => {}, { host() {}, join() {} });
    expect(el('join-note').hidden).toBe(true);
    // A friend's link: the start screen stays up while the game is joined.
    loading.back('Joining game ABCDE…', true);
    expect(el('loading').hidden).toBe(false);
    expect([el('join-note').hidden, el('join-note').textContent]).toEqual([false, 'Joining game ABCDE…']);
    const off = () => [el('play').disabled, el('host').disabled, el('join-go').disabled, el('join-code').disabled];
    expect(off()).toEqual([true, true, true, true]);
    // Gone for the lobby, then back for a failure: why, and the way in again.
    loading.hide();
    loading.back('No game with that code', false);
    expect(el('loading').hidden).toBe(false);
    expect(el('join-note').textContent).toBe('No game with that code');
    expect(off()).toEqual([false, false, false, false]);
    // A page that has stopped keeps its failure: no join can cover it, nor a lobby put it away.
    loading.fail('The graphics device was lost.');
    loading.back('Joining game KXQRT…', true);
    expect(el('status').textContent).toBe('The graphics device was lost.');
    expect(el('join-note').textContent).toBe('No game with that code');
    loading.hide();
    expect(el('loading').hidden).toBe(false);
  });
});
