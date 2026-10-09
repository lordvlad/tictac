import type { LatLng } from '../core/Travel'
import type { PassedFor } from '../game/Encounter'
import type { Player } from '../game/Rpc'

/**
 * What the travel scheduler hands the lobby when something finds a squad
 * (`ITEM-048`), and what it gets back: the one seam between `Journeys`, which
 * knows routes and clocks, and `Lobby`, which knows rooms and rosters.
 */

export interface EncounterContact {
  /** The player whose squad it was. */
  player: Player
  squadId: string
  /** Which trip, and which of its checkpoints, found the squad: the roll's key. */
  trip: string
  checkpoint: number
  /** The server's clock when it happened, in ms. */
  at: number
  /** Where the squad stood. */
  place: LatLng
  /** Seeds the aliens' squad: sheets and kit, dealt like any roll (`dealAliens`). */
  alienSeed: number
  /** How many more or fewer aliens than the player's party: -1, 0 or 1, within `1..SQUAD_SIZE`. */
  sizeOffset: -1 | 0 | 1
}

export type EncounterOpened =
  | {
      opened: true
      roomId: string
      /** How many aliens came. */
      aliens: number
      /** The server's clock when the seat passes to the AI; null when the player is offline and the AI has it already. */
      joinBy: number | null
    }
  | { opened: false; passedFor: PassedFor }

/**
 * Open the fight a contact makes, or say why there is none. Resolves once the
 * room exists and the player, if online, has been told.
 */
export type OpenEncounter = (contact: EncounterContact) => Promise<EncounterOpened>
