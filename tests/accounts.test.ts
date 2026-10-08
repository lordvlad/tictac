import { describe, expect, test } from 'bun:test'
import { ROSTER } from '../src/config'
import { fromBase64Url, toBase64Url } from '../src/game/Base64Url'
import { RpcMethods, type JsonRpcFrame } from '../src/game/JsonRpc'
import { RPC_ERRORS, type RosterEntry } from '../src/game/Rpc'
import { loopback } from '../src/game/Transport'
import { Lobby } from '../src/server/Lobby'
import type { Persistence } from '../src/server/Persistence'
import { Sessions } from '../src/server/Session'
import { MY_VERSION } from '../src/version'
import { softwareAuthenticator, type SoftwareAuthenticator } from './support/authenticator'
import { DATABASE_URLS, freshPersistence } from './support/db'

/**
 * The whole sign-in path, driven as JSON-RPC over an in-process socket.
 *
 * `Sessions` takes frames and answers frames, so a test needs no port: what is
 * exercised here is every check the server makes, which is the part worth
 * being sure about.
 */

interface Answer {
  /** The error code (`RPC_ERRORS`), or null for a result. */
  code: number | null
  result: Record<string, unknown>
  message: string | null
}

interface Window {
  call(method: string, params?: Record<string, unknown>): Promise<Answer>
}

/** A page's socket to the server behind `persistence`, past the version gate. */
function windowOn(persistence: Persistence): Window {
  const lobby = new Lobby({ matches: persistence.matches, rooms: persistence.rooms, log: () => {} })
  const sessions = new Sessions({ lobby, persistence, log: () => {} })
  const [page, server] = loopback()
  sessions.attach(server, { url: 'ws://accounts.test/' })
  const pending = new Map<number, (answer: Answer) => void>()
  let lastId = 0
  page.onFrame((frame) => {
    if ('method' in frame || typeof frame.id !== 'number') return
    const settle = pending.get(frame.id)
    pending.delete(frame.id)
    if ('error' in frame) settle?.({ code: frame.error.code, result: {}, message: frame.error.message })
    else settle?.({ code: null, result: (frame.result ?? {}) as Record<string, unknown>, message: null })
  })
  page.send({ jsonrpc: '2.0', method: RpcMethods.hello, params: { ...MY_VERSION } } as JsonRpcFrame)
  return {
    call: (method, params = {}) => {
      const { promise, resolve } = Promise.withResolvers<Answer>()
      const id = ++lastId
      pending.set(id, resolve)
      page.send({ jsonrpc: '2.0', id, method, params })
      return promise
    },
  }
}

/** Register `name`, all the way through, on `window`, and hand back the session token. */
async function register(window: Window, key: SoftwareAuthenticator, name = 'Tester'): Promise<string> {
  const options = await window.call('tictac/api/account/registerOptions', { name })
  expect(options.code).toBeNull()
  const publicKey = options.result.publicKey as { challenge: string }
  const created = await key.create({ challengeId: options.result.challengeId as string, challenge: publicKey.challenge })
  const verified = await window.call('tictac/api/account/registerVerify', { ...created })
  expect(verified.code).toBeNull()
  return verified.result.token as string
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
})
