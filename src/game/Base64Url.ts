/**
 * base64url, both ways, in the browser and on the server.
 *
 * WebAuthn is a binary protocol behind a JSON API: every challenge, credential
 * id, public key and signature is bytes that has to survive `JSON.stringify` on
 * one side and a TEXT column on the other. base64url (RFC 4648 §5) is what the
 * WebAuthn specification itself uses, and it is url-safe and padding-free,
 * which is what lets the same string be a query parameter and a primary key.
 *
 * `btoa`/`atob` rather than `Buffer`: both are standard and present in Bun and
 * in every browser this game runs in, so this file is shared rather than
 * duplicated per side.
 */

export function toBase64Url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  // Chunked, because `String.fromCharCode(...huge)` overflows the argument
  // limit — and an SPKI key is already several hundred bytes.
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/')
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new Error('not base64url')
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
