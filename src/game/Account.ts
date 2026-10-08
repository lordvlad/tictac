import { sanitizeSheet } from '../core/Characters'
import { fromBase64Url, toBase64Url } from './Base64Url'
import type { Player, RosterEntry } from './Rpc'
import type { ServerConnection } from './ServerConnection'

export type { Player, RosterEntry } from './Rpc'

/**
 * The player's account on one match server, from the browser's side.
 *
 * A match server keeps rosters; a player signs in with a passkey so the server
 * knows whose roster to deploy. None of this touches local or peer-to-peer
 * play, which still rolls a fresh squad and writes nothing anywhere.
 *
 * Everything here is a request on the window's one connection to that server
 * (`ServerConnection`, `src/game/Rpc.ts`). What is left on this side is the
 * part only a browser can do — the passkey ceremony itself — and reading what
 * comes back as this build reads it. Who the window is signed in as is the
 * connection's to know (`connection.player`): it presents the stored token on
 * every socket it opens.
 */
export class Account {
  constructor(private readonly connection: ServerConnection) {}

  /** Make a passkey, and with it a player and a squad on this server. */
  async register(name: string): Promise<Player> {
    const options = await this.connection.request('tictac/api/account/registerOptions', { name })
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

    const signed = await this.connection.request('tictac/api/account/registerVerify', {
      challengeId: options.challengeId,
      credentialId: toBase64Url(credential.rawId),
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.getAuthenticatorData()),
      publicKey: toBase64Url(spki),
      publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
    })
    this.connection.signedIn(signed)
    return signed.player
  }

  async signIn(): Promise<Player> {
    const options = await this.connection.request('tictac/api/account/loginOptions', {})
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
    const signed = await this.connection.request('tictac/api/account/loginVerify', {
      challengeId: options.challengeId,
      credentialId: toBase64Url(credential.rawId),
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
    })
    this.connection.signedIn(signed)
    return signed.player
  }

  /**
   * End the session on the server as well as here: a token that is only
   * forgotten locally is a token that still works. Forgotten here whatever
   * the server says, so a window can always get back to being nobody.
   */
  async signOut(): Promise<void> {
    try {
      if (this.connection.player) await this.connection.request('tictac/api/account/signOut', {})
    } finally {
      this.connection.signedOut()
    }
  }

  /**
   * Every active character on this server's roster for this player — the
   * dead never come back, so only the living are worth a client knowing
   * about (`[ITEM-042]`): slot, sheet, current HP and the id the referee
   * checks a deployment against.
   */
  async roster(): Promise<RosterEntry[]> {
    const { roster } = await this.connection.request('tictac/api/roster/list', {})
    return roster.map((member) => ({ ...member, sheet: sanitizeSheet(member.sheet) }))
  }

  /** Fill the lowest empty slot with a fresh recruit (`[ITEM-037]`). */
  async recruit(): Promise<RosterEntry> {
    const { member } = await this.connection.request('tictac/api/roster/recruit', {})
    return { ...member, sheet: sanitizeSheet(member.sheet) }
  }
}
