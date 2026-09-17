/**
 * Small deterministic hashes, for comparing two copies of a world.
 *
 * Hand-rolled rather than `Bun.hash` or `crypto.subtle` for two reasons: this
 * has to produce the *same* number in a browser and in a Bun process, and it
 * has to be synchronous — a digest is taken at a handover, inside the same tick
 * as the command it describes.
 *
 * FNV-1a, 32-bit. Not a cryptographic hash and not trying to be: nobody is
 * attacking it, and what it has to catch is two states that differ by a number.
 */

/** FNV-1a over a string's UTF-16 code units. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    // 16777619, as shifts: the multiply would overflow into a float.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0
  }
  return hash >>> 0
}

/**
 * JSON with its keys in order.
 *
 * Object key order is insertion order in JavaScript, and two peers build their
 * components by running the same constructors — but a component that gained a
 * field through `deserialize` rather than its constructor can hold the same
 * data in a different order. Sorting removes the question.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

/** One component's serialised state, as a number. */
export function hashData(data: unknown): number {
  return hashString(canonical(data))
}

/**
 * Fold many hashes into one, without caring what order they arrive in.
 *
 * Commutative on purpose: the entities a world holds are a *set*, and two peers
 * that created the same entities in a different order still hold the same
 * world. Addition modulo 2^32 mixed with a multiplier, so a swap of two values
 * does not cancel out the way a plain XOR would.
 */
export function foldHashes(hashes: Iterable<number>): number {
  let total = 0
  for (const hash of hashes) total = (total + Math.imul(hash, 0x9e3779b1)) >>> 0
  return total >>> 0
}
