import { describe, expect, test } from 'bun:test'
import { SQUAD_SIZE } from '../src/config'
import { fromBase64Url, toBase64Url } from '../src/game/Base64Url'
import { apiHandler } from '../src/server/Api'
import { LOCAL_RELYING_PARTY, type Persistence } from '../src/server/Persistence'
import type { RosterMember } from '../src/server/Rosters'
import { softwareAuthenticator, type SoftwareAuthenticator } from './support/authenticator'
import { DATABASE_URLS, freshPersistence } from './support/db'

/**
 * The whole sign-in path, driven with `Request` objects rather than a socket.
 *
 * `apiHandler` takes a request and answers a response, so a test needs no port
 * and no fetch: what is exercised here is every check the server makes, which
 * is the part worth being sure about.
 */

const ORIGIN = LOCAL_RELYING_PARTY.origins[0]!

interface ApiCall {
  status: number
  body: Record<string, unknown>
  response: Response
}

interface ApiDriver {
  call(
    method: string,
    path: string,
    options?: { body?: unknown; token?: string; origin?: string },
  ): Promise<ApiCall>
}

function driver(persistence: Persistence): ApiDriver {
  const handle = apiHandler(persistence, LOCAL_RELYING_PARTY, () => {})

  const call = async (
    method: string,
    path: string,
    options: { body?: unknown; token?: string; origin?: string } = {},
  ): Promise<ApiCall> => {
    const headers: Record<string, string> = { origin: options.origin ?? ORIGIN }
    if (options.token) headers.authorization = `Bearer ${options.token}`
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const response = await handle(
      new Request(`http://localhost:5174${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
    )
    if (!response) throw new Error(`${path} was not handled`)
    const text = await response.text()
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      response,
    }
  }

  return { call }
}

/** Register `name`, all the way through, and hand back the session token. */
async function register(
  api: ApiDriver,
  key: SoftwareAuthenticator,
  name = 'Tester',
): Promise<string> {
  const options = await api.call('POST', '/api/auth/register/options', { body: { name } })
  expect(options.status).toBe(200)
  const publicKey = options.body.publicKey as { challenge: string }
  const created = await key.create({
    challengeId: options.body.challengeId as string,
    challenge: publicKey.challenge,
  })
  const verified = await api.call('POST', '/api/auth/register/verify', { body: created })
  expect(verified.status).toBe(200)
  return verified.body.token as string
}

describe.each(DATABASE_URLS)('Passkey accounts on %s', (url) => {
  test('registering makes a player, a squad and a session', async () => {
    const persistence = await freshPersistence(url)
    const api = driver(persistence)
    const key = await softwareAuthenticator()

    const token = await register(api, key)
    expect(typeof token).toBe('string')

    const me = await api.call('GET', '/api/me', { token })
    expect(me.status).toBe(200)
    expect((me.body.player as { name: string }).name).toBe('Tester')

    // An account exists to own a roster, so registration that did not deal one
    // would be a half-made account.
    const roster = await api.call('GET', '/api/roster', { token })
    const members = roster.body.roster as RosterMember[]
    expect(members).toHaveLength(SQUAD_SIZE)
    expect(members.map((member) => member.slot)).toEqual([0, 1, 2, 3])
    expect(members.every((member) => member.matches === 0)).toBe(true)

    await persistence.close()
  })

  test('recruiting fills a dead slot, and refuses once the roster is full', async () => {
    const persistence = await freshPersistence(url)
    const api = driver(persistence)
    const key = await softwareAuthenticator()

    const token = await register(api, key)
    const before = await api.call('GET', '/api/roster', { token })
    const player = (before.body.roster as RosterMember[])[0]!

    // Killed outright, the way `Rosters.settle` marks a dead row — the API
    // has no route for that, so the test reaches for the row directly.
    await persistence.db.query`UPDATE roster SET status = ${'dead'} WHERE character_id = ${player.characterId}`

    const recruited = await api.call('POST', '/api/roster/recruit', { token })
    expect(recruited.status).toBe(200)
    const recruit = recruited.body.member as RosterMember
    expect(recruit.slot).toBe(player.slot)
    expect(recruit.characterId).not.toBe(player.characterId)

    const after = await api.call('GET', '/api/roster', { token })
    const members = after.body.roster as RosterMember[]
    expect(members).toHaveLength(SQUAD_SIZE)
    expect(members.map((member) => member.slot)).toEqual([0, 1, 2, 3])

    const full = await api.call('POST', '/api/roster/recruit', { token })
    expect(full.status).toBe(400)
    expect(full.body.error).toMatch(/already full/)

    await persistence.close()
  })

  test('the same passkey signs in again, and the new token works', async () => {
    const persistence = await freshPersistence(url)
    const api = driver(persistence)
    const key = await softwareAuthenticator()
    const first = await register(api, key)

    const options = await api.call('POST', '/api/auth/login/options', { body: {} })
    const publicKey = options.body.publicKey as { challenge: string }
    const asserted = await key.assert({
      challengeId: options.body.challengeId as string,
      challenge: publicKey.challenge,
    })
    const verified = await api.call('POST', '/api/auth/login/verify', { body: asserted })

    expect(verified.status).toBe(200)
    const token = verified.body.token as string
    expect(token).not.toBe(first)
    expect((await api.call('GET', '/api/me', { token })).status).toBe(200)

    await persistence.close()
  })

  test('a challenge is worth exactly one answer', async () => {
    // Replay is the attack a challenge exists to stop, so the row is deleted as
    // it is read rather than marked afterwards.
    const persistence = await freshPersistence(url)
    const api = driver(persistence)
    const key = await softwareAuthenticator()
    await register(api, key)

    const options = await api.call('POST', '/api/auth/login/options', { body: {} })
    const publicKey = options.body.publicKey as { challenge: string }
    const asserted = await key.assert({
      challengeId: options.body.challengeId as string,
      challenge: publicKey.challenge,
    })
    expect((await api.call('POST', '/api/auth/login/verify', { body: asserted })).status).toBe(200)

    const again = await api.call('POST', '/api/auth/login/verify', { body: asserted })
    expect(again.status).toBe(400)
    expect(again.body.error).toMatch(/expired or was already used/)

    await persistence.close()
  })

  test('a signature made over another challenge is refused', async () => {
    // The challenge id says which row to spend; the challenge *value* is what
    // the authenticator actually signed. Checking only the first would accept a
    // signature collected for any other sign-in attempt.
    const persistence = await freshPersistence(url)
    const api = driver(persistence)
    const key = await softwareAuthenticator()
    await register(api, key)

    const mine = await api.call('POST', '/api/auth/login/options', { body: {} })
    const other = await api.call('POST', '/api/auth/login/options', { body: {} })
    const asserted = await key.assert({
      challengeId: mine.body.challengeId as string,
      challenge: (other.body.publicKey as { challenge: string }).challenge,
    })

    const verified = await api.call('POST', '/api/auth/login/verify', { body: asserted })
    expect(verified.status).toBe(400)
    expect(verified.body.error).toMatch(/challenge mismatch/)

    await persistence.close()
  })

  test('a ceremony performed for another site is refused', async () => {
    // The origin is what makes a passkey unphishable: a page on another domain
    // cannot make the authenticator write this one.
    const persistence = await freshPersistence(url)
    const api = driver(persistence)
    const key = await softwareAuthenticator()

    const options = await api.call('POST', '/api/auth/register/options', { body: { name: 'Mark' } })
    const publicKey = options.body.publicKey as { challenge: string }
    const created = await key.create({
      challengeId: options.body.challengeId as string,
      challenge: publicKey.challenge,
      origin: 'https://evil.example',
    })

    const verified = await api.call('POST', '/api/auth/register/verify', { body: created })
    expect(verified.status).toBe(400)
    expect(verified.body.error).toMatch(/origin https:\/\/evil\.example is not allowed/)

    await persistence.close()
  })

  test('a signature that does not check out is refused', async () => {
    const persistence = await freshPersistence(url)
    const api = driver(persistence)
    const key = await softwareAuthenticator()
    await register(api, key)

    const options = await api.call('POST', '/api/auth/login/options', { body: {} })
    const publicKey = options.body.publicKey as { challenge: string }
    const asserted = await key.assert({
      challengeId: options.body.challengeId as string,
      challenge: publicKey.challenge,
    })
    // One byte of `s`, so the DER still parses and the signature is simply
    // wrong — which is the failure that matters.
    const bytes = fromBase64Url(asserted.signature)
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
    const verified = await api.call('POST', '/api/auth/login/verify', {
      body: { ...asserted, signature: toBase64Url(bytes) },
    })

    expect(verified.status).toBe(401)
    expect(verified.body.error).toMatch(/does not check out/)

    await persistence.close()
  })

  test('a counter that did not move says the passkey was copied', async () => {
    const persistence = await freshPersistence(url)
    const api = driver(persistence)
    const key = await softwareAuthenticator()
    await register(api, key)

    const options = await api.call('POST', '/api/auth/login/options', { body: {} })
    const publicKey = options.body.publicKey as { challenge: string }
    const asserted = await key.assert({
      challengeId: options.body.challengeId as string,
      challenge: publicKey.challenge,
      // The count the registration already recorded. An authenticator that
      // counts never repeats one.
      counter: 1,
    })
    const verified = await api.call('POST', '/api/auth/login/verify', { body: asserted })

    expect(verified.status).toBe(401)
    expect(verified.body.error).toMatch(/counter went backwards/)

    await persistence.close()
  })

  test('a roster is not a stranger to read', async () => {
    const persistence = await freshPersistence(url)
    const api = driver(persistence)

    const anonymous = await api.call('GET', '/api/roster')
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.error).toBe('sign in first')

    const wrong = await api.call('GET', '/api/roster', { token: 'not-a-token' })
    expect(wrong.status).toBe(401)

    await persistence.close()
  })

  test('a ticket is spent the first time it is used', async () => {
    const persistence = await freshPersistence(url)
    const api = driver(persistence)
    const key = await softwareAuthenticator()
    const token = await register(api, key)

    const issued = await api.call('POST', '/api/ticket', { token })
    const ticket = issued.body.ticket as string
    expect(typeof ticket).toBe('string')

    // Single use: a url with a ticket in it is a url that stops working the
    // moment it has been used once.
    expect(persistence.accounts.redeemTicket(ticket)).not.toBeNull()
    expect(persistence.accounts.redeemTicket(ticket)).toBeNull()
    expect(persistence.accounts.redeemTicket('invented')).toBeNull()

    await persistence.close()
  })

  test('signing out ends the session', async () => {
    const persistence = await freshPersistence(url)
    const api = driver(persistence)
    const key = await softwareAuthenticator()
    const token = await register(api, key)

    expect((await api.call('POST', '/api/auth/logout', { token })).status).toBe(204)
    expect((await api.call('GET', '/api/me', { token })).status).toBe(401)

    await persistence.close()
  })

  test('an unknown endpoint says so rather than failing', async () => {
    const persistence = await freshPersistence(url)
    const api = driver(persistence)

    const missing = await api.call('GET', '/api/nothing')
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('no such endpoint')

    await persistence.close()
  })
})

describe('Which pages this server is part of', () => {
  test('a configured origin is allowed, and anything else is not', async () => {
    const persistence = await freshPersistence(':memory:')
    const api = driver(persistence)

    const allowed = await api.call('OPTIONS', '/api/me')
    expect(allowed.status).toBe(204)
    expect(allowed.response.headers.get('access-control-allow-origin')).toBe(ORIGIN)

    const other = await api.call('OPTIONS', '/api/me', { origin: 'http://other' })
    expect(other.status).toBe(204)
    expect(other.response.headers.get('access-control-allow-origin')).toBeNull()

    await persistence.close()
  })
})
