/**
 * The arsenal: what a soldier can shoot with, load, and throw.
 *
 * Pure data plus the types describing it. Every number a designer would want to
 * tune lives here rather than inside a formula, and {@link Ballistics} reads it
 * without knowing which weapon is which.
 *
 * Stats are deliberately mutable: the debug panel edits these tables live.
 */
import { ATTACHMENTS, type AttachmentId } from './Attachments'

export const WeaponId = {
  Rifle: 'rifle',
  Shotgun: 'shotgun',
  Sniper: 'sniper',
  Gatling: 'gatling',
} as const
export type WeaponId = (typeof WeaponId)[keyof typeof WeaponId]

/**
 * Serial numbers, so two rifles are two rifles.
 *
 * A counter rather than anything random: a weapon's identity has to survive a
 * replay and a headless sweep, and nothing about it needs to be unguessable.
 *
 * It is *not* how a soldier's weapon gets its number. A counter is per-process
 * state, so two peers only agree on it by luck of how many templates each
 * happened to clone — and a loadout screen clones one on every press. Under
 * ADR-0004 both sides recompute a match from shared state, so state that
 * depends on a local count is state that cannot agree. {@link clone} therefore
 * takes a serial, and a unit's weapon is stamped with one derived from who is
 * carrying it. Found by the state digest, which went red on nothing but this.
 */
let nextSerial = 1

/**
 * The serial the unit in this squad slot gives the weapon it is holding.
 *
 * A pure function of *who carries what*, so two peers agree without the number
 * travelling, and so a replay reproduces it. Distinct per slot and per class,
 * which is all a serial is for: telling one unit's rifle from another's.
 */
export function weaponSerial(faction: number, squadIndex: number, weaponId: WeaponId): number {
  const classIndex = Object.values(WeaponId).indexOf(weaponId)
  return (faction + 1) * 1000 + (squadIndex + 1) * 10 + classIndex
}

export abstract class Weapon {
  abstract readonly id: WeaponId
  abstract readonly name: string

  /**
   * This weapon, as distinct from its class.
   *
   * `WEAPONS` holds one template per class and every unit carries a clone, so
   * a serial is what makes fitted glass belong to *that* rifle rather than to
   * rifles in general.
   */
  readonly serial: number = nextSerial++

  apCost = 4
  /**
   * Metres a line misses by at no distance at all: how steady the weapon is
   * in the hands. A long scoped rifle is hard to snap onto somebody close.
   */
  sway = 0.075
  /** Metres a line misses by per metre travelled: how the error grows with range. */
  spread = 0.02
  /**
   * Lines per round. One for a bullet; a shell of buckshot is a fan of them,
   * each its own roll, each a share of the round's damage.
   */
  pellets = 1
  /** Per projectile. A round's damage is this times the projectiles that land. */
  damage = 55
  armorPen = 0.25
  armorShred = 0
  areaRadius = 0
  maxRange = 22

  /** Chance of a critical hit, in percent, before range and armour have a say. */
  critChance = 10
  /** What a critical hit multiplies raw damage by, before armour subtracts. */
  critMultiplier = 1.5
  /**
   * Where along its reach the weapon crits best, from -1 (at the muzzle) through
   * 0 (no preference) to +1 (at the far edge of its range). A shotgun wants to
   * be close; a sniper rifle wants the distance.
   */
  critRangeBias = 0
  /**
   * Metres an ordinary ear hears a shot at (`core/Noise`). Far past what can
   * be seen: a gunshot tells a whole quarter of the map that there is a fight.
   * A suppressor keeps `NOISE.suppressed` of it.
   */
  loudness = 40

  /**
   * Rail space, in slots.
   *
   * A service rifle is built to be hung with kit; a hunting shotgun has a bead
   * and a barrel. This is where that difference lives.
   */
  slots = 1

  /** What is currently bolted on. Never more than {@link slots} allows. */
  attachments: AttachmentId[] = []

  maxClip = 6
  currentClip = 6

  abstract get availableModes(): readonly ShotMode[]

  bulletConsumption(mode: ShotMode): number {
    return mode === ShotMode.Burst ? 3 : 1
  }

  /** How a person refers to this particular weapon. */
  get label(): string {
    return `${this.name} #${this.serial}`
  }

  /** Slots taken by what is already fitted. */
  get slotsUsed(): number {
    let used = 0
    for (const id of this.attachments) used += ATTACHMENTS[id]?.slots ?? 1
    return used
  }

  get slotsFree(): number {
    return this.slots - this.slotsUsed
  }

  /**
   * Is there room for one of these, and is one not already on?
   *
   * Duplicates are refused rather than stacked: two scopes on one rifle is not
   * twice the glass, it is a mistake, and the trait fold would add it up twice.
   */
  canFit(id: AttachmentId): boolean {
    const spec = ATTACHMENTS[id]
    if (!spec || this.attachments.includes(id)) return false
    return spec.slots <= this.slotsFree
  }

  fit(id: AttachmentId): boolean {
    if (!this.canFit(id)) return false
    this.attachments.push(id)
    return true
  }

  unfit(id: AttachmentId): boolean {
    const at = this.attachments.indexOf(id)
    if (at < 0) return false
    this.attachments.splice(at, 1)
    return true
  }

  /**
   * A new weapon of the same class and condition.
   *
   * Its own serial and its own rail: cloning a template is how a unit gets a
   * weapon, and two units must not share one array of fitted kit.
   */
  clone(serial: number = nextSerial++): this {
    const copy = Object.create(Object.getPrototypeOf(this)) as this
    Object.assign(copy, this, { serial, attachments: [...this.attachments] })
    return copy
  }
}

export class Rifle extends Weapon {
  readonly id = WeaponId.Rifle
  readonly name = 'Rifle'
  constructor() {
    super()
    this.apCost = 4
    this.sway = 0.075
    this.spread = 0.02
    this.maxClip = 15
    this.currentClip = 15
    // Built as a platform: optic, grip, can.
    this.slots = 3
    // A service rifle is accurate at any sane distance and has no favourite.
    this.critChance = 12
    this.critMultiplier = 1.5
  }
  get availableModes(): readonly ShotMode[] {
    return [ShotMode.Snap, ShotMode.Aimed, ShotMode.Burst]
  }
  override bulletConsumption(mode: ShotMode): number {
    return mode === ShotMode.Burst ? 5 : 1
  }
}

export class Shotgun extends Weapon {
  readonly id = WeaponId.Shotgun
  readonly name = 'Shotgun'
  constructor() {
    super()
    this.apCost = 4
    // Nine lines, each wide. Point blank most of them land and the shell is
    // the hardest-hitting round in the game; across a room a few do; at the
    // end of its range one might. Its damage falls with distance because its
    // pellets do, not because of a rule saying so. Twice a rifle's expected
    // damage inside a room, level with it at about 7 m. Pellets at 14, not 12:
    // at 12 four shotguns won 13% against a mixed squad; at 16 they started
    // taking their fights out to 7.5 m and the mirror tilted.
    this.sway = 0
    this.spread = 0.05
    this.pellets = 9
    this.damage = 14
    // Barely penetrates — but armour is taken off the *round*, not each
    // pellet, so it is impact rather than punch-through.
    this.armorPen = 0.05
    this.armorShred = 0
    this.areaRadius = 0
    this.maxRange = 12
    this.maxClip = 4
    this.currentClip = 4
    // A bead and a barrel. Grandpa never needed a rail.
    this.slots = 1
    // In someone's face a shell puts everything in one place; at the far end of
    // its short range the spread is all that arrives.
    this.critChance = 20
    this.critMultiplier = 1.8
    this.critRangeBias = -1
    this.loudness = 45
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
    // Unwieldy up close, nearly flat beyond.
    this.sway = 0.11
    this.spread = 0.0015
    this.damage = 70
    this.armorPen = 0.5
    this.armorShred = 0
    this.areaRadius = 0
    this.maxRange = 40
    this.maxClip = 5
    this.currentClip = 5
    // Purpose-built around its glass, with room for a bipod and a can.
    this.slots = 3
    // A scope is what a crit is: aimed at a vital, from far enough away to be
    // taking the shot at all.
    this.critChance = 25
    this.critMultiplier = 2.2
    this.critRangeBias = 1
    // A full-power cartridge: the loudest thing on the map that is not a bomb.
    this.loudness = 55
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
    // Every round a rifle bullet that wanders more: volume, not placement.
    this.sway = 0.11
    this.spread = 0.014
    this.damage = 35
    this.maxClip = 30
    this.currentClip = 30
    // A bipod mount and little else: there is nowhere to put an optic on a
    // weapon nobody aims.
    this.slots = 2
    // Volume, not placement. What it does get comes from being close enough
    // that the cone still lands on one body.
    this.critChance = 5
    this.critMultiplier = 1.3
    this.critRangeBias = -0.5
    this.loudness = 50
  }
  get availableModes(): readonly ShotMode[] {
    return [ShotMode.Burst] // ONLY option for Gatling
  }
  override bulletConsumption(mode: ShotMode): number {
    return mode === ShotMode.Burst ? 10 : 1
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
  /**
   * A shot taken during somebody else's turn.
   *
   * A mode rather than a special case, because a mode already carries an AP
   * multiplier and an accuracy multiplier and every term in the chain already
   * respects them. No weapon lists it in `availableModes`, so it never appears
   * as something a player picks — it is what overwatch fires.
   */
  Reaction: 'reaction',
} as const
export type ShotMode = (typeof ShotMode)[keyof typeof ShotMode]

export interface ShotModeSpec {
  id: ShotMode
  name: string
  /** Multiplies the weapon's AP cost. */
  apMul: number
  /** Multiplies a shot's error — sway and spread both. Below 1 is steadier. */
  spreadMul: number
}

export const SHOT_MODES: Record<ShotMode, ShotModeSpec> = {
  [ShotMode.Snap]: { id: ShotMode.Snap, name: 'Snap Shot', apMul: 1, spreadMul: 1 },
  [ShotMode.Aimed]: { id: ShotMode.Aimed, name: 'Aimed Shot', apMul: 2, spreadMul: 0.5 },
  [ShotMode.Burst]: { id: ShotMode.Burst, name: 'Burst Fire', apMul: 1.25, spreadMul: 1.1 },
  // Cheaper in points than a snap shot and worse than one: the points were
  // already paid when the unit went on watch, and a round snapped off at
  // somebody crossing open ground is not an aimed one.
  [ShotMode.Reaction]: { id: ShotMode.Reaction, name: 'Reaction Fire', apMul: 0, spreadMul: 1.4 },
}

// ---------------------------------------------------------------------------
// Grenades
// ---------------------------------------------------------------------------

export const StatusKind = {
  /** Blinded: this unit's own shots suffer. */
  Flashed: 'flashed',
  /** Armour compromised: incoming damage is amplified. */
  Shredded: 'shredded',
  /** Stimulated: action points are raised while it lasts. */
  Stimmed: 'stimmed',
  /** Run into the ground: fewer action points until it recovers. */
  Winded: 'winded',
  /** Rounds cracking past: harder to shoot back, and slower to move. */
  Suppressed: 'suppressed',
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
  /** Extra action points, as a fraction of the unit's own maximum. */
  apBonus: number
  /**
   * How many times over it can be in force. Every numeric effect above is per
   * stack, so a status that is not meant to pile up says 1.
   */
  maxStacks: number
}

export const STATUSES: Record<StatusKind, StatusSpec> = {
  [StatusKind.Flashed]: {
    kind: StatusKind.Flashed,
    name: 'Flashed',
    turns: 2,
    accuracyPenalty: 40,
    defenceBonus: 0,
    damageTakenBonus: 0,
    apBonus: 0,
    maxStacks: 1,
  },
  [StatusKind.Shredded]: {
    kind: StatusKind.Shredded,
    name: 'Shredded',
    turns: 3,
    accuracyPenalty: 0,
    defenceBonus: 0,
    damageTakenBonus: 0.25,
    apBonus: 0,
    maxStacks: 1,
  },
  [StatusKind.Stimmed]: {
    kind: StatusKind.Stimmed,
    name: 'Stimmed',
    // Statuses tick once per handover, and a round is two of those, so four
    // covers the unit's own next two turns.
    turns: 4,
    accuracyPenalty: 0,
    defenceBonus: 0,
    damageTakenBonus: 0,
    apBonus: 0.2,
    maxStacks: 1,
  },
  [StatusKind.Suppressed]: {
    kind: StatusKind.Suppressed,
    name: 'Suppressed',
    // Two ticks: it lasts through the shooter's turn and the target's own
    // answer to it, then lifts unless more rounds arrive.
    turns: 2,
    accuracyPenalty: 12,
    defenceBonus: 0,
    damageTakenBonus: 0,
    apBonus: -0.1,
    // Three is being pinned: -36 to hit and a third of the unit's points gone.
    // There is no separate pinned state because there does not need to be one -
    // the degree *is* the difference.
    maxStacks: 3,
  },
  [StatusKind.Winded]: {
    kind: StatusKind.Winded,
    name: 'Winded',
    // Applied at a handover and ticked by that same handover, so three leaves
    // two: the unit's own next turn is the one that feels it.
    turns: 3,
    accuracyPenalty: 0,
    defenceBonus: 0,
    damageTakenBonus: 0,
    apBonus: -0.25,
    maxStacks: 1,
  },
}

export const GrenadeId = {
  Frag: 'frag',
  Flash: 'flash',
  Smoke: 'smoke',
  Stone: 'stone',
  Incendiary: 'incendiary',
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
  /**
   * Metres an ordinary ear hears it go off at, from where it lands. A frag is
   * heard by everybody on the map; a flashbang's bang is short and sharp; a
   * smoke canister hisses.
   */
  loudness: number
  /**
   * How many every soldier carries whatever the loadout: not from the crate,
   * and not counted against the grenade cap. Nought for anything that is.
   */
  issued: number
  /**
   * Handovers every tile in the blast burns for at the least — the fuel the
   * grenade brings — or its own burn time where that is longer. Nought for a
   * grenade that sets nothing alight.
   */
  ignites: number
  /**
   * Handovers every tile in the blast is filled with smoke for (`core/Fire`),
   * which sight does not pass through. Nought for a grenade that makes none.
   */
  smokes: number
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
    // Everybody on any map hears it. Finite because grenade specs replicate as
    // JSON, and JSON has no Infinity.
    loudness: 1000,
    issued: 0,
    ignites: 0,
    smokes: 0,
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
    loudness: 20,
    issued: 0,
    ignites: 0,
    smokes: 0,
  },
  [GrenadeId.Smoke]: {
    id: GrenadeId.Smoke,
    name: 'Smoke Grenade',
    apCost: 2,
    areaRadius: 3,
    damage: 0,
    armorShred: 0,
    throwRange: 10,
    applies: null,
    friendly: true,
    loudness: 6,
    issued: 0,
    ignites: 0,
    // Two of each side's turns: long enough to cross behind it and be across.
    smokes: 4,
  },
  // Not a grenade at all: something picked up and thrown. It does nothing
  // where it lands except be heard there — the first thing in the game that
  // works on what the other side knows rather than on its hit points. Every
  // soldier has a couple.
  [GrenadeId.Stone]: {
    id: GrenadeId.Stone,
    name: 'Stone',
    apCost: 2,
    areaRadius: 0,
    damage: 0,
    armorShred: 0,
    throwRange: 12,
    applies: null,
    friendly: false,
    loudness: 8,
    issued: 2,
    ignites: 0,
    smokes: 0,
  },
  // Brings its own fuel: whatever it lands on burns, and whatever can catch
  // from there does (`core/Fire`). The blast itself hurts nobody; the fire
  // does, to whoever is in it.
  [GrenadeId.Incendiary]: {
    id: GrenadeId.Incendiary,
    name: 'Incendiary',
    apCost: 4,
    areaRadius: 1,
    damage: 0,
    armorShred: 0,
    throwRange: 10,
    applies: null,
    friendly: false,
    loudness: 25,
    issued: 0,
    ignites: 2,
    smokes: 0,
  },
}

/** True for a throw that hurts nobody and gives nobody away: it is only a noise. */
export function harmless(spec: GrenadeSpec): boolean {
  return spec.damage === 0 && spec.applies === null && spec.ignites === 0 && spec.smokes === 0
}
