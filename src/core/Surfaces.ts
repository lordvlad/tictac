/**
 * What a tile's floor is made of.
 *
 * Generated with the map from its seed, so both peers, a replay and the
 * referee hold the same ground without it ever being sent. Fire changes it —
 * whatever burned is ash — and that change is state like a broken window.
 *
 * The one property that matters so far is how it burns: whether fire next
 * door can catch on it, and for how long it then burns. Everything a surface
 * does is read off {@link SURFACES}, so a new material is a row, not a rule.
 */
export const Surface = {
  /** Outdoor ground: asphalt, flagstones, packed earth. Does not burn. */
  Paving: 0,
  /** Outdoor patches of dry growth. Catches easily and is gone in a turn. */
  Grass: 1,
  /** Floors of some buildings, and every flat roof. Does not burn. */
  Concrete: 2,
  /** Wooden floors. Catches less readily than grass, and burns longer. */
  Timber: 3,
  /** Whatever burned. Never burns again. */
  Ash: 4,
} as const
export type Surface = (typeof Surface)[keyof typeof Surface]

export interface SurfaceSpec {
  name: string
  /** One line, as the tile readout shows it. */
  description: string
  /**
   * Percent chance, each handover, that a burning orthogonal neighbour sets
   * this tile alight. Zero never burns.
   */
  flammability: number
  /** Handovers it burns for once alight. */
  burns: number
  /** Floor tint, 0xRRGGBB, so a player can read the ground before it matters. */
  color: number
}

export const SURFACES: Record<Surface, SurfaceSpec> = {
  [Surface.Paving]: {
    name: 'Paving',
    description: 'Does not burn.',
    flammability: 0,
    burns: 0,
    color: 0x6c6f63,
  },
  [Surface.Grass]: {
    name: 'Dry grass',
    description: 'Catches from fire next to it more often than not, and burns out in a turn.',
    flammability: 60,
    burns: 1,
    color: 0x7d8a4a,
  },
  [Surface.Concrete]: {
    name: 'Concrete',
    description: 'Does not burn.',
    flammability: 0,
    burns: 0,
    color: 0x8a8a86,
  },
  [Surface.Timber]: {
    name: 'Timber floor',
    description: 'Catches from fire next to it about one time in three, and burns for three turns.',
    flammability: 35,
    burns: 3,
    color: 0x8a6a48,
  },
  [Surface.Ash]: {
    name: 'Ash',
    description: 'Already burned. Does not burn again.',
    flammability: 0,
    burns: 0,
    color: 0x3c3a38,
  },
}

/**
 * A crate is timber standing on the floor: it catches and burns in its own
 * right, whatever the floor under it is, and when it has burned out it is
 * gone — and the cover with it.
 */
export const CRATE_FIRE = { flammability: 50, burns: 3 } as const
