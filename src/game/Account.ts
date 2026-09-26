import { sanitizeSheet, type CharacterSheet } from '../core/Characters'
import { fromBase64Url, toBase64Url } from './Base64Url'

/**
 * The player's account on one match server, from the browser's side.
 *
 * A match server keeps rosters; a player signs in with a passkey so the server
 * knows whose roster to deploy. None of this touches local or peer-to-peer
 * play, which still rolls a fresh squad and writes nothing anywhere.
 *
 * One `Account` per server url: the token is stored under that url, because two
 * servers are two different sets of people.
 */

export interface Player {
  id: string
  name: string
}

interface Failure {
  error?: string
}

export class Account {
  /** The same host over HTTP, since the game is addressed by its socket url. */
  readonly httpBase: string

  constructor(serverUrl: string) {
    const url = new URL(serverUrl)
    const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol
    this.httpBase = `${protocol}//${url.host}`
  }

  private get storageKey(): string {
    return `tictac.session:${this.httpBase}`
  }

  get token(): string | null {
    return localStorage.getItem(this.storageKey)
  }

  /** Who this browser is signed in as, or null. A rejected token is cleared. */
  async me(): Promise<Player | null> {
    if (!this.token) return null
    try {
      const { player } = await this.call<{ player: Player }>('GET', '/api/me')
      return player
    } catch (error) {
      if (error instanceof Error && error.message === 'sign in first') {
        localStorage.removeItem(this.storageKey)
        return null
      }
      throw error
    }
  }

  /** Make a passkey, and with it a player and a squad on this server. */
  async register(name: string): Promise<Player> {
    const options = await this.call<{ challengeId: string; publicKey: Record<string, unknown> }>(
      'POST',
      '/api/auth/register/options',
      { name },
    )
    const publicKey = options.publicKey as unknown as PublicKeyCredentialCreationOptions & {
      challenge: string
      user: { id: string; name: string; displayName: string }
    }
    const credential = (await navigator.credentials.create({
      publicKey: {
        ...publicKey,
        challenge: fromBase64Url(publicKey.challenge),
        user: { ...publicKey.user, id: fromBase64Url(publicKey.user.id) },
      },
    })) as PublicKeyCredential | null
    if (!credential) throw new Error('no passkey was created')

    const response = credential.response as AuthenticatorAttestationResponse
    const spki = response.getPublicKey()
    if (!spki) throw new Error("this browser cannot hand over the passkey's public key")

    const { token, player } = await this.call<{ token: string; player: Player }>(
      'POST',
      '/api/auth/register/verify',
      {
        challengeId: options.challengeId,
        credentialId: toBase64Url(credential.rawId),
        clientDataJSON: toBase64Url(response.clientDataJSON),
        authenticatorData: toBase64Url(response.getAuthenticatorData()),
        publicKey: toBase64Url(spki),
        publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
      },
    )
    localStorage.setItem(this.storageKey, token)
    return player
  }

  async signIn(): Promise<Player> {
    const options = await this.call<{ challengeId: string; publicKey: Record<string, unknown> }>(
      'POST',
      '/api/auth/login/options',
      {},
    )
    const publicKey = options.publicKey as unknown as {
      challenge: string
      rpId: string
      userVerification: UserVerificationRequirement
      timeout: number
    }
    const credential = (await navigator.credentials.get({
      publicKey: { ...publicKey, challenge: fromBase64Url(publicKey.challenge) },
    })) as PublicKeyCredential | null
    if (!credential) throw new Error('no passkey was offered')

    const response = credential.response as AuthenticatorAssertionResponse
    const { token, player } = await this.call<{ token: string; player: Player }>(
      'POST',
      '/api/auth/login/verify',
      {
        challengeId: options.challengeId,
        credentialId: toBase64Url(credential.rawId),
        clientDataJSON: toBase64Url(response.clientDataJSON),
        authenticatorData: toBase64Url(response.authenticatorData),
        signature: toBase64Url(response.signature),
      },
    )
    localStorage.setItem(this.storageKey, token)
    return player
  }

  async signOut(): Promise<void> {
    if (this.token) {
      // The session is ended on the server as well as forgotten here: a token
      // that is only deleted locally is a token that still works.
      await this.call('POST', '/api/auth/logout', {}).catch(() => undefined)
    }
    localStorage.removeItem(this.storageKey)
  }

  /** The squad this server keeps for the player, in slot order. */
  async roster(): Promise<CharacterSheet[]> {
    const { roster } = await this.call<{ roster: { sheet: unknown }[] }>('GET', '/api/roster')
    return roster.map((member) => sanitizeSheet(member.sheet))
  }

  /**
   * The socket url with a single-use ticket on it.
   *
   * A browser cannot put an `Authorization` header on a WebSocket, so the
   * session buys a ticket that is worth one connection and expires in a minute.
   */
  async socketUrl(wsUrl: string): Promise<string> {
    const { ticket } = await this.call<{ ticket: string }>('POST', '/api/ticket', {})
    const url = new URL(wsUrl)
    url.searchParams.set('ticket', ticket)
    return url.toString()
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {}
    const token = this.token
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${this.httpBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.status === 204) return undefined as T
    const text = await response.text()
    const parsed = text ? (JSON.parse(text) as T & Failure) : ({} as T & Failure)
    if (!response.ok) throw new Error(parsed.error ?? `the server answered ${response.status}`)
    return parsed
  }
}
