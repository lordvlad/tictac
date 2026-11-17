import type { PasskeyAsserted, PasskeyCreated, PasskeyOptions, Player, SignedIn } from '../wire/Rpc'

/**
 * What a match server asks of the directory about a player (RFC-0002 §4).
 *
 * A region's own database holds no account: a player is an id on its rows, and
 * everything that turns the id into somebody — signing them in, proving a
 * passkey, resolving a name — goes through here. The directory is a different
 * Durable Object from a region's, so every call may be a network hop; nothing
 * on this port may be a transaction with the region's own writes.
 *
 * Two implementations answer it: the `Accounts` class itself, in the process
 * that holds the account store (the Bun host, and the singleton Durable
 * Object, which is the directory and a region at once), and
 * `workers/AccountsRpc.ts`, which asks the directory's Durable Object.
 * Refusals are `AuthError`s from either.
 */
export interface AccountsPort {
  /** What the browser needs to create a passkey, and the id of the challenge it answers. */
  registrationOptions(name: string): Promise<PasskeyOptions>
  /** Make a player of a created passkey, and a session for them. Their roster and squad are the region's to make. */
  register(answer: PasskeyCreated): Promise<SignedIn>
  /** What the browser needs to use a passkey. */
  loginOptions(): Promise<PasskeyOptions>
  login(answer: PasskeyAsserted): Promise<SignedIn>
  /** The player behind a session token, or null for one this server will not honour. */
  playerFor(token: string): Promise<Player | null>
  /** A player by id, or null for one who does not exist. */
  player(id: string): Promise<Player | null>
  logout(token: string): Promise<void>
}
