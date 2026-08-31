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

export abstract class Weapon {
  abstract readonly id: WeaponId
  abstract readonly name: string

  apCost = 4
  baseAccuracy = 85
  accuracyPerMetre = 3
  damage = 55
  armorPen = 0.25
  armorShred = 0
  areaRadius = 0
  maxRange = 22

  maxClip = 6
  currentClip = 6

  abstract get availableModes(): readonly ShotMode[]

  bulletConsumption(mode: ShotMode): number {
    return mode === ShotMode.Burst ? 3 : 1
  }

  clone(): this {
    const copy = Object.create(Object.getPrototypeOf(this)) as this
    Object.assign(copy, this)
    return copy
  }
}

export class Rifle extends Weapon {
  readonly id = WeaponId.Rifle
  readonly name = 'Rifle'
  constructor() {
    super()
    this.apCost = 4
    this.baseAccuracy = 85
    this.accuracyPerMetre = 1.8 // lowered: was 3
    this.damage = 55
    this.armorPen = 0.25
    this.armorShred = 0
    this.areaRadius = 0
    this.maxRange = 22
    this.maxClip = 6
    this.currentClip = 6
  }
  get availableModes(): readonly ShotMode[] {
    return [ShotMode.Snap, ShotMode.Aimed, ShotMode.Burst]
  }
}

export class Shotgun extends Weapon {
  readonly id = WeaponId.Shotgun
  readonly name = 'Shotgun'
  constructor() {
    super()
    this.apCost = 4
    this.baseAccuracy = 95
    this.accuracyPerMetre = 6.0 // lowered: was 9
    this.damage = 85
    this.armorPen = 0.05
    this.armorShred = 0
    this.areaRadius = 0
    this.maxRange = 12
    this.maxClip = 4
    this.currentClip = 4
  }
  get availableModes(): readonly ShotMode[] {
    return [ShotMode.Snap, ShotMode.Aimed]
  }
}

export class Sniper extends Weapon {
  readonly id = WeaponId.Sniper
  readonly name = 'Sniper Rifle'
  constructor() {
    super()
    this.apCost = 6
    this.baseAccuracy = 80
    this.accuracyPerMetre = 0.25 // lowered: was 0.4
    this.damage = 70
    this.armorPen = 0.5
    this.armorShred = 0
    this.areaRadius = 0
    this.maxRange = 40
    this.maxClip = 5
    this.currentClip = 5
  }
  get availableModes(): readonly ShotMode[] {
    return [ShotMode.Snap, ShotMode.Aimed]
  }
}

export class Gatling extends Weapon {
  readonly id = WeaponId.Gatling
  readonly name = 'Gatling'
  constructor() {
    super()
    this.apCost = 5
    this.baseAccuracy = 80 // elevated: was 70
    this.accuracyPerMetre = 2.5 // lowered: was 4
    this.damage = 35
    this.armorPen = 0.1
    this.armorShred = 12
    this.areaRadius = 0
    this.maxRange = 18
    this.maxClip = 12
    this.currentClip = 12
  }
  get availableModes(): readonly ShotMode[] {
    return [ShotMode.Burst] // ONLY option for Gatling
  }
}

export const WEAPONS: Record<WeaponId, Weapon> = {
  [WeaponId.Rifle]: new Rifle(),
  [WeaponId.Shotgun]: new Shotgun(),
  [WeaponId.Sniper]: new Sniper(),
  [WeaponId.Gatling]: new Gatling(),
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
  Burst: 'burst',
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
  [ShotMode.Burst]: { id: ShotMode.Burst, name: 'Burst Fire', apMul: 1.25, chanceMul: 0.9 },
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
