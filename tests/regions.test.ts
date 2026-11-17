import { describe, expect, test } from 'bun:test'
import { WALL_CLOCK } from '../src/server/Clock'
import { distanceKm } from '../src/core/Travel'
import { heldTokens, RpcError, ServerConnection } from '../src/game/ServerConnection'
import { RPC_ERRORS } from '../src/wire/Rpc'
import { accountsOverRpc, serveAccounts } from '../src/server/AccountsRpc'
import { openDb, openPersistence } from '../src/server/db/BunSqlDb'
import { startGameServer } from '../src/server/GameServer'
import { HandoverCoordinator, type RegionPeers } from '../src/server/Handover'
import { regionDirectory, SINGLETON_REGION, type RegionPartition } from '../src/server/Owner'
import { portsOf, type Persistence } from '../src/server/Persistence'
import { regionStoreOverDb, type SquadBundle } from '../src/server/RegionStore'
import { START_RADIUS_KM } from '../src/server/Squads'
import { AuthError } from '../src/server/WebAuthn'
import { softwareAuthenticator } from './support/authenticator'
import { seedContact } from './support/encounters'
import { inProcessPeers } from './support/peers'

/**
 * The account store and a region's store apart (RFC-0002 §4, tictac-dwq.5):
 * what a region does with a player whose account is the directory's, and what
 * moves when a squad changes region.
 */

const PARTITIONS: RegionPartition[] = [
  { id: 'west', durableObjectName: 'region-west', bounds: { minLat: 45, maxLat: 55, minLng: 5, maxLng: 10 } },
  { id: 'east', durableObjectName: 'region-east', bounds: { minLat: 45, maxLat: 55, minLng: 10.001, maxLng: 20 } },
]

/**
 * The directory's accounts as a region far away asks for them: every call and
 * every reply goes through JSON, which is what a Durable Object boundary does
 * to anything that is not plain data (an `AuthError` included).
 */
function accountsAcross(directory: Persistence) {
  return accountsOverRpc(async (request) => {
    const sent = JSON.parse(JSON.stringify(request)) as typeof request
    return JSON.parse(JSON.stringify(await serveAccounts(directory.accounts.accounts, sent)))
  })
}

/** A region of its own, with a database of its own and nothing in it, behind a server of its own. */
async function emptyRegion(directory: Persistence, self: string, peers?: RegionPeers) {
  const accounts = accountsAcross(directory)
  const region = await regionStoreOverDb(await openDb(':memory:'), WALL_CLOCK, accounts, self)
  const server = await startGameServer({
    accounts,
    region,
    party: directory.accounts.party,
    regions: PARTITIONS,
    clock: WALL_CLOCK,
    port: 0,
    log: () => {},
    peers,
    // Nothing is rolled for on the road: a squad's trip here is only its crossing.
    journeys: { openEncounter: undefined, openMeeting: undefined },
  })
  return {
    region,
    server,
    wsUrl: server.url.replace('http', 'ws'),
    connect: (token: string | null = null) =>
      new ServerConnection(server.url.replace('http', 'ws'), { tokens: heldTokens(token) }),
    stop: async () => {
      await server.stop()
      await region.close()
    },
  }
}

/**
 * Two regions behind one directory, each its own server over its own database,
 * reaching each other as Durable Objects do: the one the directory lives in
 * (the singleton) and `region-east`.
 */
async function homeAndEast(directory: Persistence) {
  const peers = inProcessPeers()
  const home = await startGameServer({
    ...portsOf(directory),
    regions: PARTITIONS,
    clock: WALL_CLOCK,
    port: 0,
    log: () => {},
    peers,
    journeys: { openEncounter: undefined, openMeeting: undefined },
  })
  const east = await emptyRegion(directory, 'region-east', peers)
  const homeWs = home.url.replace('http', 'ws')
  peers.add(SINGLETON_REGION, { crossings: home.crossings, url: homeWs })
  peers.add('region-east', { crossings: east.server.crossings, url: east.wsUrl })
  return {
    home: {
      server: home,
      region: directory.region,
      wsUrl: homeWs,
      connect: (token: string | null = null) => new ServerConnection(homeWs, { tokens: heldTokens(token) }),
    },
    east,
    stop: async () => {
      await home.stop()
      await east.stop()
    },
  }
}

/** Register a passkey over `connection`, as the browser's ceremony does; the token comes back. */
async function register(connection: ServerConnection, name: string): Promise<string> {
  const key = await softwareAuthenticator()
  const options = await connection.request('tictac/api/account/registerOptions', { name })
  const created = await key.create({
    challengeId: options.challengeId,
    challenge: (options.publicKey as { challenge: string }).challenge,
  })
  const signed = await connection.request('tictac/api/account/registerVerify', created)
  connection.signedIn(signed)
  return signed.token
}

describe('A second region, whose database holds no account', () => {
  test('serves a player whose account lives only in the directory by sending them to the region that keeps their squad', async () => {
    const directory = await openPersistence(WALL_CLOCK)
    const world = await homeAndEast(directory)

    // Ada is made where the directory is, and so are her roster and squad.
    const first = world.home.connect()
    const token = await register(first, 'Ada')
    const ada = first.player!
    first.close()
    expect(await directory.accounts.accounts.playerFor(token)).toMatchObject({ name: 'Ada' })
    expect(await directory.accounts.accounts.home(ada.id)).toBe(SINGLETON_REGION)
    await expect(world.east.region.db.query`SELECT id FROM players`).rejects.toThrow()
    expect(await world.east.region.squads.all()).toEqual([])

    // East has never heard of her, and does not deal her a squad: her token is the
    // directory's, east asks who she is and where her squad is, and sends her there.
    const there = world.east.connect(token)
    const sentTo = Promise.withResolvers<string>()
    there.onElsewhere((url) => sentTo.resolve(url))
    const asked = there.request('tictac/api/account/me', {}).catch((e: unknown) => e)
    expect(await sentTo.promise).toBe(world.home.wsUrl)
    await asked
    expect(await world.east.region.squads.of(ada.id)).toBeNull()
    expect(await world.east.region.rosters.active(ada.id)).toEqual([])
    expect(await world.east.region.squads.all()).toEqual([])

    // Where she is sent, she is let in, with the roster and squad she already had.
    const home = world.home.connect(token)
    expect((await home.request('tictac/api/account/me', {})).player?.name).toBe('Ada')
    expect(await home.request('tictac/api/roster/list', {})).toMatchObject({ roster: expect.any(Array) })
    expect(await world.home.region.rosters.active(ada.id)).toHaveLength(6)

    // The refusal of a token nobody issued is the same at either region.
    const stranger = world.east.connect()
    const refused = await stranger.request('tictac/api/account/signIn', { token: 'not-a-token' }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(RpcError)
    expect((refused as RpcError).code).toBe(RPC_ERRORS.signInFirst)

    there.close()
    home.close()
    stranger.close()
    await world.stop()
    await directory.close()
  })

  test('a passkey login at a region that is not the player\'s home hands back the session and sends the window home', async () => {
    const directory = await openPersistence(WALL_CLOCK)
    const world = await homeAndEast(directory)
    const key = await softwareAuthenticator()

    const registering = world.home.connect()
    const created = await registering.request('tictac/api/account/registerOptions', { name: 'Bo' })
    const made = await key.create({
      challengeId: created.challengeId,
      challenge: (created.publicKey as { challenge: string }).challenge,
    })
    const bo = (await registering.request('tictac/api/account/registerVerify', made)).player
    registering.close()

    const there = world.east.connect()
    const sentTo = Promise.withResolvers<string>()
    there.onElsewhere((url) => sentTo.resolve(url))
    const options = await there.request('tictac/api/account/loginOptions', {})
    const asserted = await key.assert({
      challengeId: options.challengeId,
      challenge: (options.publicKey as { challenge: string }).challenge,
    })
    const signed = await there.request('tictac/api/account/loginVerify', asserted)
    // The session is the directory's: it is good at the home region, which is where the window is sent.
    expect(signed.player.id).toBe(bo.id)
    expect(await sentTo.promise).toBe(world.home.wsUrl)
    expect(await directory.accounts.accounts.playerFor(signed.token)).toMatchObject({ id: bo.id })
    expect(await world.east.region.squads.of(bo.id)).toBeNull()

    there.close()
    await world.stop()
    await directory.close()
  })

  test('a player registered in the east is the east\'s, and the home region sends them there', async () => {
    const directory = await openPersistence(WALL_CLOCK)
    const world = await homeAndEast(directory)

    const registering = world.east.connect()
    const token = await register(registering, 'Cy')
    const cy = registering.player!
    registering.close()
    expect(await directory.accounts.accounts.home(cy.id)).toBe('region-east')

    const there = world.home.connect(token)
    const sentTo = Promise.withResolvers<string>()
    there.onElsewhere((url) => sentTo.resolve(url))
    void there.request('tictac/api/account/me', {}).catch(() => {})
    expect(await sentTo.promise).toBe(world.east.wsUrl)
    expect(await world.home.region.squads.of(cy.id)).toBeNull()

    there.close()
    await world.stop()
    await directory.close()
  })

  test('a crossing makes the target the player\'s home: the source then sends their windows over, and the target lets them in', async () => {
    const directory = await openPersistence(WALL_CLOCK)
    const world = await homeAndEast(directory)

    const first = world.home.connect()
    const token = await register(first, 'Di')
    const di = first.player!
    const squad = (await first.request('tictac/api/squad/get', {})).squad
    const here = squad.waypoints.at(-1)!
    const moved = Promise.withResolvers<void>()
    first.onHandover((event) => {
      if (event.kind === 'complete') moved.resolve()
    })
    await first.request('tictac/api/squad/order', {
      order: { kind: 'crossBorder', to: { lat: here.lat, lng: here.lng }, destinationRegion: 'region-east' },
    })
    await moved.promise
    expect(await directory.accounts.accounts.home(di.id)).toBe('region-east')
    expect(await world.east.server.directory.ownerOfSquad(squad.id)).toBe('region-east')

    // The old region sends a window that comes back to the new one, and keeps nothing of her.
    const back = world.home.connect(token)
    const sentTo = Promise.withResolvers<string>()
    back.onElsewhere((url) => sentTo.resolve(url))
    void back.request('tictac/api/account/me', {}).catch(() => {})
    expect(await sentTo.promise).toBe(world.east.wsUrl)
    expect(await world.home.region.squads.of(di.id)).toBeNull()

    const there = world.east.connect(token)
    expect((await there.request('tictac/api/squad/get', {})).squad.id).toBe(squad.id)

    first.close()
    back.close()
    there.close()
    await world.stop()
    await directory.close()
  })

  test('registers a new player in the directory and gives them a roster and a squad in the region that served it', async () => {
    const directory = await openPersistence(WALL_CLOCK)
    const east = await emptyRegion(directory, 'region-east')
    const connection = east.connect()

    const token = await register(connection, 'Bo')
    const bo = connection.player!
    // The account is the directory's…
    expect(await directory.accounts.accounts.player(bo.id)).toEqual(bo)
    expect(await directory.accounts.accounts.playerFor(token)).toEqual(bo)
    // …and what she owns is east's alone: the directory's own region has none of it.
    expect(await east.region.rosters.active(bo.id)).toHaveLength(6)
    expect(await east.region.squads.of(bo.id)).not.toBeNull()
    expect(await directory.region.rosters.active(bo.id)).toEqual([])
    expect(await directory.region.squads.of(bo.id)).toBeNull()

    // A refusal crosses the boundary as the same refusal: a bad name is a bad request.
    const refused = await connection.request('tictac/api/account/registerOptions', { name: '' }).catch((e: unknown) => e)
    expect((refused as RpcError).code).toBe(RPC_ERRORS.badInput)

    connection.close()
    await east.stop()
    await directory.close()
  })

  test('the port keeps an AuthError an AuthError across the boundary, with its status', async () => {
    const directory = await openPersistence(WALL_CLOCK)
    const accounts = accountsAcross(directory)

    const refused = await accounts.registrationOptions('').catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(AuthError)
    expect((refused as AuthError).status).toBe(400)
    expect(await accounts.playerFor('nobody')).toBeNull()
    expect(await accounts.player('nobody')).toBeNull()
    await expect(accounts.login({ challengeId: 'x', credentialId: 'y', clientDataJSON: '', authenticatorData: '', signature: '' })).rejects.toBeInstanceOf(AuthError)
    await directory.close()
  })

  test('a connection a Bun region is told came from the east places its players there', async () => {
    const directory = await openPersistence(WALL_CLOCK)
    const accounts = accountsAcross(directory)
    const region = await regionStoreOverDb(await openDb(':memory:'), WALL_CLOCK, accounts, 'region-east')
    const munich = { lat: 48.1351, lng: 11.582 }
    const server = await startGameServer({
      accounts,
      region,
      party: directory.accounts.party,
      regions: PARTITIONS,
      clock: WALL_CLOCK,
      port: 0,
      log: () => {},
      placeOf: () => munich,
    })
    const connection = new ServerConnection(server.url.replace('http', 'ws'), { tokens: heldTokens() })
    await register(connection, 'Cy')
    const start = (await connection.request('tictac/api/squad/get', {})).squad.waypoints[0]!
    expect(distanceKm(munich, start)).toBeLessThanOrEqual(START_RADIUS_KM)
    expect(server.directory.ownerOfPlace(munich)).toBe('region-east')

    connection.close()
    await server.stop()
    await region.close()
    await directory.close()
  })
})

describe('A squad changing region (RegionStore handover verbs)', () => {
  /** A region store with a player's squad in it: a roster with one casualty, a squad, a settled contact. */
  async function withSquad() {
    const persistence = await openPersistence(WALL_CLOCK, ':memory:', { self: 'region-west' })
    const { region } = persistence
    await region.enlist('ada', { lat: 48.77, lng: 9.18 })
    const squad = (await region.squads.of('ada'))!
    const [fallen] = await region.rosters.active('ada')
    await region.db.query`UPDATE roster SET status = ${'dead'}, died_in = ${'a-match-fought-in-the-west'}, hp = ${0} WHERE character_id = ${fallen!.characterId}`
    await seedContact(region.encounters, {
      squadId: squad.id,
      playerId: 'ada',
      trip: 'trip-1',
      checkpoint: 0,
      at: 1_000,
      place: { lat: 48.8, lng: 9.2 },
      aliens: 2,
      roomId: null,
      passedFor: 'nobodyFit',
    })
    return { persistence, region, squad, fallen: fallen!.characterId }
  }

  test('exportSquad reads everything a region keeps for a squad, as plain data, and nothing of the account', async () => {
    const { persistence, region, squad, fallen } = await withSquad()

    const bundle = await region.exportSquad(squad.id)
    expect(bundle!.squad).toMatchObject({ id: squad.id, playerId: 'ada', owner: 'region-west' })
    // The whole roster, the dead too: history travels.
    expect(bundle!.roster).toHaveLength(6)
    expect(bundle!.roster.find((row) => row.characterId === fallen)).toMatchObject({ status: 'dead', diedIn: 'a-match-fought-in-the-west' })
    expect(bundle!.encounters).toMatchObject([{ squadId: squad.id, trip: 'trip-1', passedFor: 'nobodyFit', settled: 1 }])
    expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle)
    expect(await region.exportSquad('no-such-squad')).toBeNull()

    await persistence.close()
  })

  test('importSquad writes it into a region that has none of it, and a second import changes nothing', async () => {
    const { persistence, region, squad } = await withSquad()
    const bundle = JSON.parse(JSON.stringify(await region.exportSquad(squad.id))) as SquadBundle

    const east = await openPersistence(WALL_CLOCK, ':memory:', { self: 'region-east' })
    // The player has no account here, and does not need one: the id is all a region holds.
    await east.region.importSquad(bundle)
    await east.region.importSquad(bundle)
    expect(await east.region.exportSquad(squad.id)).toEqual(bundle)
    expect(await east.region.rosters.active('ada')).toHaveLength(5)
    // It arrives as it left: still the west's to keep until the handover commits.
    expect(await east.region.squads.ownerOf(squad.id)).toBe('region-west')

    await east.close()
    await persistence.close()
  })

  test('enlist is nothing for a player whose roster and squad arrived by handover: they are not dealt a second roster', async () => {
    const { persistence, region, squad } = await withSquad()
    const bundle = JSON.parse(JSON.stringify(await region.exportSquad(squad.id))) as SquadBundle

    const east = await openPersistence(WALL_CLOCK, ':memory:', { self: 'region-east' })
    await east.region.importSquad(bundle)
    // A window of the arrived player signing in, as it does the moment it lands.
    expect(await east.region.enlist('ada', { lat: 50, lng: 15 })).toMatchObject({ id: squad.id })
    expect(await east.region.exportSquad(squad.id)).toEqual(bundle)

    await east.close()
    await persistence.close()
  })

  test('deleteSquad takes the squad, its roster and its contacts, and leaves the matches the region refereed', async () => {
    const { persistence, region, squad } = await withSquad()
    await region.db.query`INSERT INTO matches (id, header, created_at, seed_label)
                          VALUES (${'a-match-fought-in-the-west'}, ${'{}'}, ${'2026-01-01T00:00:00Z'}, ${'seed'})`
    await region.db.query`INSERT INTO match_results (match_id, winner, blue_player, red_player, settled_at)
                          VALUES (${'a-match-fought-in-the-west'}, ${0}, ${'ada'}, ${null}, ${'2026-01-01T00:00:00Z'})`

    await region.deleteSquad(squad.id)
    expect(await region.squads.of('ada')).toBeNull()
    expect(await region.rosters.records('ada')).toEqual([])
    expect(await region.encounters.records(squad.id)).toEqual([])
    expect(await region.rosters.result('a-match-fought-in-the-west')).toMatchObject({ bluePlayer: 'ada' })
    // Nothing to delete is nothing done.
    await region.deleteSquad(squad.id)
    await region.deleteSquad('no-such-squad')

    await persistence.close()
  })

  test('the two-phase handover moves a squad: target imports, source commits the keeper and lets go', async () => {
    const west = await withSquad()
    const east = await openPersistence(WALL_CLOCK, ':memory:', { self: 'region-east' })
    const squadId = west.squad.id
    const directoryWest = regionDirectory({ owners: west.region.squads, partitions: PARTITIONS, self: 'region-west' })
    const directoryEast = regionDirectory({ owners: east.region.squads, partitions: PARTITIONS, self: 'region-east' })
    const source = new HandoverCoordinator({ clock: WALL_CLOCK, directory: directoryWest, squads: west.region.squads })
    const target = new HandoverCoordinator({ clock: WALL_CLOCK, directory: directoryEast, squads: east.region.squads })
    const offer = {
      handoverId: 'h-1',
      playerId: 'ada',
      squadId,
      sourceRegion: 'region-west',
      targetRegion: 'region-east',
      targetUrl: 'ws://east',
      token: 'ticket',
    }

    // Prepare: the target is told, and is given what the squad is.
    target.prepare({ ...offer, expiresAt: Date.now() + 15_000 })
    await source.initiate(offer)
    await east.region.importSquad((await west.region.exportSquad(squadId))!)
    target.arrive('h-1', 'ticket', squadId, 'ada')
    // Until the source commits, the squad is the source's, in both directories.
    expect(await directoryWest.ownerOfSquad(squadId)).toBe('region-west')
    expect(await directoryEast.ownerOfSquad(squadId)).toBe('region-west')

    // Commit: the source writes the target as keeper, the target takes the squad as its own, the source lets go.
    await source.confirm('h-1')
    await east.region.squads.setOwner(squadId, 'region-east')
    await west.region.deleteSquad(squadId)
    expect(await directoryEast.ownerOfSquad(squadId)).toBe('region-east')
    expect(await directoryWest.ownerOfSquad(squadId)).toBeNull()
    expect(await east.region.rosters.active('ada')).toHaveLength(5)
    expect(await west.region.rosters.active('ada')).toEqual([])

    await east.close()
    await west.persistence.close()
  })
})
