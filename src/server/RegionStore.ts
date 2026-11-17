import { ROSTER } from '../config'
import { rollSquadSheets } from '../core/Characters'
import { Rng } from '../core/rng'
import type { LatLng } from '../core/Travel'
import type { Squad } from '../wire/Rpc'
import type { AccountsPort } from './AccountsPort'
import type { ServerClock } from './Clock'
import { Batch, type Db } from './db/Db'
import { migrate } from './db/migrate'
import { REGION_SCHEMA } from './db/regionMigrations'
import { Encounters, type EncounterRecord } from './Encounters'
import { MatchStore } from './MatchStore'
import { SINGLETON_REGION } from './Owner'
import { RoomStore } from './RoomStore'
import { Rosters, type RosterRecord } from './Rosters'
import { HandoverStore } from './HandoverStore'
import { Squads, type SquadRecord } from './Squads'

/**
 * One region's database, migrated, with every store that reads it: the intent
 * log, the rooms its lobby holds open, the rosters and squads of the players
 * standing in it, and the encounters on its roads (RFC-0002 §4).
 *
 * Nothing else in the server opens a database. A store is handed one, which is
 * what lets the referee, the sessions and the tests share a transaction-capable
 * connection instead of three that can disagree — and what lets a test run the
 * whole server against `:memory:` without a file.
 *
 * It holds no account. A player is an id on its rows; a name is asked of the
 * directory through the `AccountsPort` it is opened with.
 */

/**
 * Everything a region keeps for one squad, as stored: what a handover carries
 * to the region the squad is going to. Plain strings and numbers, so it
 * crosses a Durable Object boundary as it is. The player's account is not in
 * it — that is the directory's — and neither are the matches the squad's
 * characters have fought: they stay in the region that refereed them.
 */
export interface SquadBundle {
  squad: SquadRecord
  /** Every character the player has had, living and dead. */
  roster: RosterRecord[]
  encounters: EncounterRecord[]
}

export interface RegionStore {
  db: Db
  /**
   * This region, as an owner column names it: the keeper of every squad
   * placed here (`Squads`), and who the directory (`Owner.ts`) takes this
   * host to be. The one thing about a region that is not in its database.
   */
  self: string
  matches: MatchStore
  rooms: RoomStore
  rosters: Rosters
  squads: Squads
  encounters: Encounters
  /** The squads crossing the border: each one's order, and each handover in flight from either side (`HandoverStore`). */
  handovers: HandoverStore
  /**
   * The one door by which a player comes to exist in this region: their
   * roster and a squad on the map, made in one transaction for whichever of
   * the two is missing, and the squad returned. A roster rolled by the server
   * (a client that dealt its own would deal itself six prodigies), as a full
   * roster and not a squad — the bench exists so resting anyone is a choice —
   * and a squad whose start is drawn near `near`, where the connection was
   * placed, and kept nowhere.
   *
   * Idempotent, because registration spans two stores and cannot be one
   * transaction: an account whose enlist failed has no roster here, and the
   * next sign-in (or `squad/get`, or `roster/list`) runs this again and heals
   * it. A player who has both does nothing. Rows that arrived by handover
   * (`importSquad`) count as theirs, so a squad that came with its roster is
   * never dealt a second one.
   *
   * The check and the write both happen inside `Squads.placing`, which holds
   * every other placement back until this commit is done: two windows of one
   * player cannot both find nothing and both deal, and the 1 km separation
   * holds between players arriving at once. A handover import is not behind
   * that line; one landing between this read and its commit makes the commit
   * fail on `roster_active_slot` and roll back whole, and the retry finds the
   * imported rows.
   */
  enlist(playerId: string, near: LatLng | null): Promise<Squad>
  /** Everything this region keeps for `squadId`, or null for a squad it does not hold. Reads only. */
  exportSquad(squadId: string): Promise<SquadBundle | null>
  /**
   * Write a squad that came from another region, in one transaction. Idempotent
   * for the same squad, so a handover whose reply was lost can be sent again.
   * Who keeps the squad stays what the bundle says: committing a new keeper is
   * `squads.setOwner`, the 2PC's own step.
   */
  importSquad(bundle: SquadBundle): Promise<void>
  /** Delete a squad's rows, its player's roster and its encounters, in one transaction: the squad has gone to another region and this one keeps nothing of it. */
  deleteSquad(squadId: string): Promise<void>
  close(): Promise<void>
}

/**
 * Every store of a region, wired onto an already-open `Db` — migrated on the
 * way in. Engine-agnostic on purpose, as `accountStoreOverDb` is: what opens a
 * `Db` from a url is `db/BunSqlDb.ts`.
 */
export async function regionStoreOverDb(
  db: Db,
  clock: ServerClock,
  accounts: Pick<AccountsPort, 'player'>,
  self: string = SINGLETON_REGION,
): Promise<RegionStore> {
  await migrate(db, clock, REGION_SCHEMA)
  const rosters = new Rosters(db, clock)
  const squads = new Squads(db, clock, undefined, undefined, self)
  const rooms = new RoomStore(db)
  const encounters = new Encounters(db, { results: rosters, rooms, players: accounts })
  return {
    db,
    self,
    matches: new MatchStore(db),
    rooms,
    rosters,
    squads,
    encounters,
    handovers: new HandoverStore(db),
    async enlist(playerId, near) {
      const held = async () => ({ squad: await squads.of(playerId), rostered: await rosters.has(playerId) })
      const already = await held()
      if (already.squad && already.rostered) return already.squad
      return squads.placing(near, async (placement) => {
        const { squad, rostered } = await held()
        if (squad && rostered) return squad
        const batch = new Batch()
        if (!rostered) {
          const seed = crypto.getRandomValues(new Uint32Array(1))[0]!
          rosters.enlistInto(batch, playerId, rollSquadSheets(new Rng(seed), ROSTER.size))
        }
        if (!squad) squads.placeInto(batch, playerId, placement)
        await db.transaction(batch)
        return squad ?? placement.squad
      })
    },
    async exportSquad(squadId) {
      const squad = await squads.record(squadId)
      if (!squad) return null
      return { squad, roster: await rosters.records(squad.playerId), encounters: await encounters.records(squadId) }
    },
    async importSquad({ squad, roster, encounters: contacts }) {
      const batch = new Batch()
      // The squad first: its encounters point at it.
      squads.importInto(batch, squad)
      rosters.importInto(batch, roster)
      encounters.importInto(batch, contacts)
      await db.transaction(batch)
    },
    async deleteSquad(squadId) {
      const squad = await squads.record(squadId)
      if (!squad) return
      const batch = new Batch()
      // The encounters first: they point at the squad.
      encounters.removeInto(batch, squadId)
      rosters.removeInto(batch, squad.playerId)
      squads.removeInto(batch, squadId)
      await db.transaction(batch)
    },
    close: () => db.close(),
  }
}
