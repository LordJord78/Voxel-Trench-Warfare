import { expect, test, type Page } from '@playwright/test';
import { audioRenders, hooks, openGame, type Hooks } from './support/app';

// The gun in the hands (the shots spec's §2) as the game draws and sounds it: a sprint swings it low
// and across, and no round leaves while it is low; a reload tilts it through its curve to the
// magazine's and the bolt's cues; the shotgun pumps after each shot and loads its shells one by one;
// an empty magazine clicks and reloads; and turning moves the drawn gun every frame, smoothly, at the
// display's own rate (run with E2E_FPS unset: handling is ticked at 60 Hz and drawn between ticks);
// and aimed down the sights, no prong of a shot's flash rises over the line of sight. What is heard is
// counted only where the page's audio renders (audioRenders), as the audio specs' do: the tests that
// only count it skip (and say so) elsewhere, and the reload's curve is checked either way.

type Frame = { ms: number; ticks: number; alpha: number; m: number[] | null };
type Handy = Omit<Hooks, 'freeze'> & {
  /** Frozen: frames drawn only when stepped, `hz` of them a second of the world's time (60 unless given). */
  freeze(hz?: number): void;
  setLoadout(l: unknown): void;
  hands(): { held: number; ready: number; aimed: number; gun: string; sprint: number; reload: number | null; rounds: number; drawn: boolean; box: [number, number, number, number]; res: [number, number] };
  turn(degPerS: number, periodS?: number): void;
  gunFrames(n: number): Promise<Frame[]>;
  aim(held: boolean): void;
  flashPixels(): { res: [number, number]; flashes: { remote: boolean; at: [number, number] | null; tips: ([number, number] | null)[]; atM: [number, number, number]; tipsM: [number, number, number][]; up: [number, number, number] }[] };
  session: Hooks['session'] & { ticks: number; weapon: { rounds: number; shotsFired: number }; player: { yaw: number; pitch: number }; arm: { spec: { sight: { y: number } } } };
};

const handy = <T>(page: Page, fn: (h: Handy, arg: unknown) => T | Promise<T>, arg?: unknown): Promise<T> => hooks(page, fn as unknown as (h: Hooks, arg: unknown) => T | Promise<T>, arg);

const SILENT = 'the audio clock stands still here (no output renders): what is played cannot be counted as heard';

/**
 * Playing (from the click that starts it and its sound, if `sound`), `primary` in the hands, standing
 * on the spawn bay's duckboards looking along the bay (`along`) or at its front wall, still and
 * settled: the page's errors, and whether its sound renders.
 */
async function holding(page: Page, primary: string, { sound = false, along = false } = {}): Promise<{ errors: string[]; renders: boolean }> {
  const errors = await openGame(page);
  let renders = false;
  if (sound) {
    await page.locator('#play').click();
    renders = await audioRenders(page);
  } else await hooks(page, (h) => h.play());
  await handy(
    page,
    async (h, arg) => {
      const { primary, along } = arg as { primary: string; along: boolean };
      h.setLoadout({ primary, secondary: 'm17', fits: {} });
      const sp = h.world.spawn;
      // Along the bay (its long axis) or at its front wall.
      const wall = sp.bay.longAxis === 0 ? (sp.bay.facing > 0 ? 0 : 180) : sp.bay.facing > 0 ? 90 : -90;
      const down = sp.bay.longAxis === 0 ? 90 : 0;
      h.teleport({ position: sp.position, yaw: along ? down : wall, pitch: along ? 0 : -10 });
      await h.waitFrames(60);
    },
    { primary, along },
  );
  return { errors, renders };
}

/** The gun's roll as the camera sees it (degrees): its right axis turned toward the camera's up. */
const rollOf = (m: number[]) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;

test('sprinting swings the gun low and across: its drawn box moves right and down, and no shot leaves', async ({ page }) => {
  const { errors } = await holding(page, 'ak74', { along: true });
  const rest = await handy(page, (h) => ({ ...h.hands(), shots: h.session.weapon.shotsFired }));
  expect(rest.drawn).toBe(true);
  expect(rest.sprint).toBe(0);
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await expect.poll(() => handy(page, (h) => h.hands().sprint), { timeout: 5000 }).toBe(1);
  const sprinting = await handy(page, async (h) => {
    await h.waitFrames(10);
    return { hands: h.hands(), shots: h.session.weapon.shotsFired };
  });
  const centre = (b: [number, number, number, number], res: [number, number]) => [(b[0] + b[2] / 2) / res[0], (b[1] + b[3] / 2) / res[1]];
  const [rx, ry] = centre(rest.box, rest.res);
  const [sx, sy] = centre(sprinting.hands.box, sprinting.hands.res);
  console.log(`the gun's box at rest ${JSON.stringify(rest.box)}, sprinting ${JSON.stringify(sprinting.hands.box)} (of ${rest.res.join(' × ')})`);
  // Low and across: its box's middle right and down by a good share of the view.
  expect(sx - rx, JSON.stringify({ rest: rest.box, sprinting: sprinting.hands.box })).toBeGreaterThan(0.03);
  expect(sy - ry, JSON.stringify({ rest: rest.box, sprinting: sprinting.hands.box })).toBeGreaterThan(0.03);
  // The trigger pressed at a full sprint drops it; no round leaves while the gun is still low (its
  // blend at sprint_blocks_fire, 0.3, or over), and the first leaves within 0.12 s of the press. Read
  // a tick at a time in the world's own time: the loop frozen and stepped a sixtieth of a second a
  // frame, so each frame runs one tick and its blend is the one the tick's trigger saw.
  const fired = await handy(page, async (h) => {
    h.freeze(60);
    const before = h.session.weapon.shotsFired;
    const pressed = h.session.ticks;
    h.trigger(true);
    const seen: { tick: number; sprint: number; shots: number }[] = [];
    for (let k = 0; k < 24; k++) {
      await h.stepFrames(1);
      seen.push({ tick: h.session.ticks - pressed, sprint: h.hands().sprint, shots: h.session.weapon.shotsFired - before });
    }
    h.trigger(false);
    h.thaw();
    return seen;
  });
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  const trace = JSON.stringify(fired);
  // A tick a frame (none skipped or doubled, so each blend read is its tick's).
  fired.forEach((f, k) => expect(f.tick, trace).toBe(k + 1));
  const first = fired.findIndex((f) => f.shots > 0);
  expect(first, trace).toBeGreaterThan(0);
  // Still low at the press: the ticks before the shot held fire at the blend's 0.3 or over.
  expect(fired[0].sprint, trace).toBeGreaterThanOrEqual(0.3);
  // No shot in a tick whose blend is 0.3 or more; the shot's tick under it, the tick before at or over it.
  for (let k = 0; k < fired.length; k++) {
    const shot = fired[k].shots > (k > 0 ? fired[k - 1].shots : 0);
    if (fired[k].sprint >= 0.3) expect(shot, `tick ${fired[k].tick}: ${trace}`).toBe(false);
  }
  expect(fired[first].sprint, trace).toBeLessThan(0.3);
  expect(fired[first - 1].sprint, trace).toBeGreaterThanOrEqual(0.3);
  // Within 0.12 s of the press, in the world's time.
  expect(fired[first].tick / 60, trace).toBeLessThanOrEqual(0.12);
  // Nothing fired at a sprint before the press.
  expect(sprinting.shots).toBe(rest.shots);
  expect(errors).toEqual([]);
});

test('a reload tilts the gun through its curve and plays its cues: mag-out, mag-in, bolt heard', async ({ page }) => {
  // The curve is checked whether or not the page's audio renders; only what is heard needs it to.
  const { errors, renders } = await holding(page, 'ak74', { sound: true });
  const before = await handy(page, (h) => ({ kinds: { ...h.audio().kinds } }));
  const rest = await handy(page, (h) => h.gunFrames(5));
  const record = await handy(page, async (h) => {
    h.session.weapon.rounds = 7;
    const frames = h.gunFrames(400);
    // R, as the key asks: the reload in the hands' cues and curve.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }));
    const phases: (number | null)[] = [];
    let done = false;
    void frames.then(() => (done = true));
    while (!done) {
      phases.push(h.hands().reload);
      await h.waitFrames(1);
    }
    return { frames: await frames, phases };
  });
  // Wait the reload out: the magazine full again.
  await expect.poll(() => handy(page, (h) => ({ reload: h.hands().reload, rounds: h.hands().rounds })), { timeout: 8000 }).toEqual({ reload: null, rounds: 30 });
  await handy(page, (h) => h.waitFrames(5));
  const after = await handy(page, (h) => ({ ...h.audio().kinds }));
  expect(record.phases.some((p) => p !== null), JSON.stringify(record.phases.slice(0, 20))).toBe(true);
  // Through its curve: rolled 28° at the tilt and 34° at the bolt (as the camera sees it, by about
  // that), then back to rest.
  const restRoll = rollOf(rest[rest.length - 1].m!);
  const rolls = record.frames.filter((f) => f.m !== null).map((f) => rollOf(f.m!) - restRoll);
  const most = Math.max(...rolls.map(Math.abs));
  console.log(`the reload's roll off rest: at most ${most.toFixed(1)}°, over ${record.frames.length} frames`);
  expect(most).toBeGreaterThan(20);
  expect(most).toBeLessThan(45);
  const end = await handy(page, (h) => h.gunFrames(3));
  expect(Math.abs(rollOf(end[end.length - 1].m!) - restRoll)).toBeLessThan(3);
  // Heard: each of its cues once, where the page's audio renders.
  if (renders) {
    const heard = (kind: string) => (after[kind] ?? 0) - (before.kinds[kind] ?? 0);
    expect({ 'mag-out': heard('mag-out'), 'mag-in': heard('mag-in'), bolt: heard('bolt'), cover: heard('cover') }).toEqual({ 'mag-out': 1, 'mag-in': 1, bolt: 1, cover: 0 });
  } else {
    console.log(`the reload's cues not counted: ${SILENT}`);
    test.info().annotations.push({ type: 'heard not checked', description: SILENT });
  }
  expect(errors).toEqual([]);
});

test('the shotgun pumps after each shot, and loads its shells one by one', async ({ page }) => {
  const { errors, renders } = await holding(page, 'm870', { sound: true });
  test.skip(!renders, SILENT);
  const kind = (k: string) => handy(page, (h, k) => h.audio().kinds[k as string] ?? 0, k);
  const pumps = await kind('pump');
  // Three shots, a press each: a pump after each, heard 0.12 s on.
  for (let shot = 0; shot < 3; shot++) {
    const fired = await handy(page, async (h) => {
      const before = h.session.weapon.shotsFired;
      h.trigger(true);
      await h.waitFrames(3);
      h.trigger(false);
      await new Promise((resolve) => setTimeout(resolve, 900));
      return h.session.weapon.shotsFired - before;
    });
    expect(fired).toBe(1);
  }
  expect((await kind('pump')) - pumps).toBe(3);
  // The tube three short: a reload loads them a shell at a time, each heard as it goes in, evenly
  // spaced over the time after its base (reload_base_s 0.5, then reload_per_round_s 0.5 a shell).
  const rounds = await handy(page, (h) => h.hands().rounds);
  expect(rounds).toBe(4);
  const shells = await kind('shell');
  const loaded = await handy(page, async (h) => {
    const t0 = performance.now();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }));
    const at: number[] = [];
    let heard = h.audio().kinds.shell ?? 0;
    let reloading = false;
    while (performance.now() - t0 < 4000) {
      await h.waitFrames(1);
      const now = h.audio().kinds.shell ?? 0;
      for (; heard < now; heard++) at.push((performance.now() - t0) / 1000);
      const r = h.hands().reload;
      if (r !== null) reloading = true;
      else if (reloading) break;
    }
    return { at, s: (performance.now() - t0) / 1000, rounds: h.hands().rounds };
  });
  console.log(`the shells heard at ${loaded.at.map((s) => s.toFixed(2)).join(', ')} s; the tube full at ${loaded.s.toFixed(2)} s`);
  expect((await kind('shell')) - shells).toBe(3);
  expect(loaded.at).toHaveLength(3);
  expect(loaded.rounds).toBe(7);
  // One by one: half a second apart, the first after the base.
  for (let k = 1; k < 3; k++) expect(loaded.at[k] - loaded.at[k - 1]).toBeGreaterThan(0.35);
  expect(loaded.at[0]).toBeGreaterThan(0.4);
  // The whole of it about 0.5 + 0.5 × 3 s.
  expect(loaded.s).toBeGreaterThan(1.8);
  expect(loaded.s).toBeLessThan(2.6);
  expect(errors).toEqual([]);
});

test('an empty magazine clicks and reloads', async ({ page }) => {
  const { errors, renders } = await holding(page, 'ak74', { sound: true });
  test.skip(!renders, SILENT);
  const kinds = () => handy(page, (h) => ({ ...h.audio().kinds }));
  const before = await kinds();
  // The trigger held on an empty magazine: one click for the press, and a reload dry_reload_s (0.25 s) on.
  const press = await handy(page, async (h) => {
    h.session.weapon.rounds = 0;
    await h.waitFrames(2);
    const t0 = performance.now();
    h.trigger(true);
    let began: number | null = null;
    while (performance.now() - t0 < 600) {
      await h.waitFrames(1);
      if (began === null && h.hands().reload !== null) began = (performance.now() - t0) / 1000;
    }
    h.trigger(false);
    return { began, shots: h.session.weapon.shotsFired };
  });
  console.log(`the reload began ${press.began?.toFixed(3)} s after the press`);
  expect(press.began).not.toBeNull();
  expect(press.began!).toBeGreaterThan(0.2);
  expect(press.began!).toBeLessThan(0.25 + 0.15);
  const clicked = await kinds();
  // Once a press, however long it is held: no second click.
  expect((clicked.dry ?? 0) - (before.dry ?? 0)).toBe(1);
  await expect.poll(() => handy(page, (h) => h.hands().rounds), { timeout: 8000 }).toBe(30);
  await handy(page, (h) => h.waitFrames(5));
  const after = await kinds();
  expect((after.dry ?? 0) - (before.dry ?? 0)).toBe(1);
  expect((after['mag-out'] ?? 0) - (before['mag-out'] ?? 0)).toBe(1);
  expect((after.bolt ?? 0) - (before.bolt ?? 0)).toBe(1);
  expect(errors).toEqual([]);
});

test("aimed down the AK's sights, no prong of a shot's flash rises over the line of sight or comes near the reticle", async ({ page }) => {
  // The line of sight runs the sight's height over the bore (the AK's irons, 0.0675 m): a prong rolled
  // up toward it lay along the tracer across the reticle. Measured in the drawn gun's frame, as the
  // flash is drawn: each prong's tip over the bore, along the gun's up. On the screen (the canvas's
  // middle is the line of sight and the reticle) the kick lifts the gun a little toward it for the
  // flash's frames, so a tip at the line in the gun's frame may show a few pixels over the middle, well
  // aside of it: no prong's drawn segment comes within 2% of the canvas's height of the middle (the
  // unit test's least, at 1600 x 1000, is 3.9%; the hash's whole rolls lay one across it).
  const { errors } = await holding(page, 'ak74');
  const shots = await handy(page, async (h) => {
    h.aim(true);
    await h.waitFrames(60);
    const aimed = h.hands().aimed;
    const sight = h.session.arm.spec.sight.y;
    h.freeze(60);
    const out: { aimed: number; sight: number; rises: number[]; overPx: number[]; nearPx: number; height: number }[] = [];
    for (let n = 0; n < 12; n++) {
      const before = h.session.weapon.shotsFired;
      h.trigger(true);
      for (let k = 0; k < 10 && h.session.weapon.shotsFired === before; k++) await h.stepFrames(1);
      h.trigger(false);
      const f = h.flashPixels();
      const own = f.flashes.find((x) => !x.remote);
      const rises = own ? own.tipsM.map((tip) => (tip[0] - own.atM[0]) * own.up[0] + (tip[1] - own.atM[1]) * own.up[1] + (tip[2] - own.atM[2]) * own.up[2]) : [];
      const overPx = own ? own.tips.filter((p) => p !== null).map((p) => f.res[1] / 2 - p![1]) : [];
      // Each prong's drawn segment, muzzle to tip on the canvas: its nearest to the canvas's middle.
      const c = [f.res[0] / 2, f.res[1] / 2];
      let nearPx = Infinity;
      for (const q of own?.tips ?? []) {
        const a = own!.at;
        if (!a || !q) continue;
        const d = [q[0] - a[0], q[1] - a[1]];
        const u = Math.max(0, Math.min(1, ((c[0] - a[0]) * d[0] + (c[1] - a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1] || 1)));
        nearPx = Math.min(nearPx, Math.hypot(a[0] + d[0] * u - c[0], a[1] + d[1] * u - c[1]));
      }
      out.push({ aimed, sight, rises, overPx, nearPx, height: f.res[1] });
      await h.stepFrames(20);
    }
    h.thaw();
    h.aim(false);
    return out;
  });
  const trace = JSON.stringify(shots.map((s) => ({ rises: s.rises.map((r) => +r.toFixed(4)), overPx: s.overPx.map((p) => +p.toFixed(1)), nearPx: +s.nearPx.toFixed(1) })));
  console.log(`aimed shots' prongs over the bore (m; the sight ${shots[0].sight}), over the screen's middle (px), and the nearest any comes to it (px, of ${shots[0].height}): ${trace}`);
  expect(shots[0].aimed).toBe(1);
  expect(shots[0].sight).toBeCloseTo(0.0675, 6);
  for (const s of shots) {
    // Its star drawn: 3 to 5 prongs, every tip under the line of sight in the gun's frame.
    expect(s.rises.length, trace).toBeGreaterThanOrEqual(3);
    expect(s.rises.length, trace).toBeLessThanOrEqual(5);
    for (const r of s.rises) expect(r, trace).toBeLessThanOrEqual(s.sight + 1e-4);
    // On the canvas, none near the reticle.
    expect(s.nearPx, trace).toBeGreaterThanOrEqual(0.02 * s.height);
  }
  expect(errors).toEqual([]);
});

/**
 * Each of `frames` draws the gun somewhere new as the camera sees it, and by about as much as its
 * time asks: no frame holds still while another jumps (stepping at the ticks' 60 Hz, a 240 Hz display
 * would show three frames alike and then a jump of four's worth).
 */
function expectSmooth(frames: Frame[], what: string): void {
  const ms = frames.map((f) => f.ms).sort((a, b) => a - b);
  const median = ms[Math.floor(ms.length / 2)];
  const ticks = new Set(frames.map((f) => f.ticks)).size;
  console.log(`${what}: ${frames.length} frames, ${(1000 / median).toFixed(0)} Hz (median ${median.toFixed(2)} ms), over ${ticks} ticks`);
  expect(frames.every((f) => f.m !== null), what).toBe(true);
  const speeds: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].m!;
    const b = frames[i].m!;
    const moved = Math.max(...a.map((v, k) => Math.abs(b[k] - v)));
    expect(moved, `${what}: frame ${i} (${frames[i].ms.toFixed(2)} ms, tick ${frames[i].ticks}, alpha ${frames[i].alpha.toFixed(3)})`).toBeGreaterThan(1e-7);
    if (frames[i].ms > 0) speeds.push(moved / frames[i].ms);
  }
  const sorted = [...speeds].sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length / 2)];
  expect(Math.max(...speeds) / typical, `${what}: ${JSON.stringify(speeds.map((v) => +(v / typical).toFixed(2)))}`).toBeLessThan(4);
}

test('turning moves the drawn gun every frame, smoothly', async ({ page }) => {
  // At the display's own rate (E2E_FPS unset): handling ticks at 60 Hz and the gun is drawn between
  // its ticks, so at 120 or 240 Hz the sway must not step.
  const { errors } = await holding(page, 'ak74', { along: true });
  // A look back and forth, a second each way and back.
  const own = await handy(page, async (h) => {
    h.turn(120, 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const out = await h.gunFrames(180);
    h.turn(0);
    return out;
  });
  expectSmooth(own, "at the display's own rate");
  // A headless page may draw at 60 Hz, a frame a tick: so at a 240 Hz display's too, the loop stepped a
  // 240th of a second a frame, three frames of every four between ticks.
  const fast = await handy(page, async (h) => {
    h.freeze(240);
    h.turn(120, 1);
    await h.stepFrames(72);
    const out = h.gunFrames(240);
    await h.stepFrames(240);
    h.turn(0);
    h.thaw();
    return out;
  });
  expect(new Set(fast.map((f) => f.ticks)).size).toBeLessThan(fast.length / 3);
  expectSmooth(fast, 'at 240 Hz');
  expect(errors).toEqual([]);
});
