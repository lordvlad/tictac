import type { PasskeyOptions, Player, SignedIn } from '../wire/Rpc'
import type { AccountsPort } from './AccountsPort'
import { AuthError } from './WebAuthn'

/**
 * `AccountsPort` across a Durable Object boundary (RFC-0002 §4): the region
 * that asks, and the directory that answers.
 *
 * Free of any platform, so a test can wire the two halves to each other in one
 * process and the Worker can wire them to a stub: {@link accountsOverRpc} turns
 * a function that carries a request to the directory into a port, and
 * {@link serveAccounts} answers one against the directory's own `Accounts`.
 *
 * A refusal is an `AuthError` with a status the window is told (`Session.ts`),
 * and an exception loses its class crossing an RPC boundary; so it travels as
 * data, and is thrown again as the same class on the far side.
 */

/** One call on the port, as data: the method and the arguments it was given. */
export type AccountsRequest = {
  [M in keyof AccountsPort]: { method: M; args: Parameters<AccountsPort[M]> }
}[keyof AccountsPort]

/** What a call came to: what the directory returned, or the refusal it threw. */
export type AccountsReply =
  | { ok: true; value: PasskeyOptions | SignedIn | Player | null | undefined }
  | { ok: false; status: 400 | 401; message: string }

/** Answer one call against the directory's accounts. Anything but an `AuthError` is the directory's failure and propagates. */
export async function serveAccounts(accounts: AccountsPort, request: AccountsRequest): Promise<AccountsReply> {
  try {
    switch (request.method) {
      case 'registrationOptions':
        return { ok: true, value: await accounts.registrationOptions(...request.args) }
      case 'register':
        return { ok: true, value: await accounts.register(...request.args) }
      case 'loginOptions':
        return { ok: true, value: await accounts.loginOptions() }
      case 'login':
        return { ok: true, value: await accounts.login(...request.args) }
      case 'playerFor':
        return { ok: true, value: await accounts.playerFor(...request.args) }
      case 'player':
        return { ok: true, value: await accounts.player(...request.args) }
      case 'logout':
        await accounts.logout(...request.args)
        return { ok: true, value: undefined }
    }
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, status: error.status, message: error.message }
    throw error
  }
}

/** The directory's accounts as a port, by way of `call`: what carries a request to the directory and brings its reply back. */
export function accountsOverRpc(call: (request: AccountsRequest) => Promise<AccountsReply>): AccountsPort {
  /** The reply's value is whatever the method returns: `serveAccounts` put it there, so the cast only restates it. */
  async function ask<T>(request: AccountsRequest): Promise<T> {
    const reply = await call(request)
    if (!reply.ok) throw new AuthError(reply.status, reply.message)
    return reply.value as T
  }
  return {
    registrationOptions: (name) => ask({ method: 'registrationOptions', args: [name] }),
    register: (answer) => ask({ method: 'register', args: [answer] }),
    loginOptions: () => ask({ method: 'loginOptions', args: [] }),
    login: (answer) => ask({ method: 'login', args: [answer] }),
    playerFor: (token) => ask({ method: 'playerFor', args: [token] }),
    player: (id) => ask({ method: 'player', args: [id] }),
    logout: async (token) => {
      await ask<undefined>({ method: 'logout', args: [token] })
    },
  }
}
