import { Faction } from '../config'
import { sanitizeSheet, type CharacterSheet } from '../core/Characters'
import type { UnitFate } from '../game/MatchEnd'
import type { Db } from './db/Db'

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
}

export class Rosters {
  constructor(private readonly db: Db) {}

  /**
   * Give a player a squad, at slots `0..n-1`.
   *
   * Takes its own {@link Db} so registration can enlist inside the same
   * transaction that creates the player: an account with no squad is an account
   * that cannot play.
   */
  async enlist(db: Db, playerId: string, sheets: readonly CharacterSheet[]): Promise<void> {
    const createdAt = new Date().toISOString()
    for (const [slot, sheet] of sheets.entries()) {
      // Sanitised on the way in as well as on the way out: what is stored is
      // the canonical form, so comparing a deployed squad against the roster is
      // a string comparison rather than a structural one.
      const stored = JSON.stringify(sanitizeSheet(sheet))
      await db.query`INSERT INTO roster (character_id, player_id, slot, sheet, status, matches, created_at, died_in)
                     VALUES (${crypto.randomUUID()}, ${playerId}, ${slot}, ${stored}, ${'active'}, ${0}, ${createdAt}, ${null})`
    }
  }

  /** The living squad, in slot order. */
  async active(playerId: string): Promise<RosterMember[]> {
    const rows = await this.db.query<MemberRow>`
      SELECT character_id, slot, sheet, matches
        FROM roster
       WHERE player_id = ${playerId} AND status = ${'active'}
       ORDER BY slot`
    return rows.map((row) => ({
      characterId: row.character_id,
      slot: Number(row.slot),
      sheet: sanitizeSheet(JSON.parse(row.sheet)),
      matches: Number(row.matches),
    }))
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
    await this.db.transaction(async (tx) => {
      const already = await tx.query<{
        match_id: string
      }>`SELECT match_id FROM match_results WHERE match_id = ${result.matchId}`
      if (already.length > 0) return

      const sides = result.sides
      await tx.query`INSERT INTO match_results (match_id, winner, blue_player, red_player, settled_at)
                     VALUES (${result.matchId}, ${result.winner},
                             ${sides[Faction.Blue]?.playerId ?? null},
                             ${sides[Faction.Red]?.playerId ?? null},
                             ${new Date().toISOString()})`

      for (const side of [sides[Faction.Blue], sides[Faction.Red]]) {
        if (!side) continue
        for (const [slot, fate] of side.fates.entries()) {
          const characterId = side.characterIds[slot]
          if (!characterId) continue
          await this.record(tx, result.matchId, characterId, fate)
        }
      }
    })
  }

  /**
   * One character's match.
   *
   * Every branch counts the match, because having played it is what a service
   * record is. What differs is the rest: a winner's survivor comes back
   * changed, the loser's carried-out unit comes back exactly as they were —
   * losers learn nothing — and the dead are marked dead and named the match
   * that killed them.
   *
   * `AND status = 'active'` on every update, so a settlement arriving for a
   * character who is already dead changes nothing.
   */
  private async record(
    db: Db,
    matchId: string,
    characterId: string,
    fate: UnitFate,
  ): Promise<void> {
    if (fate.kind === 'survived') {
      const sheet = JSON.stringify(sanitizeSheet(fate.sheet))
      await db.query`UPDATE roster SET sheet = ${sheet}, matches = matches + 1
                      WHERE character_id = ${characterId} AND status = ${'active'}`
      return
    }
    if (fate.kind === 'carried') {
      await db.query`UPDATE roster SET matches = matches + 1
                      WHERE character_id = ${characterId} AND status = ${'active'}`
      return
    }
    await db.query`UPDATE roster SET status = ${'dead'}, died_in = ${matchId}, matches = matches + 1
                    WHERE character_id = ${characterId} AND status = ${'active'}`
  }
}
