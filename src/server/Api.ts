import type { Player } from './Accounts'
import type { Lobby } from './Lobby'
import type { Persistence, RelyingParty } from './Persistence'
import { AuthError } from './WebAuthn'

/**
 * The match server's HTTP side: signing in, what being signed in gets you, and
 * the lobby's room list.
 *
 * Everything the game itself does still travels over the WebSocket as JSON-RPC
 * notifications. What is here is the part that cannot: a passkey ceremony needs
 * request/response, a browser cannot put an `Authorization` header on a
 * socket — hence `/api/ticket` — and a player choosing a room to join wants to
 * see the rooms before holding a socket to any of them (`/api/lobby`).
 *
 * It answers null for anything that is not `/api/…`, so the caller keeps its
 * own routes (the upgrade, the status document) without this file knowing about
 * them.
 */

export function apiHandler(
  persistence: Persistence,
  lobby: Lobby,
  party: RelyingParty,
  log: (message: string) => void,
): (request: Request) => Promise<Response | null> {
  const { accounts, rosters } = persistence

  /**
   * CORS, from the configured origins only.
   *
   * The same list the passkey ceremony is checked against, because they are the
   * same question: which pages is this server part of?
   */
  const cors = (request: Request): Record<string, string> => {
    const origin = request.headers.get('origin')
    if (!origin || !party.origins.includes(origin)) return {}
    return {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    }
  }

  /** The player a bearer token names, or null for none — or for one this server will not honour. */
  const signedIn = async (request: Request): Promise<Player | null> => {
    const header = request.headers.get('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    return token ? await accounts.playerFor(token) : null
  }

  const bearer = async (request: Request): Promise<Player> => {
    const player = await signedIn(request)
    if (!player) throw new AuthError(401, 'sign in first')
    return player
  }

  const body = async (request: Request): Promise<Record<string, unknown>> => {
    try {
      const parsed: unknown = await request.json()
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
      return parsed as Record<string, unknown>
    } catch {
      throw new AuthError(400, 'the request body is not JSON')
    }
  }

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return null
    const headers = cors(request)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })

    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'POST /api/auth/register/options': {
          const fields = await body(request)
          return Response.json(await accounts.registrationOptions(text(fields, 'name')), { headers })
        }
        case 'POST /api/auth/register/verify': {
          const fields = await body(request)
          const result = await accounts.register({
            challengeId: text(fields, 'challengeId'),
            credentialId: text(fields, 'credentialId'),
            clientDataJSON: text(fields, 'clientDataJSON'),
            authenticatorData: text(fields, 'authenticatorData'),
            publicKey: text(fields, 'publicKey'),
            publicKeyAlgorithm: number(fields, 'publicKeyAlgorithm'),
          })
          return Response.json(result, { headers })
        }
        case 'POST /api/auth/login/options':
          return Response.json(await accounts.loginOptions(), { headers })
        case 'POST /api/auth/login/verify': {
          const fields = await body(request)
          const result = await accounts.login({
            challengeId: text(fields, 'challengeId'),
            credentialId: text(fields, 'credentialId'),
            clientDataJSON: text(fields, 'clientDataJSON'),
            authenticatorData: text(fields, 'authenticatorData'),
            signature: text(fields, 'signature'),
          })
          return Response.json(result, { headers })
        }
        case 'POST /api/auth/logout': {
          const header = request.headers.get('authorization') ?? ''
          await bearer(request)
          await accounts.logout(header.slice(7))
          return new Response(null, { status: 204, headers })
        }
        case 'GET /api/me':
          return Response.json({ player: await bearer(request) }, { headers })
        // Open to anybody, signed in or not: the lobby is a public room list.
        // A token only adds which seat is the asker's own, so one that has
        // expired costs them that and nothing else — not a 401 on a page
        // they could read without it.
        case 'GET /api/lobby':
          return Response.json(lobby.view(await signedIn(request)), { headers })
        case 'GET /api/roster': {
          const player = await bearer(request)
          return Response.json({ roster: await rosters.active(player.id) }, { headers })
        }
        case 'POST /api/roster/recruit': {
          const player = await bearer(request)
          return Response.json({ member: await rosters.recruit(player.id) }, { headers })
        }
        case 'POST /api/ticket': {
          const player = await bearer(request)
          return Response.json({ ticket: accounts.issueTicket(player) }, { headers })
        }
        default:
          return Response.json({ error: 'no such endpoint' }, { status: 404, headers })
      }
    } catch (error) {
      if (error instanceof AuthError) {
        return Response.json({ error: error.message }, { status: error.status, headers })
      }
      // Anything else is this server's fault, and the player is told nothing
      // about it beyond that: an internal message is an invitation to probe.
      log(`[api] ${url.pathname} failed: ${error instanceof Error ? error.stack : String(error)}`)
      return Response.json({ error: 'the server failed' }, { status: 500, headers })
    }
  }
}

function text(fields: Record<string, unknown>, key: string): string {
  const value = fields[key]
  if (typeof value !== 'string') throw new AuthError(400, `missing ${key}`)
  return value
}

function number(fields: Record<string, unknown>, key: string): number {
  const value = fields[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AuthError(400, `missing ${key}`)
  }
  return value
}
