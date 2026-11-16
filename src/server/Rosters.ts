import { Faction, FATIGUE, HEALING, MEDICAL_BAY, ROSTER, WOUNDS } from '../config'
import { characterSheet, derive, maxHpOf, sanitizeSheet, type CharacterSheet } from '../core/Characters'
import { mergeDeeds, noDeeds, type Deeds } from '../core/Progression'
import { Rng } from '../core/rng'
import type { UnitFate } from '../rules/MatchEnd'
import type { ServerClock } from './Clock'
import { Batch, type Db } from './db/Db'
import { AuthError } from './WebAuthn'

/**
 * The squad a player keeps between matches.
 *
 * This is where permadeath stops being a rule about one match and becomes a
 * rule about a player: the survivors of a won match come back grown, and the
 * dead do not come back. Which is why a roster lives on the server and not in
 * the tab — a squad a client could rewrite is a squad that never dies.
 *
 * A dead character is marked, never deleted. The row is the history of
 * somebody who was, and `roster_active_slot` is a *partial* unique index so a
 * slot's previous occupants can all sit beside the living one.
 */

export interface RosterMember {
  characterId: string
  slot: number
  sheet: CharacterSheet
  matches: number
  /** HP as the last settled match left them, or full for one never settled. */
  hp: number
  /** The cumulative service record — every settled match's `Deeds`, added up. */
  deeds: Deeds
  /** Consecutive deployments without rest, `0..FATIGUE.max` (`[ITEM-039]`). */
  fatigue: number
  /** Matches of medical bay left before this member can be picked again. */
  downtime: number
}

/** One side of a settled match: who played it, with which characters, and how each fared. */
export interface SideResult {
  playerId: string
  characterIds: readonly string[]
  fates: readonly UnitFate[]
}

export interface MatchSettlement {
  matchId: string
  winner: Faction
  /** Null for a side nobody signed in as: an anonymous opponent keeps no roster. */
  sides: Record<Faction, SideResult | null>
}

interface MemberRow {
  character_id: string
  slot: number
  sheet: string
  matches: number
  hp: number
  deeds: string
  fatigue: number
  downtime: number
}

export class Rosters {
  constructor(
    private readonly db: Db,
    private readonly clock: ServerClock,
  ) {}

  /** Now, as the ISO text a row stores. */
  private stamp(): string {
    return new Date(this.clock.now()).toISOString()
  }

  /**
   * Give a player a squad, at slots `0..n-1`, in one transaction of its own.
   * Registration does not use this: it queues {@link enlistInto} onto the
   * batch that creates the player, so an account with no squad cannot exist.
   */
  async enlist(playerId: string, sheets: readonly CharacterSheet[]): Promise<void> {
    const batch = new Batch()
    this.enlistInto(batch, playerId, sheets)
    await this.db.transaction(batch)
  }

  /** Queue the inserts for a player's squad onto `batch`. */
  enlistInto(batch: Batch, playerId: string, sheets: readonly CharacterSheet[]): void {
    const createdAt = this.stamp()
    const emptyDeeds = JSON.stringify(noDeeds())
    for (const [slot, rawSheet] of sheets.entries()) {
      // Sanitised on the way in as well as on the way out: what is stored is
      // the canonical form, so comparing a deployed squad against the roster is
      // a string comparison rather than a structural one.
      const sheet = sanitizeSheet(rawSheet)
      const stored = JSON.stringify(sheet)
      batch.query`INSERT INTO roster
                    (character_id, player_id, slot, sheet, status, matches, hp, deeds, created_at, died_in)
                  VALUES (${crypto.randomUUID()}, ${playerId}, ${slot}, ${stored}, ${'active'}, ${0},
                          ${maxHpOf(sheet)}, ${emptyDeeds}, ${createdAt}, ${null})`
    }
  }

  /** The living squad, in slot order. */
  async active(playerId: string): Promise<RosterMember[]> {
    const rows = await this.db.query<MemberRow>`
      SELECT character_id, slot, sheet, matches, hp, deeds, fatigue, downtime
        FROM roster
       WHERE player_id = ${playerId} AND status = ${'active'}
       ORDER BY slot`
    return rows.map((row) => ({
      characterId: row.character_id,
      slot: Number(row.slot),
      sheet: sanitizeSheet(JSON.parse(row.sheet)),
      matches: Number(row.matches),
      hp: Number(row.hp),
      deeds: JSON.parse(row.deeds) as Deeds,
      fatigue: Number(row.fatigue),
      downtime: Number(row.downtime),
    }))
  }

  /**
   * Fill the lowest empty slot with a freshly rolled recruit.
   *
   * Free, and server-rolled the same way `enlist` deals the first squad —
   * because no economy prices one yet, and hard-wiring a cost or a pool this
   * early would settle that design question by accident (`ITEM-037`). A dead
   * row is never touched: it already stopped being the active occupant of its
   * slot the moment `record` marked it, and `roster_active_slot` — the same
   * partial index that already lets a slot's history pile up beside the
   * living one — is what actually stops two recruits landing on it at once;
   * this method's own scan of {@link active} is only the choice of which slot
   * to try.
   */
  async recruit(playerId: string, rng: Rng = new Rng(crypto.getRandomValues(new Uint32Array(1))[0]!)): Promise<RosterMember> {
    const held = new Set((await this.active(playerId)).map((member) => member.slot))
    let slot = -1
    for (let at = 0; at < ROSTER.size; at++) {
      if (!held.has(at)) {
        slot = at
        break
      }
    }
    if (slot < 0) throw new AuthError(400, 'the roster is already full')

    const sheet = characterSheet(rng)
    const characterId = crypto.randomUUID()
    const createdAt = this.stamp()
    const hp = maxHpOf(sheet)
    const deeds = noDeeds()
    await this.db.query`INSERT INTO roster
                     (character_id, player_id, slot, sheet, status, matches, hp, deeds, created_at, died_in)
                   VALUES (${characterId}, ${playerId}, ${slot}, ${JSON.stringify(sheet)}, ${'active'}, ${0},
                           ${hp}, ${JSON.stringify(deeds)}, ${createdAt}, ${null})`
    return { characterId, slot, sheet, matches: 0, hp, deeds, fatigue: 0, downtime: 0 }
  }

  /**
   * Write a finished match onto both rosters.
   *
   * Only the referee calls this, and only for a match it recomputed itself, so
   * what is written is never a client's account of how it went.
   *
   * Idempotent by the `match_results` primary key: a referee asked twice — a
   * retry, a restart, a duplicated end-of-match frame — writes the growth once.
   * That is the whole reason a result is recorded at all, since the outcome is
   * otherwise derivable from the log.
   */
  async settle(result: MatchSettlement): Promise<void> {
    const already = await this.db.query<{
      match_id: string
    }>`SELECT match_id FROM match_results WHERE match_id = ${result.matchId}`
    if (already.length > 0) return

    // Everything is read and worked out first, then written in one batch: the
    // marker leads it, so the writes and the mark that they were made commit
    // together or not at all — and a second settlement racing this one hits
    // the primary key and rolls back instead of growing the squads twice.
    const sides = result.sides
    const batch = new Batch()
    batch.query`INSERT INTO match_results (match_id, winner, blue_player, red_player, settled_at)
                VALUES (${result.matchId}, ${result.winner},
                        ${sides[Faction.Blue]?.playerId ?? null},
                        ${sides[Faction.Red]?.playerId ?? null},
                        ${this.stamp()})`
    for (const side of [sides[Faction.Blue], sides[Faction.Red]]) {
      if (!side) continue
      for (const [slot, fate] of side.fates.entries()) {
        const characterId = side.characterIds[slot]
        if (!characterId) continue
        await this.record(batch, result.matchId, characterId, fate)
      }
      await this.rest(batch, side.playerId, new Set(side.characterIds))
    }
    await this.db.transaction(batch)
  }

  /**
   * How a match settled, or null while it has not: the winning side, and the
   * player each side's squad was credited to (null for a side with nobody
   * registered, such as aliens). `match_results` is this store's table, so
   * what reads an outcome asks here rather than joining it.
   */
  async result(matchId: string): Promise<{ winner: number; bluePlayer: string | null; redPlayer: string | null } | null> {
    const rows = await this.db.query<{ winner: number; blue_player: string | null; red_player: string | null }>`
      SELECT winner, blue_player, red_player FROM match_results WHERE match_id = ${matchId}`
    const row = rows[0]
    return row ? { winner: Number(row.winner), bluePlayer: row.blue_player, redPlayer: row.red_player } : null
  }

  /**
   * Every active member of this player's roster who did *not* deploy heals by
   * the same rule a survivor does — {@link HEALING.perMatch} of missing HP,
   * scaled by their own `healBonus` — and does not count a match: they were
   * not in it. The bench (`[ITEM-042]`) is what makes resting somebody mean
   * anything, and this is the reward for using it: fatigue falls twice as
   * fast as it rises and medical-bay downtime ticks down, both floored at
   * zero (`[ITEM-039]`).
   */
  private async rest(batch: Batch, playerId: string, deployed: ReadonlySet<string>): Promise<void> {
    const rows = await this.db.query<{ character_id: string; sheet: string; hp: number; fatigue: number; downtime: number }>`
      SELECT character_id, sheet, hp, fatigue, downtime FROM roster
       WHERE player_id = ${playerId} AND status = ${'active'}`
    for (const row of rows) {
      if (deployed.has(row.character_id)) continue
      const sheet = sanitizeSheet(JSON.parse(row.sheet))
      const { healBonus } = derive(sheet)
      const maxHp = maxHpOf(sheet)
      const healed = Number(row.hp) + HEALING.perMatch * maxHp * (1 + healBonus / 100)
      const hp = Math.max(1, Math.min(maxHp, Math.round(healed)))
      const fatigue = Math.max(0, Number(row.fatigue) - 2)
      const downtime = Math.max(0, Number(row.downtime) - 1)
      batch.query`UPDATE roster SET hp = ${hp}, fatigue = ${fatigue}, downtime = ${downtime}
                  WHERE character_id = ${row.character_id} AND status = ${'active'}`
    }
  }

  /**
   * One character's match.
   *
   * Every branch counts the match, adds this match's `Deeds` onto the
   * cumulative record — the combat log — and raises fatigue by one, capped at
   * {@link FATIGUE.max} (`[ITEM-039]`): having played it is what a service
   * record and a tired body both are, regardless of who won. What differs is
   * the rest:
   *
   * - **Survived**: the sheet comes back {@link grown}, already folded into
   *   `fate.sheet`. HP heals by {@link HEALING.perMatch}'s fraction of the
   *   *new* sheet's ceiling, scaled by that sheet's own `healBonus` — the
   *   stated rule, not an implicit reset to full. Ending at or below
   *   {@link WOUNDS.concussed} of that ceiling sends them to the medical bay
   *   for {@link MEDICAL_BAY.concussed} match; otherwise downtime is zero,
   *   which it already was — deploying at all required it.
   * - **Carried**: losers learn nothing, so the sheet is untouched — but HP is
   *   written down as {@link HEALING.carriedOutHp}, which then heals the same
   *   way on whatever match comes after it, and downtime is set to
   *   {@link MEDICAL_BAY.carriedOut} matches.
   * - **Died**: marked dead and named the match that killed them, with their
   *   final HP and deeds kept as history rather than discarded.
   *
   * `AND status = 'active'` on every update, so a settlement arriving for a
   * character who is already dead changes nothing — and the read that starts
   * each branch is the same guard: nothing to update means nothing to do.
   */
  private async record(batch: Batch, matchId: string, characterId: string, fate: UnitFate): Promise<void> {
    const rows = await this.db.query<{ sheet: string; deeds: string; fatigue: number }>`
      SELECT sheet, deeds, fatigue FROM roster WHERE character_id = ${characterId} AND status = ${'active'}`
    const existing = rows[0]
    if (!existing) return
    const deeds = JSON.stringify(mergeDeeds(JSON.parse(existing.deeds) as Deeds, fate.deeds))
    const fatigue = Math.min(FATIGUE.max, Number(existing.fatigue) + 1)

    if (fate.kind === 'survived') {
      const sheet = sanitizeSheet(fate.sheet)
      const { healBonus } = derive(sheet)
      const maxHp = maxHpOf(sheet)
      const healed = fate.hp + HEALING.perMatch * maxHp * (1 + healBonus / 100)
      const hp = Math.max(1, Math.min(maxHp, Math.round(healed)))
      const downtime = fate.hp <= WOUNDS.concussed * maxHp ? MEDICAL_BAY.concussed : 0
      batch.query`UPDATE roster SET sheet = ${JSON.stringify(sheet)}, hp = ${hp}, deeds = ${deeds},
                                    matches = matches + 1, fatigue = ${fatigue}, downtime = ${downtime}
                  WHERE character_id = ${characterId} AND status = ${'active'}`
      return
    }
    if (fate.kind === 'carried') {
      batch.query`UPDATE roster SET hp = ${HEALING.carriedOutHp}, deeds = ${deeds}, matches = matches + 1,
                                    fatigue = ${fatigue}, downtime = ${MEDICAL_BAY.carriedOut}
                  WHERE character_id = ${characterId} AND status = ${'active'}`
      return
    }
    batch.query`UPDATE roster SET status = ${'dead'}, died_in = ${matchId},
                                  hp = ${Math.max(0, fate.hp)}, deeds = ${deeds}, matches = matches + 1,
                                  fatigue = ${fatigue}
                WHERE character_id = ${characterId} AND status = ${'active'}`
  }
}
