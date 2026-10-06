import { describe, expect, test } from 'bun:test'
import { Faction, SQUAD_SIZE } from '../src/config'
import { AmmoId, GrenadeId, ShotMode, WeaponId } from '../src/core/Arsenal'
import { NO_FX } from '../src/core/Combatant'
import { characterSheet, rollSquadSheets } from '../src/core/Characters'
import { Grid } from '../src/core/Grid'
import { Rng } from '../src/core/rng'
import { World } from '../src/ecs/World'
import { HealthComponent } from '../src/ecs/components'
import { fireWeapon } from '../src/game/Combat'
import { deploymentStateFrom, parseRecording, RECORDING_VERSION, Recorder } from '../src/game/Recording'
import { defaultLoadout } from '../src/game/Loadout'
import { Squads } from '../src/game/Squads'
import { STOCK_PLAN } from '../src/sim/Balance'
import { SimMatch } from '../src/sim/SimMatch'
import type { CombatRecording } from '../src/game/Recording'
import { stockSquads } from './support/squads'

/**
 * No canvas stub here either — a recording is command data, and if anything in
 * this file starts needing a renderer then the format has grown a dependency on
 * one and that is the regression to look for.
 */
function recorded(seed: number): { match: SimMatch; recording: CombatRecording } {
  const match = new SimMatch({ seed, blue: STOCK_PLAN, red: STOCK_PLAN, turnCap: 40, record: true })
  match.run()
  const recording = match.recording
  if (!recording) throw new Error('match did not record')
  return { match, recording }
}

function countByType(recording: CombatRecording): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const event of recording.events) {
    counts[event.command.type] = (counts[event.command.type] ?? 0) + 1
  }
  return counts
}

describe('A simulated match writes down what it did', () => {
  test('the stream is a pure function of the setup', () => {
    const a = recorded(7).recording
    const b = recorded(7).recording
    // The header carries a wall-clock stamp, which is not part of the fight.
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events))
    expect(a.events.length).toBeGreaterThan(0)
  })

  test('a different seed is a different fight', () => {
    expect(JSON.stringify(recorded(7).recording.events)).not.toBe(
      JSON.stringify(recorded(8).recording.events),
    )
  })

  test('every shot, throw and handover is in the stream', () => {
    const match = new SimMatch({
      seed: 7,
      blue: STOCK_PLAN,
      red: STOCK_PLAN,
      turnCap: 40,
      record: true,
    })
    const outcome = match.run()
    const recording = match.recording!
    const counts = countByType(recording)

    const shots = Object.values(outcome.byWeapon).reduce((sum, tally) => sum + tally.shots, 0)
    expect(counts.fireShot ?? 0).toBe(shots)
    expect(counts.throwGrenade ?? 0).toBe(outcome.grenadesThrown)
    // Both sides act each round, so the handovers are two per completed turn.
    expect(counts.endTurn ?? 0).toBeGreaterThan(0)
    expect(counts.moveUnit ?? 0).toBeGreaterThan(0)
    expect(counts.endUnitTurn ?? 0).toBeGreaterThan(0)
  })

  test('a move records the tile it started on, so a route can be walked again', () => {
    const { recording } = recorded(7)
    const move = recording.events.find((event) => event.command.type === 'moveUnit')
    expect(move).toBeDefined()
    if (move?.command.type !== 'moveUnit') throw new Error('expected a move')
    // `MovementSystem` treats the first entry as the origin and refuses a
    // one-tile path, so a route of length one would replay as no move at all.
    expect(move.command.path.length).toBeGreaterThan(1)
  })

  test('an attack in the file carries an intent and no outcome', () => {
    // The shape intent-only gives a recording: who shot at whom, in what mode.
    // What it did is not in the file, because a replay resolves it from the
    // match's seeded dice — which is what makes a recording and the wire the
    // same frames rather than two formats that have to agree.
    const { recording } = recorded(7)

    const attacks = recording.events
      .map((event) => event.command)
      .filter((command) => command.type === 'fireShot' || command.type === 'throwGrenade')

    expect(attacks.length).toBeGreaterThan(0)
    for (const command of attacks) {
      expect(command).not.toHaveProperty('hits')
      expect(command).not.toHaveProperty('rolls')
      expect(command).not.toHaveProperty('areaRadius')
    }
  })

  test('both squads carry their kit, so a replay deploys the same fight', () => {
    const { recording } = recorded(7)
    for (const faction of [Faction.Blue, Faction.Red] as const) {
      expect(recording.header.squads[faction]).toHaveLength(SQUAD_SIZE)
      expect(recording.header.squads[faction][0]?.loadout?.weaponId).toBe(WeaponId.Rifle)
    }
  })
})

describe('A recording survives the round trip to a file', () => {
  test('what the sim wrote is what the parser accepts', () => {
    const { recording } = recorded(7)
    const parsed = parseRecording(JSON.parse(JSON.stringify(recording)))
    expect(parsed.events).toHaveLength(recording.events.length)
    expect(parsed.header.seed).toBe(recording.header.seed)
    expect(parsed.header.source).toBe('sim')
    expect(parsed.header.squads[Faction.Red][0]?.loadout?.ammoId).toBe(AmmoId.Standard)
  })

  test('a future format is refused rather than half-read', () => {
    const { recording } = recorded(7)
    const future = JSON.parse(JSON.stringify(recording))
    future.header.version = 99
    expect(() => parseRecording(future)).toThrow(/99/)
  })

  test('junk is refused', () => {
    expect(() => parseRecording({})).toThrow()
    expect(() => parseRecording(null)).toThrow()
    expect(() => parseRecording({ header: {}, events: [] })).toThrow()
  })

  test('an unknown command is refused, because a replay cannot skip one', () => {
    const { recording } = recorded(7)
    const tampered = JSON.parse(JSON.stringify(recording))
    tampered.events[0].command.type = 'launchNuke'
    expect(() => parseRecording(tampered)).toThrow(/launchNuke/)
  })

  test('a handshake command is refused: there is nobody to shake hands with', () => {
    const { recording } = recorded(7)
    const tampered = JSON.parse(JSON.stringify(recording))
    tampered.events[0].command = { type: 'ready', squad: [] }
    expect(() => parseRecording(tampered)).toThrow(/ready/)
  })

  test('an unknown weapon is refused: a replay would show a different gun', () => {
    const { recording } = recorded(7)
    const tampered = JSON.parse(JSON.stringify(recording))
    tampered.header.squads[Faction.Blue][0].loadout.weaponId = 'railgun'
    expect(() => parseRecording(tampered)).toThrow(/railgun/)
  })
})

describe('The recorder keeps the fight and drops the handshake', () => {
  test('session commands never reach the stream', () => {
    const recorder = new Recorder(
      {
        version: RECORDING_VERSION,
        seed: 1,
        seedLabel: '1',
        source: 'live',
        createdAt: '',
        turnCap: null,
        squads: { [Faction.Blue]: [], [Faction.Red]: [] },
      },
      () => ({ turn: 3, faction: Faction.Red }),
    )

    recorder.record({ type: 'init', protocol: 1, build: 'test', seed: 1, seedLabel: '1' })
    recorder.record({ type: 'ready', squad: [] })
    expect(recorder.eventCount).toBe(0)

    recorder.record({ type: 'endTurn', faction: Faction.Blue })
    expect(recorder.eventCount).toBe(1)
    expect(recorder.toJSON().events[0]).toMatchObject({ seq: 0, turn: 3, faction: Faction.Red })
  })

  test('a command mutated after recording does not rewrite the past', () => {
    const recorder = new Recorder(
      {
        version: RECORDING_VERSION,
        seed: 1,
        seedLabel: '1',
        source: 'live',
        createdAt: '',
        turnCap: null,
        squads: { [Faction.Blue]: [], [Faction.Red]: [] },
      },
      () => ({ turn: 1, faction: Faction.Blue }),
    )

    const command = {
      type: 'moveUnit' as const,
      faction: Faction.Blue,
      squadIndex: 0,
      path: [{ x: 1, y: 1 }],
    }
    recorder.record(command)
    command.path.push({ x: 2, y: 2 })

    const stored = recorder.toJSON().events[0]?.command
    if (stored?.type !== 'moveUnit') throw new Error('expected a move')
    expect(stored.path).toHaveLength(1)
  })
})

describe('A shot reports the dice it used', () => {
  function shooterAndTarget() {
    const world = new World()
    const grid = new Grid(16)
    const spawns = {
      [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 2 })),
      [Faction.Red]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 5 })),
    }
    const squads = new Squads(
      world,
      grid,
      spawns,
      stockSquads({
        [Faction.Blue]: rollSquadSheets(new Rng(1)),
        [Faction.Red]: rollSquadSheets(new Rng(2)),
      }),
    )
    return { world, grid, squads }
  }

  test('supplied dice come back out verbatim', () => {
    const { grid, squads } = shooterAndTarget()
    const shooter = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!
    shooter.equip(WeaponId.Gatling, AmmoId.Standard)

    // One die per round, which is what the planner hands over: a short array is
    // read as misses for the rounds it does not cover.
    const bullets = shooter.weapon.bulletConsumption(ShotMode.Burst)
    const dice = Array.from({ length: bullets }, (_, i) => i % 2 === 0)

    const result = fireWeapon(
      grid,
      shooter,
      target,
      NO_FX,
      squads.soldiers,
      ShotMode.Burst,
      () => 0,
      dice,
    )

    expect(result?.rolls).toEqual(dice)
  })

  test('rolled dice are reported, one per round spent', () => {
    const { grid, squads } = shooterAndTarget()
    const shooter = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!
    shooter.equip(WeaponId.Gatling, AmmoId.Standard)
    const bullets = shooter.weapon.bulletConsumption(ShotMode.Burst)

    // `roll` pinned to zero: every round lands, so this measures the count and
    // not the odds.
    const result = fireWeapon(
      grid,
      shooter,
      target,
      NO_FX,
      squads.soldiers,
      ShotMode.Burst,
      () => 0,
    )

    expect(result?.rolls).toHaveLength(bullets)
    expect(result?.rolls.every(Boolean)).toBe(true)
  })
})

describe('A world can be put back to an earlier moment', () => {
  test('restoring undoes damage without re-broadcasting it', () => {
    const world = new World()
    const grid = new Grid(16)
    const spawns = {
      [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 2 })),
      [Faction.Red]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 6 })),
    }
    const squads = new Squads(
      world,
      grid,
      spawns,
      stockSquads({
        [Faction.Blue]: rollSquadSheets(new Rng(1)),
        [Faction.Red]: rollSquadSheets(new Rng(2)),
      }),
    )
    const ids = squads.soldiers.map((soldier) => soldier.entityId)
    const victim = squads.byFaction[Faction.Red][0]!

    const before = world.snapshot(ids)
    const fullHp = victim.hp

    victim.hp = 3
    victim.tile = { x: 9, y: 9 }

    const frames: string[] = []
    world.onComponentChanged((_id, name) => frames.push(name))
    world.restore(before)

    expect(victim.hp).toBe(fullHp)
    expect(victim.tile).toEqual(spawns[Faction.Red][0]!)
    // A rewind is not a mutation to announce, and the diff must not report it
    // on the next pass either.
    expect(frames).toHaveLength(0)
    world.syncDirty()
    expect(frames).toHaveLength(0)
    expect(world.getComponent(victim.entityId, HealthComponent)?.hp).toBe(fullHp)
  })
})

describe('A soldier\'s session state, read off the wire', () => {
  test('an entry with a bad or missing field is simply absent, not a reason to refuse the rest', () => {
    // Safe now in a way a positional array never was: HP lives next to the
    // sheet it belongs to, so a short squad cannot desynchronise it onto the
    // wrong soldier — there is no neighbour for it to land on by mistake.
    expect(deploymentStateFrom({ hp: 40, fatigue: 2 })).toEqual({ hp: 40, fatigue: 2 })
    expect(deploymentStateFrom({ hp: 40 })).toEqual({ hp: 40 })
    expect(deploymentStateFrom({ hp: 'forty' })).toBeUndefined()
    expect(deploymentStateFrom({})).toBeUndefined()
    expect(deploymentStateFrom(null)).toBeUndefined()
  })
})

describe('A squad reads back what it was told to deploy', () => {
  test('characterId and fatigue survive the round trip through Squads, not only sheet and hp', () => {
    // Regression: `Squads` used to build every `Soldier` from a `Deployment`
    // but hand back a plain `{ sheet, loadout, state: { hp } }` from
    // `deploymentsOf`, forgetting `characterId` and `state.fatigue` entirely
    // — so the header a host actually sends a referee (`main.ts` builds it
    // from `deploymentsOf`, not from the `Deployment[]` handed to `Squads`)
    // never carried either, and every kept-roster match would have been
    // aborted by `Referee.verifyRosters` the moment it reached a real
    // referee, `[ITEM-042]`'s and `[ITEM-039]`'s own tests never having gone
    // through `Squads` to notice.
    const world = new World()
    const grid = new Grid(16)
    const sheet = characterSheet(new Rng(1))
    const squads = new Squads(
      world,
      grid,
      { [Faction.Blue]: [{ x: 1, y: 1 }], [Faction.Red]: [{ x: 10, y: 10 }] },
      { [Faction.Blue]: [{ characterId: 'kept-abc', sheet, state: { hp: 40, fatigue: 3 } }] },
    )

    const [deployment] = squads.deploymentsOf(Faction.Blue)
    expect(deployment!.characterId).toBe('kept-abc')
    expect(deployment!.state?.hp).toBe(40)
    expect(deployment!.state?.fatigue).toBe(3)
  })

  test('a rolled squad states no characterId at all', () => {
    const world = new World()
    const grid = new Grid(16)
    const sheet = characterSheet(new Rng(1))
    const squads = new Squads(
      world,
      grid,
      { [Faction.Blue]: [{ x: 1, y: 1 }], [Faction.Red]: [{ x: 10, y: 10 }] },
      { [Faction.Blue]: [{ sheet }] },
    )
    expect(squads.deploymentsOf(Faction.Blue)[0]!.characterId).toBeUndefined()
  })

  test('the grenades a squad states rebuild the same pouch, issued stones included once', () => {
    // Regression: `loadoutOf` read each pouch back *with* the stones every
    // soldier is issued, and applying that loadout issued them again — so
    // the header a host sends a referee deployed every soldier with twice the
    // stones, and the first digest at the first handover disagreed on every
    // unit's inventory and aborted the match.
    const spawns = { [Faction.Blue]: [{ x: 1, y: 1 }], [Faction.Red]: [{ x: 10, y: 10 }] }
    const sheet = characterSheet(new Rng(1))
    const packed = { ...defaultLoadout(1)[0]!, grenades: { ...defaultLoadout(1)[0]!.grenades, [GrenadeId.Frag]: 2 } }
    const original = new Squads(new World(), new Grid(16), spawns, { [Faction.Blue]: [{ sheet, loadout: packed }] })

    const stated = original.deploymentsOf(Faction.Blue)
    const rebuilt = new Squads(new World(), new Grid(16), spawns, { [Faction.Blue]: stated })

    expect(rebuilt.byFaction[Faction.Blue][0]!.grenades).toEqual(original.byFaction[Faction.Blue][0]!.grenades)
    expect(stated[0]!.loadout!.grenades[GrenadeId.Stone]).toBe(0)
  })
})
