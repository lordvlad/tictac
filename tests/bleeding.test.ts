import { describe, expect, test } from 'bun:test'
import { Faction, SQUAD_SIZE } from '../src/config'
import { AmmoId, ShotMode, STATUSES, StatusKind, WeaponId } from '../src/core/Arsenal'
import { bleedChance, effectiveWeapon } from '../src/core/Ballistics'
import { characterSheet } from '../src/core/Characters'
import { NO_FOCUS, NO_FX } from '../src/core/Combatant'
import { Grid, Side } from '../src/core/Grid'
import { ItemId } from '../src/core/Items'
import { Rng, type Roll } from '../src/core/rng'
import { TraitId } from '../src/core/Traits'
import { WallKind } from '../src/core/Walls'
import { World } from '../src/ecs/World'
import { createGlobalRules } from '../src/ecs/globals'
import { CombatSystem, GroundSystem, ItemSystem, MovementSystem, TurnSystem, WallSystem } from '../src/ecs/systems'
import { CommandSystem } from '../src/ecs/systems/CommandSystem'
import type { Soldier } from '../src/entities/Soldier'
import { ailmentCost, applyStatus, executeShot } from '../src/game/Combat'
import { carriedOut } from '../src/game/MatchEnd'
import { Squads } from '../src/game/Squads'
import { TurnManager } from '../src/game/TurnManager'
import { headlessSoldier } from './support/soldier'

const always = (value: number): Roll => () => value

/** A sheet with no trait of its own, so nothing but what a test gives it decides. */
const plain = () => ({ ...characterSheet(new Rng(4)), traits: [] })

describe('Who a wound starts bleeding', () => {
  const odds = (shooter: Soldier, target: Soldier) => bleedChance(effectiveWeapon(shooter, ShotMode.Snap), target)

  test('armour keeps a round off the skin, and a round that goes through armour keeps its chance', () => {
    const shooter = headlessSoldier({ sheet: plain() })
    const bare = headlessSoldier({ faction: Faction.Red, sheet: plain() })
    bare.armor = 0
    const plated = headlessSoldier({ faction: Faction.Red, sheet: plain() })
    plated.armor = 20

    expect(odds(shooter, bare)).toBe(WEAPON_BLEED.rifle)
    expect(odds(shooter, plated)).toBeLessThan(odds(shooter, bare))

    const piercing = headlessSoldier({ sheet: plain(), ammo: AmmoId.ArmorPiercing })
    expect(odds(piercing, plated)).toBeGreaterThan(odds(shooter, plated))
  })

  test('nobody Hardy, and nobody in a Nullweave vest, ever bleeds', () => {
    const shooter = headlessSoldier({ sheet: plain(), weapon: WeaponId.Sniper })
    const hardy = headlessSoldier({ faction: Faction.Red, sheet: { ...plain(), traits: [TraitId.Hardy] } })
    const vested = headlessSoldier({ faction: Faction.Red, sheet: plain(), items: { [ItemId.NullweaveVest]: 1 } })
    for (const target of [hardy, vested]) target.armor = 0
    expect(odds(shooter, hardy)).toBe(0)
    expect(odds(shooter, vested)).toBe(0)
  })

  test('a round that lands rolls for it after the crit; a target that cannot bleed costs no draw', () => {
    const grid = new Grid(16)
    const shot = (target: Soldier, roll: Roll) => {
      const shooter = headlessSoldier({ sheet: plain(), tile: { x: 4, y: 4 } })
      target.tile = { x: 4, y: 6 }
      target.armor = 0
      let draws = 0
      const counted = () => {
        draws++
        return roll()
      }
      const result = executeShot(grid, shooter, target, NO_FX, [shooter, target], ShotMode.Snap, counted)
      return { result, draws, bleeding: target.statuses.some((s) => s.kind === StatusKind.Bleeding) }
    }

    const opened = shot(headlessSoldier({ faction: Faction.Red, sheet: plain() }), always(0))
    expect(opened.bleeding).toBe(true)
    expect(opened.result.hits[0]!.status).toBe(StatusKind.Bleeding)
    expect(opened.draws).toBe(3)

    // Lands (0.2 is under the hit chance) but over the bleed odds.
    const closed = shot(headlessSoldier({ faction: Faction.Red, sheet: plain() }), always(0.2))
    expect(closed.result.hit).toBe(true)
    expect(closed.bleeding).toBe(false)

    const hardy = shot(headlessSoldier({ faction: Faction.Red, sheet: { ...plain(), traits: [TraitId.Hardy] } }), always(0))
    expect(hardy.bleeding).toBe(false)
    expect(hardy.draws).toBe(2)
  })
})

/** Rifle's bleed chance, read off the weapon rather than restated. */
const WEAPON_BLEED = { rifle: effectiveWeapon(headlessSoldier({ sheet: plain() }), ShotMode.Snap).bleedChance }

/** A small match with no scene. Blue 0 and Red 0 are placed by the test; the rest parked behind a wall. */
function match() {
  const world = new World()
  createGlobalRules(world)
  const grid = new Grid(40)
  for (let x = 0; x < grid.size; x++) grid.setWall(x, 35, Side.North, WallKind.Solid)
  const parked = (x0: number) => Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: x0 + i * 2, y: 38 }))
  const squads = new Squads(world, grid, { [Faction.Blue]: parked(1), [Faction.Red]: parked(30) }, undefined, Faction.Blue, {
    [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, plain),
    [Faction.Red]: Array.from({ length: SQUAD_SIZE }, plain),
  })
  for (const unit of squads.soldiers) unit.equip(WeaponId.Rifle, AmmoId.Standard)
  const movement = new MovementSystem(grid)
  const combat = new CombatSystem(grid, squads, NO_FX, always(0.99))
  const turns = new TurnSystem()
  const turnManager = new TurnManager(world, turns, squads, NO_FOCUS)
  const walls = new WallSystem(grid)
  walls.spawnFromGrid(world)
  const ground = new GroundSystem(grid)
  ground.spawn(world)
  const items = new ItemSystem()
  const commands = new CommandSystem(world, squads, turnManager, movement, combat, items, walls, ground)
  for (const system of [commands, movement, combat, turns]) world.addSystem(system)
  const handOver = () => commands.apply({ type: 'endTurn', faction: turns.activeFaction }, 'local')
  return { grid, squads, items, handOver, blue: squads.byFaction[Faction.Blue][0]!, red: squads.byFaction[Faction.Red][0]! }
}

describe('Bleeding', () => {
  test('costs blood at the start of the unit’s own turns, a stack at a time, armour or not, and clots after three', () => {
    const m = match()
    m.red.tile = { x: 10, y: 10 }
    applyStatus(m.red, StatusKind.Bleeding, 2)
    const per = STATUSES[StatusKind.Bleeding].damagePerTurn
    const lost: number[] = []
    for (let i = 0; i < 5; i++) {
      const before = m.red.hp
      m.handOver()
      lost.push(before - m.red.hp)
    }
    // Red's turns are the first, third and fifth handovers; Blue's cost it nothing.
    expect(lost).toEqual([2 * per, 0, 2 * per, 0, 2 * per])
    const after = m.red.hp
    m.handOver()
    m.handOver()
    expect(m.red.hp).toBe(after)
    expect(m.red.statuses.some((s) => s.kind === StatusKind.Bleeding)).toBe(false)
  })

  test('a first aid kit stops it, and leaves what is not an ailment alone', () => {
    const m = match()
    m.blue.items[ItemId.FirstAidKit] = 1
    applyStatus(m.blue, StatusKind.Bleeding, 3)
    applyStatus(m.blue, StatusKind.Suppressed)
    expect(m.items.use(m.blue, ItemId.FirstAidKit)).toBe(true)
    expect(m.blue.statuses.map((s) => s.kind)).toEqual([StatusKind.Suppressed])
  })

  test('what it will still cost if left: every stack, for each of the unit’s own turns left on the clock', () => {
    // Five ticks left is three of its own turns (the clock ticks at both
    // sides' handovers); a status that is not an ailment costs nothing.
    const per = STATUSES[StatusKind.Bleeding].damagePerTurn
    const unit = {
      statuses: [
        { kind: StatusKind.Bleeding, turnsLeft: 5, stacks: 2 },
        { kind: StatusKind.Suppressed, turnsLeft: 2, stacks: 3 },
      ],
    }
    expect(ailmentCost(unit)).toBe(2 * per * 3)
    expect(ailmentCost({ statuses: [{ kind: StatusKind.Bleeding, turnsLeft: 2, stacks: 1 }] })).toBe(per)
  })

  test('a losing side’s bleeding are passed over for the one carried out, while anyone is not', () => {
    const m = match()
    const reds = m.squads.byFaction[Faction.Red]
    reds.forEach((red, i) => {
      red.tile = { x: 10 + i, y: 10 }
      red.hp = 0
      if (i > 0) applyStatus(red, StatusKind.Bleeding)
    })
    const picked = new Set(Array.from({ length: 50 }, (_, seed) => carriedOut(m.squads, Faction.Red, m.grid, seed)))
    expect(picked).toEqual(new Set([reds[0]!]))
  })
})
