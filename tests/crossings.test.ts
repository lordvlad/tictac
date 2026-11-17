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
  /**
   * An offer to ada, and two other players, each at home in the region they can
   * sign in at: bob in the east, where ada's window is to arrive, and cy in the
   * west, which she is to leave (a region signs in only its own players).
   */
  async function offered(): Promise<{ ada: Enlisted; bob: Enlisted; cy: Enlisted; offer: Offer }> {
    const { ada } = await sentAcross()
    const bob = await enlistAt(hosts, hosts.east, 'bob', { lat: 48.9, lng: 12 })
    const cy = await enlistAt(hosts, hosts.west, 'cy', { lat: 48.9, lng: 8 })
    await hosts.at(hosts.now)
    return { ada, bob, cy, offer: offersTo(ada)[0]! }
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
    const { ada, bob, cy, offer } = await offered()
    const bobEast = await signedInAt(hosts.east, bob)
    const cyWest = await signedInAt(hosts.west, cy)
    const arrive = await bobEast.call('tictac/api/region/arrive', {
      handoverId: offer.handoverId,
      token: offer.token,
      squadId: ada.squadId,
    })
    expect(arrive.code).toBe(RPC_ERRORS.notYours)
    const cancel = await cyWest.call('tictac/api/region/cancelHandover', { handoverId: offer.handoverId, reason: 'mine now' })
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

/**
 * How the confirmation of an arrival fares between the east and the west: it
 * `works`, its reply is lost after the west acted on it, or it never gets to
 * the west at all.
 */
function confirmations(how: 'works' | 'reply lost' | 'never delivered'): void {
  hosts.peers.through(WEST, (peer) => ({
    ...peer,
    confirmArrival: async (handoverId: string) => {
      if (how === 'never delivered') throw new Error('connect ECONNREFUSED')
      const answer = await peer.confirmArrival(handoverId)
      if (how === 'reply lost') throw new Error('the reply was lost')
      return answer
    },
  }))
}

/** Ada's window arrives at the east with `offer`. */
async function arrivesAt(ada: Enlisted, offer: Offer) {
  const second = await signedInAt(hosts.east, ada)
  const arrived = await second.call('tictac/api/region/arrive', { handoverId: offer.handoverId, token: offer.token, squadId: ada.squadId })
  return { second, arrived }
}

/** Which regions hold rows for ada's squad: the keeper can be only one of them. */
async function holders(ada: Enlisted): Promise<{ west: boolean; east: boolean; keeper: string | null }> {
  return {
    west: (await hosts.west.region.squads.byId(ada.squadId)) !== null,
    east: (await hosts.east.region.squads.byId(ada.squadId)) !== null,
    keeper: (await hosts.east.region.squads.ownerOf(ada.squadId)) ?? (await hosts.west.region.squads.ownerOf(ada.squadId)),
  }
}

describe('A handover in doubt (tictac-dwq.7)', () => {
  /** An offer out of the west, ada's window about to take it. */
  async function offered(): Promise<{ ada: Enlisted; offer: Offer }> {
    const { ada } = await sentAcross()
    await hosts.at(hosts.now)
    return { ada, offer: offersTo(ada)[0]! }
  }

  test('a confirmation whose reply is lost, after the source acted on it, leaves the squad with the target alone, and the target settles it', async () => {
    const { ada, offer } = await offered()
    confirmations('reply lost')

    const { second, arrived } = await arrivesAt(ada, offer)
    expect(arrived.code).toBe(RPC_ERRORS.conflict)
    // The source had completed, and told the window where to go: one keeper, the east.
    expect(await holders(ada)).toEqual({ west: false, east: true, keeper: EAST })
    expect(pushed<SessionEnded>(ada.window, ENDED)).toEqual([{ reason: expect.stringContaining(EAST), reconnect: 'elsewhere', url: hosts.east.url }])
    // The target keeps what it holds of the handover until the source has said it is settled, and takes the squad on meanwhile.
    expect(await hosts.east.region.handovers.incoming()).toMatchObject([{ handoverId: offer.handoverId, state: 'committed' }])
    expect((await second.call('tictac/api/squad/order', { order: { kind: 'goHere', to: CHECKPOINT, pace: 'normal' } })).code).toBeNull()

    // The target asks again, and a source that has nothing of the handover has completed it.
    confirmations('works')
    await hosts.at(hosts.now + HANDOVER_RETRY_DELAYS_MS[0]!)
    expect(await hosts.east.region.handovers.incoming()).toEqual([])
    expect(await holders(ada)).toEqual({ west: false, east: true, keeper: EAST })
  })

  test('a confirmation that never reaches the source is settled within one recovery cycle: the source asks the target, which committed, and completes', async () => {
    const { ada, offer } = await offered()
    confirmations('never delivered')

    const { arrived } = await arrivesAt(ada, offer)
    expect(arrived.code).toBe(RPC_ERRORS.conflict)
    // In doubt: the target committed, the source has not heard, and still holds its rows.
    expect(await holders(ada)).toMatchObject({ west: true, east: true })
    expect(hosts.west.match.crossings.inFlight(ada.squadId)).toBe(true)
    expect(await hosts.west.region.handovers.outgoing()).toMatchObject([{ handoverId: offer.handoverId, state: 'offered' }])
    expect(pushed(ada.window, ENDED)).toEqual([])

    await hosts.at(offer.expiresAt + 1)
    expect(await holders(ada)).toEqual({ west: false, east: true, keeper: EAST })
    expect(pushed<SessionEnded>(ada.window, ENDED)).toEqual([{ reason: expect.stringContaining(EAST), reconnect: 'elsewhere', url: hosts.east.url }])
    expect(hosts.west.match.crossings.inFlight(ada.squadId)).toBe(false)
    expect(await hosts.west.region.handovers.outgoing()).toEqual([])
    expect(await hosts.west.region.handovers.intents()).toEqual([])

    // The target's own asking is answered by a source with nothing left of it, which settles it.
    confirmations('works')
    await hosts.at(hosts.now + 60_000)
    expect(await hosts.east.region.handovers.incoming()).toEqual([])
    expect(await holders(ada)).toEqual({ west: false, east: true, keeper: EAST })
  })

  test('a target that cannot be asked leaves the source the keeper, which asks again on the backoff until it is told', async () => {
    const { ada, offer } = await offered()
    confirmations('never delivered')
    const asked: number[] = []
    let down = true
    hosts.peers.through(EAST, (peer) => ({
      ...peer,
      handoverStatus: async (handoverId: string) => {
        asked.push(hosts.now)
        if (down) throw new Error('connect ECONNREFUSED')
        return peer.handoverStatus(handoverId)
      },
    }))
    expect((await arrivesAt(ada, offer)).arrived.code).toBe(RPC_ERRORS.conflict)

    const lapsed = offer.expiresAt + 1
    await hosts.at(lapsed)
    await hosts.at(lapsed + HANDOVER_RETRY_DELAYS_MS[0]!)
    await hosts.at(lapsed + HANDOVER_RETRY_DELAYS_MS[0]! + HANDOVER_RETRY_DELAYS_MS[1]!)
    expect(asked).toEqual([lapsed, lapsed + 2_000, lapsed + 7_000])
    // Nobody has heard anything: the source still keeps the squad it may not delete, and the squad is its to protect.
    expect(await hosts.west.region.squads.byId(ada.squadId)).not.toBeNull()
    expect(hosts.west.match.crossings.inFlight(ada.squadId)).toBe(true)
    expect(pushed(ada.window, ENDED)).toEqual([])

    down = false
    await hosts.at(lapsed + 7_000 + HANDOVER_RETRY_DELAYS_MS[2]!)
    expect(asked).toHaveLength(4)
    expect(await holders(ada)).toEqual({ west: false, east: true, keeper: EAST })
    expect(pushed(ada.window, ENDED)).toHaveLength(1)
  })

  test('a window that never came is asked about too: the target drops its copy for good, and the source keeps the squad and tries again', async () => {
    const { ada, offer } = await offered()
    expect(await hosts.east.region.handovers.incoming()).toMatchObject([{ state: 'prepared' }])

    await hosts.at(offer.expiresAt + 1)
    expect(await holders(ada)).toEqual({ west: true, east: false, keeper: WEST })
    expect(await hosts.west.region.handovers.outgoing()).toEqual([])
    expect(await hosts.east.region.handovers.incoming()).toEqual([])
    expect(hosts.west.match.crossings.inFlight(ada.squadId)).toBe(false)
    // The next attempt is scheduled, and the first offer can never be taken now.
    expect(hosts.west.armed.at(-1)).toBe(offer.expiresAt + 1 + HANDOVER_RETRY_DELAYS_MS[0]!)
    await expect(hosts.east.match.crossings.arrive(ada.id, offer.handoverId, offer.token, ada.squadId)).rejects.toMatchObject({ code: RPC_ERRORS.gone })
  })

  test('a source that restarts with an offer out asks the target at once: a copy never claimed is dropped, and the attempt count carries on', async () => {
    const { ada } = await offered()
    expect(await hosts.west.region.handovers.outgoing()).toHaveLength(1)

    await hosts.west.restart()
    expect(hosts.west.match.crossings.inFlight(ada.squadId)).toBe(true)
    expect(hosts.west.match.crossings.coordinator.attemptsFor(ada.squadId)).toBe(1)
    const resumed = hosts.now
    await hosts.at(resumed)

    expect(await holders(ada)).toEqual({ west: true, east: false, keeper: WEST })
    expect(await hosts.west.region.handovers.outgoing()).toEqual([])
    expect(await hosts.east.region.handovers.incoming()).toEqual([])
    expect(hosts.west.match.crossings.inFlight(ada.squadId)).toBe(false)
    expect(hosts.west.armed.at(-1)).toBe(resumed + HANDOVER_RETRY_DELAYS_MS[0]!)
  })

  test('a source that restarts after the target committed completes the crossing it finds in doubt', async () => {
    const { ada, offer } = await offered()
    confirmations('never delivered')
    expect((await arrivesAt(ada, offer)).arrived.code).toBe(RPC_ERRORS.conflict)
    expect(await holders(ada)).toMatchObject({ west: true, east: true })

    await hosts.west.restart()
    await hosts.at(hosts.now)
    expect(await holders(ada)).toEqual({ west: false, east: true, keeper: EAST })
    expect(await hosts.west.region.handovers.outgoing()).toEqual([])
    expect(hosts.west.match.crossings.inFlight(ada.squadId)).toBe(false)
  })

  test('a source that restarts mid-completion, after it committed the keeper and before it deleted its rows, finishes', async () => {
    const { ada, offer } = await offered()
    confirmations('never delivered')
    expect((await arrivesAt(ada, offer)).arrived.code).toBe(RPC_ERRORS.conflict)
    // What a crash between the two writes leaves: the keeper committed, the rows and the reservation still there.
    await hosts.west.region.squads.setOwner(ada.squadId, EAST)

    await hosts.west.restart()
    await hosts.at(hosts.now)
    expect(await holders(ada)).toEqual({ west: false, east: true, keeper: EAST })
    expect(await hosts.west.region.handovers.outgoing()).toEqual([])
  })

  test('a target that restarts keeps the offer it prepared: the window arrives on the new server with the same ticket', async () => {
    const { ada, offer } = await offered()
    await hosts.east.restart()
    expect(hosts.east.match.crossings.expects(ada.id)).toBe(true)

    const { arrived } = await arrivesAt(ada, offer)
    expect(arrived).toMatchObject({ code: null, result: { committed: true, targetRegion: EAST } })
    expect(await holders(ada)).toEqual({ west: false, east: true, keeper: EAST })
    expect(hosts.east.match.crossings.expects(ada.id)).toBe(false)
  })

  test('a target that restarts after committing answers for the commit and asks the source again: the source completes, and the squad is the target\'s', async () => {
    const { ada, offer } = await offered()
    confirmations('never delivered')
    expect((await arrivesAt(ada, offer)).arrived.code).toBe(RPC_ERRORS.conflict)

    await hosts.east.restart()
    expect(hosts.east.match.crossings.coordinator.arrivedAt(offer.handoverId)).toBeDefined()
    expect(await hosts.east.match.directory.ownerOfSquad(ada.squadId)).toBe(EAST)
    expect(await hosts.east.match.crossings.handoverStatus(offer.handoverId)).toEqual({ ok: true, status: 'committed' })

    confirmations('works')
    await hosts.at(hosts.now)
    expect(await holders(ada)).toEqual({ west: false, east: true, keeper: EAST })
    expect(await hosts.east.region.handovers.incoming()).toEqual([])
    expect(await hosts.west.region.handovers.outgoing()).toEqual([])
  })

  test('a source that decided against a handover gets a target that had committed to give the squad back, and never completes it', async () => {
    const { ada, offer } = await offered()
    // The window arrives and the target commits, but the source has meanwhile been told by the player that it will not come.
    confirmations('never delivered')
    expect((await arrivesAt(ada, offer)).arrived.code).toBe(RPC_ERRORS.conflict)
    const cancelled = await ada.window.call('tictac/api/region/cancelHandover', { handoverId: offer.handoverId, reason: 'no second socket' })
    expect(cancelled).toMatchObject({ code: null, result: { cancelled: true, retry: true } })

    expect(await holders(ada)).toEqual({ west: true, east: false, keeper: WEST })
    expect(await hosts.east.region.handovers.incoming()).toEqual([])
    expect(hosts.east.match.crossings.coordinator.arrivedAt(offer.handoverId)).toBeUndefined()
    expect(pushed(ada.window, ENDED)).toEqual([])
  })
})

describe('A crossing across a restart (tictac-dwq.8)', () => {
  test('a server restarted between the order and the squad\'s arrival crosses it at its moment', async () => {
    const { ada, squad } = await sentAcross(CHECKPOINT)
    const arrival = plannedArrivals(squad.waypoints).at(-1)!
    expect(await hosts.west.region.handovers.intents()).toMatchObject([{ squadId: ada.squadId, region: EAST, attempts: 0, nextAt: arrival }])

    await hosts.west.restart()
    const back = await signedInAt(hosts.west, ada)
    await hosts.at(arrival - 1)
    expect(offersTo(ada)).toEqual([])
    expect(pushed<Offer>(back, OFFER)).toEqual([])

    await hosts.at(arrival)
    expect(pushed<Offer>(back, OFFER)).toHaveLength(1)
    expect(await hosts.east.region.squads.ownerOf(ada.squadId)).toBe(WEST)
  })

  test('the attempts it had had are kept: a restart does not give the squad five more', async () => {
    const { ada } = await sentAcross()
    const prepares = eastCalls('refuses')
    const start = hosts.now
    await hosts.at(start)
    await hosts.at(start + 2_000)
    expect(prepares).toEqual([start, start + 2_000])
    expect(await hosts.west.region.handovers.intents()).toMatchObject([{ squadId: ada.squadId, attempts: 2, nextAt: start + 7_000 }])

    await hosts.west.restart()
    expect(hosts.west.match.crossings.coordinator.attemptsFor(ada.squadId)).toBe(2)
    const back = await signedInAt(hosts.west, ada)
    await hosts.at(start + 7_000 - 1)
    expect(prepares).toHaveLength(2)
    for (const at of [start + 7_000, start + 17_000, start + 47_000]) await hosts.at(at)

    // Five attempts in all, across the restart, and then the squad rests.
    expect(prepares).toEqual([start, start + 2_000, start + 7_000, start + 17_000, start + 47_000])
    await hosts.at(start + 3_600_000)
    expect(prepares).toHaveLength(5)
    expect(pushed<{ squadId: string }>(back, FAILED)).toHaveLength(1)
    expect(await hosts.west.region.handovers.intents()).toEqual([])
  })

  test('an order that is given up, withdrawn or carried out leaves nothing to resume', async () => {
    const { ada } = await sentAcross(CHECKPOINT)
    expect(await hosts.west.region.handovers.intents()).toHaveLength(1)
    expect((await ada.window.call('tictac/api/squad/order', { order: { kind: 'stop' } })).code).toBeNull()
    expect(await hosts.west.region.handovers.intents()).toEqual([])

    await hosts.west.restart()
    await hosts.at(hosts.now + 3_600_000)
    expect(offersTo(ada)).toEqual([])
  })
})
