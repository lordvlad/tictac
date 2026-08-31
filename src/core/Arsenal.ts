/**
 * The arsenal: what a soldier can shoot with, load, and throw.
 *
 * Pure data plus the types describing it. Every number a designer would want to
 * tune lives here rather than inside a formula, and {@link Ballistics} reads it
 * without knowing which weapon is which.
 *
 * Stats are deliberately mutable: the debug panel edits these tables live.
 */

export const WeaponId = {
  Rifle: 'rifle',
  Shotgun: 'shotgun',
  Sniper: 'sniper',
  Gatling: 'gatling',
} as const
export type WeaponId = (typeof WeaponId)[keyof typeof WeaponId]

export interface WeaponSpec {
  id: WeaponId
  name: string
  /** AP for one snap shot. */
  apCost: number
  /** Hit chance at point blank, before range, cover and status. */
  baseAccuracy: number
  /**
   * Hit chance lost per metre of range. This is the knob that separates a
   * shotgun from a sniper rifle far more than damage does.
   */
  accuracyPerMetre: number
  /** Damage before armour. */
  damage: number
  /** Fraction of the target's armour ignored, 0..1. */
  armorPen: number
  /** Armour points stripped from the target on a hit, permanently. */
  armorShred: number
  /** Blast radius in tiles. 0 means the shot only touches the target tile. */
  areaRadius: number
  /** Beyond this range the weapon cannot be fired at all. */
  maxRange: number
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  [WeaponId.Rifle]: {
    id: WeaponId.Rifle,
    name: 'Rifle',
    apCost: 4,
    baseAccuracy: 85,
    accuracyPerMetre: 3,
    damage: 55,
    armorPen: 0.25,
    armorShred: 0,
    areaRadius: 0,
    maxRange: 22,
  },
  [WeaponId.Shotgun]: {
    id: WeaponId.Shotgun,
    name: 'Shotgun',
    apCost: 4,
    baseAccuracy: 95,
    // Devastating up close and useless at range: the pellets spread.
    accuracyPerMetre: 9,
    damage: 85,
    // Pellets flatten against plate.
    armorPen: 0.05,
    armorShred: 0,
    areaRadius: 0,
    maxRange: 12,
  },
  [WeaponId.Sniper]: {
    id: WeaponId.Sniper,
    name: 'Sniper Rifle',
    apCost: 6,
    baseAccuracy: 80,
    // Range is barely a factor; the cost is AP and a poor point-blank profile.
    accuracyPerMetre: 0.4,
    damage: 70,
    armorPen: 0.5,
    armorShred: 0,
    areaRadius: 0,
    maxRange: 40,
  },
  [WeaponId.Gatling]: {
    id: WeaponId.Gatling,
    name: 'Gatling',
    apCost: 5,
    baseAccuracy: 70,
    accuracyPerMetre: 4,
    damage: 35,
    armorPen: 0.1,
    // Its job is chewing armour off a target for someone else to finish.
    armorShred: 12,
    areaRadius: 0,
    maxRange: 18,
  },
}

export const AmmoId = {
  Standard: 'standard',
  ArmorPiercing: 'ap',
  HollowPoint: 'hollow',
} as const
export type AmmoId = (typeof AmmoId)[keyof typeof AmmoId]

/** Multiplicative/additive modifiers a loaded round applies to its weapon. */
export interface AmmoSpec {
  id: AmmoId
  name: string
  damageMul: number
  /** Added to the weapon's armour penetration, then clamped to 1. */
  armorPenBonus: number
  armorShredBonus: number
  /** Scales the weapon's range penalty. */
  rangePenaltyMul: number
  /** AP surcharge — this is what "expensive" means in play. */
  apDelta: number
}

export const AMMO: Record<AmmoId, AmmoSpec> = {
  [AmmoId.Standard]: {
    id: AmmoId.Standard,
    name: 'Standard',
    damageMul: 1,
    armorPenBonus: 0,
    armorShredBonus: 0,
    rangePenaltyMul: 1,
    apDelta: 0,
  },
  [AmmoId.ArmorPiercing]: {
    id: AmmoId.ArmorPiercing,
    name: 'Armor-Piercing',
    // Punches straight through plate, at the price of an extra AP and a little
    // less raw damage against unarmoured flesh.
    damageMul: 0.9,
    armorPenBonus: 1,
    armorShredBonus: 4,
    rangePenaltyMul: 0.85,
    apDelta: 1,
  },
  [AmmoId.HollowPoint]: {
    id: AmmoId.HollowPoint,
    name: 'Hollow Point',
    // Brutal against the unarmoured, stopped cold by armour.
    damageMul: 1.35,
    armorPenBonus: -0.15,
    armorShredBonus: 0,
    rangePenaltyMul: 1.15,
    apDelta: 0,
  },
}

export const ShotMode = {
  Snap: 'snap',
  Aimed: 'aimed',
} as const
export type ShotMode = (typeof ShotMode)[keyof typeof ShotMode]

export interface ShotModeSpec {
  id: ShotMode
  name: string
  /** Multiplies the weapon's AP cost. */
  apMul: number
  /** Multiplies the final hit chance, before clamping. */
  chanceMul: number
}

export const SHOT_MODES: Record<ShotMode, ShotModeSpec> = {
  [ShotMode.Snap]: { id: ShotMode.Snap, name: 'Snap Shot', apMul: 1, chanceMul: 1 },
  [ShotMode.Aimed]: { id: ShotMode.Aimed, name: 'Aimed Shot', apMul: 2, chanceMul: 2 },
}

// ---------------------------------------------------------------------------
// Grenades
// ---------------------------------------------------------------------------

export const StatusKind = {
  /** Blinded: this unit's own shots suffer. */
  Flashed: 'flashed',
  /** Concealed by smoke: shots *at* this unit suffer. */
  Smoked: 'smoked',
  /** Armour compromised: incoming damage is amplified. */
  Shredded: 'shredded',
} as const
export type StatusKind = (typeof StatusKind)[keyof typeof StatusKind]

export interface StatusSpec {
  kind: StatusKind
  name: string
  /** Turns the effect lasts once applied. */
  turns: number
  /** Hit chance this unit loses on its own shots. */
  accuracyPenalty: number
  /** Hit chance an attacker loses when shooting this unit. */
  defenceBonus: number
  /** Extra incoming damage, as a fraction. */
  damageTakenBonus: number
}

export const STATUSES: Record<StatusKind, StatusSpec> = {
  [StatusKind.Flashed]: {
    kind: StatusKind.Flashed,
    name: 'Flashed',
    turns: 2,
    accuracyPenalty: 40,
    defenceBonus: 0,
    damageTakenBonus: 0,
  },
  [StatusKind.Smoked]: {
    kind: StatusKind.Smoked,
    name: 'Smoked',
    turns: 2,
    accuracyPenalty: 0,
    defenceBonus: 35,
    damageTakenBonus: 0,
  },
  [StatusKind.Shredded]: {
    kind: StatusKind.Shredded,
    name: 'Shredded',
    turns: 3,
    accuracyPenalty: 0,
    defenceBonus: 0,
    damageTakenBonus: 0.25,
  },
}

export const GrenadeId = {
  Frag: 'frag',
  Flash: 'flash',
  Smoke: 'smoke',
} as const
export type GrenadeId = (typeof GrenadeId)[keyof typeof GrenadeId]

export interface GrenadeSpec {
  id: GrenadeId
  name: string
  apCost: number
  /** Tiles from the blast centre that are affected. */
  areaRadius: number
  /** Damage at the centre; falls off to zero at the rim. */
  damage: number
  armorShred: number
  /** How far it can be thrown, in metres. */
  throwRange: number
  /** Applied to every unit caught in the blast. */
  applies: StatusKind | null
  /** True when the effect is meant for your own side (smoke). */
  friendly: boolean
}

export const GRENADES: Record<GrenadeId, GrenadeSpec> = {
  [GrenadeId.Frag]: {
    id: GrenadeId.Frag,
    name: 'Frag Grenade',
    apCost: 4,
    areaRadius: 2,
    damage: 45,
    // Tears plate open so follow-up fire lands properly.
    armorShred: 20,
    throwRange: 10,
    applies: StatusKind.Shredded,
    friendly: false,
  },
  [GrenadeId.Flash]: {
    id: GrenadeId.Flash,
    name: 'Flashbang',
    apCost: 3,
    areaRadius: 2,
    damage: 0,
    armorShred: 0,
    throwRange: 12,
    applies: StatusKind.Flashed,
    friendly: false,
  },
  [GrenadeId.Smoke]: {
    id: GrenadeId.Smoke,
    name: 'Smoke Grenade',
    apCost: 2,
    areaRadius: 3,
    damage: 0,
    armorShred: 0,
    throwRange: 10,
    applies: StatusKind.Smoked,
    friendly: true,
  },
}
