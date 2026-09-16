import { describe, expect, test } from 'bun:test'
import { Faction, SQUAD_SIZE } from '../src/config'
import { AmmoId, WEAPONS, WeaponId } from '../src/core/Arsenal'
import { ATTACHMENTS, AttachmentId } from '../src/core/Attachments'
import { Grid } from '../src/core/Grid'
import { World } from '../src/ecs/World'
import { Squads } from '../src/game/Squads'

function squads(): Squads {
  const world = new World()
  const grid = new Grid(16)
  return new Squads(world, grid, {
    [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 2 })),
    [Faction.Red]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 12 })),
  })
}

describe('A weapon is a thing, not a kind of thing', () => {
  test('two of the same class are two weapons', () => {
    const one = WEAPONS[WeaponId.Rifle].clone()
    const two = WEAPONS[WeaponId.Rifle].clone()

    expect(one.serial).not.toBe(two.serial)
    expect(one.label).not.toBe(two.label)
    expect(one.label).toContain('Rifle')
  })

  test('a clone gets its own rail, not a share of the original\u2019s', () => {
    // The bug this guards: `Object.assign` copying the array reference, so
    // fitting a scope to one soldier's rifle fits it to every rifle.
    const template = WEAPONS[WeaponId.Rifle].clone()
    template.fit(AttachmentId.Scope)

    const copy = template.clone()
    copy.fit(AttachmentId.Bipod)

    expect(template.attachments).toEqual([AttachmentId.Scope])
    expect(copy.attachments).toEqual([AttachmentId.Scope, AttachmentId.Bipod])
  })

  test('each soldier carries its own weapon', () => {
    const squad = squads()
    const [first, second] = squad.byFaction[Faction.Blue]
    first!.equip(WeaponId.Rifle, AmmoId.Standard)
    second!.equip(WeaponId.Rifle, AmmoId.Standard)

    first!.fitAttachment(AttachmentId.Scope)

    expect(second!.weapon.serial).not.toBe(first!.weapon.serial)
    expect(second!.weapon.attachments).toEqual([])
    expect(first!.rangeFalloff).toBeLessThan(0)
    expect(second!.rangeFalloff).toBe(0)
  })
})

describe('Rail space', () => {
  test('a purpose-built weapon has more of it than grandpa\u2019s shotgun', () => {
    expect(WEAPONS[WeaponId.Rifle].slots).toBeGreaterThan(WEAPONS[WeaponId.Shotgun].slots)
    expect(WEAPONS[WeaponId.Sniper].slots).toBeGreaterThan(WEAPONS[WeaponId.Shotgun].slots)
    expect(WEAPONS[WeaponId.Shotgun].slots).toBe(1)
  })

  test('it runs out', () => {
    const shotgun = WEAPONS[WeaponId.Shotgun].clone()

    expect(shotgun.fit(AttachmentId.Scope)).toBe(true)
    expect(shotgun.slotsFree).toBe(0)
    expect(shotgun.fit(AttachmentId.Bipod)).toBe(false)
    expect(shotgun.attachments).toEqual([AttachmentId.Scope])
  })

  test('the same mod is refused twice over', () => {
    // Two scopes is not twice the glass, it is a mistake - and the trait fold
    // would cheerfully add it up twice.
    const rifle = WEAPONS[WeaponId.Rifle].clone()

    expect(rifle.fit(AttachmentId.Scope)).toBe(true)
    expect(rifle.canFit(AttachmentId.Scope)).toBe(false)
    expect(rifle.fit(AttachmentId.Scope)).toBe(false)
    expect(rifle.slotsUsed).toBe(ATTACHMENTS[AttachmentId.Scope].slots)
  })

  test('taking one off frees its space again', () => {
    const rifle = WEAPONS[WeaponId.Rifle].clone()
    rifle.fit(AttachmentId.Scope)
    const used = rifle.slotsUsed

    expect(rifle.unfit(AttachmentId.Scope)).toBe(true)
    expect(rifle.slotsUsed).toBe(used - ATTACHMENTS[AttachmentId.Scope].slots)
    expect(rifle.unfit(AttachmentId.Scope)).toBe(false)
  })

  test('slots are counted by what a mod costs, not by how many are listed', () => {
    const rifle = WEAPONS[WeaponId.Rifle].clone()
    rifle.fit(AttachmentId.Scope)
    rifle.fit(AttachmentId.Bipod)

    const expected =
      ATTACHMENTS[AttachmentId.Scope].slots + ATTACHMENTS[AttachmentId.Bipod].slots
    expect(rifle.slotsUsed).toBe(expected)
  })
})

describe('Fitting through a soldier', () => {
  test('a mod is in force the moment it goes on, and gone when it comes off', () => {
    const soldier = squads().byFaction[Faction.Blue][0]!
    soldier.equip(WeaponId.Rifle, AmmoId.Standard)
    const bare = soldier.proficiency

    soldier.fitAttachment(AttachmentId.Scope)
    expect(soldier.proficiency).toBeLessThan(bare)
    expect(soldier.rangeFalloff).toBeLessThan(0)

    soldier.unfitAttachment(AttachmentId.Scope)
    expect(soldier.proficiency).toBe(bare)
    expect(soldier.rangeFalloff).toBe(0)
  })

  test('a full rail refuses politely rather than throwing', () => {
    const soldier = squads().byFaction[Faction.Blue][0]!
    soldier.equip(WeaponId.Shotgun, AmmoId.Standard)

    expect(soldier.fitAttachment(AttachmentId.Scope)).toBe(true)
    expect(soldier.fitAttachment(AttachmentId.Bipod)).toBe(false)
  })

  test('changing weapon leaves the old rail behind', () => {
    // A different weapon is a different rail: whatever was on the last one is
    // not in force any more, and the fold has to follow.
    const soldier = squads().byFaction[Faction.Blue][0]!
    soldier.equip(WeaponId.Rifle, AmmoId.Standard)
    soldier.fitAttachment(AttachmentId.Suppressor)
    expect(soldier.silenced).toBe(true)

    soldier.equip(WeaponId.Sniper, AmmoId.Standard)

    expect(soldier.weapon.attachments).toEqual([])
    expect(soldier.silenced).toBe(false)
  })
})
