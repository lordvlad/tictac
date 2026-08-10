/** Small, fast, seedable PRNG (mulberry32). Deterministic across runs. */
export class Rng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  /** Float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1))
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1))
      ;[items[i], items[j]] = [items[j]!, items[i]!]
    }
    return items
  }
}

/** Hash an arbitrary string into a 32-bit seed. */
export function hashSeed(value: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Resolve the map seed: `?seed=` from the URL if present, otherwise random.
 * Numeric seeds are used directly so `?seed=1234` is readable.
 */
export function resolveSeed(): { seed: number; label: string } {
  const param = new URLSearchParams(window.location.search).get('seed')
  if (param !== null && param.length > 0) {
    const numeric = Number(param)
    if (Number.isFinite(numeric)) {
      return { seed: numeric >>> 0, label: String(numeric >>> 0) }
    }
    return { seed: hashSeed(param), label: param }
  }
  const seed = (Math.random() * 0xffffffff) >>> 0
  return { seed, label: String(seed) }
}
