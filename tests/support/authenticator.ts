import { toBase64Url } from '../../src/game/Base64Url'

/**
 * A passkey, in software.
 *
 * The server's half of WebAuthn is the only half worth testing here, and it
 * cannot be tested without something that signs. This is that something: a
 * P-256 key pair, the two byte layouts an authenticator produces, and a
 * signature over them. It is deliberately obedient — every way of being
 * dishonest (another origin, a flipped byte, a counter that stands still) is
 * asked for explicitly by a test.
 */

const encoder = new TextEncoder()

export interface CreatedCredential {
  challengeId: string
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  publicKey: string
  publicKeyAlgorithm: number
}

export interface AssertedCredential {
  challengeId: string
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  signature: string
}

export interface SoftwareAuthenticator {
  credentialId: string
  /** What `navigator.credentials.create` would hand back, base64url throughout. */
  create(options: {
    challengeId: string
    challenge: string
    origin?: string
  }): Promise<CreatedCredential>
  /** What `navigator.credentials.get` would hand back. */
  assert(options: {
    challengeId: string
    challenge: string
    origin?: string
    /** Replaces the counter instead of advancing it, for the cloning test. */
    counter?: number
  }): Promise<AssertedCredential>
}

export async function softwareAuthenticator(
  rpId = 'localhost',
  defaultOrigin = 'http://localhost:5173',
): Promise<SoftwareAuthenticator> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ])
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  const credentialId = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(rpId)))
  let counter = 0

  const authenticatorData = (count: number): Uint8Array => {
    const bytes = new Uint8Array(37)
    bytes.set(rpIdHash)
    // User present and user verified, which is what a platform authenticator
    // reports after a fingerprint.
    bytes[32] = 0x05
    new DataView(bytes.buffer).setUint32(33, count, false)
    return bytes
  }

  const clientData = (type: string, challenge: string, origin: string): Uint8Array<ArrayBuffer> =>
    encoder.encode(JSON.stringify({ type, challenge, origin }))

  return {
    credentialId,
    async create({ challengeId, challenge, origin = defaultOrigin }) {
      counter += 1
      return {
        challengeId,
        credentialId,
        clientDataJSON: toBase64Url(clientData('webauthn.create', challenge, origin)),
        authenticatorData: toBase64Url(authenticatorData(counter)),
        publicKey: toBase64Url(spki),
        publicKeyAlgorithm: -7,
      }
    },
    async assert({ challengeId, challenge, origin = defaultOrigin, counter: fixed }) {
      if (fixed === undefined) counter += 1
      const data = authenticatorData(fixed ?? counter)
      const client = clientData('webauthn.get', challenge, origin)
      const signed = new Uint8Array(data.length + 32)
      signed.set(data)
      signed.set(new Uint8Array(await crypto.subtle.digest('SHA-256', client)), data.length)
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed),
      )
      return {
        challengeId,
        credentialId,
        clientDataJSON: toBase64Url(client),
        authenticatorData: toBase64Url(data),
        signature: toBase64Url(rawToDer(raw)),
      }
    },
  }
}

/**
 * `r‖s` back to the DER a real authenticator emits, which is what the server
 * parses. Test-only: the server never produces a signature, so this is the
 * inverse of `derToRaw` and lives nowhere near it.
 */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2
  const integer = (bytes: Uint8Array): number[] => {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    const body = [...bytes.subarray(start)]
    // DER integers are signed, so a high bit means a leading zero is needed.
    if (body[0]! & 0x80) body.unshift(0)
    return [0x02, body.length, ...body]
  }
  const content = [...integer(raw.subarray(0, half)), ...integer(raw.subarray(half))]
  return new Uint8Array([0x30, content.length, ...content])
}
