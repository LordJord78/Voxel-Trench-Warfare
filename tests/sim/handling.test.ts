import { describe, expect, it } from 'vitest';
import type { Loadout } from '../../src/combat/arsenal';
import { gunClass, Handling, handlingTunables, ZERO_HANDS, type HandlingCue, type HandsDelta } from '../../src/combat/handling';
import { heldPose, viewBasis, viewmodelTunables } from '../../src/combat/viewmodel';
import { loadTunables, Tunables } from '../../src/core/tunables';
import type { GunKey } from '../../src/net/gear';
import { Stance, type MoveIntent } from '../../src/physics/character';
import { idleIntent, Session, SHOVEL_HELD, type CombatEvents } from '../../src/sim/session';
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
function stand(loadout?: Loadout, yaw = 0, seed = 7, t: Tunables = tun): Session {
  const s = Session.create({ map: arena(), plan: null, spawn: { position: [12.8, 0.4, 2] } }, t, seed, yaw);
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
/**
 * The tick's strikes as their rounds made them. A tracer round's strike also carries how its last
 * streak is drawn (ballistics.ts StrikeDraw), from the muzzle as drawn when it left: the hands move
 * that and nothing else of it, so it is set aside here and held to its shot's muzzle (drawnFrom).
 */
const struck = (s: Session) => s.rounds.impacts.map(({ draw, ...hit }) => (draw ? { ...hit, draw: { ...draw, from: null } } : hit));
/** Where the tick's tracer strikes draw their last streaks from (StrikeDraw.from). */
const drawnFrom = (s: Session) => s.rounds.impacts.flatMap((h) => (h.draw ? [h.draw.from] : []));
/** `stand`, with the gun in `slot` up, then Shift and W held for a second: a full sprint. */
function sprinting(loadout?: Loadout, slot = 0): Session {
  const s = stand(loadout);
  s.intent = { ...idleIntent(), swap: slot };
  for (let k = 0; k < 90; k++) s.tick();
  s.intent = { ...idleIntent(), forward: 1, sprint: true };
  for (let k = 0; k < 60; k++) s.tick();
  expect([s.held, s.ready, s.handling.sprint]).toEqual([slot, 1, 1]);
  s.drainEvents();
  return s;
}
/** Shift and W held, and the trigger as given: a tick of a sprint. */
const sprintTick = (s: Session, fire: boolean) => {
  s.intent = { ...idleIntent(), forward: 1, sprint: true, fire };
  s.tick();
};
/**
 * A timber tread with a bench `h` voxels (10 cm each) over it at z 8.0–8.5 m and a clay parapet
 * behind: 6.5 m from the spawn to walk or sprint at it. Walked into, the bench is climbed.
 */
function benchAhead(h: number): BrickMap {
  const map = new BrickMap({ x: 64, y: 64, z: 128 });
  map.fillBox(0, 0, 0, 64, 4, 128, P.TIMBER);
  map.fillBox(0, 4, 80, 64, 4 + h, 85, P.TIMBER);
  map.fillBox(0, 3 + h, 80, 64, 4 + h, 85, P.BENCH);
  map.fillBox(0, 4, 85, 64, 18 + h, 128, P.CLAY);
  return map;
}
/** A player settled at the spawn facing the bench `h` voxels high, carrying `loadout`'s guns if given. */
function facingBench(h: number, loadout?: Loadout): Session {
  const s = Session.create({ map: benchAhead(h), plan: null, spawn: { position: [3.2, 0.4, 1.5] } }, tun, 7, 0);
  if (loadout) s.equip(loadout);
  for (let k = 0; k < 40; k++) s.tick();
  s.drainEvents();
  return s;
}
/**
 * `ticks` ticks of `s`, tick k's intent `intent(k)`: the ticks a shot left on and a dry click was
 * heard on, each tick's sprint blend, the climb's first tick, and the tick it ended on (the first
 * whose combat finds no climb under way); -1 for none.
 */
function throughClimb(s: Session, ticks: number, intent: (k: number) => MoveIntent) {
  const shots: number[] = [];
  const dry: number[] = [];
  const blends: number[] = [];
  let began = -1;
  let ended = -1;
  for (let k = 0; k < ticks; k++) {
    s.intent = intent(k);
    const was = s.player.climbTo;
    s.tick();
    if (was === null && s.player.climbTo !== null && began < 0) began = k;
    if (was !== null && s.player.climbTo === null && ended < 0) ended = k;
    if (s.shots.length > 0) shots.push(k);
    for (const c of s.drainEvents().handling) if (c.cue === 'dry') dry.push(k);
    blends.push(s.handling.sprint);
  }
  return { shots, dry, blends, began, ended };
}
/** W held, the trigger as given, and a gun asked for by its place if one is. */
const walkAt = (fire: boolean, swap?: number): MoveIntent => ({ ...idleIntent(), forward: 1, fire, ...(swap === undefined ? {} : { swap }) });

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

  it('a tap out of a full sprint is not lost: it fires once as the gun comes up, when a held press would, and the sprint comes back', () => {
    // Shift and W held throughout, the button down for a tick (a trackpad's tap: input.ts holds a
    // press for the tick that takes it) or for five (a quick click), let go while the gun is still
    // swung low. The press waits, the sprint dropped though the button is up, and fires as the blend
    // falls under 0.3. Each gun: the AK (automatic), the SVD and the M870 (a shot a press), the pistol.
    const guns: [Loadout, number][] = [
      [bare('ak74'), 0],
      [bare('svd'), 0],
      [bare('m870'), 0],
      [bare('ak74'), 1],
    ];
    for (const [loadout, slot] of guns) {
      // When a press held from the same sprint first fires: tick k is (k + 1) ticks after the press.
      const held = sprinting(loadout, slot);
      let due = -1;
      for (let k = 0; k < 30 && due < 0; k++) {
        sprintTick(held, true);
        if (held.shots.length > 0) due = k;
      }
      expect(due).toBeGreaterThan(0);
      for (const tap of [1, 5]) {
        const label = `${slot === 0 ? loadout.primary : loadout.secondary}, a ${tap}-tick tap`;
        const s = sprinting(loadout, slot);
        const blends: number[] = [];
        const shots: number[] = [];
        for (let k = 0; k < 60; k++) {
          sprintTick(s, k < tap);
          blends.push(s.handling.sprint);
          if (s.shots.length > 0) shots.push(k);
        }
        // One shot, on the tick a held press's first leaves: within 0.12 s, the gun up out of the sprint.
        expect(shots, label).toEqual([due]);
        expect(s.weapon.shotsFired, label).toBe(1);
        expect((due + 1) * TICK, label).toBeLessThanOrEqual(0.12);
        expect(blends[due], label).toBeLessThan(ht.sprintBlocksFire);
        // Before it the gun was swung low, and coming up the whole while, the button up or not.
        for (let k = 0; k < due; k++) {
          expect(blends[k], label).toBeGreaterThanOrEqual(ht.sprintBlocksFire);
          expect(blends[k], label).toBeLessThan(k === 0 ? 1 : blends[k - 1]);
        }
        // Then, with Shift and W still held, the sprint is back: nothing is left holding it off.
        expect(blends[59], label).toBe(1);
      }
    }
  });

  it('a tap out of a sprint on an empty magazine clicks as the gun comes up, and the reload begins 0.25 s after the click', () => {
    for (const tap of [1, 5]) {
      const label = `a ${tap}-tick tap`;
      const s = sprinting();
      const w = s.weapon;
      w.rounds = 0;
      const start = s.ticks;
      const heard: CombatEvents['handling'] = [];
      let began = -1;
      for (let k = 0; k < 40; k++) {
        sprintTick(s, k < tap);
        const got = s.drainEvents().handling;
        // Heard once the gun is up out of the sprint, at its muzzle then.
        for (const c of got) {
          expect(c.at, label).toEqual(s.muzzle());
          expect(s.handling.sprint, label).toBeLessThan(ht.sprintBlocksFire);
        }
        heard.push(...got);
        if (began < 0 && w.reloading) began = s.ticks;
      }
      expect(heard.map((c) => c.cue), label).toEqual(['dry']);
      // The press's tick is the first after it.
      expect((heard[0].tick - start) * TICK, label).toBeLessThanOrEqual(0.12);
      expect(began - heard[0].tick, label).toBe(Math.round(ht.dryReloadS / TICK));
    }
  });

  it('killed while a tap waits for the gun to come up out of a sprint, the press is gone', () => {
    const s = sprinting();
    sprintTick(s, true);
    sprintTick(s, false);
    expect(s.handling.sprint).toBeGreaterThanOrEqual(ht.sprintBlocksFire);
    s.alive = false;
    for (let k = 0; k < 30; k++) {
      sprintTick(s, false);
      expect(s.shots, `tick ${k}`).toHaveLength(0);
    }
    expect(s.handling.sprint).toBe(0);
    // Back in, nothing fires that was not pressed in this life.
    s.respawn([12.8, 0.4, 2], 0);
    for (let k = 0; k < 30; k++) {
      sprintTick(s, false);
      expect(s.shots, `back in, tick ${k}`).toHaveLength(0);
    }
    expect(s.weapon.shotsFired).toBe(0);
  });

  it('a press waiting out a sprint outlives no loadout and no life: equip and respawn let it go', () => {
    // A tap in a sprint's last ticks, then, with no tick between: the next match's deploy (equip,
    // then respawn), a loadout taken in a pause (equip), or a life begun afresh (respawn). Nothing
    // fires that was not pressed for the gun in the hands, in this life.
    const takes: [string, (s: Session) => void][] = [
      [
        'equip, then respawn',
        (s) => {
          s.equip(bare('svd'));
          s.respawn([12.8, 0.4, 2], 0);
        },
      ],
      ['equip', (s) => s.equip(bare('svd'))],
      ['respawn', (s) => s.respawn([12.8, 0.4, 2], 0)],
    ];
    for (const [label, take] of takes) {
      const s = sprinting();
      sprintTick(s, true);
      // The press waits, the gun still swung low.
      expect(s.handling.sprint, label).toBeGreaterThanOrEqual(ht.sprintBlocksFire);
      expect(s.shots, label).toHaveLength(0);
      take(s);
      s.intent = idleIntent();
      for (let k = 0; k < 30; k++) {
        s.tick();
        expect(s.shots, `${label}, tick ${k}`).toHaveLength(0);
      }
      // The gun came up, and nothing was waiting for it.
      expect(s.handling.sprint, label).toBe(0);
      expect(s.weapon.shotsFired, label).toBe(0);
    }
  });

  it("a deploy starts the hands clean: the last gun's pump is not heard after it, the gun comes up out of no sprint, and no reload's pose is carried", () => {
    // With no tick between it and the last life's ticks (main.ts runs none in 'ready'): the next
    // match's deploy (equip, then respawn), a loadout taken in a pause (equip), or a life begun
    // afresh (respawn). Each starts the hands as a fresh pair's.
    const takes: [string, (s: Session, loadout: Loadout) => void][] = [
      [
        'equip, then respawn',
        (s, loadout) => {
          s.equip(loadout);
          s.respawn([12.8, 0.4, 2], 0);
        },
      ],
      ['equip', (s, loadout) => s.equip(loadout)],
      ['respawn', (s) => s.respawn([12.8, 0.4, 2], 0)],
    ];
    for (const [label, take] of takes) {
      // The shotgun fired three ticks before the deploy, its pump (0.12 s on) still to come: none is
      // heard after it, at the new spawn or anywhere.
      const g = stand(bare('m870'));
      g.intent = { ...idleIntent(), fire: true };
      g.tick();
      expect(g.shots, label).toHaveLength(1);
      g.intent = idleIntent();
      for (let k = 0; k < 2; k++) g.tick();
      expect(g.drainEvents().handling, label).toEqual([]);
      take(g, bare('m870'));
      for (let k = 0; k < 60; k++) {
        g.tick();
        expect(g.drainEvents().handling, `${label}, tick ${k}`).toEqual([]);
      }
      // A full sprint, then the deploy: drawn at rest before any tick runs, and the first tick's delta
      // has none of the sprint's pose (the yaw is the sprint's alone; the pitch the sprint's or a landing's).
      const s = sprinting();
      expect(s.handling.delta.yaw, label).toBe(ht.sprintYawDeg);
      take(s, bare('ak74'));
      for (const alpha of [0, 0.5, 1]) expect(s.handling.at(alpha), `${label}, alpha ${alpha}`).toEqual(ZERO_HANDS);
      s.intent = idleIntent();
      s.tick();
      expect(s.handling.sprint, label).toBe(0);
      expect([s.handling.delta.yaw, s.handling.delta.pitch], label).toEqual([0, 0]);
      // The AK part-way through its reload, tilted over, then the deploy: the first tick's pitch and
      // roll carry none of the reload's pose, with nothing let go to ease back from (the gun in the
      // hands after it, a fresh one or the same one rearmed, is not reloading).
      const r = stand(bare('ak74'));
      r.weapon.rounds = 10;
      r.intent = { ...idleIntent(), reload: true };
      r.tick();
      r.intent = idleIntent();
      for (let k = 0; k < 40; k++) r.tick();
      expect(r.weapon.reloading, label).toBe(true);
      expect(r.handling.delta.roll, label).toBeGreaterThan(20);
      expect(r.handling.delta.pitch, label).toBeGreaterThan(5);
      take(r, bare('ak74'));
      r.tick();
      expect(r.weapon.reloading, label).toBe(false);
      expect([r.handling.delta.pitch, r.handling.delta.roll], label).toEqual([0, 0]);
    }
  });

  it("killed, the hands are quiet: a reload under way and the shotgun's pump to come are not heard, and the gun eases to rest", () => {
    // Each gun killed part-way through its reload, its first mark heard and more to come: the AK, the
    // M249, the M870 (three shells) and the pistol. The reload runs out while the player is dead.
    const cases: [Loadout, number][] = [
      [bare('ak74'), 0],
      [bare('m249'), 0],
      [bare('m870'), 0],
      [bare('ak74'), 1],
    ];
    for (const [loadout, slot] of cases) {
      const label = slot === 0 ? loadout.primary : loadout.secondary;
      const s = stand(loadout);
      s.intent = { ...idleIntent(), swap: slot };
      for (let k = 0; k < 60; k++) s.tick();
      const w = s.weapon;
      w.rounds = w.spec.magazine - 3;
      s.intent = { ...idleIntent(), reload: true };
      s.tick();
      s.intent = idleIntent();
      s.drainEvents();
      // Bounded, so a mark never heard fails the expect below rather than hanging the worker.
      let first: HandlingCue[] = [];
      for (let k = 0; k < 8 * 60 && first.length === 0; k++) {
        s.tick();
        first = s.drainEvents().handling.map((c) => c.cue);
      }
      expect(first, label).toEqual([label === 'm870' ? 'shell' : 'mag-out']);
      const was = s.handling.delta;
      s.alive = false;
      const deltas: HandsDelta[] = [];
      for (let k = 0; k < 8 * 60 && (k < 20 || w.reloading); k++) {
        s.tick();
        expect(s.drainEvents().handling, `${label}, ${k + 1} ticks dead`).toEqual([]);
        deltas.push(s.handling.delta);
      }
      expect(w.reloading, label).toBe(false);
      // The gun eases to rest from where it was, as one put away mid-reload does: no snap, falling
      // all the way, and none of the reload's turn or its push back left once reload_cut_s is past.
      for (const k of ['pitch', 'roll'] as const) {
        if (Math.abs(was[k]) < 1) continue;
        expect(deltas[0][k] / was[k], `${label}: ${k}`).toBeGreaterThan(0.9);
        for (let j = 1; j < deltas.length; j++) expect(Math.abs(deltas[j][k]), `${label}: ${k}, ${j + 1} ticks dead`).toBeLessThanOrEqual(Math.abs(deltas[j - 1][k]) + 1e-12);
      }
      const rest = deltas[Math.round(ht.reloadCutS / TICK) - 1];
      for (const v of [rest.pitch, rest.yaw, rest.roll, rest.offset[2]]) expect(v, label).toBeCloseTo(0, 9);
      if (label !== 'ak74') continue;
      // Back in, the hands are heard again.
      s.respawn([12.8, 0.4, 2], 0);
      for (let k = 0; k < 30; k++) s.tick();
      s.drainEvents();
      s.weapon.rounds = 10;
      s.intent = { ...idleIntent(), reload: true };
      const back: HandlingCue[] = [];
      for (let k = 0; k < 4 * 60; k++) {
        s.tick();
        s.intent = idleIntent();
        back.push(...s.drainEvents().handling.map((c) => c.cue));
      }
      expect(back).toEqual(['mag-out', 'mag-in', 'bolt']);
    }
    // The shotgun killed two ticks after its shot, its pump (0.12 s on) still to come: not heard.
    const g = stand(bare('m870'));
    g.intent = { ...idleIntent(), fire: true };
    g.tick();
    expect(g.shots).toHaveLength(1);
    g.intent = idleIntent();
    for (let k = 0; k < 2; k++) g.tick();
    expect(g.drainEvents().handling).toEqual([]);
    g.alive = false;
    for (let k = 0; k < 60; k++) {
      g.tick();
      expect(g.drainEvents().handling, `the pump, ${k + 1} ticks dead`).toEqual([]);
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

  it("only a gun's trigger and sights drop the sprint: with the shovel out, a sprint stays one with either button held", () => {
    for (const button of ['fire', 'aim'] as const) {
      const press = (i: MoveIntent): MoveIntent => (button === 'fire' ? { ...i, fire: true } : { ...i, aim: true });
      const s = stand();
      const walk = s.controller.t.stances[Stance.STANDING].speed;
      // F held with Shift and W: the gun put away and the shovel out (the sod is no shovel work, so nothing is dug).
      const dig = { ...idleIntent(), forward: 1, sprint: true, dig: true };
      s.intent = dig;
      for (let k = 0; k < 60; k++) s.tick();
      expect([s.held, s.ready, s.digging, s.handling.sprint], button).toEqual([SHOVEL_HELD, 1, true, 1]);
      const speed = s.player.velocity.horizontalLength;
      expect(speed, button).toBeGreaterThan(walk * 1.3);
      // The button held as well: nothing to fire and no sights to raise, so the sprint goes on.
      s.intent = press(dig);
      for (let k = 0; k < 30; k++) {
        s.tick();
        expect(s.handling.sprint, `${button}, tick ${k}`).toBe(1);
        expect(s.player.velocity.horizontalLength, `${button}, tick ${k}`).toBe(speed);
      }
      expect([s.shots.length, s.aimed], button).toEqual([0, 0]);
      // F let go: the shovel goes down and the gun comes up, and the sprint goes on until the gun is
      // up to take the button. Up, the button drops the sprint on the next tick, as Task 2 pinned.
      s.intent = press({ ...idleIntent(), forward: 1, sprint: true });
      let ticks = 0;
      while (!(s.held === 0 && s.ready >= 1)) {
        s.tick();
        expect(s.handling.sprint, `${button}, the gun coming up, tick ${ticks}`).toBe(1);
        expect(++ticks).toBeLessThan(60);
      }
      s.tick();
      expect(s.handling.sprint, button).toBeCloseTo(1 - TICK / ht.sprintOutS, 12);
    }
  });

  it('mid-climb neither the trigger nor the sights are taken: both wait out the climb, and a press held through it fires as it ends', () => {
    // The gun-up rule lives once (session.ts gunUp): the trigger, the sights, and either button's drop
    // of the sprint wait out a climb, the hands on the parapet. A timber tread, a bench 1 m over it at
    // z 3.0–3.5 m and a clay parapet behind: walked into, the bench is climbed. The trigger held: the AK
    // (automatic) and the SVD (a shot a press, so the press must still be one when the climb ends).
    const map = new BrickMap({ x: 64, y: 64, z: 64 });
    map.fillBox(0, 0, 0, 64, 4, 64, P.TIMBER);
    map.fillBox(0, 4, 30, 64, 14, 35, P.TIMBER);
    map.fillBox(0, 13, 30, 64, 14, 35, P.BENCH);
    map.fillBox(0, 4, 35, 64, 28, 64, P.CLAY);
    const cases: [string, 'fire' | 'aim', Loadout | null][] = [
      ['the AK, fire held', 'fire', null],
      ['the SVD, fire held', 'fire', bare('svd')],
      ['the sights held', 'aim', null],
    ];
    for (const [label, button, loadout] of cases) {
      const s = Session.create({ map, plan: null, spawn: { position: [3.2, 0.4, 1.5] } }, tun, 7, 0);
      if (loadout) s.equip(loadout);
      for (let k = 0; k < 40; k++) s.tick();
      s.intent = { ...idleIntent(), forward: 1 };
      for (let k = 0; k < 240 && s.player.climbTo === null; k++) s.tick();
      expect(s.player.climbTo, label).not.toBeNull();
      // The button held from the climb's first tick: no shot leaves, and the sights do not rise.
      s.intent = { ...idleIntent(), forward: 1, [button]: true };
      let climbing = 0;
      for (let k = 0; k < 240; k++) {
        s.tick();
        if (s.player.climbTo === null) break;
        climbing++;
        expect(s.shots, `${label}, ${climbing} ticks into the climb`).toHaveLength(0);
        expect(s.aimed, `${label}, ${climbing} ticks into the climb`).toBe(0);
      }
      expect(s.player.climbTo, label).toBeNull();
      expect(s.player.position.y, label).toBeCloseTo(1.4, 6);
      expect(climbing, label).toBeGreaterThan(10);
      // On the bench, the climb over (the first tick whose combat finds none under way): the press
      // held through it fires there, its first shot, and the sights begin to come up.
      if (button === 'fire') expect([s.shots.length, s.weapon.shotsFired], label).toEqual([1, 1]);
      else expect([s.shots.length, s.aimed > 0], label).toEqual([0, true]);
    }
  });

  it('a press taken before a climb is not taken again as it ends: held through it, a gun that fires once a press neither fires nor clicks empty; let go and pressed, it is a press again', () => {
    // The climb holds the shot; it does not let go of the trigger. Before the ruling the trigger was
    // taken mid-climb, so a press held through it stayed the one press, and it still does. Fire held
    // from a standstill, walking at the bench: the press is taken on its first tick, then held
    // through the climb and on along the bench. The SVD, the AK switched to single shots (B), and the
    // SVD on its last round, which that press empties: held, it does not click.
    const cases: [string, Loadout | undefined, (s: Session) => void][] = [
      ['the SVD', bare('svd'), () => {}],
      [
        'the AK in single shots',
        undefined,
        (s) => {
          s.intent = { ...idleIntent(), mode: true };
          s.tick();
          expect(s.weapon.semi).toBe(true);
        },
      ],
      ['the SVD on its last round', bare('svd'), (s) => (s.weapon.rounds = 1)],
    ];
    for (const [label, loadout, prep] of cases) {
      const s = facingBench(10, loadout);
      prep(s);
      s.drainEvents();
      const last = s.weapon.rounds === 1;
      const held = throughClimb(s, 180, () => walkAt(true));
      expect(held.began, label).toBeGreaterThan(0);
      expect(held.ended, label).toBeGreaterThan(held.began + 10);
      expect(held.ended, label).toBeLessThan(150);
      expect(s.player.position.y, label).toBeCloseTo(1.4, 6);
      // Its one shot, on the press's tick: none mid-climb, none as the climb ends, none on the bench.
      expect([held.shots, held.dry, s.weapon.shotsFired], label).toEqual([[0], [], 1]);
      expect(s.weapon.reloading, label).toBe(false);
      // Let go for a tick and pressed again on the bench: a press, so a shot, or on an empty magazine a click.
      const again = throughClimb(s, 10, (k) => walkAt(k > 0));
      expect([again.shots, again.dry], label).toEqual(last ? [[], [1]] : [[1], []]);
    }
  });

  it('a press not yet taken waits out a climb, as one the sprint holds back does, and fires as it ends; a gun put down mid-climb lets it go', () => {
    // When the climb begins with nothing pressed: sessions alike run alike up to the press.
    const begins = (h: number, intent: (k: number) => MoveIntent, loadout?: Loadout) => throughClimb(facingBench(h, loadout), 180, intent).began;
    const sprintAt = (fire: boolean): MoveIntent => ({ ...idleIntent(), forward: 1, sprint: true, fire });

    // A tap in a full sprint's last ticks before the bench: still waiting, the gun swung low, as the
    // climb begins. Before the ruling it fired mid-climb as the blend fell under 0.3; it now waits the
    // climb out and fires as it ends, where a press held from the climb's first tick fires. Shift and W
    // held, neither press holds the sprint off while the climb holds the gun (a press drops it only
    // while a gun is up to take it), so the climb's last tick, on the bench's top, brings a tick's
    // share of it back.
    const sprinted = begins(10, () => sprintAt(false));
    const fromSprint: [string, (k: number) => boolean, boolean][] = [
      ['a tap waiting out the sprint', (k) => k === sprinted - 2, false],
      ["a press held from the climb's first tick", (k) => k >= sprinted, true],
    ];
    for (const [label, fire, held] of fromSprint) {
      const out = throughClimb(facingBench(10), 180, (k) => sprintAt(fire(k)));
      expect(out.blends[sprinted - 3], label).toBe(1);
      expect(out.began, label).toBeGreaterThanOrEqual(sprinted);
      expect(out.blends[out.began - 1], label).toBeGreaterThanOrEqual(ht.sprintBlocksFire);
      expect(out.ended, label).toBeGreaterThan(out.began + 10);
      // None before the climb or in it: the first leaves as it ends, and a tap's is its only one (the
      // AK held fires on at its rate).
      expect(out.shots[0], label).toBe(out.ended);
      if (!held) expect(out.shots, label).toEqual([out.ended]);
      expect(out.blends[out.ended], label).toBeCloseTo(TICK / ht.sprintInS, 12);
    }

    // A tap mid-climb, of a tick or of five: it waits, as a tap out of a sprint does, and fires as the climb ends.
    const walked = begins(10, () => walkAt(false));
    for (const tap of [1, 5]) {
      const mid = throughClimb(facingBench(10), 180, (k) => walkAt(k >= walked + 3 && k < walked + 3 + tap));
      expect(mid.began, `a ${tap}-tick tap`).toBe(walked);
      expect(mid.ended, `a ${tap}-tick tap`).toBeGreaterThan(walked + 3 + tap);
      expect(mid.shots, `a ${tap}-tick tap`).toEqual([mid.ended]);
    }

    // The SVD's press taken before the climb, let go mid-climb and pressed again: that is a press, and
    // it fires as the climb ends.
    const svd = begins(10, () => walkAt(true), bare('svd'));
    const re = throughClimb(facingBench(10, bare('svd')), 180, (k) => walkAt(k < svd + 3 || k >= svd + 6));
    expect(re.began).toBe(svd);
    expect(re.shots).toEqual([0, re.ended]);

    // A tap mid-climb up a bench 1.5 m high, then the pistol asked for: the AK goes down, which lets
    // the press go as any gun put down does, and the pistol is up before the climb ends. Nothing
    // fires: the press was not made for it.
    const tall = begins(15, () => walkAt(false));
    const put = facingBench(15);
    const lead = throughClimb(put, tall + 30, (k) => walkAt(k === tall + 2, k === tall + 3 ? 1 : undefined));
    expect(lead.began).toBe(tall);
    expect(put.player.climbTo).not.toBeNull();
    expect([put.held, put.ready]).toEqual([1, 1]);
    const rest = throughClimb(put, 60, () => walkAt(false));
    expect(rest.ended).toBeGreaterThan(0);
    expect(put.player.position.y).toBeCloseTo(1.9, 6);
    expect([lead.shots, rest.shots, put.weapon.shotsFired]).toEqual([[], [], 0]);
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
    const froms: [number, number, number][][] = [[], []];
    for (let k = 0; k < 60; k++) {
      for (const s of [moving, still]) {
        s.player.yaw = (s.player.yaw + 100 * TICK) % 360;
        s.tick();
      }
      // Where the rounds leave and go: the eye, the view's line, the same whatever the hands do.
      expect(moving.shots).toEqual(still.shots);
      for (const shot of moving.shots) expect(shot.origin).toEqual(eyeOf(moving));
      expect(struck(moving)).toEqual(struck(still));
      [moving, still].forEach((s, j) => froms[j].push(...drawnFrom(s)));
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
    // As do their strikes' last streaks: each from a muzzle its own session's shots left as drawn.
    expect(froms[0].length).toBeGreaterThan(0);
    for (const f of froms[0]) expect(a.map((e) => e.muzzle)).toContainEqual(f);
    for (const f of froms[1]) expect(b.map((e) => e.muzzle)).toContainEqual(f);
  });

  it("after a jump the drawn muzzle carries the eye's landing dip, and no round does: the shots are a dipless session's", () => {
    // Two sessions alike but that one has no landing dip at all ([camera] landing_dip 0: the muzzle as
    // it was placed before it carried one). Both stand firing the AK, jump, and fire on through the
    // landing and the dip's recovery. Every round leaves the undipped eye along the same line and
    // strikes where the other's does; the drawn muzzle and port (the flash, the tracer's start, the
    // brass, the cues) are carried down with the eye, by the camera's dip for the tick's landing
    // (landing_dip by landingImpact / 8, held to 8, as camera-rig.ts draws it), along the world's up.
    const raw = tun.raw();
    (raw.camera as Record<string, unknown>).landing_dip = 0;
    const dipped = stand();
    const flat = stand(undefined, 0, 7, new Tunables(raw));
    const dipOf = (s: Session) => (-Math.min(s.player.landingImpact, 8) / 8) * tun.f('camera.landing_dip');
    let landed = -1;
    let landedDip = 0;
    let deep = 0;
    for (let k = 0; k < 90; k++) {
      for (const s of [dipped, flat]) {
        s.intent = { ...idleIntent(), fire: true, jump: k === 10 };
        s.tick();
      }
      // The bodies are the same: only where the gun is drawn differs.
      expect(dipped.player.position, `tick ${k}`).toEqual(flat.player.position);
      expect(dipped.player.landingImpact, `tick ${k}`).toBe(flat.player.landingImpact);
      const dip = dipOf(dipped);
      if (landed < 0 && k > 10 && dipped.player.onGround) [landed, landedDip] = [k, dip];
      for (const [a, b] of [[dipped.muzzle(), flat.muzzle()], [dipped.port(), flat.port()]]) {
        expect(a[0], `tick ${k}`).toBe(b[0]);
        expect(a[1] - b[1], `tick ${k}`).toBeCloseTo(dip, 12);
        expect(a[2], `tick ${k}`).toBe(b[2]);
      }
      // Where the rounds leave and go: the undipped eye and the view's line, the same in each.
      expect(dipped.shots, `tick ${k}`).toEqual(flat.shots);
      for (const shot of dipped.shots) expect(shot.origin, `tick ${k}`).toEqual(eyeOf(dipped));
      expect(struck(dipped), `tick ${k}`).toEqual(struck(flat));
      expect(dipped.rounds.count, `tick ${k}`).toBe(flat.rounds.count);
      for (let i = 0; i < dipped.rounds.count; i++) expect(dipped.rounds.position(i), `tick ${k}`).toEqual(flat.rounds.position(i));
      // Each shot's event: the same round, its flash and tracer at its own session's muzzle.
      const [ea, eb] = [dipped.drainEvents().shots, flat.drainEvents().shots];
      expect(ea.map((e) => [e.origin, e.dir, e.tracer]), `tick ${k}`).toEqual(eb.map((e) => [e.origin, e.dir, e.tracer]));
      ea.forEach((e, i) => expect(e.muzzle[1] - eb[i].muzzle[1], `tick ${k}`).toBeCloseTo(dip, 12));
      if (dip < -0.01) deep += ea.length;
    }
    // It came down off its jump with the eye dipped most of 6 cm, and rounds left while it was still
    // dipped over a centimetre.
    expect(landed).toBeGreaterThan(20);
    expect(landedDip).toBeLessThan(-0.04);
    expect(deep).toBeGreaterThanOrEqual(2);
  });

  it('aimed, breathing still moves the drawn gun, a third of it, and never the round', () => {
    // The SVD under its scope: at 0.85 aimed the scope hides the gun, but the gun still breathes.
    const scoped: Loadout = { primary: 'svd', secondary: 'pm', fits: { svd: { optic: 'scope', muzzle: 'none', under: 'none', side: 'none' } } };
    const moving = stand(scoped);
    const still = stand(scoped);
    still.handsStill = true;
    for (const s of [moving, still]) s.intent = { ...idleIntent(), aim: true };
    const ups: number[] = [];
    let arrived: number | null = null;
    let overshoot = 0;
    for (let k = 0; k < 240; k++) {
      for (const s of [moving, still]) s.tick();
      if (moving.aimed < 1) continue;
      arrived ??= k;
      // Still and aimed, the hands' delta is breathing alone, at 0.35 of it, carried along the view.
      // For aim_overshoot_s from the tick the sights are up, the overshoot as well (the shots spec's
      // §3): the hands' pitch, muzzle up, which turns the gun about its own right and so moves the
      // drawn muzzle up and forward, never aside. What it cannot move holds all the while.
      const hands = moving.handling.delta;
      expect([hands.offset[2], hands.yaw, hands.roll], `tick ${k}`).toEqual([0, 0, 0]);
      expect(Math.abs(hands.offset[1]), `tick ${k}`).toBeLessThanOrEqual(0.0025 * 0.35);
      expect(Math.abs(hands.offset[0]), `tick ${k}`).toBeLessThanOrEqual(0.0015 * 0.35);
      const { forward, right, up } = basisOf(moving);
      const d = sub(moving.muzzle(), still.muzzle());
      expect(dot(d, right), `tick ${k}`).toBeCloseTo(hands.offset[0], 12);
      if ((k - arrived) * TICK < ht.aimOvershootS) {
        expect(hands.pitch, `tick ${k}`).toBeGreaterThanOrEqual(0);
        expect(hands.pitch, `tick ${k}`).toBeLessThanOrEqual(ht.aimOvershootDeg);
        overshoot = Math.max(overshoot, hands.pitch);
        // Turned by a about the gun's own origin, its muzzle (m, model metres) moves beyond breathing
        // up by m_z sin a + m_y (cos a − 1) and forward by m_z (cos a − 1) − m_y sin a.
        const a = (hands.pitch * Math.PI) / 180;
        const [, my, mz] = moving.arm.spec.muzzle;
        expect(dot(d, up) - hands.offset[1], `tick ${k}`).toBeCloseTo(mz * Math.sin(a) + my * (Math.cos(a) - 1), 9);
        expect(dot(d, forward), `tick ${k}`).toBeCloseTo(mz * (Math.cos(a) - 1) - my * Math.sin(a), 9);
        continue;
      }
      expect(hands.pitch, `tick ${k}`).toBe(0);
      expect(dot(d, up)).toBeCloseTo(hands.offset[1], 12);
      expect(dot(d, forward)).toBeCloseTo(0, 12);
      ups.push(hands.offset[1]);
    }
    // The sights' arrival carried the drawn gun its whole overshoot.
    expect(overshoot).toBeCloseTo(ht.aimOvershootDeg, 12);
    expect(ups.length).toBeGreaterThan(180);
    expect(Math.max(...ups) - Math.min(...ups)).toBeGreaterThan(0.0005);
    // A shot from each: the same round, from the eye, and the same where it lands.
    for (const s of [moving, still]) s.intent = { ...s.intent, fire: true };
    const froms: [number, number, number][][] = [[], []];
    for (let k = 0; k < 60; k++) {
      for (const s of [moving, still]) s.tick();
      expect(moving.shots).toEqual(still.shots);
      for (const shot of moving.shots) expect(shot.origin).toEqual(eyeOf(moving));
      expect(struck(moving)).toEqual(struck(still));
      [moving, still].forEach((s, j) => froms[j].push(...drawnFrom(s)));
    }
    expect(moving.weapon.shotsFired).toBe(1);
    // Its strike's last streak drawn from the muzzle it left, as each session drew it.
    const [a, b] = [moving.drainEvents().shots, still.drainEvents().shots];
    expect(froms[0]).toEqual([a[0].muzzle]);
    expect(froms[1]).toEqual([b[0].muzzle]);
  });

  it('a round fired while the sights overshoot leaves along the aim, exactly as with the hands held still', () => {
    // The AK on full auto from the tick the sights arrive: its rounds leave as the overshoot carries
    // the drawn gun up past the aim, as it eases back, and after. Each leaves the eye along the view
    // plus recoil, to the bit the still hands' round, and lands where it does; and so with no
    // overshoot at all (aim_overshoot_deg 0), which no hands, still or not, can carry.
    const raw = tun.raw();
    (raw.handling as Record<string, unknown>).aim_overshoot_deg = 0;
    const moving = stand();
    const still = stand();
    const flat = stand(undefined, 0, 7, new Tunables(raw));
    still.handsStill = true;
    const ads = moving.arm.spec.adsTimeS;
    let firing = false;
    let was = 0;
    const left = { rising: 0, easing: 0, after: 0 };
    // Each session's strikes' drawn starts, and the muzzles its shots left as drawn (see `struck`).
    const froms: [number, number, number][][] = [[], [], []];
    const muzzles: [number, number, number][][] = [[], [], []];
    for (let k = 0; k < 60; k++) {
      // As the session raises the sights: this tick's blend reaches 1, and the trigger is pulled with it.
      firing ||= Math.min(1, moving.aimed + TICK / ads) >= 1;
      for (const s of [moving, still, flat]) {
        s.intent = { ...idleIntent(), aim: true, fire: firing };
        s.tick();
      }
      const pitch = moving.handling.delta.pitch;
      expect(flat.handling.delta.pitch, `tick ${k}`).toBe(0);
      for (const other of [still, flat]) {
        expect(moving.shots, `tick ${k}`).toEqual(other.shots);
        expect(struck(moving), `tick ${k}`).toEqual(struck(other));
      }
      [moving, still, flat].forEach((s, j) => froms[j].push(...drawnFrom(s)));
      for (const shot of moving.shots) expect(shot.origin).toEqual(eyeOf(moving));
      const events = [moving, still, flat].map((s) => s.drainEvents().shots);
      events.forEach((es, j) => muzzles[j].push(...es.map((e) => e.muzzle)));
      const [a, b, c] = events.map((es) => es.map((e) => [e.origin, e.dir, e.tracer]));
      expect(a, `tick ${k}`).toEqual(b);
      expect(a, `tick ${k}`).toEqual(c);
      if (a.length > 0) {
        expect(firing).toBe(true);
        if (pitch > was) left.rising++;
        else if (pitch > 0) left.easing++;
        else left.after++;
      }
      was = pitch;
    }
    // Rounds left on the overshoot's way up, on its way back, and after it.
    expect(left.rising).toBeGreaterThan(0);
    expect(left.easing).toBeGreaterThan(0);
    expect(left.after).toBeGreaterThan(0);
    // Their strikes' last streaks start where their own session's gun was drawn as each round left.
    expect(froms[0].length).toBeGreaterThan(0);
    froms.forEach((fs, j) => {
      for (const f of fs) expect(muzzles[j]).toContainEqual(f);
    });
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
    // None pushed while it was put away.
    expect(pushed).toBe(2);
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

  it("the hands are fed the body's share of a run, stride, ground and landing: a Handling fed them alike moves alike", () => {
    // From the session's first tick: settling from the spawn, standing, then walking forward at the
    // standing speed, lifted a metre mid-stride and landing again. A Handling of the test's own is
    // fed what the session reads off the body each tick (its share of a run is its speed over
    // run_mps), and must agree to the bit.
    const s = Session.create({ map: arena(), plan: null, spawn: { position: [12.8, 0.4, 2] } }, tun, 7, 0);
    const twin = new Handling(handlingTunables(tun));
    const dt = s.clock.dt;
    const walk = s.controller.t.stances[Stance.STANDING].speed * s.arm.spec.move;
    let ratio = 0;
    let peak = -1;
    let landings = 0;
    let landedAt = 0;
    for (let k = 0; k < 360; k++) {
      if (k === 240) {
        const at = s.player.position;
        s.teleport([at.x, at.y + 1, at.z], s.player.yaw, s.player.pitch);
      }
      s.intent = k < 40 ? idleIntent() : { ...idleIntent(), forward: 1 };
      const wasOnGround = s.player.onGround;
      s.tick();
      const p = s.player;
      twin.tick({
        dt,
        time: s.ticks * dt,
        yawRate: 0,
        pitchRate: 0,
        speedRatio: p.velocity.horizontalLength / ht.runMps,
        bobPhase: p.bobPhase,
        onGround: p.onGround,
        landingImpact: p.landingImpact,
        sprinting: false,
        aimed: s.aimed,
        reload: null,
        sinceShot: s.weapon.sinceShot,
        gun: gunClass(s.arm.spec.gun.key),
      });
      expect(s.handling.delta, `tick ${k}`).toEqual(twin.delta);
      if (k > 40 && !wasOnGround && p.onGround) {
        landings++;
        landedAt = p.landingImpact;
      }
      // At a steady walk, breathing (what is left of it) taken out: the up-down bob alone.
      if (k >= 120 && k < 240) {
        expect(p.velocity.horizontalLength).toBeCloseTo(walk, 9);
        ratio = p.velocity.horizontalLength / ht.runMps;
        const breath = (1 - ratio) * ht.breathUpM * Math.sin(2 * Math.PI * ht.breathUpHz * s.ticks * dt);
        peak = Math.max(peak, s.handling.delta.offset[1] - breath);
      }
    }
    // The fall's landing was hard enough to dip the hands well (more than half a hard one).
    expect(landings).toBe(1);
    expect(landedAt).toBeGreaterThan(0.5 * ht.landingHardMps);
    // The bob's height: 0.008 m by the walk's share of a run (4.1 / 5), at the stride's top.
    expect(ratio).toBeCloseTo(walk / ht.runMps, 12);
    expect(peak).toBeLessThanOrEqual(ht.bobUpM * ratio + 1e-9);
    expect(peak).toBeGreaterThan(0.99 * ht.bobUpM * ratio);
  });

  it("the hands' share of a run is the body's speed over [handling] run_mps: at a run_mps of 8, a walk bobs 0.008 m × (speed / 8)", () => {
    // Every other test runs at 5, the literal the share was once divided by: this one is not.
    const raw = tun.raw();
    (raw.handling as Record<string, unknown>).run_mps = 8;
    const t8 = new Tunables(raw);
    const h8 = handlingTunables(t8);
    expect(h8.runMps).toBe(8);
    const s = stand(undefined, 0, 7, t8);
    const walk = s.controller.t.stances[Stance.STANDING].speed * s.arm.spec.move;
    s.intent = { ...idleIntent(), forward: 1 };
    let peak = -1;
    for (let k = 0; k < 200; k++) {
      s.tick();
      if (k < 80) continue;
      // At a steady walk, breathing (what is left of it) taken out: the up-down bob alone.
      expect(s.player.velocity.horizontalLength, `tick ${k}`).toBeCloseTo(walk, 9);
      const breath = (1 - walk / 8) * h8.breathUpM * Math.sin(2 * Math.PI * h8.breathUpHz * s.ticks * TICK);
      peak = Math.max(peak, s.handling.delta.offset[1] - breath);
    }
    // At the stride's top: 0.008 m by the walk's share of a run of 8 (4.1 / 8).
    expect(peak).toBeLessThanOrEqual(h8.bobUpM * (walk / 8) + 1e-9);
    expect(peak).toBeGreaterThan(0.99 * h8.bobUpM * (walk / 8));
  });

  it('a landing dips the gun on the tick it lands, by its share of a hard one: 0.03 m and 4° × min(1, landingImpact / 8)', () => {
    // A jump, and falls of 1 m (most of a hard landing) and 3 m (more than one: the full dip). A jump
    // on flat ground comes down at about its jump speed (5 m/s), set down by the ground probe as its
    // last tick in the air ends within 0.06 m of the ground (character.ts): about half a hard one.
    for (const [how, drop] of [['a jump', 0], ['a fall of 1 m', 1], ['a fall of 3 m', 3]] as const) {
      const s = stand();
      if (drop > 0) s.teleport([12.8, 0.4 + drop, 2], 0, 0);
      s.intent = { ...idleIntent(), jump: drop === 0 };
      let share = -1;
      for (let k = 0; k < 120 && share < 0; k++) {
        const wasOnGround = s.player.onGround;
        s.tick();
        s.intent = idleIntent();
        if (wasOnGround || !s.player.onGround) continue;
        // The tick it lands, standing still: the dip on whatever breathing has the gun doing.
        share = Math.min(1, s.player.landingImpact / ht.landingHardMps);
        const d = s.handling.delta;
        const breath = ht.breathUpM * Math.sin(2 * Math.PI * ht.breathUpHz * s.ticks * TICK);
        expect(d.pitch, how).toBeCloseTo(ht.landingPitchDeg * share, 12);
        expect(d.offset[1] - breath, how).toBeCloseTo(-ht.landingDropM * share, 9);
      }
      expect(share, how).toBeGreaterThanOrEqual(0);
      if (drop === 0) {
        expect(share, how).toBeGreaterThan(0.4);
        expect(share, how).toBeLessThan(1);
      }
      if (drop === 1) {
        expect(share, how).toBeGreaterThan(0.5);
        expect(share, how).toBeLessThan(1);
      }
      if (drop === 3) expect(share, how).toBe(1);
    }
  });
});
