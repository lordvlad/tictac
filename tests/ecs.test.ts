import { describe, expect, test } from 'bun:test'
import { Component } from '../src/ecs/Component'
import { System } from '../src/ecs/System'
import { World } from '../src/ecs/World'
import { Grid } from '../src/core/Grid'
import { Faction, RULES } from '../src/config'
import { GrenadeId, StatusKind, WeaponId } from '../src/core/Arsenal'
import {
  ActionPointsComponent,
  AmmoComponent,
  ArmorComponent,
  GrenadeSpecsComponent,
  HealthComponent,
  IdentityComponent,
  InventoryComponent,
  MatchRulesComponent,
  PositionComponent,
  StanceComponent,
  StatusesComponent,
  WeaponComponent,
} from '../src/ecs/components'
import { MovementSystem, TurnSystem } from '../src/ecs/systems'

class Counter extends Component {
  static readonly componentName = 'counter'
  get name(): string {
    return Counter.componentName
  }
  constructor(public value = 0) {
    super()
  }
  serialize(): Record<string, unknown> {
    return { value: this.value }
  }
  deserialize(data: Record<string, unknown>): void {
    if (typeof data.value === 'number') this.value = data.value
  }
}

class Marker extends Component {
  static readonly componentName = 'marker'
  get name(): string {
    return Marker.componentName
  }
  serialize(): Record<string, unknown> {
    return {}
  }
  deserialize(): void {}
}

class TickSpy extends System {
  ticks = 0
  update(): void {
    this.ticks++
  }
}

/** Collect every change the world broadcasts. */
function recorder(world: World) {
  const seen: { entityId: number; name: string; data: Record<string, unknown> }[] = []
  world.onComponentChanged((entityId, name, data) => seen.push({ entityId, name, data }))
  return seen
}

describe('World', () => {
  test('allocates and destroys entities', () => {
    const world = new World()
    const a = world.createEntity()
    const b = world.createEntity()

    expect(a).not.toBe(b)
    expect(world.hasEntity(a)).toBe(true)

    world.destroyEntity(a)
    expect(world.hasEntity(a)).toBe(false)
    expect(world.hasEntity(b)).toBe(true)
  })

  test('stores, retrieves and removes components', () => {
    const world = new World()
    const entity = world.createEntity()
    world.addComponent(entity, new Counter(42))

    expect(world.hasComponent(entity, Counter)).toBe(true)
    expect(world.getComponent(entity, Counter)?.value).toBe(42)

    world.removeComponent(entity, Counter)
    expect(world.hasComponent(entity, Counter)).toBe(false)
    expect(world.getComponent(entity, Counter)).toBeUndefined()
  })

  test('query returns only entities holding every requested component', () => {
    const world = new World()
    const both = world.createEntity()
    const counterOnly = world.createEntity()
    const markerOnly = world.createEntity()

    world.addComponent(both, new Counter())
    world.addComponent(both, new Marker())
    world.addComponent(counterOnly, new Counter())
    world.addComponent(markerOnly, new Marker())

    expect(world.query([Counter]).sort()).toEqual([both, counterOnly].sort())
    expect(world.query([Counter, Marker])).toEqual([both])
  })

  test('destroyed entities drop out of queries', () => {
    const world = new World()
    const entity = world.createEntity()
    world.addComponent(entity, new Counter())

    world.destroyEntity(entity)
    expect(world.query([Counter])).toEqual([])
  })

  test('update ticks every registered system', () => {
    const world = new World()
    const spy = new TickSpy()
    world.addSystem(spy)

    world.update(0.016)
    world.update(0.016)

    expect(spy.ticks).toBe(2)
  })
})

describe('World change replication', () => {
  test('broadcasts a mutation nobody announced', () => {
    const world = new World()
    const entity = world.createEntity()
    const counter = world.addComponent(entity, new Counter(1))
    const seen = recorder(world)

    counter.value = 7
    world.syncDirty()

    expect(seen).toEqual([{ entityId: entity, name: 'counter', data: { value: 7 } }])
  })

  test('stays silent when nothing changed', () => {
    const world = new World()
    const entity = world.createEntity()
    world.addComponent(entity, new Counter(1))
    const seen = recorder(world)

    world.syncDirty()
    world.syncDirty()

    expect(seen).toEqual([])
  })

  test('reports a component only once per distinct value', () => {
    const world = new World()
    const entity = world.createEntity()
    const counter = world.addComponent(entity, new Counter(1))
    const seen = recorder(world)

    counter.value = 2
    world.syncDirty()
    world.syncDirty()

    expect(seen.length).toBe(1)
  })

  test('detects nested mutation, not just reassignment', () => {
    const world = new World()
    const entity = world.createEntity()
    const inventory = world.addComponent(entity, new InventoryComponent())
    const seen = recorder(world)

    inventory.grenades[GrenadeId.Frag] += 3
    world.syncDirty()

    expect(seen.length).toBe(1)
    expect((seen[0]!.data.grenades as Record<string, number>)[GrenadeId.Frag]).toBe(4)
  })

  test('applyRemote writes peer state without echoing it back', () => {
    const world = new World()
    const entity = world.createEntity()
    world.addComponent(entity, new HealthComponent(100, 100))
    const seen = recorder(world)

    expect(world.applyRemote(entity, 'health', { hp: 40, maxHp: 100 })).toBe(true)
    world.syncDirty()

    expect(world.getComponent(entity, HealthComponent)?.hp).toBe(40)
    expect(seen).toEqual([])
  })

  test('applyRemote reports failure for an unknown component', () => {
    const world = new World()
    const entity = world.createEntity()

    expect(world.applyRemote(entity, 'health', { hp: 1 })).toBe(false)
  })

  test('a local change after a remote one is still replicated', () => {
    const world = new World()
    const entity = world.createEntity()
    const health = world.addComponent(entity, new HealthComponent(100, 100))
    const seen = recorder(world)

    world.applyRemote(entity, 'health', { hp: 40, maxHp: 100 })
    health.hp = 10
    world.syncDirty()

    expect(seen).toEqual([{ entityId: entity, name: 'health', data: { hp: 10, maxHp: 100 } }])
  })
})

describe('Components', () => {
  test('round-trip through serialize/deserialize', () => {
    const cases: [Component, Component][] = [
      [new IdentityComponent(Faction.Blue, 1, 'Alpha'), new IdentityComponent(Faction.Red, 0, '')],
      [new HealthComponent(80, 120), new HealthComponent()],
      [new ActionPointsComponent(3, 9), new ActionPointsComponent()],
      [new ArmorComponent(15, 22), new ArmorComponent()],
      [new StanceComponent(true, true, [{ x: 5, y: 10 }], true), new StanceComponent()],
      [new StatusesComponent([{ kind: StatusKind.Smoked, turnsLeft: 2 }]), new StatusesComponent()],
      [new InventoryComponent({ frag: 3, flash: 0, smoke: 1 }), new InventoryComponent()],
      [new GrenadeSpecsComponent(), new GrenadeSpecsComponent()],
    ]

    for (const [source, sink] of cases) {
      sink.deserialize(source.serialize())
      expect(sink.serialize()).toEqual(source.serialize())
    }
  })

  test('position survives the trip as plain JSON', () => {
    const source = new PositionComponent({ x: 5, y: 10 }, undefined, 1.57)
    source.targetPos.set(5, 0, 10)

    const sink = new PositionComponent()
    sink.deserialize(source.serialize())

    expect(sink.tile).toEqual({ x: 5, y: 10 })
    expect([sink.targetPos.x, sink.targetPos.y, sink.targetPos.z]).toEqual([5, 0, 10])
    expect(sink.targetYaw).toBe(1.57)
  })

  test('weapon component carries per-unit stat tuning', () => {
    const source = new WeaponComponent(WeaponId.Shotgun)
    source.weapon.damage = 123
    source.weapon.currentClip = 2

    const sink = new WeaponComponent(WeaponId.Rifle)
    sink.deserialize(source.serialize())

    expect(sink.weaponId).toBe(WeaponId.Shotgun)
    expect(sink.weapon.damage).toBe(123)
    expect(sink.weapon.currentClip).toBe(2)
  })

  test('ammo component carries per-unit stat tuning', () => {
    const source = new AmmoComponent()
    source.ammo.damageMul = 2.5

    const sink = new AmmoComponent()
    sink.deserialize(source.serialize())

    expect(sink.ammo.damageMul).toBe(2.5)
  })

  test('rules components wrap the live table rather than copying it', () => {
    const component = new MatchRulesComponent()
    const original = RULES.moveSpeed
    try {
      component.deserialize({ moveSpeed: 9 })
      expect(RULES.moveSpeed).toBe(9)
    } finally {
      RULES.moveSpeed = original
    }
  })
})

describe('MovementSystem', () => {
  const grid = new Grid(8)

  function walker(world: World, ap: number) {
    const entity = world.createEntity()
    world.addComponent(entity, new PositionComponent({ x: 0, y: 0 }, grid.tileToWorld({ x: 0, y: 0 })))
    world.addComponent(entity, new StanceComponent())
    world.addComponent(entity, new ActionPointsComponent(ap, ap))
    world.addComponent(entity, new HealthComponent(100, 100))
    return entity
  }

  test('walks the route, charging AP per tile', () => {
    const world = new World()
    const system = new MovementSystem(grid)
    world.addSystem(system)
    const entity = walker(world, 10)

    system.startMovement(world, entity, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ])
    world.update(5)

    expect(world.getComponent(world.query([PositionComponent])[0]!, PositionComponent)?.tile).toEqual({ x: 2, y: 0 })
    expect(world.getComponent(entity, ActionPointsComponent)?.ap).toBe(8)
    expect(world.getComponent(entity, StanceComponent)?.isMoving).toBe(false)
  })

  test('halts on a tile boundary when AP runs out', () => {
    const world = new World()
    const system = new MovementSystem(grid)
    world.addSystem(system)
    const entity = walker(world, 1)

    system.startMovement(world, entity, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ])
    world.update(5)

    expect(world.getComponent(entity, PositionComponent)?.tile).toEqual({ x: 1, y: 0 })
    expect(world.getComponent(entity, ActionPointsComponent)?.ap).toBe(0)
    expect(world.getComponent(entity, StanceComponent)?.isMoving).toBe(false)
  })

  test('charges the diagonal rate for a diagonal step', () => {
    const world = new World()
    const system = new MovementSystem(grid)
    world.addSystem(system)
    const entity = walker(world, 10)

    system.startMovement(world, entity, [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ])
    world.update(5)

    expect(world.getComponent(entity, ActionPointsComponent)?.ap).toBe(10 - RULES.stepDiagonal)
  })

  test('moving breaks cover', () => {
    const world = new World()
    const system = new MovementSystem(grid)
    const entity = walker(world, 10)
    world.getComponent(entity, StanceComponent)!.isCrouching = true

    system.startMovement(world, entity, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ])

    expect(world.getComponent(entity, StanceComponent)?.isCrouching).toBe(false)
  })

  test('refuses a route with nowhere to go', () => {
    const world = new World()
    const system = new MovementSystem(grid)
    const entity = walker(world, 10)

    expect(system.startMovement(world, entity, [{ x: 0, y: 0 }])).toBe(false)
    expect(world.getComponent(entity, StanceComponent)?.isMoving).toBe(false)
  })

  test('the dead stop walking', () => {
    const world = new World()
    const system = new MovementSystem(grid)
    world.addSystem(system)
    const entity = walker(world, 10)

    system.startMovement(world, entity, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ])
    world.getComponent(entity, HealthComponent)!.hp = 0
    world.update(5)

    expect(world.getComponent(entity, StanceComponent)?.isMoving).toBe(false)
    expect(world.getComponent(entity, PositionComponent)?.tile).toEqual({ x: 0, y: 0 })
  })
})

describe('TurnSystem', () => {
  function squad(world: World, faction: Faction, hp = 100) {
    const entity = world.createEntity()
    world.addComponent(entity, new IdentityComponent(faction, 0, 'unit'))
    world.addComponent(entity, new ActionPointsComponent(0, 8))
    world.addComponent(entity, new HealthComponent(hp, 100))
    return entity
  }

  test('hands the turn to the other faction and refills its AP', () => {
    const world = new World()
    const system = new TurnSystem()
    const blue = squad(world, Faction.Blue)
    const red = squad(world, Faction.Red)

    expect(system.activeFaction).toBe(Faction.Blue)
    system.endTurn(world)

    expect(system.activeFaction).toBe(Faction.Red)
    expect(world.getComponent(red, ActionPointsComponent)?.ap).toBe(8)
    expect(world.getComponent(blue, ActionPointsComponent)?.ap).toBe(0)
  })

  test('the dead get no action points back', () => {
    const world = new World()
    const system = new TurnSystem()
    const corpse = squad(world, Faction.Red, 0)

    system.endTurn(world)

    expect(world.getComponent(corpse, ActionPointsComponent)?.ap).toBe(0)
  })

  test('a round advances only when play returns to the first faction', () => {
    const world = new World()
    const system = new TurnSystem()

    system.endTurn(world)
    expect(system.turnNumber).toBe(1)

    system.endTurn(world)
    expect(system.turnNumber).toBe(2)
  })

  test('ending a unit turn strips only that unit', () => {
    const world = new World()
    const system = new TurnSystem()
    const first = squad(world, Faction.Blue)
    const second = squad(world, Faction.Blue)
    world.getComponent(first, ActionPointsComponent)!.ap = 8
    world.getComponent(second, ActionPointsComponent)!.ap = 8

    system.endUnitTurn(world, first)

    expect(world.getComponent(first, ActionPointsComponent)?.ap).toBe(0)
    expect(world.getComponent(second, ActionPointsComponent)?.ap).toBe(8)
  })
})
