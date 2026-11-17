import { describe, expect, test } from 'bun:test'
import { WALL_CLOCK } from '../src/server/Clock'
import { distanceKm } from '../src/core/Travel'
import { heldTokens, RpcError, ServerConnection } from '../src/game/ServerConnection'
import { RPC_ERRORS } from '../src/wire/Rpc'
import { accountsOverRpc, serveAccounts } from '../src/server/AccountsRpc'
import { openDb, openPersistence } from '../src/server/db/BunSqlDb'
import { startGameServer } from '../src/server/GameServer'
import { HandoverCoordinator } from '../src/server/Handover'
import { regionDirectory, type RegionPartition } from '../src/server/Owner'
import { portsOf, type Persistence } from '../src/server/Persistence'
import { regionStoreOverDb, type SquadBundle } from '../src/server/RegionStore'
import { START_RADIUS_KM } from '../src/server/Squads'
import { AuthError } from '../src/server/WebAuthn'
import { softwareAuthenticator } from './support/authenticator'
import { seedContact } from './support/encounters'

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
async function emptyRegion(directory: Persistence, self: string) {
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
  })
  return {
    region,
    server,
    connect: (token: string | null = null) =>
      new ServerConnection(server.url.replace('http', 'ws'), { tokens: heldTokens(token) }),
    stop: async () => {
      await server.stop()
      await region.close()
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
  test('serves a signed-in player whose account lives only in the directory', async () => {
    const directory = await openPersistence(WALL_CLOCK)
    const home = await startGameServer({ ...portsOf(directory), clock: WALL_CLOCK, port: 0, log: () => {} })
    const east = await emptyRegion(directory, 'region-east')

    // Ada is made where the directory is, and so are her roster and squad.
    const first = new ServerConnection(home.url.replace('http', 'ws'), { tokens: heldTokens() })
    const token = await register(first, 'Ada')
    first.close()
    expect(await directory.accounts.accounts.playerFor(token)).toMatchObject({ name: 'Ada' })
    await expect(east.region.db.query`SELECT id FROM players`).rejects.toThrow()
    expect(await east.region.squads.all()).toEqual([])

    // East has never heard of her. Her token is the directory's, and east asks.
    const there = east.connect(token)
    const me = await there.request('tictac/api/account/me', {})
    expect(me.player?.name).toBe('Ada')
    expect(there.player?.name).toBe('Ada')
    // The squad she is given there is east's to keep, from the first moment.
    const squad = (await there.request('tictac/api/squad/get', {})).squad
    expect(await east.server.directory.ownerOfSquad(squad.id)).toBe('region-east')
    expect(await east.region.squads.of(there.player!.id)).toMatchObject({ id: squad.id })
    expect(await east.region.rosters.active(there.player!.id)).toEqual([])
    // And she is her name in east's encounter feed, not an id: asked of the directory.
    expect(await there.request('tictac/api/encounter/feed', {})).toEqual({ entries: [] })

    // A token nobody issued is turned down by the directory, and the refusal is the same one as at home.
    const stranger = east.connect()
    const refused = await stranger.request('tictac/api/account/signIn', { token: 'not-a-token' }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(RpcError)
    expect((refused as RpcError).code).toBe(RPC_ERRORS.signInFirst)

    there.close()
    stranger.close()
    await east.stop()
    await home.stop()
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
    target.arrive('h-1', 'ticket', squadId)
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
