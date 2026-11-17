import type { Vector3 } from 'three'
import type { Faction } from '../config'
import type { WeaponId } from '../core/Arsenal'
import type { CharacterAppearance } from '../core/Characters'
import type { MeleeId } from '../core/Melee'
import type { World } from '../ecs/World'
import {
  CharacterComponent,
  HealthComponent,
  IdentityComponent,
  InventoryComponent,
  PositionComponent,
  SightedComponent,
  StanceComponent,
  WeaponComponent,
} from '../ecs/components'

/**
 * What a body needs to know about the unit it shows: its pose, its place and its
 * kit, and nothing it could decide with.
 *
 * Read live, because a body is redrawn every frame from whatever the components
 * say now. It is built from the components rather than from the `Soldier`
 * wrapper so that a body does not depend on the class the rules use to hold a
 * unit together, and so that anything which can put these components on an
 * entity — a peer's replicated state included — can be drawn.
 */
export interface SoldierModel {
  readonly entityId: number
  readonly faction: Faction
  readonly squadIndex: number
  /** How the character is built; fixed for the match. */
  readonly appearance: CharacterAppearance | undefined
  /** The logical position, which the body eases toward. */
  readonly position: Vector3
  readonly targetYaw: number
  readonly isDead: boolean
  readonly isCrouching: boolean
  readonly isMoving: boolean
  readonly watching: boolean
  readonly sidearm: MeleeId
  readonly weaponId: WeaponId
  /** Whether the side whose eyes this screen is can see the unit. */
  readonly seen: boolean
}

/**
 * The model of the unit that owns `entityId`.
 *
 * Throws if the entity is not a soldier: a body for something without these
 * components is a bug in whoever built it, and a body that silently never
 * moves would hide it.
 */
export function soldierModel(world: World, entityId: number): SoldierModel {
  const identity = world.getComponent(entityId, IdentityComponent)
  const character = world.getComponent(entityId, CharacterComponent)
  const position = world.getComponent(entityId, PositionComponent)
  const health = world.getComponent(entityId, HealthComponent)
  const stance = world.getComponent(entityId, StanceComponent)
  const inventory = world.getComponent(entityId, InventoryComponent)
  const weapon = world.getComponent(entityId, WeaponComponent)
  const sighted = world.getComponent(entityId, SightedComponent)
  if (!identity || !character || !position || !health || !stance || !inventory || !weapon || !sighted) {
    throw new Error(`entity ${entityId} is missing the components of a soldier`)
  }
  return {
    entityId,
    faction: identity.faction,
    squadIndex: identity.squadIndex,
    get appearance() {
      return character.sheet.appearance
    },
    get position() {
      return position.targetPos
    },
    get targetYaw() {
      return position.targetYaw
    },
    get isDead() {
      return health.hp <= 0
    },
    get isCrouching() {
      return stance.isCrouching
    },
    get isMoving() {
      return stance.isMoving
    },
    get watching() {
      return stance.watching
    },
    get sidearm() {
      return inventory.sidearm
    },
    get weaponId() {
      return weapon.weaponId
    },
    get seen() {
      return sighted.seen
    },
  }
}
