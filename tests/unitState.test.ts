import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import { characterSheet } from '../src/core/Characters'
import { hashData } from '../src/core/digest'
import { Grid } from '../src/core/Grid'
import type { Deployment } from '../src/core/Loadout'
import { RoleId } from '../src/core/Roles'
import { Rng } from '../src/core/rng'
import { TraitId } from '../src/core/Traits'
import { CharacterComponent } from '../src/ecs/components'
import { World } from '../src/ecs/World'
import { Squads } from '../src/game/Squads'

const spawns = { [Faction.Blue]: [{ x: 4, y: 4 }], [Faction.Red]: [{ x: 4, y: 9 }] }

/** One soldier a side, built the way a match builds them: a world, a grid, and sheets a peer stated. */
function squadWith(...traits: TraitId[]) {
  const world = new World()
  const sheet = { ...characterSheet(new Rng(3)), traits }
  const deployment = (): Deployment => ({ sheet: structuredClone(sheet) })
  const squads = new Squads(world, new Grid(24), spawns, {
    [Faction.Blue]: [deployment()],
    [Faction.Red]: [deployment()],
  })
  return { world, soldier: squads.byFaction[Faction.Blue][0]! }
}

describe('A rewound unit is a fresh fold of what it was', () => {
  test('proficiency and crit chance after going back to an earlier wound state match a fresh fold', () => {
    const { world, soldier } = squadWith(TraitId.Deadeye)
    const reads = () => ({ proficiency: soldier.proficiency, crit: soldier.critChanceBonus })
    const whole = reads()
    const before = world.snapshot([soldier.entityId])

    // Badly hurt: concussed, which costs accuracy.
    soldier.hp = 1
    const hurt = squadWith(TraitId.Deadeye).soldier
    hurt.hp = 1
    expect(soldier.proficiency).toBeLessThan(whole.proficiency)
    const wounded = world.snapshot([soldier.entityId])

    // Back to whole, then back to hurt: what is read is what a unit in that
    // state folds to, not what the unit last had.
    world.restore(before)
    expect(reads()).toEqual(whole)
    world.restore(wounded)
    expect(soldier.hp).toBe(1)
    expect(reads()).toEqual({ proficiency: hurt.proficiency, crit: hurt.critChanceBonus })
  })

  test('the refold after a restore puts the traits right even when the snapshot’s folded numbers were stale', () => {
    const { world, soldier } = squadWith(TraitId.Deadeye)
    const proficiency = soldier.proficiency
    const snapshot = world.snapshot([soldier.entityId])
    snapshot[0]!.components.traits!.accuracy = 999

    world.restore(snapshot)

    expect(soldier.proficiency).toBe(proficiency)
  })
})

describe('A unit’s role and fatigue are state', () => {
  test('they serialise, so the digest tells two units apart by them', () => {
    const { world, soldier } = squadWith()
    const digestOf = () => hashData(world.componentData(soldier.entityId)!.character)
    const plain = digestOf()

    soldier.role = RoleId.Marksman
    const marksman = digestOf()
    expect(marksman).not.toBe(plain)

    world.getComponent(soldier.entityId, CharacterComponent)!.fatigue = 2
    expect(digestOf()).not.toBe(marksman)
  })

  test('a rewind puts the role back and the traits it granted with it', () => {
    const { world, soldier } = squadWith()
    const before = world.snapshot([soldier.entityId])
    const plain = soldier.rangeFalloff

    soldier.role = RoleId.Marksman
    expect(soldier.rangeFalloff).not.toBe(plain)

    world.restore(before)
    expect<RoleId>(soldier.role).toBe(RoleId.Rifleman)
    expect(soldier.rangeFalloff).toBe(plain)
  })
})

describe('A deployment states its sheet', () => {
  test('one that does not is refused rather than fielded as somebody rolled in its place', () => {
    const noSheet = [{ loadout: undefined }] as unknown as Deployment[]
    expect(() => new Squads(new World(), new Grid(24), spawns, { [Faction.Blue]: noSheet })).toThrow('sheet')
  })
})
