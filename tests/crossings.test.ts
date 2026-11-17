import { afterEach, describe, expect, test } from 'bun:test'
import { plannedArrivals, type LatLng } from '../src/core/Travel'
import { CROSSING_IN_FLIGHT, HANDOVER_RECHECK_MS } from '../src/server/Crossings'
import { GRACE_MS } from '../src/server/Lobby'
import { HANDOVER_RETRY_DELAYS_MS, HANDOVER_TIMEOUT_MS, type PrepareRequest } from '../src/server/Handover'
import { RPC_ERRORS, type SessionEnded, type Squad } from '../src/wire/Rpc'
import {
  EAST,
  enlistAt,
  type Enlisted,
  pushed,
  regionHosts,
  type RegionHosts,
  signedInAt,
  WEST,
} from './support/regionHosts'

/**
 * A squad crossing a border, from the order to the far side (RFC-0002 §2,
 * `tictac-dwq.2`/`.4`): two regions, each its own server over its own database,
 * reaching each other through peers the way Durable Objects do, on a clock the
 * test turns. The window is raw JSON-RPC, so what is checked is what each
 * server says and keeps — `tests/handover.test.ts` has the real client.
 */

const HERE: LatLng = { lat: 48.78, lng: 9.18 }
/** About a kilometre north: a few minutes on foot. */
const CHECKPOINT: LatLng = { lat: 48.789, lng: 9.18 }

const OFFER = 'tictac/api/region/handoverOffer'
const FAILED = 'tictac/api/region/handoverFailed'
const CHANGED = 'tictac/api/squad/changed'
const ENDED = 'tictac/api/session/ended'

interface Offer {
  handoverId: string
  squadId: string
  targetRegion: string
  targetUrl: string
  token: string
  expiresAt: number
}

let hosts: RegionHosts
afterEach(async () => {
  await hosts.stop()
})

/** Ada at `HERE` in the west, with the order to cross at `to` given. */
async function sentAcross(to: LatLng = HERE): Promise<{ ada: Enlisted; squad: Squad }> {
  hosts = await regionHosts()
  const ada = await enlistAt(hosts, hosts.west, 'ada', HERE)
  const ordered = await ada.window.call('tictac/api/squad/order', {
    order: { kind: 'crossBorder', to, destinationRegion: EAST },
  })
  expect(ordered.code).toBeNull()
  return { ada, squad: ordered.result.squad as Squad }
}

/** The offers a window has been pushed. */
const offersTo = (ada: Enlisted): Offer[] => pushed<Offer>(ada.window, OFFER)

/** Make every call to the east `how` answers, and record when it was made. */
function eastCalls(how: 'refuses' | 'down' | 'works'): number[] {
  const made: number[] = []
  hosts.peers.through(EAST, (peer) => ({
    ...peer,
    prepareHandover: async (request: PrepareRequest) => {
      made.push(hosts.now)
      if (how === 'down') throw new Error('connect ECONNREFUSED')
      if (how === 'refuses') return { ok: false, code: RPC_ERRORS.conflict, message: 'the east is closed' }
      return peer.prepareHandover(request)
    },
    cancelHandover: async (handoverId: string) => {
      if (how === 'down') throw new Error('connect ECONNREFUSED')
      return peer.cancelHandover(handoverId)
    },
  }))
  return made
}

describe('A squad sent across the border', () => {
  test('walks to the checkpoint and is offered the way across only when it gets there', async () => {
    const { ada, squad } = await sentAcross(CHECKPOINT)
    const arrival = plannedArrivals(squad.waypoints).at(-1)!
    expect(arrival).toBeGreaterThan(hosts.now)

    await hosts.at(arrival - 1)
    expect(offersTo(ada)).toEqual([])
    expect(await hosts.east.region.squads.byId(ada.squadId)).toBeNull()

    await hosts.at(arrival)
    const [offer, ...more] = offersTo(ada)
    expect(more).toEqual([])
    expect(offer).toMatchObject({
      squadId: ada.squadId,
      targetRegion: EAST,
      targetUrl: hosts.east.url,
      expiresAt: arrival + HANDOVER_TIMEOUT_MS,
    })
    expect(offer!.token.length).toBeGreaterThan(8)
    // The target holds the squad as a copy it does not keep; the source still does.
    expect(await hosts.east.region.squads.ownerOf(ada.squadId)).toBe(WEST)
    expect(await hosts.west.match.directory.ownerOfSquad(ada.squadId)).toBe(WEST)
    expect(await hosts.east.match.directory.ownerOfSquad(ada.squadId)).toBe(WEST)
  })

  test('crosses on the window arriving: the target commits first, the source lets go only after it confirms', async () => {
    const { ada } = await sentAcross()
    const roster = await hosts.west.region.rosters.active(ada.id)
    const atConfirm: { westRow: boolean; westKeeper: string | null; eastKeeper: string | null }[] = []
    hosts.peers.through(WEST, (peer) => ({
      ...peer,
      confirmArrival: async (handoverId) => {
        atConfirm.push({
          westRow: (await hosts.west.region.squads.byId(ada.squadId)) !== null,
          westKeeper: await hosts.west.region.squads.ownerOf(ada.squadId),
          eastKeeper: await hosts.east.region.squads.ownerOf(ada.squadId),
        })
        return peer.confirmArrival(handoverId)
      },
    }))

    await hosts.at(hosts.now)
    const [offer] = offersTo(ada)
    const second = await signedInAt(hosts.east, ada)
    const arrived = await second.call('tictac/api/region/arrive', {
      handoverId: offer!.handoverId,
      token: offer!.token,
      squadId: ada.squadId,
    })

    // The real region, not a placeholder.
    expect(arrived).toMatchObject({ code: null, result: { committed: true, targetRegion: EAST } })
    expect(atConfirm).toEqual([{ westRow: true, westKeeper: WEST, eastKeeper: EAST }])
    // The source let go of everything, and said where the window went.
    expect(await hosts.west.region.squads.byId(ada.squadId)).toBeNull()
    expect(await hosts.west.region.rosters.active(ada.id)).toEqual([])
    expect(await hosts.west.match.directory.ownerOfSquad(ada.squadId)).toBeNull()
    expect(pushed<SessionEnded>(ada.window, ENDED)).toEqual([
      { reason: expect.stringContaining(EAST), reconnect: 'elsewhere', url: hosts.east.url },
    ])
    // The target keeps it, rows and all, and takes orders for it.
    expect(await hosts.east.match.directory.ownerOfSquad(ada.squadId)).toBe(EAST)
    expect(await hosts.east.region.rosters.active(ada.id)).toHaveLength(roster.length)
    const onward = await second.call('tictac/api/squad/order', { order: { kind: 'goHere', to: CHECKPOINT, pace: 'normal' } })
    expect(onward.code).toBeNull()
  })

  test('is refused for a region the table does not route to, and for this one', async () => {
    hosts = await regionHosts()
    const ada = await enlistAt(hosts, hosts.west, 'ada', HERE)
    for (const destinationRegion of ['region-mars', WEST]) {
      const refused = await ada.window.call('tictac/api/squad/order', { order: { kind: 'crossBorder', to: HERE, destinationRegion } })
      expect(refused.code).toBe(RPC_ERRORS.conflict)
    }
    const nowhere = await ada.window.call('tictac/api/squad/order', { order: { kind: 'crossBorder', to: HERE } })
    expect(nowhere.code).toBe(RPC_ERRORS.invalidParams)
  })

  test('is not given another order while its crossing is out', async () => {
    const { ada } = await sentAcross()
    await hosts.at(hosts.now)
    expect(offersTo(ada)).toHaveLength(1)

    const order = await ada.window.call('tictac/api/squad/order', { order: { kind: 'stop' } })
    expect(order).toMatchObject({ code: RPC_ERRORS.conflict, message: CROSSING_IN_FLIGHT })
    const standing = await ada.window.call('tictac/api/squad/standing', { order: 'evade' })
    expect(standing.code).toBe(RPC_ERRORS.conflict)
  })

  test('is given up on the schedule when the player is seated: a match does not cross', async () => {
    const { ada } = await sentAcross()
    const prepares = eastCalls('works')
    const seated = await ada.window.call('tictac/api/room/enter', { intent: { kind: 'open' } })
    expect(seated.code).toBeNull()

    const start = hosts.now
    await hosts.at(start)
    expect(prepares).toEqual([])
    // It looks again on its own schedule, and goes on waiting while the room lives.
    expect(hosts.west.armed.at(-1)).toBe(start + HANDOVER_RECHECK_MS)
    await hosts.at(start + HANDOVER_RECHECK_MS)
    expect(prepares).toEqual([])
    expect(hosts.west.armed.at(-1)).toBe(start + 2 * HANDOVER_RECHECK_MS)

    // Out of the room, a seat is still held for its grace: the squad waits for that too.
    expect((await ada.window.call('tictac/api/room/leave')).code).toBeNull()
    const left = hosts.now
    expect(hosts.west.match.lobby.holdsSeat(ada.id)).toBe(true)
    // Once the seat is given up and the room is over, the crossing goes ahead at the next look.
    await hosts.at(left + GRACE_MS + 1)
    expect(hosts.west.match.lobby.holdsSeat(ada.id)).toBe(false)
    expect(prepares).toEqual([left + GRACE_MS + 1])
    expect(offersTo(ada)).toHaveLength(1)
  })

  test('is not offered to a player with no window open, until they have one', async () => {
    const { ada } = await sentAcross()
    const prepares = eastCalls('works')
    const start = hosts.now
    hosts.west.match.lobby.endWindow(ada.id, { reason: 'closed', reconnect: 'never' })

    await hosts.at(start)
    expect(prepares).toEqual([])
    const back = await signedInAt(hosts.west, ada)
    await hosts.at(start + HANDOVER_RECHECK_MS)
    expect(prepares).toHaveLength(1)
    expect(pushed<Offer>(back, OFFER)).toHaveLength(1)
  })
})

describe('A crossing that does not come off', () => {
  test('retries on the schedule, whatever the target does, and rests at the checkpoint after five failures, telling the player', async () => {
    const { ada } = await sentAcross()
    // First the east refuses; then it is gone altogether.
    const prepares: number[] = []
    let refusing = true
    hosts.peers.through(EAST, (peer) => ({
      ...peer,
      prepareHandover: async () => {
        prepares.push(hosts.now)
        if (refusing) return { ok: false, code: RPC_ERRORS.conflict, message: 'the east is closed' }
        throw new Error('connect ECONNREFUSED')
      },
      cancelHandover: async () => ({ ok: true }),
    }))

    const start = hosts.now
    await hosts.at(start)
    refusing = false
    expect(prepares).toEqual([start])
    // A failed attempt arms the alarm for the next one, and nothing sooner.
    let at = start
    for (const delay of HANDOVER_RETRY_DELAYS_MS.slice(0, 4)) {
      expect(hosts.west.armed.at(-1)).toBe(at + delay)
      await hosts.at(at + delay - 1)
      expect(prepares.at(-1)).toBe(at)
      at += delay
      await hosts.at(at)
    }
    expect(prepares).toEqual([start, start + 2_000, start + 7_000, start + 17_000, start + 47_000])

    // The fifth failure is the last: no alarm for another, however long the clock runs.
    await hosts.at(start + 3_600_000)
    expect(prepares).toHaveLength(5)
    expect(offersTo(ada)).toEqual([])

    // The squad is still the west's, at the checkpoint, and the player is told why.
    expect(await hosts.west.match.directory.ownerOfSquad(ada.squadId)).toBe(WEST)
    expect(await hosts.east.region.squads.byId(ada.squadId)).toBeNull()
    const [failure] = pushed<{ squadId: string; targetRegion: string; reason: string }>(ada.window, FAILED)
    expect(failure).toMatchObject({ squadId: ada.squadId, targetRegion: EAST })
    expect(failure!.reason).toContain('ECONNREFUSED')
    expect(pushed<{ squad: Squad }>(ada.window, CHANGED).at(-1)!.squad.id).toBe(ada.squadId)
    expect(pushed(ada.window, ENDED)).toEqual([])

    // Sent across again, the squad has five attempts of its own.
    const again = await ada.window.call('tictac/api/squad/order', { order: { kind: 'crossBorder', to: HERE, destinationRegion: EAST } })
    expect(again.code).toBeNull()
    await hosts.at(hosts.now)
    expect(prepares).toHaveLength(6)
  })

  test('a target that dies after preparing leaves the source in charge: the offer lapses, the copy goes, the next attempt is two seconds on', async () => {
    const { ada } = await sentAcross()
    const prepares = eastCalls('works')
    const start = hosts.now
    await hosts.at(start)
    const [offer] = offersTo(ada)
    expect(await hosts.east.region.squads.ownerOf(ada.squadId)).toBe(WEST)

    // The window never gets to the target; time runs out for both.
    await hosts.at(offer!.expiresAt)
    expect(prepares).toEqual([start])
    await hosts.at(offer!.expiresAt + 1)
    expect(await hosts.east.region.squads.byId(ada.squadId)).toBeNull()
    expect(await hosts.west.match.directory.ownerOfSquad(ada.squadId)).toBe(WEST)
    expect(hosts.west.armed.at(-1)).toBe(offer!.expiresAt + 1 + 2_000)

    await hosts.at(offer!.expiresAt + 1 + 2_000)
    expect(prepares).toEqual([start, offer!.expiresAt + 1 + 2_000])
    expect(offersTo(ada)).toHaveLength(2)
    // A late arrival on the first offer is turned away: nothing is left of it.
    const late = await (await signedInAt(hosts.east, ada)).call('tictac/api/region/arrive', {
      handoverId: offer!.handoverId,
      token: offer!.token,
      squadId: ada.squadId,
    })
    expect(late.code).toBe(RPC_ERRORS.gone)
  })

  test('a source that will not confirm, because the player sat down in a match meanwhile, keeps the squad and the target undoes its commit', async () => {
    const { ada } = await sentAcross()
    await hosts.at(hosts.now)
    const [offer] = offersTo(ada)
    expect((await ada.window.call('tictac/api/room/enter', { intent: { kind: 'open' } })).code).toBeNull()

    const second = await signedInAt(hosts.east, ada)
    const arrived = await second.call('tictac/api/region/arrive', {
      handoverId: offer!.handoverId,
      token: offer!.token,
      squadId: ada.squadId,
    })

    expect(arrived.code).toBe(RPC_ERRORS.conflict)
    expect(await hosts.west.match.directory.ownerOfSquad(ada.squadId)).toBe(WEST)
    expect(await hosts.west.region.squads.byId(ada.squadId)).not.toBeNull()
    expect(await hosts.east.region.squads.byId(ada.squadId)).toBeNull()
    expect(pushed(ada.window, ENDED)).toEqual([])
  })
})

describe('Region RPCs authenticate and authorize (tictac-dwq.4)', () => {
  /** An offer to ada, and a second player, bob, standing in the east. */
  async function offered(): Promise<{ ada: Enlisted; bob: Enlisted; offer: Offer }> {
    const { ada } = await sentAcross()
    const bob = await enlistAt(hosts, hosts.east, 'bob', { lat: 48.9, lng: 12 })
    await hosts.at(hosts.now)
    return { ada, bob, offer: offersTo(ada)[0]! }
  }

  test('arriving and cancelling need a sign-in', async () => {
    const { ada, offer } = await offered()
    const anonymous = hosts.east.window()
    const params = { handoverId: offer.handoverId, token: offer.token, squadId: ada.squadId }
    expect((await anonymous.call('tictac/api/region/arrive', params)).code).toBe(RPC_ERRORS.signInFirst)
    expect((await hosts.west.window().call('tictac/api/region/cancelHandover', { handoverId: offer.handoverId, reason: 'x' })).code).toBe(
      RPC_ERRORS.signInFirst,
    )
    // Nothing happened to the handover.
    expect(await hosts.east.region.squads.ownerOf(ada.squadId)).toBe(WEST)
  })

  test('another player can neither arrive on a handover nor cancel it, even with its ticket', async () => {
    const { ada, bob, offer } = await offered()
    const bobEast = await signedInAt(hosts.east, bob)
    const bobWest = await signedInAt(hosts.west, bob)
    const arrive = await bobEast.call('tictac/api/region/arrive', {
      handoverId: offer.handoverId,
      token: offer.token,
      squadId: ada.squadId,
    })
    expect(arrive.code).toBe(RPC_ERRORS.notYours)
    const cancel = await bobWest.call('tictac/api/region/cancelHandover', { handoverId: offer.handoverId, reason: 'mine now' })
    expect(cancel.code).toBe(RPC_ERRORS.notYours)

    // Ada's handover is as it was.
    expect(hosts.west.match.crossings.inFlight(ada.squadId)).toBe(true)
    expect(await hosts.east.region.squads.ownerOf(ada.squadId)).toBe(WEST)
  })

  test('a wrong ticket is notYours, an unknown handover is gone', async () => {
    const { ada, offer } = await offered()
    const second = await signedInAt(hosts.east, ada)
    const wrong = await second.call('tictac/api/region/arrive', { handoverId: offer.handoverId, token: 'guessed', squadId: ada.squadId })
    expect(wrong.code).toBe(RPC_ERRORS.notYours)
    const unknown = await second.call('tictac/api/region/arrive', { handoverId: 'nobody', token: offer.token, squadId: ada.squadId })
    expect(unknown.code).toBe(RPC_ERRORS.gone)
    const cancelled = await ada.window.call('tictac/api/region/cancelHandover', { handoverId: 'nobody', reason: 'x' })
    expect(cancelled.code).toBe(RPC_ERRORS.gone)
  })

  test('cancelling says whether a retry is scheduled, and drops the target\'s copy', async () => {
    const { ada, offer } = await offered()
    const start = hosts.now
    const first = await ada.window.call('tictac/api/region/cancelHandover', { handoverId: offer.handoverId, reason: 'no second socket' })
    expect(first).toMatchObject({ code: null, result: { cancelled: true, retry: true } })
    expect(hosts.west.armed.at(-1)).toBe(start + HANDOVER_RETRY_DELAYS_MS[0]!)
    expect(await hosts.east.region.squads.byId(ada.squadId)).toBeNull()
    // Already cancelled: there is nothing left to cancel.
    const twice = await ada.window.call('tictac/api/region/cancelHandover', { handoverId: offer.handoverId, reason: 'again' })
    expect(twice.code).toBe(RPC_ERRORS.gone)

    // Four more cancelled offers, and the fifth attempt is the last.
    let at = start
    let last = first
    for (let attempt = 2; attempt <= 5; attempt++) {
      at += HANDOVER_RETRY_DELAYS_MS[attempt - 2]!
      await hosts.at(at)
      const next = offersTo(ada).at(-1)!
      last = await ada.window.call('tictac/api/region/cancelHandover', { handoverId: next.handoverId, reason: `try ${attempt}` })
      expect(last.result.retry).toBe(attempt < 5)
    }
    expect(last).toMatchObject({ code: null, result: { cancelled: true, retry: false } })
    expect(pushed(ada.window, FAILED)).toHaveLength(1)
  })

  test('a handover already confirmed cannot be cancelled', async () => {
    const { ada, offer } = await offered()
    const second = await signedInAt(hosts.east, ada)
    const arrived = await second.call('tictac/api/region/arrive', { handoverId: offer.handoverId, token: offer.token, squadId: ada.squadId })
    expect(arrived.code).toBeNull()
    // The source forgot the reservation when it committed: there is nothing to cancel, and the squad is the east's.
    const cancel = await second.call('tictac/api/region/cancelHandover', { handoverId: offer.handoverId, reason: 'too late' })
    expect(cancel.code).toBe(RPC_ERRORS.gone)
    expect(await hosts.east.match.directory.ownerOfSquad(ada.squadId)).toBe(EAST)
  })
})
