import { describe, expect, test } from 'bun:test'
import { ROSTER } from '../src/config'
import { fromBase64Url, toBase64Url } from '../src/game/Base64Url'
import { RPC_ERRORS, type RosterEntry } from '../src/game/Rpc'
import type { Persistence } from '../src/server/Persistence'
import { distanceKm, type LatLng } from '../src/core/Travel'
import type { Squad } from '../src/game/Rpc'
import { DEFAULT_ANCHOR, START_RADIUS_KM } from '../src/server/Squads'
import { softwareAuthenticator, type SoftwareAuthenticator } from './support/authenticator'
import { DATABASE_URLS, freshPersistence } from './support/db'
import { register, rpcServer, type Window } from './support/rpcServer'

/**
 * The whole sign-in path, driven as JSON-RPC over an in-process socket.
 *
 * `Sessions` takes frames and answers frames, so a test needs no port: what is
 * exercised here is every check the server makes, which is the part worth
 * being sure about.
 */

/**
 * A page's socket to its own server behind `persistence`, past the version
 * gate — connected from `place` when its host can tell (Cloudflare's
 * `request.cf`).
 */
function windowOn(persistence: Persistence, place: LatLng | null = null): Window {
  return rpcServer(persistence).window(place)
}

/** A passkey assertion over a fresh login challenge, ready to verify (or tamper with). */
async function assertion(window: Window, key: SoftwareAuthenticator, extra: { counter?: number } = {}) {
  const options = await window.call('tictac/api/account/loginOptions')
  const publicKey = options.result.publicKey as { challenge: string }
  return key.assert({ challengeId: options.result.challengeId as string, challenge: publicKey.challenge, ...extra })
}

describe.each(DATABASE_URLS)('Passkey accounts on %s', (url) => {
  test('registering makes a player, a squad and a session, and binds the socket that did it', async () => {
    const persistence = await freshPersistence(url)
    const window = windowOn(persistence)
    const key = await softwareAuthenticator()

    const token = await register(window, key)
    expect(typeof token).toBe('string')

    const me = await window.call('tictac/api/account/me')
    expect((me.result.player as { name: string }).name).toBe('Tester')

    // An account exists to own a roster, so registration that did not deal one
    // would be a half-made account.
    const roster = await window.call('tictac/api/roster/list')
    const members = roster.result.roster as RosterEntry[]
    expect(members).toHaveLength(ROSTER.size)
    expect(members.map((member) => member.slot)).toEqual([0, 1, 2, 3, 4, 5])
    // What a window is shown of a member: never the combat log or growth.
    expect(Object.keys(members[0]!).sort()).toEqual(['characterId', 'downtime', 'fatigue', 'hp', 'sheet', 'slot'])

    await persistence.close()
  })

  test('recruiting fills a dead slot, and refuses once the roster is full', async () => {
    const persistence = await freshPersistence(url)
    const window = windowOn(persistence)
    await register(window, await softwareAuthenticator())
    const before = await window.call('tictac/api/roster/list')
    const fallen = (before.result.roster as RosterEntry[])[0]!

    // Killed outright, the way `Rosters.settle` marks a dead row — there is
    // no request for that, so the test reaches for the row directly.
    await persistence.db.query`UPDATE roster SET status = ${'dead'} WHERE character_id = ${fallen.characterId}`

    const recruited = await window.call('tictac/api/roster/recruit')
    expect(recruited.code).toBeNull()
    const recruit = recruited.result.member as RosterEntry
    expect(recruit.slot).toBe(fallen.slot)
    expect(recruit.characterId).not.toBe(fallen.characterId)

    const full = await window.call('tictac/api/roster/recruit')
    expect(full.code).toBe(RPC_ERRORS.badInput)
    expect(full.message).toMatch(/already full/)

    await persistence.close()
  })

  test('the same passkey signs in again on another socket, and the new token works on a third', async () => {
    const persistence = await freshPersistence(url)
    const key = await softwareAuthenticator()
    const first = await register(windowOn(persistence), key)

    const second = windowOn(persistence)
    const verified = await second.call('tictac/api/account/loginVerify', { ...(await assertion(second, key)) })
    expect(verified.code).toBeNull()
    const token = verified.result.token as string
    expect(token).not.toBe(first)

    const third = windowOn(persistence)
    expect((await third.call('tictac/api/account/signIn', { token })).code).toBeNull()
    expect(((await third.call('tictac/api/account/me')).result.player as { name: string }).name).toBe('Tester')

    await persistence.close()
  })

  test('a challenge is worth exactly one answer', async () => {
    // Replay is the attack a challenge exists to stop, so the row is deleted as
    // it is read rather than marked afterwards.
    const persistence = await freshPersistence(url)
    const window = windowOn(persistence)
    const key = await softwareAuthenticator()
    await register(window, key)

    const asserted = await assertion(window, key)
    expect((await window.call('tictac/api/account/loginVerify', { ...asserted })).code).toBeNull()

    const again = await window.call('tictac/api/account/loginVerify', { ...asserted })
    expect(again.code).toBe(RPC_ERRORS.badInput)
    expect(again.message).toMatch(/expired or was already used/)

    await persistence.close()
  })

  test('a signature made over another challenge is refused', async () => {
    // The challenge id says which row to spend; the challenge *value* is what
    // the authenticator actually signed. Checking only the first would accept a
    // signature collected for any other sign-in attempt.
    const persistence = await freshPersistence(url)
    const window = windowOn(persistence)
    const key = await softwareAuthenticator()
    await register(window, key)

    const mine = await window.call('tictac/api/account/loginOptions')
    const other = await window.call('tictac/api/account/loginOptions')
    const asserted = await key.assert({
      challengeId: mine.result.challengeId as string,
      challenge: (other.result.publicKey as { challenge: string }).challenge,
    })

    const verified = await window.call('tictac/api/account/loginVerify', { ...asserted })
    expect(verified.code).toBe(RPC_ERRORS.badInput)
    expect(verified.message).toMatch(/challenge mismatch/)

    await persistence.close()
  })

  test('a ceremony performed for another site is refused', async () => {
    // The origin is what makes a passkey unphishable: a page on another domain
    // cannot make the authenticator write this one. It is read out of what the
    // authenticator signed, not off the connection.
    const persistence = await freshPersistence(url)
    const window = windowOn(persistence)
    const key = await softwareAuthenticator()

    const options = await window.call('tictac/api/account/registerOptions', { name: 'Mark' })
    const created = await key.create({
      challengeId: options.result.challengeId as string,
      challenge: (options.result.publicKey as { challenge: string }).challenge,
      origin: 'https://evil.example',
    })

    const verified = await window.call('tictac/api/account/registerVerify', { ...created })
    expect(verified.code).toBe(RPC_ERRORS.badInput)
    expect(verified.message).toMatch(/origin https:\/\/evil\.example is not allowed/)

    await persistence.close()
  })

  test('a signature that does not check out is refused', async () => {
    const persistence = await freshPersistence(url)
    const window = windowOn(persistence)
    const key = await softwareAuthenticator()
    await register(window, key)

    const asserted = await assertion(window, key)
    // One byte of `s`, so the DER still parses and the signature is simply
    // wrong — which is the failure that matters.
    const bytes = fromBase64Url(asserted.signature)
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
    const verified = await window.call('tictac/api/account/loginVerify', { ...asserted, signature: toBase64Url(bytes) })

    expect(verified.code).toBe(RPC_ERRORS.signInFirst)
    expect(verified.message).toMatch(/does not check out/)

    await persistence.close()
  })

  test('a counter that did not move says the passkey was copied', async () => {
    const persistence = await freshPersistence(url)
    const window = windowOn(persistence)
    const key = await softwareAuthenticator()
    await register(window, key)

    // The count the registration already recorded. An authenticator that
    // counts never repeats one.
    const verified = await window.call('tictac/api/account/loginVerify', {
      ...(await assertion(window, key, { counter: 1 })),
    })

    expect(verified.code).toBe(RPC_ERRORS.signInFirst)
    expect(verified.message).toMatch(/counter went backwards/)

    await persistence.close()
  })

  test('a roster is not a stranger to read, and a dead token does not make one somebody', async () => {
    const persistence = await freshPersistence(url)
    const window = windowOn(persistence)

    const anonymous = await window.call('tictac/api/roster/list')
    expect(anonymous.code).toBe(RPC_ERRORS.signInFirst)
    expect(anonymous.message).toBe('sign in first')

    const wrong = await window.call('tictac/api/account/signIn', { token: 'not-a-token' })
    expect(wrong.code).toBe(RPC_ERRORS.signInFirst)
    expect((await window.call('tictac/api/roster/list')).code).toBe(RPC_ERRORS.signInFirst)

    await persistence.close()
  })

  test('signing out ends the session everywhere, not only on this socket', async () => {
    const persistence = await freshPersistence(url)
    const window = windowOn(persistence)
    const token = await register(window, await softwareAuthenticator())

    expect((await window.call('tictac/api/account/signOut')).code).toBeNull()
    expect((await window.call('tictac/api/account/me')).result.player).toBeNull()
    // The token itself is revoked: no other socket can present it.
    expect((await windowOn(persistence).call('tictac/api/account/signIn', { token })).code).toBe(
      RPC_ERRORS.signInFirst,
    )

    await persistence.close()
  })

  test('a method the server does not answer says so rather than failing', async () => {
    const persistence = await freshPersistence(url)
    const missing = await windowOn(persistence).call('tictac/api/nothing')
    expect(missing.code).toBe(RPC_ERRORS.noSuchMethod)
    expect(missing.message).toMatch(/does not answer/)

    await persistence.close()
  })

  test('a registration through Cloudflare starts the squad near where it came from, and keeps only the start', async () => {
    const persistence = await freshPersistence(url)
    const tokyo: LatLng = { lat: 35.6895, lng: 139.6917 }
    const window = windowOn(persistence, tokyo)
    await register(window, await softwareAuthenticator())

    const read = await window.call('tictac/api/squad/get')
    const [start] = (read.result.squad as Squad).waypoints
    expect(start).toMatchObject({ kind: 'past', departed: null })
    expect(distanceKm(tokyo, start!)).toBeLessThanOrEqual(START_RADIUS_KM)

    // What is written down is the drawn start and nothing else: no column
    // holds where the connection was.
    const rows = await persistence.db.query<Record<string, unknown>>`SELECT * FROM squads`
    expect(Object.keys(rows[0]!).sort()).toEqual(['created_at', 'id', 'player_id', 'start_lat_e6', 'start_lng_e6', 'waypoints'])
    expect(JSON.stringify(rows)).not.toContain('35.6895')
    expect(JSON.stringify(rows)).not.toContain('139.6917')

    await persistence.close()
  })

  test('a registration from nowhere in particular starts near Stuttgart', async () => {
    const persistence = await freshPersistence(url)
    const window = windowOn(persistence)
    await register(window, await softwareAuthenticator())

    const [start] = ((await window.call('tictac/api/squad/get')).result.squad as Squad).waypoints
    expect(distanceKm(DEFAULT_ANCHOR, start!)).toBeLessThanOrEqual(START_RADIUS_KM)

    await persistence.close()
  })

  test('a squad is its player\'s alone to read', async () => {
    const persistence = await freshPersistence(url)
    const anonymous = await windowOn(persistence).call('tictac/api/squad/get')
    expect(anonymous.code).toBe(RPC_ERRORS.signInFirst)

    await persistence.close()
  })

  test('a player from before squads existed is placed the first time anybody asks, and stays there', async () => {
    const persistence = await freshPersistence(url)
    const lyon: LatLng = { lat: 45.764, lng: 4.8357 }
    const token = await register(windowOn(persistence), await softwareAuthenticator())
    // As every account registered before migration 7 is: a player with no row.
    await persistence.db.query`DELETE FROM squads`

    const window = windowOn(persistence, lyon)
    await window.call('tictac/api/account/signIn', { token })
    const first = (await window.call('tictac/api/squad/get')).result.squad as Squad
    expect(distanceKm(lyon, first.waypoints[0]!)).toBeLessThanOrEqual(START_RADIUS_KM)
    expect((await window.call('tictac/api/squad/get')).result.squad).toEqual(first)

    await persistence.close()
  })
})
