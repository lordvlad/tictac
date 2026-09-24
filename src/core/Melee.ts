/**
 * Contact: what a soldier fights with when there is no distance left.
 *
 * Pure data, like {@link Arsenal}. A sidearm is carried *beside* the primary
 * weapon — a rifleman with a knife is a rifleman with a knife — so it has its
 * own slot on the loadout and its own table here. An empty slot is not nothing:
 * it is {@link MeleeId.Fists}, which every soldier always has.
 *
 * The three families answer different questions rather than climbing one
 * ladder, and every difference between them is a number below:
 *
 * - **Fists** are free and need no kit, and armour stops them almost entirely.
 * - **A knife** is the precision tool: cheap, the best at a critical, and the
 *   best at finding a gap in a plate. Quiet.
 * - **A club** does not care what the plate is made of — it keeps its damage
 *   through armour and strips it — but it is slow, it never lands a
 *   "critical" (there is nothing to place), and it is loud.
 *
 * Stats are mutable, like the weapon tables: the debug panel edits them live.
 */
import { WeaponId } from './Arsenal'

export const MeleeId = {
  Fists: 'fists',
  Knife: 'knife',
  Club: 'club',
} as const
export type MeleeId = (typeof MeleeId)[keyof typeof MeleeId]

export interface MeleeSpec {
  id: MeleeId
  name: string
  /** Action points per blow. */
  apCost: number
  /** Chance to land, in percent, before either fighter has a say. */
  accuracy: number
  /**
   * Percentage points this takes off an attacker's chance when the *defender*
   * is the one holding it: a blade in hand is a different problem from an open
   * palm.
   */
  parry: number
  damage: number
  /** 0..1 fraction of the target's armour that does not count. */
  armorPen: number
  /** Armour points stripped by a blow that lands. */
  armorShred: number
  critChance: number
  critMultiplier: number
  /**
   * Metres an ordinary ear hears a blow at (`core/Noise`); nought is silent.
   * A knife in the dark makes no sound; a hammer on a plate carrier carries
   * across a building — and, like a shot, anything audible gives the
   * attacker's position away to the other side.
   */
  loudness: number
  /**
   * What the blow's damage is multiplied by when it lands from behind. Every
   * blow from behind already gets past parry and dodge; this is the weapon
   * being *for* it. A knife there is lethal to anyone but a very large, very
   * well-plated soldier; a fist or a club is merely unopposed.
   */
  fromBehind: number
}

export const MELEE: Record<MeleeId, MeleeSpec> = {
  [MeleeId.Fists]: {
    id: MeleeId.Fists,
    name: 'Fists',
    apCost: 3,
    accuracy: 75,
    parry: 0,
    damage: 14,
    armorPen: 0,
    armorShred: 0,
    critChance: 5,
    critMultiplier: 1.5,
    loudness: 0,
    fromBehind: 1,
  },
  [MeleeId.Knife]: {
    id: MeleeId.Knife,
    name: 'Knife',
    apCost: 3,
    accuracy: 80,
    parry: 10,
    damage: 32,
    armorPen: 0.5,
    armorShred: 0,
    critChance: 25,
    critMultiplier: 2,
    loudness: 0,
    fromBehind: 5,
  },
  [MeleeId.Club]: {
    id: MeleeId.Club,
    name: 'Club',
    // 4, not 5: at 5 a knife out-damaged it per point *against plate*, the one
    // fight a club exists for (measured: 18 vs 20 damage a blow, 3 vs 5 AP).
    apCost: 4,
    accuracy: 70,
    parry: 5,
    damage: 36,
    armorPen: 0.9,
    armorShred: 12,
    critChance: 0,
    critMultiplier: 1,
    loudness: 12,
    fromBehind: 1,
  },
}

/**
 * What the defender's *primary* weapon is worth held across them.
 *
 * Added to their sidearm's parry. A carbine can be swung and a shotgun shoved;
 * a gatling or a scoped rifle at arm's length is a liability, which is the
 * honest reason nobody clears a doorway with one.
 */
export const LONG_GUN_PARRY: Record<WeaponId, number> = {
  [WeaponId.Rifle]: 0,
  [WeaponId.Shotgun]: 0,
  [WeaponId.Gatling]: -5,
  [WeaponId.Sniper]: -10,
}
