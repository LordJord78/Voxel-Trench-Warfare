/**
 * The match's rules (the multiplayer spec's §4), as the room applies them: everyone's health, who
 * killed whom, the teams' scores, respawns, and the win. Pure and given its clock, so the room's
 * Durable Object and the tests run the same rules.
 *
 * - A round does its zone's damage: the head 100 (a kill), the torso 55, a limb 30; times its gun's
 *   scale (net/gear.ts), where the claim says which gun.
 * - Health comes back at REGEN_PER_S a second, REGEN_DELAY_MS after the last hurt.
 * - The dead respawn after the match's respawn time, protected for PROTECT_MS (and no longer once
 *   they fire, which the client stops sending as protection: the room only times it out).
 * - Killing an enemy scores their team a point; killing a teammate costs the killer's team one;
 *   the battle's kills (shells, the enemy line's fire) and a player's own score nothing.
 * - The first team to the kill target wins; the match is then over.
 */

import { gunDamage } from './gear';
import type { Cause, Team, Zone } from './protocol';

export const DAMAGE: Record<Zone, number> = { head: 100, torso: 55, limb: 30 };
export const HP = 100;
export const REGEN_DELAY_MS = 6000;
export const REGEN_PER_S = 10;
export const PROTECT_MS = 2000;
/** A dead player's rounds still in the air may still kill, this long after they died. */
export const DEAD_HANDS_MS = 1500;
/** Hits a second a shooter may claim: a magazine on full auto is ten rounds a second. */
const CLAIMS_PER_S = 15;

export interface Fighter {
  id: number;
  team: Team;
  hp: number;
  alive: boolean;
  diedAt: number;
  respawnAt: number;
  protectedUntil: number;
  hurtAt: number;
  kills: number;
  deaths: number;
  /** A sliding count of claims, for the rate limit. */
  claims: number;
  claimsAt: number;
}

export type MatchEvent =
  | { t: 'hurt'; victim: number; hp: number; from: number }
  | { t: 'death'; victim: number; killer: number; zone: Zone | null; teamkill: boolean; cause: Cause }
  | { t: 'respawn'; id: number; spawn: number }
  | { t: 'score'; red: number; blue: number }
  | { t: 'over'; winner: Team };

export class MatchRules {
  readonly fighters = new Map<number, Fighter>();
  score: Record<Team, number> = { red: 0, blue: 0 };
  winner: Team | null = null;
  private spawns = 0;
  /** The last tick's clock: health comes back for the time since. */
  private tickedAt: number | null = null;

  constructor(
    readonly killTarget: number,
    readonly respawnMs: number,
  ) {}

  /** A player in the match: alive, at full health, protected as they spawn. */
  join(id: number, team: Team, now: number): MatchEvent[] {
    const f = this.fighters.get(id);
    if (f) {
      f.team = team;
      return [];
    }
    this.fighters.set(id, { id, team, hp: HP, alive: true, diedAt: 0, respawnAt: 0, protectedUntil: now + PROTECT_MS, hurtAt: 0, kills: 0, deaths: 0, claims: 0, claimsAt: now });
    return [{ t: 'respawn', id, spawn: this.nextSpawn() }];
  }

  leave(id: number): void {
    this.fighters.delete(id);
  }

  /** A shooter's claim that their round (from `gun`, if it says) struck `victim` in `zone`: what follows from it, if it stands. */
  hit(shooter: number, victim: number, zone: Zone, now: number, gun?: number): MatchEvent[] {
    const s = this.fighters.get(shooter);
    const v = this.fighters.get(victim);
    if (!s || !v || shooter === victim || this.winner) return [];
    if (!s.alive && now - s.diedAt > DEAD_HANDS_MS) return [];
    s.claims = Math.max(0, s.claims - ((now - s.claimsAt) / 1000) * CLAIMS_PER_S);
    s.claimsAt = now;
    if (s.claims >= CLAIMS_PER_S) return [];
    s.claims++;
    return this.harm(v, gunDamage(DAMAGE[zone], gun), shooter, zone, 'round', now);
  }

  /** The battle hurt `victim` (its rounds, a shell's blast): no one scores for it. */
  hurt(victim: number, amount: number, cause: Cause, now: number): MatchEvent[] {
    const v = this.fighters.get(victim);
    if (!v || this.winner || !(amount > 0)) return [];
    return this.harm(v, Math.min(HP, amount), -1, null, cause, now);
  }

  /** Health back to the hurt, and the dead back in: what happened since the last tick. */
  tick(now: number): MatchEvent[] {
    const out: MatchEvent[] = [];
    const since = this.tickedAt ?? now;
    this.tickedAt = now;
    for (const f of this.fighters.values()) {
      if (f.alive) {
        const from = Math.max(since, f.hurtAt + REGEN_DELAY_MS);
        if (f.hp < HP && now > from) f.hp = Math.min(HP, f.hp + (REGEN_PER_S * (now - from)) / 1000);
      } else if (!this.winner && now >= f.respawnAt) {
        f.alive = true;
        f.hp = HP;
        f.protectedUntil = now + PROTECT_MS;
        out.push({ t: 'respawn', id: f.id, spawn: this.nextSpawn() });
      }
    }
    return out;
  }

  /** Health now, as the room reckons it (regeneration and all). */
  health(id: number): number {
    return this.fighters.get(id)?.hp ?? 0;
  }

  private harm(v: Fighter, amount: number, from: number, zone: Zone | null, cause: Cause, now: number): MatchEvent[] {
    if (!v.alive || now < v.protectedUntil) return [];
    v.hp -= amount;
    v.hurtAt = now;
    if (v.hp > 0) return [{ t: 'hurt', victim: v.id, hp: v.hp, from }];
    v.hp = 0;
    v.alive = false;
    v.diedAt = now;
    v.respawnAt = now + this.respawnMs;
    v.deaths++;
    const killer = from >= 0 ? this.fighters.get(from) : undefined;
    const teamkill = killer !== undefined && killer.team === v.team;
    const out: MatchEvent[] = [{ t: 'death', victim: v.id, killer: from, zone, teamkill, cause }];
    if (killer) {
      if (teamkill) this.score[killer.team]--;
      else {
        killer.kills++;
        this.score[killer.team]++;
      }
      out.push({ t: 'score', red: this.score.red, blue: this.score.blue });
      if (!teamkill && this.score[killer.team] >= this.killTarget) {
        this.winner = killer.team;
        out.push({ t: 'over', winner: killer.team });
      }
    }
    return out;
  }

  /** Spawns are handed out round each team's few starts in turn. */
  private nextSpawn(): number {
    return this.spawns++;
  }
}
