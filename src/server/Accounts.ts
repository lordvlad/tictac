import { rollSquadSheets } from '../core/Characters'
import { ROSTER } from '../config'
import { Rng } from '../core/rng'
import { fromBase64Url, toBase64Url } from '../game/Base64Url'
import type { PasskeyAsserted, PasskeyCreated, PasskeyOptions, Player, SignedIn } from '../game/Rpc'
import type { Db } from './db/Db'
import type { RelyingParty } from './Persistence'
import type { Rosters } from './Rosters'
import {
  ALGORITHMS,
  AuthError,
  FLAG_USER_PRESENT,
  importCredentialKey,
  parseAuthenticatorData,
  readClientData,
  verifySignature,
} from './WebAuthn'

/**
 * Who a player is, proved by a passkey.
 *
 * Passkeys and nothing else: no password to leak, no email to verify, no third
 * party to depend on, and no account recovery flow to get wrong. A player is a
 * name they chose and a public key their device holds, and the server never
 * sees a secret it could lose.
 *
 * The one thing an account is *for*, in this game, is owning a roster — so a
 * registration that created a player without a squad would be a half-made
 * account, and both happen in one transaction below.
 */

/** How long a challenge is worth answering. Long enough for a human, short enough to be useless later. */
const CHALLENGE_MINUTES = 5
/** How long a signed-in session lasts before the passkey is asked again. */
const SESSION_DAYS = 30

interface ChallengeRow {
  id: string
  purpose: string
  challenge: string
  user_id: string | null
  name: string | null
  expires_at: string
}

interface CredentialRow {
  id: string
  player_id: string
  public_key: string
  algorithm: number
  sign_count: number | string
}

export class Accounts {
  constructor(
    private readonly db: Db,
    private readonly rosters: Rosters,
    private readonly party: RelyingParty,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** What the browser needs to create a passkey, and the id of the challenge it answers. */
  async registrationOptions(rawName: string): Promise<PasskeyOptions> {
    const name = rawName.trim()
    if (name.length < 1 || name.length > 24) {
      throw new AuthError(400, 'a name is 1 to 24 characters')
    }
    // The player id is settled here rather than at verification, because the
    // authenticator stores it inside the passkey: it is what a discoverable
    // credential hands back at sign-in.
    const userId = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
    const { id, challenge } = await this.issueChallenge('register', userId, name)
    return {
      challengeId: id,
      publicKey: {
        challenge,
        rp: { id: this.party.id, name: 'TicTac' },
        user: { id: userId, name, displayName: name },
        pubKeyCredParams: [
          { type: 'public-key', alg: ALGORITHMS.ES256 },
          { type: 'public-key', alg: ALGORITHMS.RS256 },
        ],
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
        attestation: 'none',
        timeout: 60_000,
      },
    }
  }

  /** Take a created passkey, and with it make a player, a squad and a session. */
  async register(answer: PasskeyCreated): Promise<SignedIn> {
    const challenge = await this.takeChallenge(answer.challengeId, 'register')
    readClientData(fromBase64Url(answer.clientDataJSON), {
      type: 'webauthn.create',
      challenge: challenge.challenge,
      origins: this.party.origins,
    })

    const authenticator = parseAuthenticatorData(fromBase64Url(answer.authenticatorData))
    await this.checkRelyingParty(authenticator.rpIdHash)
    if ((authenticator.flags & FLAG_USER_PRESENT) === 0) {
      throw new AuthError(400, 'the user was not present')
    }

    const spki = fromBase64Url(answer.publicKey)
    // Imported now, not at first sign-in: a key this server cannot verify is a
    // passkey the player could never use, and finding that out later is worse.
    await importCredentialKey(spki, answer.publicKeyAlgorithm)

    const existing = await this.db
      .query<{ id: string }>`SELECT id FROM credentials WHERE id = ${answer.credentialId}`
    if (existing.length > 0) throw new AuthError(400, 'that passkey is already registered')

    const playerId = challenge.user_id
    const name = challenge.name
    if (!playerId || !name) throw new AuthError(400, 'that sign-in request is not a registration')

    const created = this.now().toISOString()
    const token = await this.db.transaction(async (tx) => {
      await tx.query`INSERT INTO players (id, name, created_at) VALUES (${playerId}, ${name}, ${created})`
      await tx.query`INSERT INTO credentials (id, player_id, public_key, algorithm, sign_count, created_at)
                     VALUES (${answer.credentialId}, ${playerId}, ${answer.publicKey},
                             ${answer.publicKeyAlgorithm}, ${authenticator.signCount}, ${created})`
      // The squad is rolled by the server, from system randomness: a client
      // that dealt its own would deal itself six prodigies. A full roster,
      // not a squad — the bench exists so resting anyone is a choice.
      const seed = crypto.getRandomValues(new Uint32Array(1))[0]!
      await this.rosters.enlist(tx, playerId, rollSquadSheets(new Rng(seed), ROSTER.size))
      return this.startSession(tx, playerId)
    })
    return { token, player: { id: playerId, name } }
  }

  /**
   * What the browser needs to use a passkey.
   *
   * No `allowCredentials`: the passkeys here are discoverable, so the
   * authenticator offers the player their accounts rather than the server
   * having to know who is signing in before they have said so.
   */
  async loginOptions(): Promise<PasskeyOptions> {
    const { id, challenge } = await this.issueChallenge('login', null, null)
    return {
      challengeId: id,
      publicKey: {
        challenge,
        rpId: this.party.id,
        userVerification: 'preferred',
        timeout: 60_000,
      },
    }
  }

  async login(answer: PasskeyAsserted): Promise<SignedIn> {
    const challenge = await this.takeChallenge(answer.challengeId, 'login')
    const rows = await this.db.query<CredentialRow>`
      SELECT id, player_id, public_key, algorithm, sign_count
        FROM credentials WHERE id = ${answer.credentialId}`
    const credential = rows[0]
    if (!credential) throw new AuthError(401, 'unknown passkey')

    const clientDataJSON = fromBase64Url(answer.clientDataJSON)
    readClientData(clientDataJSON, {
      type: 'webauthn.get',
      challenge: challenge.challenge,
      origins: this.party.origins,
    })

    const authenticatorData = fromBase64Url(answer.authenticatorData)
    const authenticator = parseAuthenticatorData(authenticatorData)
    await this.checkRelyingParty(authenticator.rpIdHash)
    if ((authenticator.flags & FLAG_USER_PRESENT) === 0) {
      throw new AuthError(400, 'the user was not present')
    }

    const algorithm = Number(credential.algorithm)
    const key = await importCredentialKey(fromBase64Url(credential.public_key), algorithm)
    // What is signed is the authenticator's own data followed by a hash of the
    // client's account of the ceremony — which is what binds the signature to
    // this challenge and this origin rather than to any request at all.
    const signed = new Uint8Array(authenticatorData.length + 32)
    signed.set(authenticatorData)
    signed.set(new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON)), authenticatorData.length)
    const ok = await verifySignature(key, algorithm, fromBase64Url(answer.signature), signed)
    if (!ok) throw new AuthError(401, 'the passkey signature does not check out')

    const stored = Number(credential.sign_count)
    const next = authenticator.signCount
    // An authenticator that counts keeps a counter that only goes up, so a
    // repeat means somebody cloned it. One that does not count reports zero
    // forever, which is not evidence of anything.
    if ((stored > 0 || next > 0) && next <= stored) {
      throw new AuthError(401, "this passkey's counter went backwards; it may have been copied")
    }

    const players = await this.db
      .query<{ name: string }>`SELECT name FROM players WHERE id = ${credential.player_id}`
    const player = players[0]
    if (!player) throw new AuthError(401, 'unknown passkey')

    await this.db.query`UPDATE credentials SET sign_count = ${next} WHERE id = ${credential.id}`
    const token = await this.startSession(this.db, credential.player_id)
    return { token, player: { id: credential.player_id, name: player.name } }
  }

  /** The player behind a session token, or null for one this server will not honour. */
  async playerFor(token: string): Promise<Player | null> {
    const rows = await this.db.query<{ id: string; name: string; expires_at: string }>`
      SELECT p.id AS id, p.name AS name, s.expires_at AS expires_at
        FROM sessions s JOIN players p ON p.id = s.player_id
       WHERE s.token_hash = ${await sha256Hex(token)}`
    const row = rows[0]
    if (!row) return null
    if (Date.parse(row.expires_at) <= this.now().getTime()) return null
    return { id: row.id, name: row.name }
  }

  async logout(token: string): Promise<void> {
    await this.db.query`DELETE FROM sessions WHERE token_hash = ${await sha256Hex(token)}`
  }

  private async issueChallenge(
    purpose: 'register' | 'login',
    userId: string | null,
    name: string | null,
  ): Promise<{ id: string; challenge: string }> {
    // Swept on the way past rather than on a timer: a challenge nobody answered
    // is dead weight, and this is the only place that makes them.
    await this.db.query`DELETE FROM auth_challenges WHERE expires_at <= ${this.now().toISOString()}`
    const id = crypto.randomUUID()
    const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const expires = new Date(this.now().getTime() + CHALLENGE_MINUTES * 60_000).toISOString()
    await this.db.query`INSERT INTO auth_challenges (id, purpose, challenge, user_id, name, expires_at)
                        VALUES (${id}, ${purpose}, ${challenge}, ${userId}, ${name}, ${expires})`
    return { id, challenge }
  }

  /**
   * Take a challenge out of the database, so it can only be answered once.
   *
   * Deleted rather than marked: a challenge that is still there after it has
   * been answered is a replay waiting to happen.
   */
  private async takeChallenge(id: string, purpose: string): Promise<ChallengeRow> {
    const rows = await this.db.query<ChallengeRow>`
      DELETE FROM auth_challenges WHERE id = ${id} AND purpose = ${purpose} RETURNING *`
    const row = rows[0]
    if (!row || Date.parse(row.expires_at) <= this.now().getTime()) {
      throw new AuthError(400, 'the sign-in request expired or was already used; try again')
    }
    return row
  }

  private async checkRelyingParty(rpIdHash: Uint8Array): Promise<void> {
    const expected = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.party.id)),
    )
    const same =
      rpIdHash.length === expected.length && rpIdHash.every((byte, i) => byte === expected[i])
    if (!same) throw new AuthError(400, 'wrong relying party')
  }

  /**
   * The token is returned and never stored; only its hash is.
   *
   * A stolen database is then not a drawer full of working sessions.
   */
  private async startSession(db: Db, playerId: string): Promise<string> {
    const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const created = this.now()
    const expires = new Date(created.getTime() + SESSION_DAYS * 86_400_000)
    await db.query`INSERT INTO sessions (token_hash, player_id, created_at, expires_at)
                   VALUES (${await sha256Hex(token)}, ${playerId}, ${created.toISOString()}, ${expires.toISOString()})`
    return token
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
