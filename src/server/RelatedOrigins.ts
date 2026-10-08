import type { RelyingParty } from './Persistence'

/** Where a browser looks, on the relying party id's own host, for the origins it may lend that id to. */
export const RELATED_ORIGINS_PATH = '/.well-known/webauthn'

/**
 * WebAuthn Related Origin Requests: a page may ask for a passkey bound to a
 * relying party id it is not a suffix of — the GitHub Pages client asking for
 * the Worker's — only if that id's host lists the page's origin here. The
 * list is the same one the ceremony is checked against (`Accounts`), so a
 * site is either trusted for both or for neither.
 *
 * Chrome/Edge 128+ and Safari 18 fetch this; Firefox does not yet, so there a
 * page must still sit on the relying party's own site.
 */
export function relatedOriginsHandler(party: RelyingParty): (request: Request) => Response | undefined {
  const body = JSON.stringify({ origins: party.origins })
  return (request) => {
    if (new URL(request.url).pathname !== RELATED_ORIGINS_PATH) return undefined
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
    }
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
    })
  }
}
