import type { LatLng } from '../../src/core/Travel'
import type { PassedFor } from '../../src/wire/Encounter'
import type { Encounters } from '../../src/server/Encounters'

/** A contact as a test states it: what was found, and what was done about it. */
export interface SeededContact {
  squadId: string
  playerId: string
  trip: string
  checkpoint: number
  at: number
  place: LatLng
  aliens: number
  roomId: string | null
  passedFor: PassedFor | null
  opponentPlayerId?: string
}

/** Write a contact that is already settled, as if a server had carried it out: the intent, then its outcome. */
export async function seedContact(encounters: Encounters, contact: SeededContact): Promise<void> {
  const handling = await encounters.begin([
    {
      squadId: contact.squadId,
      playerId: contact.playerId,
      trip: contact.trip,
      checkpoint: contact.checkpoint,
      at: contact.at,
      place: contact.place,
      opponentPlayerId: contact.opponentPlayerId,
    },
  ])
  await encounters.settle(handling, { roomId: contact.roomId, passedFor: contact.passedFor, aliens: contact.aliens })
}
