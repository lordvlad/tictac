import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import { AmmoId, StatusKind, WeaponId } from '../src/core/Arsenal'
import { rollSquadSheets } from '../src/core/Characters'
import { canonical, foldHashes, hashData } from '../src/core/digest'
import { Grid } from '../src/core/Grid'
import { Rng } from '../src/core/rng'
import {
  ArmorComponent,
  HealthComponent,
  MatchRulesComponent,
  StanceComponent,
} from '../src/ecs/components'
import { createGlobalRules } from '../src/ecs/globals'
import { GLOBAL_ENTITY_ID, World } from '../src/ecs/World'
import { Squads } from '../src/game/Squads'
import { compareDigests, digestWorld } from '../src/game/StateDigest'

/** Two worlds dealt the same people, as two peers hold them after a handshake. */
function peer(seed = 5) {
  const world = new World()
  createGlobalRules(world)
  const grid = new Grid(24)
  const squads = new Squads(
    world,
    grid,
    { [Faction.Blue]: [{ x: 4, y: 4 }], [Faction.Red]: [{ x: 4, y: 9 }] },
    undefined,
    Faction.Blue,
    {
      [Faction.Blue]: rollSquadSheets(new Rng(seed)),
      [Faction.Red]: rollSquadSheets(new Rng(seed + 1)),
    },
  )
  for (const unit of squads.soldiers) unit.equip(WeaponId.Rifle, AmmoId.Standard)
  const digest = () => digestWorld(world, squads.soldiers.map((u) => u.entityId), 3)
  const nameOf = (entityId: number) =>
    squads.soldiers.find((u) => u.entityId === entityId)?.name ?? `#${entityId}`
  return { world, grid, squads, digest, nameOf }
}

describe('Hashing state so two copies can be compared', () => {
  test('key order does not change what a component hashes to', () => {
    // Two peers run the same constructors, but a component that gained its
    // values through `deserialize` can hold the same data in another order.
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }))
    expect(hashData({ hp: 90, maxHp: 100 })).toBe(hashData({ maxHp: 100, hp: 90 }))
  })

  test('a different value is a different hash', () => {
    expect(hashData({ hp: 90 })).not.toBe(hashData({ hp: 91 }))
    // Nested, since statuses arrive as arrays of objects.
    expect(hashData({ list: [{ kind: 'winded', turnsLeft: 1 }] })).not.toBe(
      hashData({ list: [{ kind: 'winded', turnsLeft: 2 }] }),
    )
  })

  test('folding does not care what order the parts arrive in', () => {
    // The entities a world holds are a set: two peers that created the same
    // ones in a different order still hold the same world.
    expect(foldHashes([1, 2, 3])).toBe(foldHashes([3, 1, 2]))
    // And a swap of two values must not cancel out, the way a plain XOR would.
    expect(foldHashes([1, 2])).not.toBe(foldHashes([2, 4]))
  })
})

describe('Comparing two peers at a handover', () => {
  test('identical worlds agree, in one comparison', () => {
    const a = peer()
    const b = peer()

    expect(a.digest().total).toBe(b.digest().total)
    expect(compareDigests(a.digest(), b.digest(), a.nameOf)).toEqual([])
  })

  test('one mutated component is named, with the unit that holds it', () => {
    // The drift a single action never reveals. Health, because it is the thing
    // most likely to be one number out.
    const a = peer()
    const b = peer()
    const unit = b.squads.byFaction[Faction.Red][1]!
    b.world.getComponent(unit.entityId, HealthComponent)!.hp -= 1

    const found = compareDigests(a.digest(), b.digest(), a.nameOf)

    expect(found).toHaveLength(1)
    expect(found[0]!.what).toBe('component health')
    expect(found[0]!.unit).toBe(unit.name)
    expect(found[0]!.mine).not.toBe(found[0]!.theirs)
  })

  test('it notices state no shot would have touched', () => {
    // Armour and stance drift silently: nothing announces a stance, and armour
    // only moves as a side effect. This is the case `ITEM-020` cannot see.
    const a = peer()
    const b = peer()
    const unit = b.squads.byFaction[Faction.Blue][0]!
    b.world.getComponent(unit.entityId, ArmorComponent)!.armor -= 2
    b.world.getComponent(unit.entityId, StanceComponent)!.isCrouching = true

    const found = compareDigests(a.digest(), b.digest(), a.nameOf)

    expect(found.map((d) => d.what).sort()).toEqual(['component armor', 'component stance'])
    for (const d of found) expect(d.unit).toBe(unit.name)
  })

  test('a status nobody replicated is caught', () => {
    const a = peer()
    const b = peer()
    const unit = b.squads.byFaction[Faction.Red][0]!
    unit.statuses = [{ kind: StatusKind.Suppressed, turnsLeft: 1, stacks: 1 }]

    const found = compareDigests(a.digest(), b.digest(), a.nameOf)

    expect(found.map((d) => d.what)).toContain('component statuses')
  })

  test('a non-unit entity that differs is reported as terrain', () => {
    // Walls are entities too and there are hundreds on a map, so everything
    // that is not a soldier folds into one number: a hash per wall per turn
    // would be paying every turn to diagnose something that has never drifted.
    // The report still says *that* terrain differs, which is where to start.
    const a = peer()
    const b = peer()
    const extra = b.world.createEntity()
    b.world.addComponent(extra, new StanceComponent())

    const found = compareDigests(a.digest(), b.digest(), a.nameOf)

    expect(found.map((d) => d.what)).toEqual(['terrain'])
  })

  test('a drifted rule table changes the fingerprint', () => {
    // A tunable that moved is a different problem from a wall that did, and the
    // global entity is where a debug panel writes — so it gets its own hash.
    //
    // One world, not two: the rules components wrap the live `RULES` object, so
    // two worlds in one process share it and cannot disagree. That is a fact
    // about the singleton rather than about the digest, and it is why this test
    // compares the same world before and after.
    const a = peer()
    const before = a.digest()
    const rules = a.world.getComponent(GLOBAL_ENTITY_ID, MatchRulesComponent)!
    const wasMaxAp = rules.rules.maxAp

    rules.rules.maxAp = wasMaxAp + 1
    const after = a.digest()

    expect(after.rules).not.toBe(before.rules)
    expect(after.total).not.toBe(before.total)
    expect(after.terrain).toBe(before.terrain)

    // Restored: it is a process-wide singleton, and leaving it moved would
    // change the rules for every test that runs after this one.
    rules.rules.maxAp = wasMaxAp
    expect(a.digest().total).toBe(before.total)
  })

  test('comparing two different turns says so instead of blaming every unit', () => {
    const a = peer()
    const mine = a.digest()
    const theirs = { ...a.digest(), turn: mine.turn + 1, total: mine.total + 1 }

    const found = compareDigests(mine, theirs, a.nameOf)

    expect(found).toEqual([{ what: 'digestTurn', mine: mine.turn, theirs: mine.turn + 1 }])
  })

  test('a whole match of digests costs a fraction of a frame', () => {
    // Once per handover is what makes it free. A 40-turn match is 40 of these,
    // and a frame is 16ms.
    const a = peer()
    const started = performance.now()
    for (let i = 0; i < 40; i++) a.digest()
    const each = (performance.now() - started) / 40

    expect(each).toBeLessThan(16)
  })
})
