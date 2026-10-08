/**
 * The parts of WebAuthn a server has to do itself.
 *
 * No library: what a relying party actually has to verify is a short list, and
 * every item on it is a primitive WebCrypto already has. What is left is
 * parsing two byte layouts and comparing four fields, which is this file.
 *
 * The security of a passkey is not in the signature alone. It is in *what* is
 * signed: the authenticator signs `authenticatorData ‖ sha256(clientDataJSON)`,
 * and the client data names the ceremony, the challenge and the origin. That is
 * why every check below is against a value the server chose — a signature over
 * somebody else's challenge, or made for another site, verifies perfectly well
 * and means nothing.
 *
 * Nothing here touches the database, so it can be read and tested on its own.
 */

/**
 * A passkey, session or roster request turned down, in words the player
 * reads. A window is answered with it as the request's error, `400` as
 * `RPC_ERRORS.badInput` and `401` as `RPC_ERRORS.signInFirst` (`Session.ts`).
 */
export class AuthError extends Error {
  constructor(
    readonly status: 400 | 401,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * COSE algorithm identifiers this server accepts.
 *
 * ES256 is what every platform authenticator offers; RS256 is what Windows
 * Hello and some security keys offer instead. Ed25519 (-8) is deliberately
 * absent until Bun's WebCrypto support for it is confirmed: accepting an
 * algorithm the server cannot verify would register a passkey nobody can ever
 * sign in with.
 */
export const ALGORITHMS = { ES256: -7, RS256: -257 } as const

/** The authenticator saw a human. Bit 0 of the flags byte. */
export const FLAG_USER_PRESENT = 0x01

export interface AuthenticatorData {
  rpIdHash: Uint8Array
  flags: number
  signCount: number
}

/**
 * The fixed head of authenticator data: 32 bytes of relying-party hash, one
 * flags byte, then a big-endian u32 counter. Anything after that is attested
 * credential data, which this server does not use — the public key comes from
 * `getPublicKey()` on the client instead.
 */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) throw new AuthError(400, 'authenticator data is too short')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    rpIdHash: bytes.subarray(0, 32),
    flags: bytes[32]!,
    signCount: view.getUint32(33, false),
  }
}

/**
 * An ECDSA signature from DER to the raw `r‖s` WebCrypto wants.
 *
 * Authenticators emit `SEQUENCE { INTEGER r, INTEGER s }`, where each integer
 * is minimally encoded and may carry a leading zero to keep it positive.
 * WebCrypto wants two fixed-width big-endian numbers, so each is stripped and
 * then left-padded.
 */
export function derToRaw(der: Uint8Array, size = 32): Uint8Array {
  const malformed = new AuthError(401, 'the signature is malformed')
  if (der.length < 8 || der[0] !== 0x30) throw malformed

  let offset = 2
  // A long-form length byte: the sequence is longer than 127 bytes.
  if (der[1]! & 0x80) offset = 2 + (der[1]! & 0x7f)

  const raw = new Uint8Array(size * 2)
  for (let half = 0; half < 2; half++) {
    if (der[offset] !== 0x02) throw malformed
    const length = der[offset + 1]
    if (length === undefined) throw malformed
    let start = offset + 2
    let end = start + length
    if (end > der.length) throw malformed
    // Leading zeros are DER's way of saying "this is positive", not part of
    // the number.
    while (start < end && der[start] === 0x00) start++
    if (end - start > size) throw malformed
    raw.set(der.subarray(start, end), size * half + size - (end - start))
    offset = end
  }
  return raw
}

/** The stored SPKI bytes as a verification key, or a refusal naming the algorithm. */
export function importCredentialKey(spki: Uint8Array, algorithm: number): Promise<CryptoKey> {
  const params =
    algorithm === ALGORITHMS.ES256
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : algorithm === ALGORITHMS.RS256
        ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
        : null
  if (!params) {
    throw new AuthError(400, 'this passkey uses an algorithm the server does not accept')
  }
  return crypto.subtle.importKey('spki', spki as BufferSource, params, false, ['verify'])
}

export function verifySignature(
  key: CryptoKey,
  algorithm: number,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  if (algorithm === ALGORITHMS.ES256) {
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      derToRaw(signature) as BufferSource,
      data as BufferSource,
    )
  }
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature as BufferSource,
    data as BufferSource,
  )
}

export interface ClientDataExpectation {
  /** `webauthn.create` for a registration, `webauthn.get` for a sign-in. */
  type: string
  /** The challenge this server issued, base64url, exactly as it was sent out. */
  challenge: string
  origins: readonly string[]
}

export interface ClientData {
  type: string
  challenge: string
  origin: string
}

/**
 * The client's account of the ceremony, checked against the server's.
 *
 * Three fields, three attacks. The type stops a signature collected for one
 * ceremony being replayed as the other; the challenge stops a signature being
 * replayed at all; the origin is what makes a passkey unphishable, because a
 * page on another domain cannot make the authenticator write this origin.
 */
export function readClientData(bytes: Uint8Array, expected: ClientDataExpectation): ClientData {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new AuthError(400, 'the client data is not JSON')
  }
  const data = parsed as Partial<ClientData>
  if (typeof data.type !== 'string' || typeof data.challenge !== 'string' || typeof data.origin !== 'string') {
    throw new AuthError(400, 'the client data is missing a field')
  }
  if (data.type !== expected.type) {
    throw new AuthError(400, `wrong ceremony: expected ${expected.type}, got ${data.type}`)
  }
  if (data.challenge !== expected.challenge) throw new AuthError(400, 'challenge mismatch')
  if (!expected.origins.includes(data.origin)) {
    throw new AuthError(400, `origin ${data.origin} is not allowed`)
  }
  return { type: data.type, challenge: data.challenge, origin: data.origin }
}
