import type { MatchDurableObject } from './MatchDurableObject'

export interface Env {
  MATCH: DurableObjectNamespace<MatchDurableObject>
  ASSETS: Fetcher
  /** The domain a real deploy's passkeys are bound to. Unset until one is chosen. */
  RELYING_PARTY_ID?: string
  /** Comma-separated origins CORS and the passkey ceremony both check against. */
  RELYING_PARTY_ORIGINS?: string
}

/**
 * The Worker itself is a router with exactly one destination.
 *
 * Every request — a page load, an asset, a WebSocket upgrade — is forwarded
 * to the same Durable Object instance, addressed by a fixed name rather than
 * one derived from the request. `[ITEM-045]` plants a single DO on purpose:
 * a match server is one lobby of rooms, so there is one of it, the same way
 * `startGameServer` binds one port to one `Lobby` today.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.MATCH.idFromName('singleton')
    const stub = env.MATCH.get(id)
    return stub.fetch(request)
  },
} satisfies ExportedHandler<Env>

export { MatchDurableObject } from './MatchDurableObject'
