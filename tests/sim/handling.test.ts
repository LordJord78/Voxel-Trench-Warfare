import { describe, expect, it } from 'vitest';
import type { Loadout } from '../../src/combat/arsenal';
import { handlingTunables, ZERO_HANDS, type HandlingCue } from '../../src/combat/handling';
import { heldPose, viewBasis, viewmodelTunables } from '../../src/combat/viewmodel';
import { loadTunables } from '../../src/core/tunables';
import type { GunKey } from '../../src/net/gear';
import { Stance, type MoveIntent } from '../../src/physics/character';
import { idleIntent, Session, type CombatEvents } from '../../src/sim/session';
import { BrickMap } from '../../src/world/bricks';
import { P } from '../../src/world/materials';

// The gun in the hands in play (the shots spec's §2). The session ticks Handling after the hands
// and before combat, so the muzzle the tracers, the flash and the cues leave from is the drawn one;
// a sprint holds the shot until the gun is up; an empty trigger clicks and reloads. None of it
// moves a round, which leaves from the eye.
const TICK = 1 / 60;
const tun = loadTunables();
const ht = handlingTunables(tun);
const vt = viewmodelTunables(tun);
const STILL_KICK = { back: 0, up: 0, side: 0, pitch: 0, yaw: 0, roll: 0 };

/** 25.6 × 6.4 × 51.2 m: a floor 0.4 m deep, room to sprint, and a clay wall at z 40–43 m. */
function arena(): BrickMap {
  const map = new BrickMap({ x: 256, y: 64, z: 512 });
  map.fillBox(0, 0, 0, 256, 4, 512, P.SOD);
  map.fillBox(0, 4, 400, 256, 64, 430, P.CLAY);
  return map;
}

/** A player settled at the near end facing `yaw` (+z at 0), carrying `loadout`'s guns if given. */
function stand(loadout?: Loadout, yaw = 0, seed = 7): Session {
  const s = Session.create({ map: arena(), plan: null, spawn: { position: [12.8, 0.4, 2] } }, tun, seed, yaw);
  if (loadout) s.equip(loadout);
  for (let k = 0; k < 40; k++) s.tick();
  s.drainEvents();
  return s;
}

const bare = (primary: GunKey, secondary: GunKey = 'm17'): Loadout => ({ primary, secondary, fits: {} });
const sub = (a: readonly number[], b: readonly number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const eyeOf = (s: Session) => [s.player.position.x, s.player.position.y + s.controller.eyeHeight(s.player), s.player.position.z];
/** The view's axes as the last tick left them, as the session carries the gun along them. */
function basisOf(s: Session) {
  const v = s.viewAt(1);
  return viewBasis(s.player.yaw + v.yaw, s.player.pitch + v.pitch, v.roll);
}
/** The muzzle as the session would have it with the hands held still. */
function stillMuzzle(s: Session): [number, number, number] {
  const was = s.handsStill;
  s.handsStill = true;
  const m = s.muzzle();
  s.handsStill = was;
  return m;
}

describe('the gun in the hands, in play', () => {
  it('with fire held the player never sprints, and the first shot leaves within 0.12 s of the press out of a full sprint', () => {
    // The AK (automatic) and the SVD (a shot a press): a press held while the sprint leaves is not lost.
    for (const loadout of [bare('ak74'), bare('svd')]) {
      // From a standstill, forward, sprint and fire held together: no sprint at all, and a shot at once.
      const s = stand(loadout);
      const walk = s.controller.t.stances[Stance.STANDING].speed * s.arm.spec.move;
      s.intent = { ...idleIntent(), forward: 1, sprint: true, fire: true };
      for (let k = 0; k < 90; k++) {
        s.tick();
        if (k === 0) expect(s.shots.length, loadout.primary).toBeGreaterThan(0);
        expect(s.handling.sprint).toBe(0);
        expect(s.player.velocity.horizontalLength).toBeLessThanOrEqual(walk + 1e-9);
      }
      expect(s.player.velocity.horizontalLength).toBeGreaterThan(walk * 0.99);
      // Out of a full sprint, the press drops it at once. No shot leaves while the gun is still swung
      // low (the blend at or over 0.3), and the first leaves within 0.12 s.
      const r = stand(loadout);
      r.intent = { ...idleIntent(), forward: 1, sprint: true };
      for (let k = 0; k < 60; k++) r.tick();
      expect(r.handling.sprint).toBe(1);
      expect(r.player.velocity.horizontalLength).toBeGreaterThan(walk * 1.3);
      r.intent = { ...r.intent, fire: true };
      const blends: number[] = [];
      let first = -1;
      for (let k = 0; k < 30 && first < 0; k++) {
        r.tick();
        blends.push(r.handling.sprint);
        if (r.shots.length > 0) first = k;
      }
      // Tick k is (k + 1) ticks after the press.
      expect(blends[0]).toBeLessThan(1);
      expect(first, loadout.primary).toBeGreaterThan(0);
      expect((first + 1) * TICK).toBeLessThanOrEqual(0.12);
      for (let k = 0; k < first; k++) expect(blends[k]).toBeGreaterThanOrEqual(ht.sprintBlocksFire);
      expect(blends[first]).toBeLessThan(ht.sprintBlocksFire);
    }
  });

  it('the sights held drop the sprint at once, as fire does', () => {
    const s = stand();
    s.intent = { ...idleIntent(), forward: 1, sprint: true };
    for (let k = 0; k < 60; k++) s.tick();
    expect(s.handling.sprint).toBe(1);
    s.intent = { ...s.intent, aim: true };
    s.tick();
    // A tick in, the sights far from half up: the sprint is dropped all the same, and the pose leaves.
    expect(s.aimed).toBeLessThan(0.5);
    expect(s.handling.sprint).toBeCloseTo(1 - TICK / ht.sprintOutS, 12);
    for (let k = 0; k < 7; k++) s.tick();
    expect(s.handling.sprint).toBe(0);
    // From a standstill with the sights held: no sprint at all.
    const t = stand();
    t.intent = { ...idleIntent(), forward: 1, sprint: true, aim: true };
    const walk = t.controller.t.stances[Stance.STANDING].speed;
    for (let k = 0; k < 60; k++) {
      t.tick();
      expect(t.handling.sprint).toBe(0);
      expect(t.player.velocity.horizontalLength).toBeLessThanOrEqual(walk + 1e-9);
    }
  });

  it('a press on an empty magazine clicks once and starts a reload 0.25 s later', () => {
    const s = stand();
    const w = s.weapon;
    w.rounds = 0;
    s.intent = { ...idleIntent(), fire: true };
    s.tick();
    const press = s.ticks;
    // Its click, heard at the muzzle as drawn on the press's tick.
    expect(s.drainEvents().handling).toEqual([{ tick: press, cue: 'dry', at: s.muzzle() }]);
    // Held: no more clicks, and the reload begins 0.25 s after the press, not a tick before.
    const later = Math.round(ht.dryReloadS / TICK);
    expect(later).toBe(15);
    while (s.ticks < press + later - 1) {
      s.tick();
      expect(w.reloading).toBe(false);
    }
    s.tick();
    expect(w.reloading).toBe(true);
    expect(w.reloadPhase).toBe(0);
    expect(s.drainEvents().handling).toEqual([]);
    // Pressed again while it reloads: nothing.
    s.intent = idleIntent();
    s.tick();
    s.intent = { ...idleIntent(), fire: true };
    s.tick();
    expect(s.drainEvents().handling).toEqual([]);

    // A click a press: let go and pressed again before the reload begins, it clicks again, and the
    // reload still begins 0.25 s after the first.
    const again = stand();
    again.weapon.rounds = 0;
    const clicks: number[] = [];
    const start = again.ticks;
    for (let k = 0; k < 20; k++) {
      again.intent = { ...idleIntent(), fire: k < 3 || (k >= 5 && k < 8) };
      again.tick();
      clicks.push(...again.drainEvents().handling.filter((c) => c.cue === 'dry').map((c) => c.tick - start));
      expect(again.weapon.reloading, `tick ${k + 1}`).toBe(k + 1 >= 1 + later);
    }
    expect(clicks).toEqual([1, 6]);

    // Held as the magazine runs dry (an automatic's), no click: the next press clicks.
    const auto = stand();
    auto.weapon.rounds = 3;
    auto.intent = { ...idleIntent(), fire: true };
    let shots = 0;
    for (let k = 0; k < 60; k++) {
      auto.tick();
      shots += auto.shots.length;
    }
    expect(shots).toBe(3);
    expect(auto.drainEvents().handling).toEqual([]);
    expect(auto.weapon.reloading).toBe(false);
    auto.intent = idleIntent();
    auto.tick();
    auto.intent = { ...idleIntent(), fire: true };
    auto.tick();
    expect(auto.drainEvents().handling.map((c) => c.cue)).toEqual(['dry']);
    // A press with a round left fires it, and does not click.
    const one = stand(bare('svd'));
    one.weapon.rounds = 1;
    one.intent = { ...idleIntent(), fire: true };
    one.tick();
    expect(one.shots).toHaveLength(1);
    expect(one.weapon.rounds).toBe(0);
    expect(one.drainEvents().handling).toEqual([]);
  });

  it("a reload's cues arrive in order with the gun's muzzle as where", () => {
    const cases: [Loadout, HandlingCue[]][] = [
      [bare('ak74'), ['mag-out', 'mag-in', 'bolt']],
      [bare('m249'), ['mag-out', 'cover', 'mag-in', 'bolt']],
      [bare('m870'), ['shell', 'shell', 'shell']],
    ];
    for (const [loadout, cues] of cases) {
      const s = stand(loadout);
      const w = s.weapon;
      w.rounds = w.spec.magazine - 3;
      s.intent = { ...idleIntent(), reload: true };
      const heard: CombatEvents['handling'] = [];
      for (let k = 0; k < 8 * 60 && (k < 2 || w.reloading); k++) {
        s.tick();
        s.intent = idleIntent();
        const got = s.drainEvents().handling;
        for (const c of got) {
          // Heard on its tick, at the muzzle as drawn then: posed by the reload, not the still gun's.
          expect(c.tick).toBe(s.ticks);
          expect(c.at).toEqual(s.muzzle());
          expect(Math.hypot(...sub(c.at, stillMuzzle(s)))).toBeGreaterThan(0.005);
        }
        heard.push(...got);
      }
      expect(heard.map((c) => c.cue), loadout.primary).toEqual(cues);
      for (let k = 1; k < heard.length; k++) expect(heard[k].tick).toBeGreaterThan(heard[k - 1].tick);
      expect(w.reloading).toBe(false);
      expect(w.rounds).toBe(w.spec.magazine);
    }
    // The shotgun's pump, 0.12 s after its shot, at the muzzle as it works.
    const g = stand(bare('m870'));
    g.intent = { ...idleIntent(), fire: true };
    g.tick();
    expect(g.shots).toHaveLength(1);
    const shot = g.ticks;
    g.drainEvents();
    g.intent = idleIntent();
    const pumped: CombatEvents['handling'] = [];
    for (let k = 0; k < 40; k++) {
      g.tick();
      const got = g.drainEvents().handling;
      for (const c of got) expect(c.at).toEqual(g.muzzle());
      pumped.push(...got);
    }
    expect(pumped.map((c) => c.cue)).toEqual(['pump']);
    expect((pumped[0].tick - shot) * TICK).toBeGreaterThanOrEqual(ht.pumpAfterS);
    expect((pumped[0].tick - shot) * TICK).toBeLessThan(ht.pumpAfterS + 2 * TICK);
  });

  it('turning the view sways the drawn muzzle (session.muzzle()) but not where the round leaves (the eye)', () => {
    // Two sessions alike but that one's hands are held still: whatever differs between them is the
    // hands'. Both fire while turning right at 100°/s through north, where the yaw wraps from 359° to 0°.
    const moving = stand(undefined, 350);
    const still = stand(undefined, 350);
    still.handsStill = true;
    for (const s of [moving, still]) s.intent = { ...idleIntent(), fire: true };
    let shots = 0;
    let impacts = 0;
    for (let k = 0; k < 60; k++) {
      for (const s of [moving, still]) {
        s.player.yaw = (s.player.yaw + 100 * TICK) % 360;
        s.tick();
      }
      // Where the rounds leave and go: the eye, the view's line, the same whatever the hands do.
      expect(moving.shots).toEqual(still.shots);
      for (const shot of moving.shots) expect(shot.origin).toEqual(eyeOf(moving));
      expect(moving.rounds.impacts).toEqual(still.rounds.impacts);
      expect(moving.rounds.count).toBe(still.rounds.count);
      for (let i = 0; i < moving.rounds.count; i++) expect(moving.rounds.position(i)).toEqual(still.rounds.position(i));
      shots += moving.shots.length;
      impacts += moving.rounds.impacts.length;
      // Banked into the turn the whole way (right side down): the turn is the short way round, so
      // the wrap at north is no whip the other way.
      expect(moving.handling.delta.roll, `tick ${k}`).toBeLessThanOrEqual(0);
    }
    expect(shots).toBeGreaterThan(5);
    expect(impacts).toBeGreaterThan(0);
    // The drawn muzzle trails the turn: to the left of the still gun's by most of 0.012 m.
    const { right } = basisOf(moving);
    const aside = dot(sub(moving.muzzle(), still.muzzle()), right);
    expect(aside).toBeLessThan(-0.009);
    expect(aside).toBeGreaterThan(-0.016);
    // And their tracers leave the drawn muzzles: the events carry each its own.
    const [a, b] = [moving.drainEvents().shots, still.drainEvents().shots];
    expect(a.map((e) => e.muzzle)).not.toEqual(b.map((e) => e.muzzle));
  });

  it('aimed, breathing still moves the drawn gun, a third of it, and never the round', () => {
    // The SVD under its scope: at 0.85 aimed the scope hides the gun, but the gun still breathes.
    const scoped: Loadout = { primary: 'svd', secondary: 'pm', fits: { svd: { optic: 'scope', muzzle: 'none', under: 'none', side: 'none' } } };
    const moving = stand(scoped);
    const still = stand(scoped);
    still.handsStill = true;
    for (const s of [moving, still]) s.intent = { ...idleIntent(), aim: true };
    const ups: number[] = [];
    for (let k = 0; k < 240; k++) {
      for (const s of [moving, still]) s.tick();
      if (moving.aimed < 1) continue;
      // Still and aimed, the hands' delta is breathing alone, at 0.35 of it, carried along the view.
      const hands = moving.handling.delta;
      expect([hands.offset[2], hands.pitch, hands.yaw, hands.roll]).toEqual([0, 0, 0, 0]);
      expect(Math.abs(hands.offset[1])).toBeLessThanOrEqual(0.0025 * 0.35);
      expect(Math.abs(hands.offset[0])).toBeLessThanOrEqual(0.0015 * 0.35);
      const { forward, right, up } = basisOf(moving);
      const d = sub(moving.muzzle(), still.muzzle());
      expect(dot(d, right)).toBeCloseTo(hands.offset[0], 12);
      expect(dot(d, up)).toBeCloseTo(hands.offset[1], 12);
      expect(dot(d, forward)).toBeCloseTo(0, 12);
      ups.push(hands.offset[1]);
    }
    expect(ups.length).toBeGreaterThan(180);
    expect(Math.max(...ups) - Math.min(...ups)).toBeGreaterThan(0.0005);
    // A shot from each: the same round, from the eye, and the same where it lands.
    for (const s of [moving, still]) s.intent = { ...s.intent, fire: true };
    for (let k = 0; k < 60; k++) {
      for (const s of [moving, still]) s.tick();
      expect(moving.shots).toEqual(still.shots);
      for (const shot of moving.shots) expect(shot.origin).toEqual(eyeOf(moving));
      expect(moving.rounds.impacts).toEqual(still.rounds.impacts);
    }
    expect(moving.weapon.shotsFired).toBe(1);
  });

  it('handling is deterministic: two sessions, same intents, same muzzles', () => {
    // Walking and turning, a sprint, a burst with the view climbing, a reload, the sights, a jump.
    const script = (k: number): { intent: Partial<MoveIntent>; yaw: number; pitch: number } =>
      k < 60 ? { intent: { forward: 1 }, yaw: 1.5, pitch: 0 }
      : k < 120 ? { intent: { forward: 1, sprint: true }, yaw: -0.5, pitch: 0 }
      : k < 180 ? { intent: { fire: true }, yaw: 0.2, pitch: 0.3 }
      : k < 330 ? { intent: { reload: k === 180 }, yaw: 0, pitch: -0.1 }
      : k < 360 ? { intent: { aim: true }, yaw: 0, pitch: 0 }
      : { intent: { jump: k === 362 }, yaw: 0, pitch: 0 };
    const a = stand();
    const b = stand();
    const cues: HandlingCue[] = [];
    let most = 0;
    for (let k = 0; k < 420; k++) {
      const step = script(k);
      for (const s of [a, b]) {
        s.intent = { ...idleIntent(), ...step.intent };
        s.player.yaw = (s.player.yaw + step.yaw + 360) % 360;
        s.player.pitch += step.pitch;
        s.tick();
      }
      expect(a.muzzle()).toEqual(b.muzzle());
      expect(a.port()).toEqual(b.port());
      expect(a.viewmodelAt(0.37, 0.002, 0.5)).toEqual(b.viewmodelAt(0.37, 0.002, 0.5));
      expect(a.handling.delta).toEqual(b.handling.delta);
      expect(a.shots).toEqual(b.shots);
      const [ea, eb] = [a.drainEvents(), b.drainEvents()];
      expect(ea.handling).toEqual(eb.handling);
      cues.push(...ea.handling.map((c) => c.cue));
      most = Math.max(most, Math.hypot(...a.handling.delta.offset));
    }
    // The script worked the hands: a reload's cues heard, and the gun swung well off its pose.
    expect(cues).toEqual(['mag-out', 'mag-in', 'bolt']);
    expect(most).toBeGreaterThan(0.05);
  });

  it("a reload cut short by putting the gun away eases back from where it was, and the shotgun's pushed shells are not kept", () => {
    // The AK part-way through its reload, tilted over; the pistol asked for. The reload runs on while
    // the AK comes down, and is lost as it is put away.
    const s = stand();
    s.weapon.rounds = 10;
    s.intent = { ...idleIntent(), reload: true };
    s.tick();
    s.intent = idleIntent();
    for (let k = 0; k < 50; k++) s.tick();
    s.intent = { ...idleIntent(), swap: 1 };
    const ak = s.arms[0].weapon;
    const rolls: number[] = [];
    let cut = -1;
    for (let k = 0; k < 40; k++) {
      s.tick();
      rolls.push(s.handling.delta.roll);
      if (cut < 0 && ak.reloadPhase === null) cut = k;
    }
    expect(cut).toBeGreaterThan(0);
    expect(s.held).toBe(1);
    expect(ak.rounds).toBe(10);
    // Tilted over (28°) up to the cut; then no snap, easing back to rest over 0.15 s, never past it.
    expect(rolls[cut - 1]).toBeCloseTo(ht.reloadTiltRollDeg, 6);
    expect(rolls[cut]).toBeGreaterThan(rolls[cut - 1] * 0.9);
    for (let k = cut + 1; k < 40; k++) {
      expect(rolls[k]).toBeLessThanOrEqual(rolls[k - 1]);
      expect(rolls[k]).toBeGreaterThanOrEqual(0);
    }
    const settled = cut + Math.round(ht.reloadCutS / TICK) - 1;
    expect(rolls[settled]).toBeCloseTo(0, 9);

    // The shotgun, five shells to load (3.0 s), put away after two are pushed: the tube is as it
    // was, and the next reload loads all five again, over the whole of their time.
    const g = stand(bare('m870'));
    const m870 = g.arms[0].weapon;
    m870.rounds = 2;
    g.intent = { ...idleIntent(), reload: true };
    const shells = () => g.drainEvents().handling.filter((c) => c.cue === 'shell').length;
    let pushed = 0;
    for (let k = 0; k < 90; k++) {
      g.tick();
      g.intent = idleIntent();
      pushed += shells();
    }
    expect(pushed).toBe(2);
    g.intent = { ...idleIntent(), swap: 1 };
    for (let k = 0; k < 40; k++) {
      g.tick();
      pushed += shells();
    }
    expect(m870.reloadPhase).toBeNull();
    expect(m870.rounds).toBe(2);
    g.intent = { ...idleIntent(), swap: 0 };
    for (let k = 0; k < 60; k++) g.tick();
    expect(g.held).toBe(0);
    g.drainEvents();
    g.intent = { ...idleIntent(), reload: true };
    g.tick();
    g.intent = idleIntent();
    expect(m870.reloadShells).toBe(5);
    // Its 3.0 s: the ticks it runs after the one it began in.
    let ticks = 0;
    let again = 0;
    while (m870.reloading) {
      g.tick();
      again += shells();
      ticks++;
    }
    expect(ticks).toBe(Math.round((0.5 + 5 * 0.5) / TICK));
    expect(again).toBe(5);
    expect(m870.rounds).toBe(7);
  });

  it('the drawn gun is heldPose with the hands between the last two ticks; held still, with none', () => {
    // Walking and turning, nothing fired: the kick, the step's raise and the sights all at rest.
    const s = stand();
    s.intent = { ...idleIntent(), forward: 1 };
    for (let k = 0; k < 30; k++) {
      s.player.yaw += 1.2;
      s.tick();
    }
    for (const alpha of [0, 0.3, 0.75]) {
      const hands = s.handling.at(alpha);
      expect(hands).not.toEqual(ZERO_HANDS);
      expect(s.viewmodelAt(alpha, 0.004, 0.6)).toEqual(heldPose(vt, s.holding(), STILL_KICK, 0.004, 0.6, 0, 0, 1, null, hands));
    }
    s.handsStill = true;
    for (const alpha of [0, 0.3, 0.75]) expect(s.viewmodelAt(alpha, 0.004, 0.6)).toEqual(heldPose(vt, s.holding(), STILL_KICK, 0.004, 0.6, 0, 0, 1, null));
  });
});
